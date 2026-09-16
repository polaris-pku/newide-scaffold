/**
 * backend — 每个角色一个后端 RPC 进程
 *
 * `NEWIDE_PRIMARY_AGENT_ID` 是**进程级**环境变量（`backend-rpc-stdio.ts`），不是
 * 请求参数，所以角色隔离要求一角色一进程。配合 `NEWIDE_AUCTION_ENABLED=0`，
 * `select_agent` 单候选短路，任务必然落到该角色自己身上。
 *
 * 后端查询侧钉死 1024 维真实嵌入（与语料资产同模型同维度），并复用种子那一步写下的
 * 同一份 PGlite 数据目录——维度一致，不会触发 `migrateVectorColumnDimensions` 的
 * 破坏性 DROP/ADD。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DRIVER_ENV_FILE_ENV,
  DRIVER_RUNNER_DIR_ENV,
  PGLITE_DIR_ENV,
  type ExperimentConfig,
} from './config';
import { EXPECTED_DIMENSIONS } from './seed';

export interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

export interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  waitForTerminal(
    runId: string,
    timeoutMs: number,
    budget?: ContextBudget,
  ): Promise<Record<string, unknown>>;
  /**
   * 该 run 的 driver 会话 id（驱动轨迹里出现过的）。
   *
   * 必须在 run 跑完之后取：真实计费要从 driver 的 Claude 会话文件里读，而那些文件是
   * 按 sessionId 命名的——拿不到 id 就无法把开销归到这一格。
   */
  driverSessionIds(budget: ContextBudget, runId: string): string[];
  close(): Promise<void>;
}

export interface BackendOptions {
  config: ExperimentConfig;
  roleId: string;
  stateRoot: string;
  /** run.getSnapshot 轮询间隔 */
  pollMs?: number;
}

/** 从 scaffold 根的 .env / .env.local 与环境拼出后端进程 env */
export function buildBackendEnv(config: ExperimentConfig, roleId: string, stateRoot: string) {
  return {
    ...loadEnv(path.join(config.scaffold_root, '.env')),
    ...loadEnv(path.join(config.scaffold_root, '.env.local')),
    ...process.env,
    [DRIVER_RUNNER_DIR_ENV]: config.driver_runner_dir,
    [DRIVER_ENV_FILE_ENV]: config.driver_env_file,
    ACP_DRIVER_TIMEOUT_MS: String(7 * 24 * 60 * 60 * 1000),
    [PGLITE_DIR_ENV]: config.pglite_dir,
    NEWIDE_B_EMBEDDING_PROVIDER: 'litellm',
    NEWIDE_B_EMBEDDING_DIMENSIONS: String(EXPECTED_DIMENSIONS),
    EMBEDDING_DIMENSIONS: String(EXPECTED_DIMENSIONS),
    NEWIDE_STATE_ROOT: stateRoot,
    NEWIDE_COORDINATION_DB: path.join(stateRoot, 'coordination.sqlite'),
    NEWIDE_AUCTION_ENABLED: '0',
    NEWIDE_PRIMARY_AGENT_ID: roleId,
    NEWIDE_DEFAULT_RUN_MODE: 'single_agent',
    // 记忆卫生：关掉运行后经验提取 + 启动时待处理重放，使角色记忆在整轮实验里保持与
    // 种子一致；关掉市场自学习，避免角色被引入技能。见 eval/role-divergence/README.md。
    NEWIDE_B_DISABLE_EXTRACTION: '1',
    NEWIDE_B_AUTO_LEARN: '0',
    // 注入路径隔离：关掉 facade 的任务级预检索，使 driver 只拿到顶层 Agent 经
    // query_memory 自查并显式传入的技能/经验。这是本实验的操纵变量所在——「角色
    // 自己去查什么」而不是「拿任务原文预先查好塞进去」。同时它让超长问题陈述不再
    // 进嵌入（预检索才是被 8192 token 窗口打挂的那条路）。
    NEWIDE_B_DISABLE_PRE_RETRIEVAL: '1',
    // 顶层 Agent 的 tool-calling 观测：每次 query_memory / invoke_driver 追加一行。
    // 没有它，注入为空时只能猜「Agent 没去查」还是「查了没命中」。
    NEWIDE_B_AGENT_TRACE_DIR: path.join(stateRoot, 'b', 'agent-traces'),
    // 顶层 Agent 的工具调用输出上限。默认 2000 token，实测会让 Agent 内联的技能文本
    // 在字符串中间被截断 → "Unterminated string in JSON" → invoke_driver 直接失败，
    // 每个格白烧 4 次 driver 调用。见 eval/role-divergence/README.md。
    NEWIDE_AGENT_LLM_MAX_TOKENS: '16000',
    AUTO_APPROVE: '1',
  };
}

export async function startBackend(options: BackendOptions): Promise<BackendClient> {
  const { config, roleId, stateRoot } = options;
  const pollMs = options.pollMs ?? 1_000;
  await fs.mkdir(stateRoot, { recursive: true });

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'], {
    cwd: config.scaffold_root,
    env: buildBackendEnv(config, roleId, stateRoot),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.pipe(createWriteStream(path.join(stateRoot, 'backend.stderr.log'), { flags: 'a' }));

  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const waiters = new Map<number, (message: JsonRpcMessage) => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      if (typeof message.id !== 'number') return;
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    } catch {
      // stdout 只承载 JSON-RPC；畸形行由后端 stderr 留存
    }
  });

  let nextId = 1;
  // 增量读上下文用量：见 createContextUsageReader 的注释（每秒轮询，不能整份重读）
  const readContextUsed = createContextUsageReader();
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      waiters.set(id, resolve);
      setTimeout(() => {
        if (!waiters.delete(id)) return;
        reject(new Error(`RPC ${method} timed out`));
      }, 60_000).unref();
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await response;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result as T;
  };

  await request('system.ping', {});

  return {
    request,
    waitForTerminal: async (runId: string, timeoutMs: number, budget?: ContextBudget) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        if (snapshot.status !== 'running') return snapshot;

        // 硬成本闸门：driver 每轮重发整个上下文，所以「峰值上下文」是花费的主因。
        // 光靠 prompt 里的预算条款不够——实测 agent 会照读不误（121 次调用、0 产出），
        // 所以这里由 harness 自己把关：超限就取消该格，不再继续烧。
        if (budget) {
          const used = await readContextUsed(budget, runId);
          if (used !== undefined && used > budget.max_context_tokens) {
            await request('run.cancel', { run_id: runId }).catch(() => undefined);
            throw new Error(
              `cell exceeded the context budget: driver reached ${String(used)} context tokens ` +
                `(limit ${String(budget.max_context_tokens)}). Cancelled to stop the cost. ` +
                'See --max-context-tokens.',
            );
          }
        }

        // 账单闸门：driver 自报的累计花费。和上下文闸互补——上下文闸拦不住
        // 「缓存没命中所以同样的上下文贵十倍」，那种情况下 used 涨得并不快，账单涨得快。
        // `costOf` 只读内存状态，增量解析在上面那行里已经做过，必须排在它后面。
        if (budget?.max_cost_usd !== undefined) {
          const spent = readContextUsed.costOf(budget, runId);
          if (spent !== undefined && spent > budget.max_cost_usd) {
            await request('run.cancel', { run_id: runId }).catch(() => undefined);
            throw new Error(
              `cell exceeded the cost budget: driver reported $${spent.toFixed(4)} ` +
                `(limit $${budget.max_cost_usd.toFixed(2)}). Cancelled to stop the spend. ` +
                'See --max-cell-cost-usd.',
            );
          }
        }

        await sleep(pollMs);
      }
      await request('run.cancel', { run_id: runId }).catch(() => undefined);
      throw new Error(`Run ${runId} exceeded budget ${String(timeoutMs)}ms`);
    },
    driverSessionIds: (budget, runId) => readContextUsed.sessionIds(budget, runId),
    close: async () => {
      child.stdin?.end();
      const result = await Promise.race([closed, sleep(5_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') child.kill('SIGTERM');
    },
  };
}

/** 上下文预算：上限 + 去哪里找驱动轨迹 */
export interface ContextBudget {
  stateRoot: string;
  roleKey: string;
  max_context_tokens: number;
  /**
   * 单格实时花费上限（USD，driver 自报）。缺省 = 不设这道闸。
   *
   * 与 `max_context_tokens` 是两回事：那个管峰值上下文，这个管**账单**，且它同时覆盖
   * 「轮数多」「缓存没命中」两种烧法——缓存失效时同样的上下文要多付约十倍。
   */
  max_cost_usd?: number;
}

/**
 * 增量读该 run 的驱动轨迹，取最后一次 `usage_update.used`，并顺手记下出现过的 sessionId。
 *
 * `used` 是**累计上下文观测值**（不是每轮增量），所以只要最后一个读数。
 *
 * 增量是必要的：这个文件会长到几 MB，而 `waitForTerminal` 每秒轮询一次——
 * 整份重读既浪费 I/O，也会让"成本守卫"自己变成成本。这里记住读到哪，只解析新增部分，
 * 并把半行留在缓冲里等下一次。
 *
 * sessionId 是**归账的钥匙**：真实计费在 Claude Code 的会话文件里，而 project 目录下
 * 同一工作区可能躺着多份会话文件，只有这个 id 能确定哪一份属于本次 run。
 */
export interface ContextUsageReader {
  (budget: ContextBudget, runId: string): Promise<number | undefined>;
  /** 本次 run 轨迹里出现过的 sessionId（按首次出现顺序） */
  sessionIds(budget: ContextBudget, runId: string): string[];
  /**
   * 本次 run 的 driver 自报累计花费峰值（USD）。
   *
   * `cost.amount` 是 Claude Code 自己按会话累计的量，所以取峰值而不是求和——同一条
   * `usage_update` 会把当前的累计值重复报很多次，求和会把它放大成调用次数倍。
   * 取不到（轨迹还没有 cost 字段）返回 undefined，调用方按「不设闸」处理。
   */
  costOf(budget: ContextBudget, runId: string): number | undefined;
}

export function createContextUsageReader(): ContextUsageReader {
  const states = new Map<
    string,
    { offset: number; carry: string; used?: number; cost?: number; sessionIds: string[] }
  >();
  const read = async (budget: ContextBudget, runId: string): Promise<number | undefined> => {
    const key = `${budget.stateRoot}\u0000${runId}`;
    const state = states.get(key) ?? { offset: 0, carry: '', sessionIds: [] };
    states.set(key, state);

    const tracePath = path.join(budget.stateRoot, 'runs', runId, 'driver-stream.jsonl');
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(tracePath, 'r');
    } catch {
      return state.used;
    }
    try {
      const { size } = await handle.stat();
      if (size <= state.offset) return state.used;
      const length = size - state.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      state.offset = size;

      const text = state.carry + buffer.toString('utf8');
      const lines = text.split('\n');
      state.carry = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes('usage_update')) continue;
        try {
          const parsed = JSON.parse(line) as {
            event?: {
              event_type?: string;
              session_id?: unknown;
              payload?: {
                sessionId?: unknown;
                update?: { used?: unknown; cost?: { amount?: unknown } };
              };
            };
          };
          const event = parsed.event;
          if (event?.event_type !== 'usage_update') continue;
          const sessionId =
            typeof event.session_id === 'string'
              ? event.session_id
              : typeof event.payload?.sessionId === 'string'
                ? event.payload.sessionId
                : undefined;
          if (sessionId && !state.sessionIds.includes(sessionId)) state.sessionIds.push(sessionId);
          const used = event.payload?.update?.used;
          if (typeof used === 'number' && Number.isFinite(used) && used >= 0) state.used = used;
          // 累计花费：取峰值（见 costOf 的注释）。
          const amount = event.payload?.update?.cost?.amount;
          if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
            state.cost = Math.max(state.cost ?? 0, amount);
          }
        } catch {
          // 畸形行跳过；半行已由 carry 处理
        }
      }
    } finally {
      await handle.close();
    }
    return state.used;
  };

  const reader = read as ContextUsageReader;
  reader.sessionIds = (budget, runId) => {
    const state = states.get(`${budget.stateRoot}\u0000${runId}`);
    return state ? [...state.sessionIds] : [];
  };
  // 只读内存里已解析到的状态——增量解析发生在上面那次调用里，两者必须成对使用。
  reader.costOf = (budget, runId) => states.get(`${budget.stateRoot}\u0000${runId}`)?.cost;
  return reader;
}

/** 把一次 run 的落盘证据拷进单元目录 */
export async function copyRunEvidence(
  config: ExperimentConfig,
  roleKey: string,
  runId: string,
  cellRoot: string,
): Promise<void> {
  const source = path.join(config.result_root, 'backend', roleKey, 'runs', runId);
  for (const [from, to] of [
    ['driver-stream.jsonl', 'trajectory.jsonl'],
    ['audit.jsonl', 'audit.jsonl'],
    ['summary.json', 'run-summary.json'],
    ['frontend-snapshot.json', 'snapshot.json'],
    ['result.json', 'result.json'],
    ['timeline.json', 'timeline.json'],
  ] as const) {
    const input = path.join(source, from);
    if (existsSync(input)) await fs.copyFile(input, path.join(cellRoot, to));
  }

  // 顶层 Agent 的 tool call 不在 runs/<runId>/ 下——facade 按 state root 写，
  // 与 context pack 同族。单独取一次，让「Agent 到底查没查」跟着单元证据走。
  const trace = path.join(stateRootFor(config, roleKey), 'b', 'agent-traces', `${runId}.jsonl`);
  if (existsSync(trace)) await fs.copyFile(trace, path.join(cellRoot, 'agent-tools.jsonl'));
}

function stateRootFor(config: ExperimentConfig, roleKey: string): string {
  return path.join(config.result_root, 'backend', roleKey);
}

function loadEnv(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .flatMap((raw) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return [];
        const index = line.indexOf('=');
        if (index < 1) return [];
        const key = line.slice(0, index).trim();
        const value = line
          .slice(index + 1)
          .trim()
          .replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
        return [[key, value]];
      }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
