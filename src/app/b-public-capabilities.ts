import {
  RepositoryAgentBoardQuery,
  reviewSkill,
  type AgentBoardQuery,
  type BufferRepository,
  type MemoryDeliveryRepository,
  type MemoryRepository,
  type ReviewSkillInput,
  type RoleTokenUsageReader,
} from '../memory';
import type { TokenUsageLedgerStore } from '../persistence';
import type {
  BMemoryMaintenanceEvidence,
  BMemoryMaintenancePort,
  BSkillPromotionRequest,
} from './b-memory-maintenance-runner';
import type { BackendBRuntime } from './production-b-runtime';

export type ReviewedSkill = Awaited<ReturnType<typeof reviewSkill>>;

export interface BMemoryMaintenanceCapabilities extends BMemoryMaintenancePort {
  listEvidence(roleId?: string): Promise<BMemoryMaintenanceEvidence[]>;
  promoteSkills(input: BSkillPromotionRequest): Promise<BMemoryMaintenanceEvidence>;
}

/**
 * 主线应用层消费 B 模块的唯一能力集合。
 *
 * B 的实现仍由 src/memory/index.ts 暴露；这里仅负责把生产 runtime、
 * Agent Board 查询和应用层维护操作组合为稳定依赖。
 */
export interface BPublicCapabilities {
  readonly repository: MemoryRepository;
  readonly bufferRepository: BufferRepository;
  /** 下游交付存储：上下文交付项与 Driver 反馈 outbox */
  readonly deliveryRepository: MemoryDeliveryRepository;
  readonly boardQuery: AgentBoardQuery;
  readonly maintenance: BMemoryMaintenanceCapabilities;
  reviewSkill(input: ReviewSkillInput): Promise<ReviewedSkill>;
}

export function createBPublicCapabilities(
  runtime: BackendBRuntime,
  maintenance: BMemoryMaintenanceCapabilities,
  /**
   * 角色累计用量（账本求和）。缺省时不叠加，Agent Board 只透出档案里那个字段。
   */
  roleTokenUsage?: RoleTokenUsageReader,
): BPublicCapabilities {
  return {
    repository: runtime.repository,
    bufferRepository: runtime.bufferRepository,
    deliveryRepository: runtime.deliveryRepository,
    boardQuery: new RepositoryAgentBoardQuery(runtime.repository, roleTokenUsage),
    maintenance,
    reviewSkill: (input) => reviewSkill(runtime.repository, input),
  };
}

/**
 * 用量账本 → `RoleTokenUsageReader` 的适配（装配点用）。
 *
 * 放这里而不是 `persistence` 或 `memory`：它是**跨层的接线**，而这一层本来就同时依赖
 * 两边（memory 的端口 + persistence 的账本），别的层都不该为了这一处多一条依赖。
 *
 * `now` 只用来填聚合结果里的 `as_of`（聚合本身不按时间过滤，`role` scope 的 `WHERE`
 * 就是 `role_id = ?`），所以给进程时钟即可。
 */
export function createLedgerRoleTokenUsage(
  ledger: TokenUsageLedgerStore,
  now: () => string = () => new Date().toISOString(),
): RoleTokenUsageReader {
  return {
    totalBilledTokens(roleId) {
      const aggregate = ledger.aggregateTokenUsage({ scope: 'role', scope_id: roleId }, now());
      // 判据是「账本里到底有没有这个角色的腿」，不是 `runs_counted`：后者会把「执行过但没进
      // 账本」的 run 也算进来，那种情况 `totals` 全是 0——按它判会把「取不到」报成「花了 0」。
      return Object.keys(aggregate.by_source).length === 0
        ? undefined
        : aggregate.totals.total_tokens;
    },
  };
}
