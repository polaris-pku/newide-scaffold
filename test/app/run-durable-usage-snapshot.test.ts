/**
 * 「已收尾 run 的用量活过进程重启」这一条链路的服务级验证。
 *
 * 这是本轮补上的覆盖缺口：`usage` 块此前**只在存活期内存里**——`proxy.llm_usage_recorded`
 * 不落 `coordination.sqlite`（它走 telemetry 通道），所以一个跑的进程死掉之后，
 * `run.getSnapshot(runId).usage` 整个消失，哪怕用量账本里这个 run 的行一直在。
 *
 * 模拟重启的做法不是「mock 一个空 registry」，而是**真的造第二个服务**：同一个
 * `coordination.sqlite` + 同一个 `TaskProcessor`，只换一个干净的 `InMemoryRunRegistry`。
 * 那正是重启之后生产进程的样子（持久层还在，内存全没了）。
 *
 * 四条断言守四件不同的事：
 * 1. 重启后 `usage.billed` 仍在，且与重启前**逐字段相同**——同一个 run 的数字不许随后端
 *    重启而变；
 * 2. 在飞状态（`activity`）**仍然缺席**——那是真的只属于持有它的进程，不该假装持久；
 * 3. 账本为空时 `usage` 缺席而不是全 0——**缺 ≠ 0**；
 * 4. 用量只存在于 run 目录、账本里还没有行的 run（账本上线之前的**全部**历史）也必须报得
 *    出来，而且答案不取决于「有没有人先读过一次历史」。
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NoopDriverStreamAuditWriter } from '../../src/app/driver-stream-audit-writer';
import {
  LedgerRunUsageHistoryReader,
  type RunUsageHistoryReader,
} from '../../src/app/run-usage-history';
import {
  TaskExecutionLoop,
  TaskProcessor,
  type TaskExecutionLoopExecutors,
} from '../../src/coordination';
import { FileRunEvidenceStore, SqliteCoordinationStore } from '../../src/persistence';
import { runSnapshotSchema } from '../../src/protocol/run-snapshot';
import {
  FileRunEventConsumptionSink,
  FileRunTelemetryJsonlSink,
  emptyTokenUsageSummary,
  recordProxyLlmUsage,
  resetAgentActivities,
} from '../../src/telemetry';

const ROLE = 'role_backend_engineer';

async function waitFor(predicate: () => boolean, label: string, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition was never met: ${label}`);
}

/**
 * 等到「终态已定」**且**「终态产物已落盘」。
 *
 * 只等持久状态变成 `completed` 是不够的：那个状态由游标推进写在 `runAuthorityLoop` 的
 * **前半段**（`advanceStage`），而终态产物与账本行是后半段 `finalize` 的事。等前者会稳定地
 * 抢在 `finalize` 之前——这个竞态在本文件里骗过一次（让「账本为空」看起来像产品缺陷），而
 * 对本轮的**目录兜底**同样致命：summary 还没写，兜底当然读不到，于是「用量缺席」的断言会
 * 因为空转而变绿。
 */
async function waitForTerminalRun(
  runsRoot: string,
  runId: string,
  isTerminal: () => boolean,
): Promise<void> {
  await waitFor(
    () => isTerminal() && existsSync(path.join(runsRoot, runId, 'summary.json')),
    'run terminal with its artifacts on disk',
  );
}

/**
 * 这个 run 在账本里是不是已经有腿了。
 *
 * 用持久层直接问（而不是用被测的那个读者），免得把断言做成循环论证。
 */
function ledgerHasRows(store: SqliteCoordinationStore, runId: string): boolean {
  const aggregate = store.aggregateTokenUsage({ scope: 'run', scope_id: runId }, 'T');
  return Object.keys(aggregate.by_source).length > 0;
}

/**
 * 一条单 agent 的 stage 装配：三个用例共用。
 *
 * 抽出来是因为它们之间唯一的差别就是「`execute_agent` 里要不要记一笔 LLM 用量」——把整组
 * executor 抄三遍会让真正的变量埋没在噪声里。
 */
function singleAgentExecutors(onExecuteAgent?: () => Promise<void>): TaskExecutionLoopExecutors {
  return {
    select_agent: {
      execute: async () => ({ winner_agent_id: ROLE, evidence: { winner_agent_id: ROLE } }),
    },
    execute_agent: {
      execute: async () => {
        await onExecuteAgent?.();
        return {
          changeset_ref: 'artifact_primary_changeset',
          expected_sha256: 'd'.repeat(64),
          agent_id: ROLE,
          session_id: 'session_primary',
          evidence: { response: 'done' },
        };
      },
    },
    council: {
      execute: async () => {
        throw new Error('single_agent run must not reach the Council stage');
      },
    },
    gate: { execute: async () => ({ evidence: { status: 'skipped' } }) },
    deliver: {
      execute: async (context) => ({
        final_output: {
          artifact_ref: context.cursor_input.changeset_ref,
          sha256: context.cursor_input.expected_sha256,
          workspace_path: '/workspace/result.ts',
        },
        evidence: { files_written: ['result.ts'] },
      }),
    },
  };
}

/**
 * 按生产的参数顺序装配一个服务。
 *
 * 两个注入点与本轮直接相关，缺一条这条链路就断了：
 * - `FileRunTerminalOutputWriter` 的第 5 个参数是**用量账本**（run 收尾时写入）；
 * - 最后一个参数是**用量读取口**（`getRunSnapshot` 从这里补已收尾 run 的 `usage`）。
 * 后者用 `reader` 而不是固定构造，正是为了能注入一个**空账本**做反向对照。
 */
function buildService(input: {
  runsRoot: string;
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
  loop: TaskExecutionLoop;
  registry: InMemoryRunRegistry;
  reader: RunUsageHistoryReader;
}): NewideBackendService {
  return new NewideBackendService(
    undefined,
    input.registry,
    new FileRunAuditWriter(input.runsRoot),
    // 第 3 个参数（Claude session 刮取）显式替换成空摘要：否则测试会去读真实的
    // `~/.claude`，结果取决于跑测试的机器上装了什么。
    new FileRunTerminalOutputWriter(
      input.runsRoot,
      undefined,
      async () => emptyTokenUsageSummary(),
      undefined,
      input.store,
    ),
    new FileRunRequestStore(input.runsRoot),
    input.processor,
    undefined,
    undefined,
    undefined,
    undefined,
    new NoopDriverStreamAuditWriter(),
    input.loop,
    undefined,
    undefined,
    undefined,
    undefined,
    new FileRunEventConsumptionSink(input.runsRoot),
    new FileRunTelemetryJsonlSink(input.runsRoot),
    undefined,
    undefined,
    undefined,
    input.reader,
  );
}

describe('已收尾 run 的 usage 在进程重启后仍然可读', () => {
  it('serves the same billed usage from a fresh registry, and keeps activity absent', async () => {
    resetAgentActivities();
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'durable-usage-'));
    const store = new SqliteCoordinationStore(path.join(runsRoot, 'coordination.sqlite'));
    const processor = new TaskProcessor(store);

    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      // proxy 用量只进存活期事件流 + telemetry 文件，**不落 SQLite**——所以重启后
      // 唯一的持久来源是 run 收尾时写下的账本行。
      executors: singleAgentExecutors(async () => {
        await recordProxyLlmUsage({ input_tokens: 100, output_tokens: 10, model: 'fake-model' });
      }),
    });

    const serviceBefore = buildService({
      runsRoot,
      store,
      processor,
      loop,
      registry: new InMemoryRunRegistry(),
      reader: new LedgerRunUsageHistoryReader(store, runsRoot, () => 'T'),
    });

    try {
      const created = await serviceBefore.createTask({
        spec: 'durable usage across a restart',
        role_id: ROLE,
        completion_criteria: ['usage survives a restart'],
        workspace_path: process.cwd(),
        mode: 'single_agent',
      });
      const runId = created.current_run?.run_id ?? '';
      // 判据刻意不是「持久状态变成 completed」：那个状态由游标推进写在 `runAuthorityLoop`
      // **前半段**（`advanceStage`），而终态产物与账本行是后半段、`finalize` 的最后一件事
      // （`appendUsageLedger`）。等前者会稳定地抢在 `finalize` 之前——这个竞态最初真的骗过
      // 了本用例，让「账本为空」看起来像产品缺陷。
      await waitFor(
        () => ledgerHasRows(store, runId),
        'run finalized into the usage ledger',
      );
      expect(processor.getRunSnapshot(runId)?.status).toBe('completed');

      const live = serviceBefore.getRunSnapshot(runId);
      expect(live.status).toBe('completed');
      expect(live.usage?.billed?.by_source.proxy?.total_tokens).toBe(110);

      // driver 腿的刮取结局必须留在真实产物里。这个 run 没有 worktree_path（gate 没有
      // materialize），所以 driver 腿**注定**拿不到——而那正是要能说出口的事：
      // 「没有 driver 用量」与「刮取没跑」在此之前长得一模一样。
      const summary = JSON.parse(
        await readFile(path.join(runsRoot, runId, 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(summary.driver_billed_merge).toMatchObject({ status: 'skipped_no_worktree' });
      expect(summary.token_usage).toBeDefined();

      // ——— 重启：同一个持久层，一个干净的 registry，另一个读取口实例 ———
      const serviceAfter = buildService({
        runsRoot,
        store,
        processor,
        loop,
        registry: new InMemoryRunRegistry(),
        reader: new LedgerRunUsageHistoryReader(store, runsRoot, () => 'T'),
      });

      const restarted = serviceAfter.getRunSnapshot(runId);

      expect(restarted.status).toBe('completed');
      // ① 数字不许随后端重启而变：逐字段相同，而不是「也是 110」。
      expect(restarted.usage?.billed).toEqual(live.usage?.billed);
      expect(restarted.usage?.billed?.by_source.proxy?.total_tokens).toBe(110);
      expect(restarted.usage?.billed?.by_source.proxy?.call_count).toBe(1);
      // ② 在飞状态是真的内存态，重启后必须缺席——不编一个「空闲」，也不假装持久。
      expect(restarted.activity).toBeUndefined();
      // ③ 存活期才有的分桶在重启后缺席；`billed` 与它不同源，所以它还在。
      expect(restarted.usage?.by_stage).toBeUndefined();
      expect(live.usage?.by_stage).toBeDefined();
      // ④ 补出来的块必须过**协议 schema**：这是前端解析的那一份契约，而「投影对了」不等于
      // 「形状合法」——多一个字段或少一个字段都会在真正的消费方那里炸，不会在单测里炸。
      expect(runSnapshotSchema.safeParse(live).success).toBe(true);
      expect(runSnapshotSchema.safeParse(restarted).success).toBe(true);
      // ⑤ 已收尾的 run 不再说「还有腿没到」：那时候该到的都到了；某条腿仍然缺席的成因在
      // `summary.json` 的 `driver_billed_merge` 里，不是这里。运行中才报 pending，那一条由
      // `run-live-observation` 的 task-loop 用例钉住。
      expect(restarted.usage?.billed?.pending_sources).toBeUndefined();
      expect(live.usage?.billed?.pending_sources).toBeUndefined();
    } finally {
      resetAgentActivities();
      await serviceBefore.close().catch(() => undefined);
      try {
        store.close();
      } catch {
        // 清理尽力而为。
      }
      await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
  }, 30_000);

  it('leaves usage absent when the ledger has nothing for the run', async () => {
    resetAgentActivities();
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'durable-usage-empty-'));
    const store = new SqliteCoordinationStore(path.join(runsRoot, 'coordination.sqlite'));
    const processor = new TaskProcessor(store);

    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      executors: singleAgentExecutors(),
    });
    // 反向对照：一个**空账本**。这里的 run 完全没有 LLM 用量，账本里也不会有它的行。
    const emptyLedger = new SqliteCoordinationStore(':memory:');
    const service = buildService({
      runsRoot,
      store,
      processor,
      loop,
      registry: new InMemoryRunRegistry(),
      reader: new LedgerRunUsageHistoryReader(emptyLedger, runsRoot, () => 'T'),
    });

    try {
      const created = await service.createTask({
        spec: 'no usage at all',
        role_id: ROLE,
        completion_criteria: ['usage stays absent'],
        workspace_path: process.cwd(),
        mode: 'single_agent',
      });
      const runId = created.current_run?.run_id ?? '';
      await waitForTerminalRun(
        runsRoot,
        runId,
        () => processor.getRunSnapshot(runId)?.status === 'completed',
      );

      // 一行 LLM 调用都没有 → 没有 proxy 腿 → 整个 `usage` 缺席，不是一个 0。
      expect(service.getRunSnapshot(runId).usage).toBeUndefined();
    } finally {
      resetAgentActivities();
      await service.close().catch(() => undefined);
      for (const open of [emptyLedger, store]) {
        try {
          open.close();
        } catch {
          // 清理尽力而为。
        }
      }
      await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
  }, 30_000);

  it('reads a run from before the ledger existed out of its own summary', async () => {
    // 这条守的是**读的顺序**，也是账本上线那一刻的真实状态。
    //
    // 账本的行是 run 收尾时写的，所以「账本里有行」只对账本之后跑过的 run 成立；账本之前的
    // 历史只活在 `runs/<id>/summary.json` 里。实测本机 41 个状态库、292 个 run：`runs` 表里
    // 的 run 一个都没有账本行（`token_usage_ledger` 表在这些库里都还不存在），而 208 个 run
    // 有 summary.json。回填能把它们搬进账本，但回填是异步的、快照是同步的——曾经因此「这个
    // run 花了多少」取决于**有没有人先读过一次历史**：先读 `run.getUsage` 就有数字，直接读
    // 快照就没有。同一个 run 的用量随读的顺序而变是不能接受的。
    resetAgentActivities();
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'durable-usage-preledger-'));
    const store = new SqliteCoordinationStore(path.join(runsRoot, 'coordination.sqlite'));
    const processor = new TaskProcessor(store);
    const loop = new TaskExecutionLoop({
      processor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      executors: singleAgentExecutors(async () => {
        await recordProxyLlmUsage({ input_tokens: 100, output_tokens: 10, model: 'fake-model' });
      }),
    });
    // 读取口指向一个**空账本**、目录指向真实的 runsRoot：这就是「升级之后、回填之前」。
    const preLedger = new SqliteCoordinationStore(':memory:');
    const serviceBefore = buildService({
      runsRoot,
      store,
      processor,
      loop,
      registry: new InMemoryRunRegistry(),
      reader: new LedgerRunUsageHistoryReader(preLedger, runsRoot, () => 'T'),
    });

    try {
      const created = await serviceBefore.createTask({
        spec: 'a run from before the usage ledger existed',
        role_id: ROLE,
        completion_criteria: ['usage is readable without a backfill'],
        workspace_path: process.cwd(),
        mode: 'single_agent',
      });
      const taskId = created.current_run?.task_id ?? '';
      const runId = created.current_run?.run_id ?? '';
      await waitFor(() => ledgerHasRows(store, runId), 'run finalized into the usage ledger');

      // 前提要钉死：产物里**确实有**用量。否则下面的断言会因为「本来就没有」而空转——
      // 那正是这条用例要防的失效模式。
      const summary = JSON.parse(
        await readFile(path.join(runsRoot, runId, 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(summary.token_usage).toBeDefined();

      // ——— 重启：同一个持久层，一个**干净的 registry** ———
      //
      // 这一步不能省，而且第一版就是漏了它才让反向对照漏过去：进程还持有该 run 时，
      // `usage.billed` 可以从存活期 timeline 折出来，兜底读不读得到根本看不出来。只有
      // registry 空了，答案才**只能**来自持久层——那恰好也是面板连上一个新后端进程时的样子。
      const serviceAfter = buildService({
        runsRoot,
        store,
        processor,
        loop,
        registry: new InMemoryRunRegistry(),
        reader: new LedgerRunUsageHistoryReader(preLedger, runsRoot, () => 'T'),
      });

      // 一条历史读都没发生过，答案必须由这一条读自己给出。
      const snapshot = serviceAfter.getRunSnapshot(runId);
      expect(snapshot.usage?.billed?.by_source.proxy?.total_tokens).toBe(110);

      // 顺序不能改变答案：触发一次历史读（会把整棵目录树回填进账本）之后必须同值。
      await serviceAfter.getRunUsage({ scope: 'task', scope_id: taskId, run_id: runId });
      expect(serviceAfter.getRunSnapshot(runId).usage?.billed).toEqual(snapshot.usage?.billed);
    } finally {
      resetAgentActivities();
      await serviceBefore.close().catch(() => undefined);
      for (const open of [preLedger, store]) {
        try {
          open.close();
        } catch {
          // 清理尽力而为。
        }
      }
      await rm(runsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
  }, 30_000);
});
