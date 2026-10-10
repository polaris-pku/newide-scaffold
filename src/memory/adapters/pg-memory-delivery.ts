/**
 * PgMemoryDeliveryRepository — MemoryDeliveryRepository 数据库适配器
 *
 * 同一份实现同时跑在嵌入式 PGlite（WASM PostgreSQL）与外部 PostgreSQL 上：两者都
 * 只经 `ports/sql-pool` 暴露的 SqlPool，SQL 里没有 Postgres 专属特性泄漏到领域层。
 *
 * 与 File / InMemory 适配器共用 services/delivery-lifecycle.ts 的转移规则，差别只在
 * **临界区怎么给**：这里靠存储自身的条件更新。两次 claim 都读到同一条 pending 时，
 * 第一次写的 UPDATE 会改掉 `status`/`updated_at`，第二次的
 * `WHERE status = ... AND updated_at = ...` 于是匹配不到任何行，返回 undefined
 * ——正是「检查 pending + 写 processing」落在单条语句里的样子。
 *
 * 刻意**不用显式事务**：PGlite 是单连接数据库，进程内的 BEGIN/COMMIT 不是隔离边界
 * （并发的第二个 BEGIN 会挤进第一个事务里）。单条条件 UPDATE 本身就是原子的，两个
 * 引擎上行为一致，也不需要把连接从池里借出来独占。
 *
 * payload 是解析的唯一来源，列只服务 WHERE / ORDER BY。
 */
import { nowTimestamp } from '../../core';
import {
  ContextDeliveryItemSchema,
  DriverFeedbackRecordSchema,
  type ContextDeliveryItem,
  type DriverFeedbackRecord,
} from '../schemas';
import {
  DEFAULT_DELIVERY_LEASE_MS,
  DEFAULT_DELIVERY_RETRY_POLICY,
  claimDeliveryRecord,
  newClaimToken,
  compareDeliveryCandidates,
  completeDeliveryRecord,
  expireDeliveryClaimRecord,
  failDeliveryRecord,
  isDeliveryClaimExpired,
  renewDeliveryClaimRecord,
  resetDeliveryForRetry,
  type DeliveryLifecycleRecord,
  type DeliveryRetryPolicy,
} from '../services/delivery-lifecycle';
import {
  CONTEXT_DELIVERY_TABLE,
  DRIVER_FEEDBACK_TABLE,
  ensurePgMaintenanceSchema,
} from './pg-maintenance-schema';
import type { SqlPool } from '../ports/sql-pool';
import type {
  ClaimedDelivery,
  ContextDeliveryFilter,
  DeliveryChannel,
  DeliveryClaimRequest,
  DeliveryRecordLocator,
  DeliveryRepositoryPolicy,
  DeliverySubmitResult,
  DriverFeedbackFilter,
  MemoryDeliveryRepository,
} from '../ports/memory-delivery';

export interface PgMemoryDeliveryRepositoryOptions {
  pool: SqlPool;
  retryPolicy?: Partial<DeliveryRetryPolicy>;
  lease_ms?: number;
  /** 关闭懒建表（由调用方自行 ensurePgMaintenanceSchema）；缺省 true */
  autoMigrate?: boolean;
}

/** 一条通道在数据库里的形状：表名、主键列名、幂等键列名、载荷 schema 与列映射 */
interface ChannelTable {
  channel: DeliveryChannel;
  table: string;
  idColumn: string;
  keyColumn: string;
  parse: (value: unknown) => DeliveryRecord;
  columns: (record: DeliveryRecord) => Record<string, string | null>;
}

/** 两条通道的载荷在适配器内部按联合类型处理；对外仍按 channel 收窄 */
type DeliveryRecord = ContextDeliveryItem | DriverFeedbackRecord;

interface Candidate {
  role_id: string;
  id: string;
  record: DeliveryRecord;
}

export class PgMemoryDeliveryRepository implements MemoryDeliveryRepository {
  private readonly pool: SqlPool;
  private readonly autoMigrate: boolean;
  private schemaReady: Promise<void> | undefined;

  readonly policy: DeliveryRepositoryPolicy;

  constructor(options: PgMemoryDeliveryRepositoryOptions) {
    this.pool = options.pool;
    this.autoMigrate = options.autoMigrate ?? true;
    this.policy = {
      ...DEFAULT_DELIVERY_RETRY_POLICY,
      ...options.retryPolicy,
      lease_ms: options.lease_ms ?? DEFAULT_DELIVERY_LEASE_MS,
      claim_isolation: 'conditional_update',
    };
  }

  // ── 提交与读取 ───────────────────────────────────────────────────

  async submitContextDelivery(
    item: ContextDeliveryItem,
  ): Promise<DeliverySubmitResult<ContextDeliveryItem>> {
    const stored = await this.submitRecord(this.contextTable(), item, item.delivery_id);
    return { item: stored.item as ContextDeliveryItem, created: stored.created };
  }

  async getContextDelivery(
    role_id: string,
    delivery_id: string,
  ): Promise<ContextDeliveryItem | undefined> {
    return (await this.readRecord(this.contextTable(), role_id, delivery_id)) as
      | ContextDeliveryItem
      | undefined;
  }

  async listContextDeliveries(
    filter: ContextDeliveryFilter = {},
  ): Promise<ContextDeliveryItem[]> {
    const records = await this.listRecords(this.contextTable(), {
      role_id: filter.role_id,
      task_id: filter.task_id,
      status: filter.status,
    });
    return records as ContextDeliveryItem[];
  }

  async submitDriverFeedback(
    record: DriverFeedbackRecord,
  ): Promise<DeliverySubmitResult<DriverFeedbackRecord>> {
    const stored = await this.submitRecord(this.feedbackTable(), record, record.feedback_id);
    return { item: stored.item as DriverFeedbackRecord, created: stored.created };
  }

  async getDriverFeedback(
    role_id: string,
    feedback_id: string,
  ): Promise<DriverFeedbackRecord | undefined> {
    return (await this.readRecord(this.feedbackTable(), role_id, feedback_id)) as
      | DriverFeedbackRecord
      | undefined;
  }

  async listDriverFeedback(filter: DriverFeedbackFilter = {}): Promise<DriverFeedbackRecord[]> {
    const records = await this.listRecords(this.feedbackTable(), {
      role_id: filter.role_id,
      task_id: filter.task_id,
      experience_id: filter.experience_id,
      status: filter.status,
    });
    return records as DriverFeedbackRecord[];
  }

  /**
   * 交付存储没有「按 role 开一块地方」的概念——所有 role 共享同一张表，按 role_id 列
   * 隔离。这里只需要确认表已经建好（内存/文件实现要的 ensureAgent 是那些后端的实现
   * 细节，不是端口语义）。
   */
  async ensureAgent(_role_id: string): Promise<void> {
    await this.ensureSchema();
  }

  async deleteAgent(role_id: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`DELETE FROM ${CONTEXT_DELIVERY_TABLE} WHERE role_id = $1`, [role_id]);
    await this.pool.query(`DELETE FROM ${DRIVER_FEEDBACK_TABLE} WHERE role_id = $1`, [role_id]);
  }

  // ── claim / lease / 重试 ─────────────────────────────────────────

  async claimDelivery(
    input: DeliveryClaimRequest & { role_id: string; id: string },
  ): Promise<ClaimedDelivery | undefined> {
    const claim = this.claimInput(input);
    return this.transition(this.tableOf(input.channel), input.role_id, input.id, (record) =>
      claimDeliveryRecord(record, claim),
    );
  }

  /**
   * claim 下一条可投递记录：列举候选 → 按共享的比较函数排序 → 逐条尝试。
   *
   * 逐条而不是取第一条就放弃——排在前面的那条可能刚被别人条件更新走，
   * 这不该让整次 claim 空手而归（与文件实现「抢不到锁就试下一条」同一形状）。
   */
  async claimNextDelivery(input: DeliveryClaimRequest): Promise<ClaimedDelivery | undefined> {
    const claim = this.claimInput(input);
    const table = this.tableOf(input.channel);
    const candidates = await this.scanDue(table, input.role_id, claim.now);
    candidates.sort(compareDeliveryCandidates);
    for (const candidate of candidates) {
      const claimed = await this.transition(
        table,
        candidate.role_id,
        candidate.id,
        (record) => claimDeliveryRecord(record, claim),
      );
      if (claimed) return claimed;
    }
    return undefined;
  }

  async renewDeliveryClaim(
    input: DeliveryRecordLocator & {
      claim_token: string;
      owner?: string;
      lease_ms?: number;
      now?: string;
    },
  ): Promise<ClaimedDelivery | undefined> {
    const now = input.now ?? nowTimestamp();
    const lease_ms = input.lease_ms ?? this.policy.lease_ms;
    return this.transition(this.tableOf(input.channel), input.role_id, input.id, (record) =>
      renewDeliveryClaimRecord(record, {
        claim_token: input.claim_token,
        owner: input.owner,
        now,
        lease_ms,
      }),
    );
  }

  async completeDelivery(
    input: DeliveryRecordLocator & {
      claim_token: string;
      owner?: string;
      processor_version?: string;
      now?: string;
    },
  ): Promise<ClaimedDelivery | undefined> {
    const now = input.now ?? nowTimestamp();
    return this.transition(this.tableOf(input.channel), input.role_id, input.id, (record) =>
      completeDeliveryRecord(record, {
        claim_token: input.claim_token,
        owner: input.owner,
        now,
        processor_version: input.processor_version,
      }),
    );
  }

  async failDelivery(
    input: DeliveryRecordLocator & {
      claim_token: string;
      owner?: string;
      error: string;
      retryable: boolean;
      now?: string;
    },
  ): Promise<ClaimedDelivery | undefined> {
    const now = input.now ?? nowTimestamp();
    return this.transition(this.tableOf(input.channel), input.role_id, input.id, (record) =>
      failDeliveryRecord(record, {
        claim_token: input.claim_token,
        owner: input.owner,
        error: input.error,
        retryable: input.retryable,
        now,
        policy: this.policy,
      }),
    );
  }

  async retryDeadLetterDelivery(
    input: DeliveryRecordLocator & { now?: string },
  ): Promise<ClaimedDelivery | undefined> {
    const now = input.now ?? nowTimestamp();
    return this.transition(this.tableOf(input.channel), input.role_id, input.id, (record) =>
      resetDeliveryForRetry(record, { now }),
    );
  }

  async restoreExpiredDeliveryClaims(options: {
    channel?: DeliveryChannel;
    role_id?: string;
    now?: string;
  } = {}): Promise<ClaimedDelivery[]> {
    const now = options.now ?? nowTimestamp();
    const restored: ClaimedDelivery[] = [];
    for (const channel of channelsOf(options.channel)) {
      const table = this.tableOf(channel);
      const expired = await this.scanExpired(table, options.role_id, now);
      expired.sort(compareDeliveryCandidates);
      for (const candidate of expired) {
        const next = await this.transition(table, candidate.role_id, candidate.id, (record) => {
          // 列举到写入之间可能有人完成了它，那时过期判定已经不成立，必须放过它
          if (!isDeliveryClaimExpired(record, now)) return undefined;
          return expireDeliveryClaimRecord(record, { now, policy: this.policy });
        });
        if (next) restored.push(next);
      }
    }
    return restored;
  }

  async listRetryableDeliveries(options: {
    channel?: DeliveryChannel;
    role_id?: string;
    now?: string;
  } = {}): Promise<ClaimedDelivery[]> {
    const now = options.now ?? nowTimestamp();
    const due: ClaimedDelivery[] = [];
    for (const channel of channelsOf(options.channel)) {
      const candidates = await this.scanDue(this.tableOf(channel), options.role_id, now);
      candidates.sort(compareDeliveryCandidates);
      due.push(...candidates.map((candidate) => toClaimed(channel, candidate.record)));
    }
    return due;
  }

  // ── 内部：单条记录的读 / 条件写 ──────────────────────────────────

  /**
   * claim 的入参：每次调用生成一个新的 fencing token（与文件、内存实现一致）。
   *
   * `claimNextDelivery` 拿同一份入参逐条尝试候选——token 相同不影响正确性，
   * 一次 claimNext 至多有一条真的被写进去；关键是下一次 claim 一定是新 token。
   */
  private claimInput(input: DeliveryClaimRequest) {
    return {
      owner: input.owner,
      claim_token: newClaimToken(),
      now: input.now ?? nowTimestamp(),
      lease_ms: input.lease_ms ?? this.policy.lease_ms,
      policy: this.policy,
    };
  }

  /**
   * 状态转移的唯一入口：读 → 纯规则算下一条 → **条件更新**。
   *
   * 条件里的 (status, updated_at, attempt_count, claim_owner, claim_token,
   * lease_expires_at) 合起来是这条记录的乐观锁令牌：自己在读之后没被别人改过才写得
   * 进去。写不进就是「这次什么都没做」——与文件实现抢不到锁、内存实现排在别人后面
   * 是同一件事。
   *
   * claim_token 必须在里面：它每次 claim 都变，于是「记录已经被别人接手」这件事在
   * 数据库这一层就能被判出来，而不是只在纯规则里判过一次、落库时又放行。
   */
  private async transition(
    table: ChannelTable,
    role_id: string,
    id: string,
    apply: (record: DeliveryRecord) => DeliveryRecord | undefined,
  ): Promise<ClaimedDelivery | undefined> {
    const current = await this.readRecord(table, role_id, id);
    if (!current) return undefined;
    const next = apply(current);
    if (!next) return undefined;
    const updated = await this.writeIfUnchanged(table, role_id, id, current, next);
    return updated ? toClaimed(table.channel, updated) : undefined;
  }

  /**
   * 条件 UPDATE：只有记录仍是读到的那个版本才写。
   *
   * `IS NOT DISTINCT FROM` 让可空列也能参与比较——`claim_owner` 从 NULL 变成某人是
   * 一次真实的版本变化，用普通 `=` 会把它当成「没变」而让 CAS 漏判。
   */
  private async writeIfUnchanged(
    table: ChannelTable,
    role_id: string,
    id: string,
    current: DeliveryRecord,
    next: DeliveryRecord,
  ): Promise<DeliveryRecord | undefined> {
    const result = await this.pool.query<{ payload: unknown }>(
      `UPDATE ${table.table} SET
         status = $1, attempt_count = $2, claimed_at = $3, claim_owner = $4,
         claim_token = $5, lease_expires_at = $6, next_retry_at = $7, updated_at = $8,
         payload = $9::jsonb
       WHERE ${table.idColumn} = $10 AND role_id = $11
         AND status = $12 AND updated_at = $13 AND attempt_count = $14
         AND claim_owner IS NOT DISTINCT FROM $15
         AND claim_token IS NOT DISTINCT FROM $16
         AND lease_expires_at IS NOT DISTINCT FROM $17
       RETURNING payload`,
      [
        next.status,
        next.attempt_count,
        next.claimed_at ?? null,
        next.claim_owner ?? null,
        next.claim_token ?? null,
        next.lease_expires_at ?? null,
        next.next_retry_at ?? null,
        next.updated_at,
        JSON.stringify(next),
        id,
        role_id,
        current.status,
        current.updated_at,
        current.attempt_count,
        current.claim_owner ?? null,
        current.claim_token ?? null,
        current.lease_expires_at ?? null,
      ],
    );
    return result.rows[0] ? parseRecord(table, result.rows[0].payload) : undefined;
  }

  /**
   * 只在记录缺席时插入一条（幂等提交）。
   *
   * `ON CONFLICT DO NOTHING` 不指名约束：主键与幂等键哪一个先撞上都按「已经有了」处理，
   * 回读时先按 id 找，找不到再按键找——两个键在正常路径上是同一个键的两种写法。
   */
  private async submitRecord(
    table: ChannelTable,
    record: DeliveryRecord,
    id: string,
  ): Promise<{ item: DeliveryRecord; created: boolean }> {
    await this.ensureSchema();
    const columns = table.columns(record);
    const columnNames = Object.keys(columns);
    const placeholders = [
      ...columnNames.map((_, index) => `$${String(index + 1)}`),
      `$${String(columnNames.length + 1)}::jsonb`,
    ];
    const result = await this.pool.query(
      `INSERT INTO ${table.table} (${columnNames.join(', ')}, payload)
       VALUES (${placeholders.join(', ')})
       ON CONFLICT DO NOTHING`,
      [...Object.values(columns), JSON.stringify(record)],
    );
    if (result.rowCount === 1) return { item: record, created: true };
    const byKey = columns[table.keyColumn];
    const existing =
      (await this.readRecord(table, record.role_id, id)) ??
      (byKey !== undefined && byKey !== null
        ? await this.readRecordByKey(table, record.role_id, byKey)
        : undefined);
    if (!existing) {
      throw new Error(
        `Delivery submit conflicted but the stored record could not be read back: ${id}`,
      );
    }
    return { item: existing, created: false };
  }

  private async readRecord(
    table: ChannelTable,
    role_id: string,
    id: string,
  ): Promise<DeliveryRecord | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM ${table.table} WHERE ${table.idColumn} = $1 AND role_id = $2`,
      [id, role_id],
    );
    return result.rows[0] ? parseRecord(table, result.rows[0].payload) : undefined;
  }

  private async readRecordByKey(
    table: ChannelTable,
    role_id: string,
    key: string,
  ): Promise<DeliveryRecord | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM ${table.table} WHERE ${table.keyColumn} = $1 AND role_id = $2`,
      [key, role_id],
    );
    return result.rows[0] ? parseRecord(table, result.rows[0].payload) : undefined;
  }

  private async listRecords(
    table: ChannelTable,
    filter: Record<string, string | undefined>,
  ): Promise<DeliveryRecord[]> {
    await this.ensureSchema();
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(filter)) {
      if (value === undefined) continue;
      params.push(value);
      clauses.push(`${column} = $${String(params.length)}`);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM ${table.table}${where} ORDER BY created_at, ${table.idColumn}`,
      params,
    );
    return parsedRows(table, result.rows);
  }

  /** 到期待投递的候选；排序交给共享的比较函数，这里的 ORDER BY 只是取数顺序的确定性 */
  private async scanDue(
    table: ChannelTable,
    role_id: string | undefined,
    now: string,
  ): Promise<Candidate[]> {
    await this.ensureSchema();
    const params: unknown[] = [now];
    let where = `status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1)`;
    if (role_id !== undefined) {
      params.push(role_id);
      where += ` AND role_id = $${String(params.length)}`;
    }
    const result = await this.pool.query<{ payload: unknown; role_id: string; id: string }>(
      `SELECT payload, role_id, ${table.idColumn} AS id FROM ${table.table}
       WHERE ${where}
       ORDER BY next_retry_at NULLS FIRST, updated_at, ${table.idColumn}`,
      params,
    );
    return toCandidates(table, result.rows);
  }

  /**
   * lease 已过期、或**根本没有 lease** 却停在 processing 的记录。
   *
   * 条件必须与 delivery-lifecycle 的 `isDeliveryClaimExpired` 逐字对应：无租约的
   * processing 算过期（更早版本留下的记录只能这样回收）。这里少写这一支，那些记录
   * 在数据库后端就永远捞不出来——纯规则判它过期、SQL 却把它滤掉，两边就漂了。
   */
  private async scanExpired(
    table: ChannelTable,
    role_id: string | undefined,
    now: string,
  ): Promise<Candidate[]> {
    await this.ensureSchema();
    const params: unknown[] = [now];
    let where = `status = 'processing'
      AND (lease_expires_at IS NULL OR lease_expires_at <= $1)`;
    if (role_id !== undefined) {
      params.push(role_id);
      where += ` AND role_id = $${String(params.length)}`;
    }
    const result = await this.pool.query<{ payload: unknown; role_id: string; id: string }>(
      `SELECT payload, role_id, ${table.idColumn} AS id FROM ${table.table}
       WHERE ${where}
       ORDER BY lease_expires_at, ${table.idColumn}`,
      params,
    );
    return toCandidates(table, result.rows);
  }

  /**
   * 懒建表：成功才留下缓存。
   *
   * 直接把 `ensurePgMaintenanceSchema()` 的 promise 存进 `schemaReady` 是错的——首次
   * 建表因数据库暂时不可用而失败时，被缓存的是一个 rejected promise，之后每一次调用
   * 都会拿到同一个失败结果，这个适配器就**永久**不可用了（连重试的机会都没有）。
   * 因此失败时清掉缓存，让下一次调用重新走一遍初始化。
   *
   * 并发行为：`schemaReady` 只在「此刻没有在途初始化」时才被赋值，所以任何时刻至多
   * 有一份在途 promise，并发的首次调用共用它、DDL 只真的执行一次。失败路径同理——能
   * 走到「重新初始化」这一步的前提是缓存已经被清空，而清空只发生在这次失败的处理里，
   * 因此不存在「旧失败的清理动作抹掉新一次成功结果」的交错。
   *
   * 原始错误照旧抛出：调用方要看见的是「连接不上」而不是「schema 没准备好」。
   */
  private async ensureSchema(): Promise<void> {
    if (!this.autoMigrate) return;
    if (!this.schemaReady) {
      this.schemaReady = ensurePgMaintenanceSchema(this.pool).catch((error: unknown) => {
        this.schemaReady = undefined;
        throw error;
      });
    }
    await this.schemaReady;
  }

  // ── 内部：通道形状 ──────────────────────────────────────────────

  private tableOf(channel: DeliveryChannel): ChannelTable {
    return channel === 'feedback' ? this.feedbackTable() : this.contextTable();
  }

  private contextTable(): ChannelTable {
    return {
      channel: 'context',
      table: CONTEXT_DELIVERY_TABLE,
      idColumn: 'delivery_id',
      keyColumn: 'delivery_key',
      parse: (value) => ContextDeliveryItemSchema.parse(value),
      // 这张表只装上下文交付项；列映射按契约声明的形状读，不做第二套解释
      columns: (record) => {
        const item = record as ContextDeliveryItem;
        return {
          delivery_id: item.delivery_id,
          delivery_key: item.delivery_key,
          role_id: item.role_id,
          task_id: item.task_id,
          status: item.status,
          attempt_count: String(item.attempt_count),
          claimed_at: item.claimed_at ?? null,
          claim_owner: item.claim_owner ?? null,
          claim_token: item.claim_token ?? null,
          lease_expires_at: item.lease_expires_at ?? null,
          next_retry_at: item.next_retry_at ?? null,
          created_at: item.created_at,
          updated_at: item.updated_at,
        };
      },
    };
  }

  private feedbackTable(): ChannelTable {
    return {
      channel: 'feedback',
      table: DRIVER_FEEDBACK_TABLE,
      idColumn: 'feedback_id',
      keyColumn: 'feedback_key',
      parse: (value) => DriverFeedbackRecordSchema.parse(value),
      columns: (record) => {
        const feedback = record as DriverFeedbackRecord;
        return {
          feedback_id: feedback.feedback_id,
          feedback_key: feedback.feedback_key,
          role_id: feedback.role_id,
          task_id: feedback.task_id,
          experience_id: feedback.experience_id,
          feedback_source: feedback.feedback_source,
          status: feedback.status,
          attempt_count: String(feedback.attempt_count),
          claimed_at: feedback.claimed_at ?? null,
          claim_owner: feedback.claim_owner ?? null,
          claim_token: feedback.claim_token ?? null,
          lease_expires_at: feedback.lease_expires_at ?? null,
          next_retry_at: feedback.next_retry_at ?? null,
          created_at: feedback.created_at,
          updated_at: feedback.updated_at,
        };
      },
    };
  }
}

/** delivery-lifecycle 的记录形状 + role 归属，两条通道的载荷都满足 */
type StoredRecord = DeliveryLifecycleRecord & { role_id: string };

/** 编译期自证：两张表的载荷都能当作 StoredRecord 参与转移规则 */
export type AssertDeliveryRecordsAreStored = [
  ContextDeliveryItem extends StoredRecord ? true : never,
  DriverFeedbackRecord extends StoredRecord ? true : never,
];

function channelsOf(channel: DeliveryChannel | undefined): DeliveryChannel[] {
  if (channel !== undefined) return [channel];
  return ['context', 'feedback'];
}

function toClaimed(channel: DeliveryChannel, item: DeliveryRecord): ClaimedDelivery {
  return channel === 'feedback'
    ? { channel: 'feedback', item: item as DriverFeedbackRecord }
    : { channel: 'context', item: item as ContextDeliveryItem };
}

function toCandidates(
  table: ChannelTable,
  rows: Array<{ payload: unknown; role_id: string; id: string }>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const record = parseRecord(table, row.payload);
    // 读不出来的记录被跳过：一条损坏的交付项不该让整次 claim 失败
    if (record) candidates.push({ role_id: row.role_id, id: row.id, record });
  }
  return candidates;
}

function parsedRows(table: ChannelTable, rows: Array<{ payload: unknown }>): DeliveryRecord[] {
  const records: DeliveryRecord[] = [];
  for (const row of rows) {
    const record = parseRecord(table, row.payload);
    if (record) records.push(record);
  }
  return records;
}

/** jsonb 列经 pg / PGlite 回来已是对象；字符串形态（某些驱动配置）也一并接住 */
function parsePayload(payload: unknown): unknown {
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

function parseRecord(table: ChannelTable, payload: unknown): DeliveryRecord | undefined {
  try {
    return table.parse(parsePayload(payload));
  } catch {
    return undefined;
  }
}
