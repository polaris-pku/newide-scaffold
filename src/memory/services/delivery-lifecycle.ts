/**
 * delivery-lifecycle — 上下文交付项与反馈 outbox 的状态机（工作包 C）
 *
 * 两条通道（context delivery / driver feedback）共用同一套状态语义，所以转移规则
 * 在这里只写一次，由两个适配器共同调用：适配器只负责「怎么读写」，规则的「怎么变」
 * 全在这个文件里。这样测试替身与生产实现不可能各有一套解释。
 *
 * 一个投递回合的完整形状：
 *
 *   pending --claim(owner, lease)--> processing --complete--> processed
 *                                       |  |
 *                        fail(retryable) |  | lease 过期 / 崩溃
 *                                       v  v
 *                              pending(next_retry_at) 或 dead_letter
 *
 * 关键约定：
 * - **attempt_count 在 claim 时递增**：一次投递尝试就是一次 claim。失败与 lease
 *   过期都不再各加一次，避免同一回合被记两次；超过 `max_attempts` 之后既不再
 *   claim，也不再有记录回到 pending。
 * - 达到上限（或下游明确报不可重试）时进 `dead_letter`，并保留最后一次 `last_error`。
 * - `processed` 是终止态：不再能被 claim，也不参与过期恢复。
 *
 * 纯规则函数都接收显式的 `now`，不自己读时钟——退避与 lease 的测试因此不依赖真实时间。
 */
import type { DeliveryStatus } from '../schemas';

/** 重试策略：指数退避 + 次数上限 */
export interface DeliveryRetryPolicy {
  /** 允许的最大投递次数（含首次）；达到后进 dead_letter */
  max_attempts: number;
  /** 指数退避基数（毫秒）：第 n 次失败后等 base * 2^(n-1) */
  base_delay_ms: number;
  /** 退避上限（毫秒） */
  max_delay_ms: number;
}

/**
 * 默认重试策略：最多 3 次投递。计划里写死的「指数退避，默认最多 3 次」，
 * 两个适配器共用同一份默认值，避免内存实现与文件实现的重试行为不一致。
 */
export const DEFAULT_DELIVERY_RETRY_POLICY: DeliveryRetryPolicy = {
  max_attempts: 3,
  base_delay_ms: 1_000,
  max_delay_ms: 60_000,
};

/** 默认 lease 时长：下游一次处理窗口 60s，未续租即可被判定为崩溃 */
export const DEFAULT_DELIVERY_LEASE_MS = 60_000;

/** 文件锁的默认存活上限：超过它可被另一进程判定为陈旧锁并接管 */
export const DEFAULT_DELIVERY_LOCK_TTL_MS = 30_000;

/** 状态机作用的记录形状：两种交付记录共有的那部分字段 */
export interface DeliveryLifecycleRecord {
  status: DeliveryStatus;
  attempt_count: number;
  claimed_at?: string | undefined;
  claim_owner?: string | undefined;
  lease_expires_at?: string | undefined;
  next_retry_at?: string | undefined;
  last_error?: string | undefined;
  updated_at: string;
}

/** ISO 时刻 + 毫秒 → ISO 时刻 */
export function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

/** 指数退避：第 n 次投递失败后应等待的毫秒数（n 从 1 起） */
export function deliveryRetryDelayMs(
  attempt: number,
  policy: DeliveryRetryPolicy = DEFAULT_DELIVERY_RETRY_POLICY,
): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.max_delay_ms, policy.base_delay_ms * 2 ** exponent);
}

/** 这条记录现在是否可以被投递：还在 pending，且已经过了退避窗口 */
export function isDeliveryDue(record: DeliveryLifecycleRecord, now: string): boolean {
  if (record.status !== 'pending') return false;
  if (record.next_retry_at === undefined) return true;
  return Date.parse(record.next_retry_at) <= Date.parse(now);
}

/** 这条记录是否是一次已经无人持有的投递（下游崩在 processing 里） */
export function isDeliveryClaimExpired(record: DeliveryLifecycleRecord, now: string): boolean {
  if (record.status !== 'processing') return false;
  if (record.lease_expires_at === undefined) return false;
  return Date.parse(record.lease_expires_at) <= Date.parse(now);
}

export interface ClaimDeliveryRecordInput {
  owner: string;
  now: string;
  lease_ms: number;
  policy?: DeliveryRetryPolicy;
}

/**
 * claim：pending → processing。
 *
 * 不是 pending、还没到退避窗口、已经用完投递次数，都返回 undefined（本次没拿到）。
 * 拿到的记录带上 owner、lease 到期时刻，并把 attempt_count 记上一次。
 */
export function claimDeliveryRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: ClaimDeliveryRecordInput,
): T | undefined {
  const policy = input.policy ?? DEFAULT_DELIVERY_RETRY_POLICY;
  if (!isDeliveryDue(record, input.now)) return undefined;
  if (record.attempt_count >= policy.max_attempts) return undefined;
  return {
    ...record,
    status: 'processing',
    attempt_count: record.attempt_count + 1,
    claimed_at: input.now,
    claim_owner: input.owner,
    lease_expires_at: addMilliseconds(input.now, input.lease_ms),
    next_retry_at: undefined,
    updated_at: input.now,
  };
}

/**
 * renew：延长自己持有的 lease。
 *
 * 只有当前持有者能续租，且 lease 必须还没过期——已经过期的记录对持有者来说
 * 就是「已经被别人拿走了」，续租成功只会制造两个消费者同时在写的假象。
 */
export function renewDeliveryClaimRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: { owner: string; now: string; lease_ms: number },
): T | undefined {
  if (record.status !== 'processing') return undefined;
  if (record.claim_owner !== input.owner) return undefined;
  if (isDeliveryClaimExpired(record, input.now)) return undefined;
  return {
    ...record,
    lease_expires_at: addMilliseconds(input.now, input.lease_ms),
    updated_at: input.now,
  };
}

/**
 * complete：processing → processed（终止态）。
 *
 * `claimed_at` / `claim_owner` 保留下来当审计信息——「谁处理完的」比「现在有没有人
 * 持有」更值得留；lease 与退避字段一起清掉，因为终止态不再有租约。
 */
export function completeDeliveryRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: { owner?: string | undefined; now: string; processor_version?: string | undefined },
): T | undefined {
  if (record.status !== 'processing') return undefined;
  if (input.owner !== undefined && record.claim_owner !== input.owner) return undefined;
  return {
    ...record,
    status: 'processed',
    lease_expires_at: undefined,
    next_retry_at: undefined,
    last_error: undefined,
    ...(input.processor_version !== undefined
      ? { processor_version: input.processor_version }
      : {}),
    updated_at: input.now,
  };
}

export interface FailDeliveryRecordInput {
  owner?: string | undefined;
  now: string;
  error: string;
  /** 下游判断这次失败能不能靠重投解决；不可重试的直接 dead_letter */
  retryable: boolean;
  policy?: DeliveryRetryPolicy;
}

/**
 * fail：processing → pending（退避后重投）或 dead_letter。
 *
 * 不可重试的错误（schema 解析不了、role/seq 非法、配置永久错）不看次数直接进死信；
 * 可重试的错误在退避窗口后回到 pending，直到用完 `max_attempts`。
 */
export function failDeliveryRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: FailDeliveryRecordInput,
): T | undefined {
  if (record.status !== 'processing') return undefined;
  if (input.owner !== undefined && record.claim_owner !== input.owner) return undefined;
  const policy = input.policy ?? DEFAULT_DELIVERY_RETRY_POLICY;
  const exhausted = record.attempt_count >= policy.max_attempts;
  if (!input.retryable || exhausted) {
    return {
      ...record,
      status: 'dead_letter',
      lease_expires_at: undefined,
      next_retry_at: undefined,
      last_error: input.error,
      updated_at: input.now,
    };
  }
  return {
    ...record,
    status: 'pending',
    lease_expires_at: undefined,
    next_retry_at: addMilliseconds(input.now, deliveryRetryDelayMs(record.attempt_count, policy)),
    last_error: input.error,
    updated_at: input.now,
  };
}

/**
 * 崩溃恢复：processing 且 lease 已过期 → 回到 pending（立即可投递）或 dead_letter。
 *
 * 与 fail 的区别在语义：这里没有下游的判断，只有「拿着它的人不见了」。因此不套
 * 退避窗口（立即可重投），但仍然计入次数上限——反复被 claim 又从不完成，正是
 * 一条毒记录的形状，无限重投只会让消费者反复倒下。
 *
 * `claim_owner`/`claimed_at` 与 complete 一样保留下来当审计（「上一次是谁拿着它」
 * 是排查崩溃循环最直接的线索）；真正表示「现在有人持有」的是 lease，它在这里被清掉。
 */
export function expireDeliveryClaimRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: { now: string; policy?: DeliveryRetryPolicy },
): T {
  const policy = input.policy ?? DEFAULT_DELIVERY_RETRY_POLICY;
  const error = 'Claim lease expired without completion.';
  if (record.attempt_count >= policy.max_attempts) {
    return {
      ...record,
      status: 'dead_letter',
      lease_expires_at: undefined,
      next_retry_at: undefined,
      last_error: error,
      updated_at: input.now,
    };
  }
  return {
    ...record,
    status: 'pending',
    lease_expires_at: undefined,
    next_retry_at: undefined,
    last_error: error,
    updated_at: input.now,
  };
}

/**
 * 人工重试：dead_letter → pending，并清零投递次数。
 *
 * 只有 dead_letter 可重试：processed 是完成态，processing 有人持有。清零次数是
 * 刻意的人力介入语义——运维说「再试一次」，就是再给满额机会，否则一条已经用完
 * 3 次的机会只够再投一次。
 */
export function resetDeliveryForRetry<T extends DeliveryLifecycleRecord>(
  record: T,
  input: { now: string },
): T | undefined {
  if (record.status !== 'dead_letter') return undefined;
  return {
    ...record,
    status: 'pending',
    attempt_count: 0,
    claimed_at: undefined,
    claim_owner: undefined,
    lease_expires_at: undefined,
    next_retry_at: undefined,
    last_error: undefined,
    updated_at: input.now,
  };
}

/** 一条待投递记录的定位信息（claimNext 需要在拿到记录后再去加锁） */
export interface DeliveryCandidate<T> {
  role_id: string;
  id: string;
  record: T;
}

/** claimNext 的候选排序：先到期的先投；同刻按创建时间，再按 id，保证确定性 */
export function compareDeliveryCandidates<T extends DeliveryLifecycleRecord>(
  left: DeliveryCandidate<T>,
  right: DeliveryCandidate<T>,
): number {
  const leftDue = left.record.next_retry_at ?? '';
  const rightDue = right.record.next_retry_at ?? '';
  if (leftDue !== rightDue) return leftDue < rightDue ? -1 : 1;
  if (left.record.updated_at !== right.record.updated_at) {
    return left.record.updated_at < right.record.updated_at ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}
