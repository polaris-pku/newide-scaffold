/**
 * delivery-claim — 交付状态机的临界区编排
 *
 * services/delivery-lifecycle.ts 定的是「记录怎么变」，这里定的是「在什么保护下变」：
 * 每一次状态转移都是**读—判断—写**，两步之间必须有临界区，否则两个消费者会同时
 * 看到同一条 pending。
 *
 * 适配器提供 `DeliveryRecordStore`（怎么读写、怎么加锁），编排逻辑只写一次，因此
 * 内存实现与文件实现共用完全相同的转移顺序与失败处理。抢不到锁时统一返回
 * undefined，含义是「本次什么都没做」，与「状态不允许」对调用方是同一件事。
 */
import {
  claimDeliveryRecord,
  compareDeliveryCandidates,
  completeDeliveryRecord,
  expireDeliveryClaimRecord,
  failDeliveryRecord,
  isDeliveryClaimExpired,
  isDeliveryDue,
  renewDeliveryClaimRecord,
  resetDeliveryForRetry,
  type ClaimDeliveryRecordInput,
  type DeliveryLifecycleRecord,
  type DeliveryRetryPolicy,
  type FailDeliveryRecordInput,
} from './delivery-lifecycle';

/** 一条候选记录 + 它在哪个 role 下（claimNext 需要拿它去加锁） */
export interface DeliveryRecordCandidate<T> {
  role_id: string;
  id: string;
  record: T;
}

export interface DeliveryRecordStore<T extends DeliveryLifecycleRecord> {
  /** 该通道的全部记录（可按 role 收窄） */
  list(role_id?: string): Promise<Array<DeliveryRecordCandidate<T>>>;
  read(role_id: string, id: string): Promise<T | undefined>;
  write(role_id: string, record: T): Promise<void>;
  /**
   * 在该记录的临界区里执行 `fn`。
   *
   * 返回 undefined 表示没抢到锁（别处正在改这条）——调用方按「本次跳过」处理，
   * 不要在这里抛错：抢锁失败是并发下的正常结果，不是故障。
   */
  lock<R>(role_id: string, id: string, fn: () => Promise<R>): Promise<R | undefined>;
}

/** 读—判断—写的公共骨架：转移函数返回 undefined 就什么都不写 */
async function mutateRecord<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  role_id: string,
  id: string,
  apply: (record: T) => T | undefined,
): Promise<T | undefined> {
  return store.lock(role_id, id, async () => {
    const record = await store.read(role_id, id);
    if (!record) return undefined;
    const next = apply(record);
    if (!next) return undefined;
    await store.write(role_id, next);
    return next;
  });
}

/** claim 一条指定记录；不是 pending / 没到退避窗口 / 次数用满 → undefined */
export function claimRecord<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  role_id: string,
  id: string,
  input: ClaimDeliveryRecordInput,
): Promise<T | undefined> {
  return mutateRecord(store, role_id, id, (record) => claimDeliveryRecord(record, input));
}

/**
 * claim 下一条可投递记录：按到期时刻排序后逐条尝试。
 *
 * 逐条而不是取第一条就放弃——排在前面那条可能正被别人改（抢不到锁），
 * 这不该让整次 claim 空手而归。
 */
export async function claimNextRecord<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  input: ClaimDeliveryRecordInput & { role_id?: string | undefined },
): Promise<T | undefined> {
  const candidates = (await store.list(input.role_id)).filter((candidate) =>
    isDeliveryDue(candidate.record, input.now),
  );
  candidates.sort(compareDeliveryCandidates);
  for (const candidate of candidates) {
    const claimed = await claimRecord(store, candidate.role_id, candidate.id, input);
    if (claimed) return claimed;
  }
  return undefined;
}

/** 延长 lease；持有者不匹配或已过期 → undefined */
export function renewRecordClaim<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  role_id: string,
  id: string,
  input: { owner: string; now: string; lease_ms: number },
): Promise<T | undefined> {
  return mutateRecord(store, role_id, id, (record) => renewDeliveryClaimRecord(record, input));
}

/** 交付完成 */
export function completeRecord<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  role_id: string,
  id: string,
  input: { owner?: string | undefined; now: string; processor_version?: string | undefined },
): Promise<T | undefined> {
  return mutateRecord(store, role_id, id, (record) => completeDeliveryRecord(record, input));
}

/** 交付失败（可重试 → 退避后 pending；否则 dead_letter） */
export function failRecord<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  role_id: string,
  id: string,
  input: FailDeliveryRecordInput,
): Promise<T | undefined> {
  return mutateRecord(store, role_id, id, (record) => failDeliveryRecord(record, input));
}

/** 人工重试：dead_letter → pending（次数清零） */
export function retryDeadLetterRecord<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  role_id: string,
  id: string,
  input: { now: string },
): Promise<T | undefined> {
  return mutateRecord(store, role_id, id, (record) => resetDeliveryForRetry(record, input));
}

/**
 * 启动恢复：把 lease 已过期仍停在 processing 的记录放回队列。
 *
 * 每一条都在自己的临界区里重新读一遍再判断——列举到写入之间可能有人完成了它，
 * 那时过期判定已经不成立，就必须放过它（否则会把一份已交付的活重投一次）。
 */
export async function restoreExpiredRecords<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  input: { role_id?: string | undefined; now: string; policy?: DeliveryRetryPolicy | undefined },
): Promise<DeliveryRecordCandidate<T>[]> {
  const expired = (await store.list(input.role_id))
    .filter((candidate) => isDeliveryClaimExpired(candidate.record, input.now))
    .sort(compareDeliveryCandidates);
  const restored: DeliveryRecordCandidate<T>[] = [];
  for (const candidate of expired) {
    const next = await store.lock(candidate.role_id, candidate.id, async () => {
      const current = await store.read(candidate.role_id, candidate.id);
      if (!current || !isDeliveryClaimExpired(current, input.now)) return undefined;
      const updated = expireDeliveryClaimRecord(current, {
        now: input.now,
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
      });
      await store.write(candidate.role_id, updated);
      return updated;
    });
    if (next) restored.push({ ...candidate, record: next });
  }
  return restored;
}

/** 当前可投递的记录（pending 且已过退避窗口），按到期时刻排序 */
export async function listRetryableRecords<T extends DeliveryLifecycleRecord>(
  store: DeliveryRecordStore<T>,
  input: { role_id?: string | undefined; now: string },
): Promise<DeliveryRecordCandidate<T>[]> {
  const due = (await store.list(input.role_id)).filter((candidate) =>
    isDeliveryDue(candidate.record, input.now),
  );
  return due.sort(compareDeliveryCandidates);
}
