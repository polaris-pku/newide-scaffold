/**
 * 跨进程恢复 worker 的**无 tsx 启动器**（仅在 sandbox 阻断 tsx/esbuild 服务时使用）。
 *
 * 为什么需要它：`node --import tsx worker.ts` 会拉起 esbuild 子进程服务（管道 stdio）；
 * DSH sandbox 的 workspace-write 模式禁止该派生（spawn EPERM）。这里改用 Node 自带的
 * TypeScript 变换（`--experimental-transform-types`）+ 一个只补扩展名的 resolve hook：
 * 全程在进程内，无子进程派生，仍然运行**同一份** `role-recovery-child-worker.ts`。
 *
 * 用法（父测试进程）：
 *   node --experimental-transform-types role-recovery-child-bootstrap.mjs
 *   env: ROLE_RECOVERY_WORKER_PATH=<绝对路径的 role-recovery-child-worker.ts>
 *        ROLE_RECOVERY_RUNS_ROOT / ROLE_RECOVERY_RUN_ID / ROLE_RECOVERY_MODE（透传给 worker）
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const workerPath = process.env.ROLE_RECOVERY_WORKER_PATH;
if (workerPath === undefined || workerPath.length === 0) {
  throw new Error('missing required environment variable ROLE_RECOVERY_WORKER_PATH');
}

register(new URL('./ts-extensionless-loader.mjs', import.meta.url).href, import.meta.url);
await import(pathToFileURL(workerPath).href);
