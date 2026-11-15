/**
 * 跨进程重启 fixture：在**真实子进程**里创建一个 Run 的 RunDispatchJournal，写入 durable 前缀，
 * 然后在调用 driver 之前直接 `process.exit(0)` —— 模拟「宿主机进程被强杀」。
 *
 * 为什么这样模拟：进程崩溃不会执行 `journal.close()`，写者锁目录会留在 run 目录里；
 * 父测试进程随后用同一个 `run_dir` 重新 `RunDispatchJournal.open()`，必须靠 stale-lock 回收
 * 才能继续（这正是真实重启会走的路径）。
 *
 * 环境变量：
 * - `ROLE_RECOVERY_RUNS_ROOT`：runs root（父进程创建的临时目录）。
 * - `ROLE_RECOVERY_RUN_ID`：本 Run 的 id（安全 id，父进程保证）。
 * - `ROLE_RECOVERY_MODE`：
 *   - `dispatched`：只写到 `dispatched` durable 后退出（driver 从未被调用 = unknown 前缀）；
 *   - `settled`：写到 `settled` durable 后退出（已完成一次真实派工，但 finish 尚未落盘）。
 *
 * 输出：正常退出码 0；失败时把原因写到 `<run_dir>/worker-error.txt` 并以 1 退出
 * （父进程用文件回传错误，避免在受限沙箱里依赖子进程 stdio 管道）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildExecutionBrief,
  buildExecutionEvidence,
  hashExecutionBrief,
} from '../../src/driver';
import { RunDispatchJournal } from '../../src/persistence';
import { buildRoleFreezeInitInput } from '../../src/app/role-autonomy-contract';

const IDENTITY = { task_id: 'task_1', role_id: 'role_1' };
const FROZEN_AT = '2026-11-13T10:00:00.000Z';
const DEADLINE_AT = '2027-11-13T00:45:00.000Z';

const LIMITS = {
  max_dispatches: 12,
  max_role_rounds: 40,
  role_token_budget: 120_000,
  wall_clock_seconds: 2_700,
  dispatch_timeout_ms: 600_000,
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const runsRoot = requireEnv('ROLE_RECOVERY_RUNS_ROOT');
  const runId = requireEnv('ROLE_RECOVERY_RUN_ID');
  const mode = requireEnv('ROLE_RECOVERY_MODE');
  if (mode !== 'dispatched' && mode !== 'settled') {
    throw new Error(`unsupported ROLE_RECOVERY_MODE: ${mode}`);
  }
  const runDir = path.join(runsRoot, runId);
  const journal = await RunDispatchJournal.open({
    runDir,
    identity: { run_id: runId, ...IDENTITY },
  });
  await journal.appendInit({
    ...buildRoleFreezeInitInput({ limits: LIMITS, deadline_at: DEADLINE_AT }),
    at: FROZEN_AT,
  });

  const dispatchId = `dsp_child_${runId}`;
  const brief = buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      run_id: runId,
      task_id: IDENTITY.task_id,
      role_id: IDENTITY.role_id,
      sequence: 1,
      accepted_at: FROZEN_AT,
    },
    request: { kind: 'execute', instruction: 'work done by the child process' },
  }).brief;
  await journal.appendAccepted({
    brief,
    brief_sha256: hashExecutionBrief(brief),
    budget_before: {
      dispatches_left: LIMITS.max_dispatches,
      role_tokens_left: LIMITS.role_token_budget,
      deadline_at: DEADLINE_AT,
    },
  });
  await journal.appendDispatched({ dispatch_id: dispatchId, at: FROZEN_AT });

  if (mode === 'settled') {
    const evidence = buildExecutionEvidence({
      dispatch_id: dispatchId,
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'child done' },
      },
    });
    const artifact = await journal.appendEvidence({ dispatch_id: dispatchId, evidence });
    await journal.appendSettled({
      dispatch_id: dispatchId,
      status: evidence.status,
      evidence,
      evidence_sha256: artifact.sha256,
      violations: [],
      at: FROZEN_AT,
    });
  }

  // 关键：不 close 写者、不调用 driver、不写 finish —— 直接终止进程。
  process.exit(0);
}

main().catch(async (error: unknown) => {
  const runsRoot = process.env.ROLE_RECOVERY_RUNS_ROOT ?? '';
  const runId = process.env.ROLE_RECOVERY_RUN_ID ?? '';
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (runsRoot.length > 0 && runId.length > 0) {
    await fs
      .writeFile(path.join(runsRoot, runId, 'worker-error.txt'), message, 'utf8')
      .catch(() => undefined);
  }
  process.exit(1);
});
