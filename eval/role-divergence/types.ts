/**
 * types — 角色分歧实验的单元标识与落盘证据形状
 *
 * 一个「单元」（cell）= (实验 × 实例 × 角色) 或其交叉形式（实验三再加被审 plan 作者）。
 * 证据记录把「用了什么档位 / 注入了哪些技能 / 产出什么 / 花了多少 token 与墙钟」
 * 收成一条记录，供后续分析与复算直接消费。
 */
import type { CorpusRole } from '../../src/memory';
import type { DriverTokenEvidence } from './driver-usage';

/** 当事角色键：语料五维度 + 白板用的中性 agent */
export type PartyKey = CorpusRole | 'neutral';

/** 中性（白板）agent 的运行时 role_id；不属语料五维度，单独种一个空记忆 agent */
export const NEUTRAL_AGENT_ID = 'role_neutral';

/**
 * 四个实验条件。对应文档的三轮实验：
 * - `plan_role`    实验一：角色各自从零出 plan
 * - `plan_neutral` 白板 plan（中性 agent 产出，实验二的被审对象）
 * - `review_neutral` 实验二：各角色评审同一份白板 plan
 * - `review_role`  实验三：各角色交叉评审实验一产出的角色 plan
 */
export const EXPERIMENTS = ['plan_role', 'plan_neutral', 'review_neutral', 'review_role'] as const;
export type ExperimentId = (typeof EXPERIMENTS)[number];

/** 评审裁决词表，与 council `Review.verdict` 保持一致（`src/council/contract.ts`） */
export const REVIEW_VERDICTS = ['approve', 'needs_revision', 'reject'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export interface CellKey {
  experiment: ExperimentId;
  instance_id: string;
  /** 当事角色：生成类是作者，评审类是审者 */
  role_key: PartyKey;
  /** 仅 `review_role`：被审 plan 的作者 */
  author_key?: CorpusRole;
}

/** 稳定单元 id，用作落盘文件名与缓存键 */
export function cellId(key: CellKey): string {
  return key.author_key === undefined
    ? `${key.experiment}__${key.instance_id}__${key.role_key}`
    : `${key.experiment}__${key.instance_id}__${key.role_key}__by_${key.author_key}`;
}

/** 检索策略快照——记录并断言生产默认值，防止实验期间默认值漂移导致控制失效 */
export interface ExpectedRetrievalPolicy {
  recall_top_k: number;
  min_embedding_similarity: number;
  min_confidence: number;
  max_memory_items: number;
  min_tag_overlap: number;
}

export interface InjectedSkillEntry {
  id: string;
  /** 由 id 反查语料 slug（uuid v5）得到；查不到为 null */
  slug: string | null;
  description: string;
  content_chars: number;
  est_tokens: number;
}

/**
 * 注入证据——「隔离真的发生」的机器凭据。
 *
 * 注入集合由**顶层 agent 自己决定**（它按需调 `query_memory`，结果经 facade 合并后
 * 交给 driver），所以它只存在于运行产物里、不存在于任何跑前计算里。本记录因此是
 * **跑后**从该格的 context pack（`driver_invocation_context.skills`）读出来的。
 *
 * 与生产 facade 的 `toDriverMemoryItems` 同口径（`{id, description, content}` 全文、
 * 无长度截断），因此 `total_est_tokens` 就是该角色这次真实注入的技能正文体量。
 * **`skill_count === 0` 意味着操纵变量没进这一格，该格应判无效。**
 */
export interface InjectionEvidence {
  cell_id: string;
  role_key: PartyKey;
  role_id: string;
  instance_id: string;
  run_id: string;
  /** 当时生效的生产检索默认值（记录用；本模块不再据此复算注入） */
  policy: ExpectedRetrievalPolicy;
  skill_count: number;
  experience_count: number;
  total_content_chars: number;
  total_est_tokens: number;
  skills: InjectedSkillEntry[];
}

/**
 * 顶层 Agent 的工具调用摘要（跑后从 `agent-tools.jsonl` 汇总）。
 *
 * 存在的理由只有一个：注入为空时立刻区分「Agent 压根没查」与「查了没命中」——
 * 前者 `query_memory === 0`，后者为 N 而 `query_memory_skill_counts` 全 0。
 * 没有它，这两种成因在证据里长得一模一样。
 */
export interface AgentToolSummary {
  total: number;
  query_memory: number;
  invoke_driver: number;
  /** `query_memory` 每次返回的技能条数，按发生顺序 */
  query_memory_skill_counts: number[];
}

/**
 * driver（Claude Code）自己的工具调用摘要，来自 `<cell>/trajectory.jsonl`。
 *
 * 与 `AgentToolSummary` 是两层东西：那一层是**顶层 Agent** 的 `query_memory`/`invoke_driver`，
 * 这一层是 **driver 在代码树里做了什么**。有仓库形态下 `repo_reads` 就是关键读数——
 * 它是 0，说明 plan 依然是凭题目文本猜的，哪怕仓库挂在那儿。
 */
export interface DriverToolSummary {
  /** 所有工具调用次数（含失败） */
  total: number;
  /** 按工具名分组的调用次数 */
  by_tool: Record<string, number>;
  /** 真正的读代码次数：Read/Glob/Grep */
  repo_reads: number;
  /** 其中成功的次数 */
  repo_reads_ok: number;
  /** 被拒/失败的工具调用总数（deny 列表生效的读数） */
  failed: number;
  /** 写出产出文件的次数 */
  writes: number;
  /** 走过的对话事件总数（thought + message），表征推理量 */
  stream_events: number;
}

export interface CellEvidence {
  status: 'completed' | 'failed';
  cell_id: string;
  experiment: ExperimentId;
  instance_id: string;
  role_key: PartyKey;
  role_id: string;
  /** 被审 plan 的作者（仅 review_role），仅存证据、不进 prompt */
  author_key?: CorpusRole;
  memory_ablation: string;
  model_label: string;
  prompt_path: string;
  prompt_sha256: string;
  workspace_path: string;
  /** 产出文件（生成类 plan.md / 评审类 review.md） */
  output_path: string;
  output_sha256?: string;
  /** 评审类：从产出的首行 `VERDICT:` 宽容提取；提不到则 parse_failed */
  review_verdict?: ReviewVerdict;
  review_parse_failed?: boolean;
  run_id?: string;
  task_id?: string;
  terminal_status?: string;
  wall_ms: number;
  token_usage?: unknown;
  driver_usage?: unknown;
  /** 顶层 Agent 的工具调用摘要（`agent-tools.jsonl` 缺席时为缺省） */
  agent_tools?: AgentToolSummary;
  /** driver 自己的工具调用摘要（`trajectory.jsonl` 缺席时为缺省） */
  driver_tools?: DriverToolSummary;
  /**
   * driver 的**真实计费台账**（每次推理的输入/输出/缓存读写 + 加权花费）。
   *
   * 与 `driver_usage` 不是一回事：那个来自驱动轨迹的 `usage_update`，只有上下文占用；
   * 这个来自 driver 自己的会话文件，才有缓存命中读数。见 `driver-usage.ts`。
   */
  driver_tokens?: DriverTokenEvidence;
  /** 取计费台账失败的原因。与 `driver_tokens` 缺省区分开：缺省不等于零花费。 */
  driver_tokens_error?: string;
  /** 该格 driver 流式轨迹的落盘路径（`cells/<cell>/trajectory.jsonl`） */
  trajectory_path?: string;
  /**
   * 白板对照（`role_neutral`）的零注入标记：该 agent 名下按定义没有技能，注入为空即
   * 控制条件成立，不是失败。角色格的零注入仍然走 `error` + `status: 'failed'`。
   */
  control_zero_injection?: boolean;
  /**
   * 本格所属的实验形态。两种形态的 prompt 字节不同，混进同一个结果根会让跨格比较失真，
   * 所以写进证据并在批次开始时对齐检查。
   */
  run_form?: 'with-repo' | 'no-repo';
  /**
   * `--repo-checkout` 形态下 driver 实际读到的仓库来源。没有它就无法事后回答
   * 「这份 plan 是基于哪棵树写的」——尤其是副本是不是真的钉在 base_commit 上。
   */
  repo_provenance?: {
    mount: string;
    canonical_path: string;
    base_commit: string;
    head_commit: string;
    /** 本格工作区里仓库是链接（junction/symlink）还是复制 */
    mount_kind: 'link' | 'copy';
  };
  error?: string;
}
