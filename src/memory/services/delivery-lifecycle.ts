/**
 * delivery-lifecycle — 上下文交付项与反馈 outbox 的状态机（工作包 C + Phase 0 fencing）
 *
 * 两条通道（context delivery / driver feedback）共用同一套状态语义，所以转移规则
 * 在这里只写一次，由三个适配器共同调用：适配器只负责「怎么读写」，规则的「怎么变」
 * 全在这个文件里。这样测试替身与生产实现不可能各有一套解释。
 *
 * 一个投递回合的完整形状：
 *
 *   pending --claim(owner, token, lease)--> processing --complete(token)--> processed
 *                                              |  |
 *                               fail(token,retryable) |  | lease 过期 / 崩溃
 *                                              v  v
 *                                     pending(next_retry_at) 或 dead_letter
 *
 * 关键约定：
 * - **attempt_count 在 claim 时递增**：一次投递尝试就是一次 claim。失败与 lease
 *   过期都不再各加一次，避免同一回合被记两次；超过 `max_attempts` 之后既不再
 *   claim，也不再有记录回到 pending。
 * - **每次 claim 发一个新 token**（fencing token）。renew / complete / fail 都必须
 *   原样带回，写不匹配就什么都不做。只有 owner 是不够的：owner 是稳定 worker 标识，
 *   同一个 worker 重启后还是它，无法区分「上一个进程的持有」与「这个进程的持有」。
 * - **lease 过期即失去写权**：过期的持有者连 complete/fail 都不许——它可能已经在
 *   毫不知情的情况下被新 worker 接手了。这条与 token 一起构成 fencing：token 挡住
 *   「别人接手后的写入」，lease 检查挡住「自己过期后的写入」。
 * - 达到上限（或下游明确报不可重试）时进 `dead_letter`，并保留最后一次 `last_error`。
 * - `processed` 是终止态：不再能被 claim，也不参与过期恢复。
 * - token 是**活着的凭据**，不是历史：离开 processing（完成/失败/过期恢复/人工重试）
 *   时一律清掉；`claim_owner`/`claimed_at` 作为审计信息保留。
 *
 * 纯规则函数都接收显式的 `now`，不自己读时钟——退避与 lease 的测试因此不依赖真实时间。
 * token 由调用方（适配器）生成，规则函数只接收它，保持可预测。
 */
import { randomUUID } from 'node:crypto';
import type { DeliveryStatus } from '../schemas';

/**
 * 交付通道的判别式。
 *
 * 三条通道共用一套状态机与 claim/lease/retry 规则：两个 outbox（上下文交付、Driver 反馈）
 * 是上游交给维护系统的输入，`pending_feedback` 是反馈消费者自己的待归并队列（反馈先到、
 * Experience 还没出现时寄存于此）。它们的不同只在**记录形状**与**重试预算**上，转移规则
 * 完全相同；把通道判别式定义在这里而不是 ports 里，是因为重试预算按通道解析（见
 * resolveChannelRetryPolicy）属于状态机的一部分。ports/memory-delivery 把它再导出为
 * `DeliveryChannel`。
 */
export type DeliveryChannelKind = 'context' | 'feedback' | 'pending_feedback';

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

/**
 * 消费 Driver 反馈的默认重试预算。
 *
 * 比基策略宽得多（5 秒起、封顶 5 分钟、最多 8 次，约 10 分钟），因为这条通道上的失败
 * 几乎只有一类：存储/数据库暂时不可用。而它的代价不对称——消费一条反馈最多写两处
 * （把反馈应用进 Experience，或把它寄存进待归并队列），一次抖动用光 3 次机会就意味着
 * 「这份反馈没被消化」，那是整套机制最不能出的错。基策略（3 次 / 约 4 秒）留给上下文
 * 交付通道，那里失败可以等下一次调度。
 */
export const DEFAULT_FEEDBACK_CONSUME_RETRY_POLICY: DeliveryRetryPolicy = {
  max_attempts: 8,
  base_delay_ms: 5_000,
  max_delay_ms: 5 * 60_000,
};

/**
 * 待归并反馈的默认重试预算：等的是「某条 Experience 什么时候出现」，不是「网络什么时候通」。
 *
 * 指数退避 30s 起、封顶 15 分钟、最多 20 次投递 —— 累加起来约 3.8 小时，这就是**保留期限**：
 * Experience 一直不出现时，反馈不会无限重试，也不会被悄悄丢掉，而是在用满次数后带着最后一次
 * 原因进死信，等人处理。数值放在这里（可被适配器构造参数覆盖），不散落在 worker 里。
 */
export const DEFAULT_PENDING_FEEDBACK_RETRY_POLICY: DeliveryRetryPolicy = {
  max_attempts: 20,
  base_delay_ms: 30_000,
  max_delay_ms: 15 * 60_000,
};

/**
 * 技能晋升（Skill Promotion Job）的默认重试预算。
 *
 * 晋升不是「等某个东西出现」，也不是「网络抖了一下」，所以两面都不像：它的失败几乎只有
 * 存储故障（可立刻重投）与坏数据（不可重试，当场进死信）。次数取 5、退避 30s 起、封顶
 * 15 分钟 —— 累加约 1 小时。给到这个宽度是因为一次晋升要写两处（Skill 与经验的回写），
 * 中间崩溃留下的半成品必须靠重试收敛；而超过一小时还没收敛的，说明不是抖动，该让人看。
 */
export const DEFAULT_PROMOTION_RETRY_POLICY: DeliveryRetryPolicy = {
  max_attempts: 5,
  base_delay_ms: 30_000,
  max_delay_ms: 15 * 60_000,
};

/**
 * Persona 演化（Persona Evolution Job）的默认重试预算。
 *
 * 与晋升**同值**，这是刻意的而不是抄漏了：两条通道的失败面几乎一样（存储故障可立刻重投、
 * 契约错当场进死信），而演化的失败面多一类——`model_error`（策略/归纳器调模型时的超时与
 * 限流），它和网络抖动是同一种东西，退避曲线也照同一个形状走。在没有证据说明它需要一份
 * 不同的预算之前给一个不同的数字，只会让运维多记一组没有理由的参数。
 *
 * 它是单独的常量而不是复用上面那个，理由与「通道之间必须能各自定价」相同：将来其中一条
 * 要改（例如演化接了更贵的模型、需要更长的退避），改这里不会顺手改掉晋升。
 */
export const DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY: DeliveryRetryPolicy = {
  max_attempts: 5,
  base_delay_ms: 30_000,
  max_delay_ms: 15 * 60_000,
};

/**
 * 解析某条通道实际使用的重试策略。
 *
 * 通道之间必须能各自定价：消费一条交付项的失败（存储抖动）值得立刻重投，等待 Experience
 * 出现的每一次尝试则要拉开间隔——共用一个计数器与同一组退避，任何一次抖动都会吃掉归并的
 * 预算，观测上分不清积压属于谁。覆盖是按字段合并的，没写的字段沿用基策略。
 */
export function resolveChannelRetryPolicy(
  base: DeliveryRetryPolicy,
  overrides: Partial<Record<DeliveryChannelKind, Partial<DeliveryRetryPolicy>>> | undefined,
  channel: DeliveryChannelKind,
): DeliveryRetryPolicy {
  const override = overrides?.[channel];
  return override ? { ...base, ...override } : base;
}

/** 文件锁的默认存活上限：超过它可被另一进程判定为陈旧锁并接管 */
export const DEFAULT_DELIVERY_LOCK_TTL_MS = 30_000;

/** 状态机作用的记录形状：两种交付记录共有的那部分字段 */
export interface DeliveryLifecycleRecord {
  status: DeliveryStatus;
  attempt_count: number;
  claimed_at?: string | undefined;
  claim_owner?: string | undefined;
  /** 本次 claim 的 fencing token；见 schemas.ts 的 lifecycleRecordFields */
  claim_token?: string | undefined;
  lease_expires_at?: string | undefined;
  next_retry_at?: string | undefined;
  last_error?: string | undefined;
  updated_at: string;
}

/**
 * 生成一次 claim 的 fencing token。
 *
 * 只要「每次 claim 唯一」这一点成立即可，因此用 UUID；前缀只是为了在落盘记录与
 * 日志里一眼认出这是 claim 凭据而不是别的 id。**不要**用派生的确定性值（例如
 * owner+时刻）：同一毫秒内的两次 claim 会撞成同一个 token，fencing 就废了。
 */
export function newClaimToken(): string {
  return `claim_${randomUUID()}`;
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

/**
 * 这条记录是否是一次已经无人持有的投递（下游崩在 processing 里）。
 *
 * 「processing 但没有 lease」同样算过期，这是**旧记录的恢复策略**而不是宽松判定：
 * 本状态机写出的 processing 一定带 lease（claim 时写死），所以没有 lease 的
 * processing 只能来自更早的版本或手工改动。把它当作过期，那条记录还能回到队列被
 * 重新 claim（拿到新 token）；不这样处理，它就会永远卡在 processing —— 既没有人
 * 持得住（没有租约可续），也没有任何人能完成它（没有 token 可匹配）。
 */
export function isDeliveryClaimExpired(record: DeliveryLifecycleRecord, now: string): boolean {
  if (record.status !== 'processing') return false;
  if (record.lease_expires_at === undefined) return true;
  return Date.parse(record.lease_expires_at) <= Date.parse(now);
}

export interface ClaimDeliveryRecordInput {
  owner: string;
  now: string;
  lease_ms: number;
  /** 本次 claim 的 fencing token（由适配器生成，见 newClaimToken） */
  claim_token: string;
  policy?: DeliveryRetryPolicy;
}

/**
 * claim：pending → processing。
 *
 * 不是 pending、还没到退避窗口、已经用完投递次数，都返回 undefined（本次没拿到）。
 * 拿到的记录带上 owner、**新 token**、lease 到期时刻，并把 attempt_count 记上一次。
 *
 * token 为空是调用方的编程错误：没有 token 的 processing 记录谁也 fence 不住，
 * 而它又拦不住任何人写终态——这种记录一旦落盘就只能靠租约过期回收。宁可在这里
 * 拒绝，也不要写出一条「看起来被持有、实际无人可负责」的记录。
 */
export function claimDeliveryRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: ClaimDeliveryRecordInput,
): T | undefined {
  if (!input.claim_token) {
    throw new Error('claimDeliveryRecord requires a non-empty claim_token.');
  }
  const policy = input.policy ?? DEFAULT_DELIVERY_RETRY_POLICY;
  if (!isDeliveryDue(record, input.now)) return undefined;
  if (record.attempt_count >= policy.max_attempts) return undefined;
  return {
    ...record,
    status: 'processing',
    attempt_count: record.attempt_count + 1,
    claimed_at: input.now,
    claim_owner: input.owner,
    claim_token: input.claim_token,
    lease_expires_at: addMilliseconds(input.now, input.lease_ms),
    next_retry_at: undefined,
    updated_at: input.now,
  };
}

/**
 * 持有者凭据校验：状态、token、可选 owner、租约都要过关。
 *
 * 四项缺一不可，且各自挡的是不同的东西：
 * - status：只对 processing 生效，终态谁也不许再改
 * - token：挡住「被接手之后还拿旧凭据写」
 * - lease：挡住「自己已经过期还写」（过期即视为被别人接手，哪怕暂时没人来抢）
 * - owner：可选的交叉核对，用来早点发现「把别人的记录传进来了」，不是 fencing 本身
 */
function isHeldBy(
  record: DeliveryLifecycleRecord,
  input: { claim_token: string; owner?: string | undefined },
  now: string,
): boolean {
  if (record.status !== 'processing') return false;
  if (record.claim_token === undefined) return false;
  if (record.claim_token !== input.claim_token) return false;
  if (input.owner !== undefined && record.claim_owner !== input.owner) return false;
  if (isDeliveryClaimExpired(record, now)) return false;
  return true;
}

/**
 * renew：延长自己持有的 lease。
 *
 * 只有当前持有者能续租，且 lease 必须还没过期——已经过期的记录对持有者来说
 * 就是「已经被别人拿走了」，续租成功只会制造两个消费者同时在写的假象。
 */
export function renewDeliveryClaimRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: { owner?: string | undefined; claim_token: string; now: string; lease_ms: number },
): T | undefined {
  if (!isHeldBy(record, input, input.now)) return undefined;
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
 * 持有」更值得留；token 与 lease 一起清掉：它们是**活着的凭据**，终态不再有人持有，
 * 留着只会让一条过期的凭据看起来还管用。
 */
export function completeDeliveryRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: {
    owner?: string | undefined;
    claim_token: string;
    now: string;
    processor_version?: string | undefined;
  },
): T | undefined {
  if (!isHeldBy(record, input, input.now)) return undefined;
  return {
    ...record,
    status: 'processed',
    claim_token: undefined,
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
  claim_token: string;
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
 *
 * 两条分支都清掉 token：回到 pending 就是交还持有权，下一个消费者 claim 时会拿到
 * 自己的新 token。
 */
export function failDeliveryRecord<T extends DeliveryLifecycleRecord>(
  record: T,
  input: FailDeliveryRecordInput,
): T | undefined {
  if (!isHeldBy(record, input, input.now)) return undefined;
  const policy = input.policy ?? DEFAULT_DELIVERY_RETRY_POLICY;
  const exhausted = record.attempt_count >= policy.max_attempts;
  if (!input.retryable || exhausted) {
    return {
      ...record,
      status: 'dead_letter',
      claim_token: undefined,
      lease_expires_at: undefined,
      next_retry_at: undefined,
      last_error: input.error,
      updated_at: input.now,
    };
  }
  return {
    ...record,
    status: 'pending',
    claim_token: undefined,
    lease_expires_at: undefined,
    next_retry_at: addMilliseconds(input.now, deliveryRetryDelayMs(record.attempt_count, policy)),
    last_error: input.error,
    updated_at: input.now,
  };
}

/**
 * 崩溃恢复：processing 且 lease 已过期（或本就无租约）→ 回到 pending（立即可投递）
 * 或 dead_letter。
 *
 * 与 fail 的区别在语义：这里没有下游的判断，只有「拿着它的人不见了」。因此不套
 * 退避窗口（立即可重投），但仍然计入次数上限——反复被 claim 又从不完成，正是
 * 一条毒记录的形状，无限重投只会让消费者反复倒下。
 *
 * `claim_owner`/`claimed_at` 与 complete 一样保留下来当审计（「上一次是谁拿着它」
 * 是排查崩溃循环最直接的线索）；表示「现在有人持有」的 lease 与被回收的 token 一起
 * 清掉——这正是 fencing 生效的时刻：被回收的记录再被 claim 时发新 token，旧持有者
 * 手里的那一个从此写不进任何东西。
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
      claim_token: undefined,
      lease_expires_at: undefined,
      next_retry_at: undefined,
      last_error: error,
      updated_at: input.now,
    };
  }
  return {
    ...record,
    status: 'pending',
    claim_token: undefined,
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
    claim_token: undefined,
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
