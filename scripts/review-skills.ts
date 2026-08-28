/**
 * 技能审核 CLI — 人工审核 pending Skill（方向 B 的"每 N 题人工过一遍"配套工具）
 *
 * 用法（对同一份 DB/state 启动后端，跑题进程结束后使用）：
 *   pnpm review:skills --list                     # 列出全部 pending Skill
 *   pnpm review:skills --approve <role> <skill> [reviewer]   # 批准（默认 reviewer=me）
 *   pnpm review:skills --reject <role> <skill> [reviewer]    # 拒绝
 *   pnpm review:skills --interactive              # 逐条展示，y=批准 n=拒绝 q=退出
 *   pnpm review:skills                            # 等价 --list
 *
 * 说明：
 *   - 数据源与测评一致：读取 .env/.env.local 里的 NEWIDE_B_DATABASE_URL / NEWIDE_STATE_ROOT，
 *     无 PG 时（内存/单文件存储）本 CLI 无法看到测评进程的数据，仅适用于持久化存储。
 *   - 每次启动后端会触发 replayPending()（幂等，仅处理未处理的 buffer），无副作用风险；
 *     但仍建议在测评进程停止后运行，避免并发写。
 *   - 不会设置 NEWIDE_B_SKILL_AUTO_APPROVE，保证 pending 状态保留给人工审核。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingSkill {
  id: string;
  description: string;
  content: string;
  tags: string[];
  agent_id: string;
  promoted_from?: string;
  promoted_at: string;
  review_status: string;
}

const repoRoot = process.cwd();
const configuredEnv = {
  ...loadEnvFile(path.join(repoRoot, '.env')),
  ...loadEnvFile(path.join(repoRoot, '.env.local')),
};

const [mode, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (mode === '--help' || mode === '-h') {
    printHelp();
    return;
  }

  const backend = await startBackend();
  try {
    if (mode === '--approve' || mode === '--reject') {
      const [roleId, skillId, reviewer] = rest;
      if (!roleId || !skillId) {
        throw new Error(`用法：pnpm review:skills --${mode.slice(2)} <role_id> <skill_id> [reviewer]`);
      }
      const method = mode === '--approve' ? 'memory.approveSkill' : 'memory.rejectSkill';
      const result = await backend.request<{ skill?: PendingSkill }>(method, {
        role_id: roleId,
        skill_id: skillId,
        reviewed_by: reviewer ?? 'me',
      });
      const skill = result.skill;
      console.log(
        `${mode === '--approve' ? '已批准' : '已拒绝'} ${skillId} → review_status=${String(skill?.review_status)}`,
      );
      return;
    }

    if (mode === '--interactive') {
      await interactiveReview(backend);
      return;
    }

    // 默认 / --list：列出全部 pending
    const result = await backend.request<{ skills?: PendingSkill[] }>(
      'memory.listPendingReviews',
      {},
    );
    const skills = result.skills ?? [];
    if (skills.length === 0) {
      console.log('没有待审核的 pending Skill（0 条）');
      return;
    }
    console.log(`待审核 pending Skill 共 ${skills.length} 条：\n`);
    skills.forEach((skill, index) => {
      console.log(`#${index + 1}  ${skill.agent_id}  ${skill.id}`);
      console.log(`    description: ${skill.description}`);
      console.log(`    content: ${truncate(skill.content, 140)}`);
      console.log(`    tags: [${(skill.tags ?? []).join(', ')}]`);
      if (skill.promoted_from) console.log(`    promoted_from: ${skill.promoted_from}`);
      console.log(`    promoted_at: ${skill.promoted_at}\n`);
    });
    console.log('审核：pnpm review:skills --approve <role_id> <skill_id>  或  --interactive');
  } finally {
    await backend.close();
  }
}

/** 交互模式：逐条展示 pending，y=批准 n=拒绝 回车=跳过 q=退出 */
async function interactiveReview(backend: BackendClient): Promise<void> {
  const result = await backend.request<{ skills?: PendingSkill[] }>(
    'memory.listPendingReviews',
    {},
  );
  const skills = result.skills ?? [];
  if (skills.length === 0) {
    console.log('没有待审核的 pending Skill（0 条）');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin EOF（管道输入耗尽 / Ctrl-D）时按退出处理：close 可能在两次提问之间
  // 触发，此时再调 question() 会抛 "readline was closed"，故用 closed 守卫短路。
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  const ask = (question: string) => {
    if (closed) return Promise.resolve('q');
    return new Promise<string>((resolve) => {
      const onClose = () => resolve('q');
      rl.once('close', onClose);
      rl.question(question, (answer) => {
        rl.removeListener('close', onClose);
        resolve(answer);
      });
    });
  };

  try {
    let approved = 0;
    let rejected = 0;
    for (let index = 0; index < skills.length; index += 1) {
      const skill = skills[index]!;
      console.log(`\n=== ${index + 1}/${skills.length} ===  ${skill.agent_id}  ${skill.id}`);
      console.log(`description: ${skill.description}`);
      console.log(`content:\n${skill.content}\n`);
      console.log(`tags: [${(skill.tags ?? []).join(', ')}]`);
      if (skill.promoted_from) console.log(`promoted_from: ${skill.promoted_from}`);

      const answer = (await ask('批准 y / 拒绝 n / 跳过回车 / 退出 q > ')).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 'y') {
        await backend.request('memory.approveSkill', {
          role_id: skill.agent_id,
          skill_id: skill.id,
          reviewed_by: 'me',
        });
        approved += 1;
        console.log(`  ✔ 已批准 ${skill.id}`);
      } else if (answer === 'n') {
        await backend.request('memory.rejectSkill', {
          role_id: skill.agent_id,
          skill_id: skill.id,
          reviewed_by: 'me',
        });
        rejected += 1;
        console.log(`  ✖ 已拒绝 ${skill.id}`);
      } else {
        console.log('  跳过');
      }
    }
    console.log(`\n完成：批准 ${approved}，拒绝 ${rejected}`);
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────
//  Backend stdio client（与消融脚本同模式）
// ─────────────────────────────────────────────

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  close(): Promise<void>;
}

async function startBackend(): Promise<BackendClient> {
  const env: NodeJS.ProcessEnv = {
    ...configuredEnv,
    ...process.env,
    NEWIDE_B_EMBEDDING_PROVIDER: process.env.NEWIDE_B_EMBEDDING_PROVIDER ?? 'hash',
    NEWIDE_B_EMBEDDING_DIMENSIONS: process.env.NEWIDE_B_EMBEDDING_DIMENSIONS ?? '32',
    NEWIDE_B_SKILL_AUTO_APPROVE: '0', // 审核工具必须保留 pending，禁止自动批准
  };
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'],
    { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });

  const waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });

  let nextId = 1;
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    const waiting = new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter = { predicate: (message: JsonRpcMessage) => message.id === id, resolve };
      waiters.add(waiter);
      setTimeout(() => {
        if (!waiters.delete(waiter)) return;
        reject(new Error(`[review] timed out on ${method}. stderr=${stderr.join('')}`));
      }, 60_000).unref();
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waiting;
    if (response.error) {
      throw new Error(
        `[review] ${method}: ${String(response.error.code)} ${response.error.message} stderr=${stderr.join('')}`,
      );
    }
    return response.result as T;
  };

  await request('system.ping', {});
  return {
    request,
    close: async () => {
      child.stdin?.end();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      child.kill();
    },
  };
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  const parsed: NodeJS.ProcessEnv = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

function printHelp(): void {
  console.log(
    [
      '技能审核 CLI（memory pending Skill 人工审核）',
      '',
      '用法：',
      '  pnpm review:skills --list',
      '  pnpm review:skills --approve <role_id> <skill_id> [reviewer]',
      '  pnpm review:skills --reject <role_id> <skill_id> [reviewer]',
      '  pnpm review:skills --interactive',
      '  pnpm review:skills',
      '',
      '数据源：.env/.env.local 的 NEWIDE_B_DATABASE_URL / NEWIDE_STATE_ROOT（与测评同源）',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  console.error(`审核失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
