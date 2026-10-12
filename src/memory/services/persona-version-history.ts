/**
 * Persona 版本历史与回滚的纯规则（Phase 4 修复 B）
 *
 * 这个模块只做三件事，都是**两条后端腿必须逐字相同**的判断或构造，因此放在服务层、由
 * InMemoryRepository 与 PgMemoryRepository 一起调用，而不是各写一份：
 *
 * 1. **构造一行版本记录**（`personaVersionRecord`）：版本号从正文派生，缺席的字段不补默认值。
 * 2. **回滚该不该发生**（`resolvePersonaRollback`）：与演化的 `resolvePersonaEvolutionWrite`
 *    同一条判据——「你读到的当前版本还是当前版本吗」，只是条件写在 Persona 的版本号上。
 * 3. **回滚这一版的正文与摘要**（`buildRolledBackPersona` / `summarizePersonaRollback`）：
 *    正文抄自目标版本，版本号与生成时刻属于新的一版。
 *
 * 为什么回滚要**新起一个版本号**而不是把版本号改回目标版本：`PersonaDef.version` 是这条通道
 * 的乐观锁（演化写回的前置条件就是「父版本 == 当前版本」）。把版本号改小等于让这个锁倒退，
 * 一个拿着 v5 判定结果的 worker 会在「当前版本又变回 v3」之后重新认为自己是对的，于是把刚被
 * 回滚掉的那一版写回来。新版本号让这份判定立刻过期（`parent_conflict`），回滚才是真的回滚。
 * 历史同样按版本号单调追加，旧版本一行不少——「回滚」在这里是**再写一版**，不是**擦掉一版**。
 *
 * 回滚刻意**不碰演化标记**（见两个适配器的 `rollbackPersona`）：标记记的是「上一次演化判了
 * 什么」，而它的去重键是 `(role_id, input_snapshot_hash, strategy_version)`——输入没变的
 * 情况下，把标记作废会让下一次演化把刚回滚掉的版本原样写回来，那正是回滚要挡的事。
 */
import type {
  PersonaDef,
  PersonaVersionRecord,
  PersonaVersionSource,
} from '../schemas';

export interface PersonaVersionRecordInput {
  /** 这一版的完整正文；`role_id` 与 `persona_version` 都从它派生 */
  persona: PersonaDef;
  source: PersonaVersionSource;
  /** 这一版落下来的时刻 */
  created_at: string;
  parent_version?: number | undefined;
  source_run_id?: string | undefined;
  strategy_version?: string | undefined;
  input_snapshot_hash?: string | undefined;
  rollback_from_version?: number | undefined;
  change_summary?: string | undefined;
  reviewed_by?: string | undefined;
}

/**
 * 构造一行版本记录 —— **全仓唯一**把 `persona_version` 与 `persona.version` 摆在一起的地方。
 *
 * 版本号从正文派生而不是由调用方传：传进来的话就有两个来源，而它们迟早会分叉（Phase 3 的
 * `promoted_from` 列与载荷分裂过一次，代价是一次对账迁移）。数据库那一列也由这个值填入，
 * 因此「按列查出来的版本」与「载荷里的版本」不可能各说各话。
 *
 * 缺席的字段一律不写键（不是写 `undefined`、更不是写默认值）：`parent_version` 缺席读作
 * 「不知道它取代了谁」，写个 0 或 1 就成了编。
 */
export function personaVersionRecord(input: PersonaVersionRecordInput): PersonaVersionRecord {
  return {
    role_id: input.persona.role_id,
    persona_version: input.persona.version,
    // 深拷贝：记录一旦造出来就不再跟着调用方手里那一份走。内存后端不拷贝就等于把「历史」
    // 交给写入方日后可变的那份对象（Pg 那条腿因为过了序列化天然没有这个耦合），三条腿必须
    // 语义一致——这条与 Phase 4 修复 A 给 `MaintenanceRun.audit` 深拷贝是同一条理由。
    persona: structuredClone(input.persona),
    source: input.source,
    ...(input.parent_version !== undefined ? { parent_version: input.parent_version } : {}),
    ...(input.source_run_id !== undefined ? { source_run_id: input.source_run_id } : {}),
    ...(input.strategy_version !== undefined ? { strategy_version: input.strategy_version } : {}),
    ...(input.input_snapshot_hash !== undefined
      ? { input_snapshot_hash: input.input_snapshot_hash }
      : {}),
    ...(input.rollback_from_version !== undefined
      ? { rollback_from_version: input.rollback_from_version }
      : {}),
    ...(input.change_summary !== undefined ? { change_summary: input.change_summary } : {}),
    ...(input.reviewed_by !== undefined ? { reviewed_by: input.reviewed_by } : {}),
    created_at: input.created_at,
  };
}

/**
 * 种子版本那一行：`created_at` 取正文自己的 `generated_at`，而不是「登记它的那一刻」。
 *
 * 两者在 Agent 刚建出来时几乎相同，但语义只有一个是诚实的——这一版是什么时候生成的，正文
 * 自己带着这个答案；用调用方的时间就等于在历史里多写一个与正文无关的时刻。两条腿都走这里，
 * 因此「内存后端记了哪个时刻、Pg 后端记了另一个」不可能发生。
 */
export function seedPersonaVersionRecord(persona: PersonaDef): PersonaVersionRecord {
  return personaVersionRecord({
    persona,
    source: 'seed',
    created_at: persona.generated_at,
  });
}

/**
 * 演化写下的一版记录。两条腿共用同一份构造，因此「演化这一版在两边的历史里长得不一样」
 * 不可能发生——升个级只改一处。
 *
 * `change_summary` 与 `reviewed_by` 由调用方给（策略算出来的摘要、自动批准的批准者），
 * 其余四个溯源字段就是那一次判定的事实：父版本、run、策略版本、输入快照 hash。
 */
export function evolvedPersonaVersionRecord(input: {
  persona: PersonaDef;
  parent_version: number;
  source_run_id: string;
  strategy_version: string;
  input_snapshot_hash: string;
  change_summary?: string | undefined;
  reviewed_by?: string | undefined;
  now: string;
}): PersonaVersionRecord {
  return personaVersionRecord({
    persona: structuredClone(input.persona),
    source: 'evolution',
    created_at: input.now,
    parent_version: input.parent_version,
    source_run_id: input.source_run_id,
    strategy_version: input.strategy_version,
    input_snapshot_hash: input.input_snapshot_hash,
    ...(input.change_summary !== undefined ? { change_summary: input.change_summary } : {}),
    ...(input.reviewed_by !== undefined ? { reviewed_by: input.reviewed_by } : {}),
  });
}

/**
 * 手动写入（`savePersona`）那一行。
 *
 * 这条路径是**无条件覆盖**（既有语义，本阶段不动它），因此 `parent_version` 记的是「写之前
 * 读到的那一版」，而且只在它**严格小于**写下的版本号时才记：
 *
 * - 写下的版本比当前大：这是一次推进，父版本就是它取代的那一版，如实记下。
 * - 同号重写（版本没动、只换了正文）：推不出一个诚实的父版本——「取代了自己」不是一种来历。
 * - 版本号反而变小（并发读改写踩到了别的写入）：同样推不出来，而且这一版的来历已经不可考。
 *
 * 后两种情形下宁可不写这个键：缺席读作「不知道」，编一个值则会在审计里变成一个看起来确凿的
 * 错误事实。
 */
export function manualPersonaVersionRecord(input: {
  persona: PersonaDef;
  /** 写之前读到的当前版本；读不到（还没有当前版本）时为 undefined */
  previous_version?: number | undefined;
  now: string;
}): PersonaVersionRecord {
  const predecessor =
    input.previous_version !== undefined && input.previous_version < input.persona.version
      ? input.previous_version
      : undefined;
  return personaVersionRecord({
    persona: structuredClone(input.persona),
    source: 'manual',
    created_at: input.now,
    ...(predecessor !== undefined ? { parent_version: predecessor } : {}),
  });
}

// ═══════════════════════════════════════════
//  回滚
// ═══════════════════════════════════════════

/** 一次回滚该不该发生：`apply` 时连带给出新版本号（当前版本 +1）与正文来源 */
export type PersonaRollbackResolution =
  | { kind: 'apply'; parent_version: number; next_version: number; target_version: number }
  | { kind: 'conflict'; expected_version: number; current_version: number };

/**
 * 判定「这次回滚还能不能落下去」。
 *
 * 唯一的条件是**你读到的当前版本仍然是当前版本**——与演化写回的前置条件同一个东西，只是
 * 这里的名字更直白：回滚是「以某一版为准」，而「当前是第几版」就是那个「准」的依据。
 * 不成立时返回 `conflict`：并发回滚只可能有一个赢，另一个必须**明确地**知道自己输了
 * （而不是悄悄再写一版，把赢家刚回滚出来的那一版覆盖掉）。
 *
 * 目标版本存不存在**不在这里判**：那是查表而不是比较，由适配器在读到那一行之后回答
 * （返回 `target_missing`），顺序上排在版本条件之前——请求本身就不可满足时，先说这件事。
 */
export function resolvePersonaRollback(input: {
  /** 调用方读到的当前版本 —— 条件写的前置条件 */
  expected_current_version: number;
  /** 写下去那一刻读到的当前版本 */
  current_version: number;
  /** 正文抄自哪一版 */
  target_version: number;
}): PersonaRollbackResolution {
  if (input.current_version !== input.expected_current_version) {
    return {
      kind: 'conflict',
      expected_version: input.expected_current_version,
      current_version: input.current_version,
    };
  }
  return {
    kind: 'apply',
    parent_version: input.current_version,
    next_version: input.current_version + 1,
    target_version: input.target_version,
  };
}

/**
 * 由目标版本构造回滚后的新一版 Persona。
 *
 * **逐字段列出内容**而不是展开目标那一份：`version` 与 `generated_at` 属于新的一版（前者是
 * 单调的版本号，后者是这一版的生成时刻），而正文五个字段原样抄过来。写成展开会让将来给
 * `PersonaDef` 加字段时**默认继承旧值**——那是一个没人会注意到的静默决定，列出来则会变成
 * 一次编译错误，逼人在那个字段上做一次选择。
 */
export function buildRolledBackPersona(input: {
  role_id: string;
  /** 正文来源 */
  target: PersonaDef;
  /** 新的一版号（当前版本 +1） */
  next_version: number;
  now: string;
}): PersonaDef {
  return {
    role_id: input.role_id,
    version: input.next_version,
    summary: input.target.summary,
    skills_overview: input.target.skills_overview,
    experience_coverage: input.target.experience_coverage,
    recent_performance: input.target.recent_performance,
    notes: input.target.notes,
    generated_at: input.now,
  };
}

/** 回滚的变更摘要（人读）：从哪一版回滚到哪一版、正文抄自哪一版、为什么 */
export function summarizePersonaRollback(input: {
  parent_version: number;
  next_version: number;
  target_version: number;
  reason?: string | undefined;
}): string {
  const base =
    `Persona v${String(input.parent_version)} → v${String(input.next_version)} `
    + `rolled back to v${String(input.target_version)}.`;
  return input.reason === undefined ? base : `${base} Reason: ${input.reason}`;
}

/**
 * 回滚写下的那一行记录。两条腿共用，因此「内存后端记了 `rollback_from_version`、Pg 后端
 * 漏了」这种差异不可能出现——这种缺口不会被任何单腿测试发现，只会让人在生产上读不到本
 * 以为有的字段（与 `personaEvolutionSettlement` 同一条理由）。
 */
export function personaRollbackRecord(input: {
  role_id: string;
  /** 回滚后的新版正文（由 `buildRolledBackPersona` 造出来） */
  persona: PersonaDef;
  parent_version: number;
  target_version: number;
  reason?: string | undefined;
  reviewed_by?: string | undefined;
  now: string;
}): PersonaVersionRecord {
  return personaVersionRecord({
    persona: structuredClone(input.persona),
    source: 'rollback',
    created_at: input.now,
    parent_version: input.parent_version,
    rollback_from_version: input.target_version,
    change_summary: summarizePersonaRollback({
      parent_version: input.parent_version,
      next_version: input.persona.version,
      target_version: input.target_version,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }),
    ...(input.reviewed_by !== undefined ? { reviewed_by: input.reviewed_by } : {}),
  });
}

/**
 * 截取最近的 `limit` 条（输入必须已按版本号升序）。
 *
 * 与 `applyMaintenanceRunLimit` 同一套约定与同一条理由：过滤与排序交给 SQL（那是索引的用处），
 * 只把「最近 N 条」这一步拿回来共享，免得两个适配器对 `limit` 有各自的解释——一个当「最早的
 * N 条」、一个当「最新的 N 条」，在只跑一条腿的测试里永远看不出来。返回仍然是升序：截的是
 * 尾巴，不是把顺序倒过来。
 */
export function applyPersonaVersionLimit(
  records: PersonaVersionRecord[],
  limit: number | undefined,
): PersonaVersionRecord[] {
  if (limit === undefined) return records;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Persona version query limit must be a non-negative integer.');
  }
  return records.slice(Math.max(0, records.length - limit));
}
