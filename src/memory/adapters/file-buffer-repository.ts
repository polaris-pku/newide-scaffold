/**
 * FileBufferRepository — BufferRepository 文件持久化适配器
 *
 * 将 Agent 的 buffer 队列落盘至应用状态目录（非用户工作区）：
 * `{agentStateRoot}/{role_id}/buffer/` 下的 pending / processed / dead_letter。
 * 仅负责存储与状态迁移，不做经验提取；处理由 processPendingBuffer 等上层服务完成。
 */
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AgentContextSnapshotSchema,
  BufferMetaSchema,
  BufferSnapshotSchema,
  type AgentContextSnapshot,
  type BufferMeta,
  type BufferSnapshot,
  type UserRating,
} from '../schemas';
import type { BufferRepository, SaveBufferResult } from '../ports/buffer-repository';

/** FileBufferRepository 构造选项 */
export interface FileBufferRepositoryOptions {
  /** Agent 状态根目录，由 runtime 注入（非工作区路径） */
  agentStateRoot: string;
}

const BUFFER_DIR = 'buffer';
const META_FILE = 'buffer_meta.json';
const PENDING_DIR = 'pending';
const PROCESSED_DIR = 'processed';
const DEAD_LETTER_DIR = 'dead_letter';

const REPORT_FILE_PATTERN = /^report_(\d+)\.json$/;

function createEmptyBufferMeta(role_id: string): BufferMeta {
  return {
    role_id,
    pending_count: 0,
    cursor: 0,
    total_processed: 0,
    total_dead_letters: 0,
  };
}

function assertSafeRoleId(role_id: string): void {
  if (!role_id || role_id.includes('/') || role_id.includes('\\') || role_id.includes('..')) {
    throw new Error(`Invalid role_id for buffer storage: ${role_id}`);
  }
}

function reportFileName(seq: number): string {
  return `report_${seq}.json`;
}

function contextFileName(seq: number): string {
  return `context_${seq}.json`;
}

export class FileBufferRepository implements BufferRepository {
  private readonly agentStateRoot: string;

  constructor(options: FileBufferRepositoryOptions) {
    this.agentStateRoot = options.agentStateRoot;
  }

  async ensureAgent(role_id: string): Promise<void> {
    assertSafeRoleId(role_id);
    const bufferRoot = this.bufferRoot(role_id);
    await mkdir(join(bufferRoot, PENDING_DIR), { recursive: true });
    await mkdir(join(bufferRoot, PROCESSED_DIR), { recursive: true });
    await mkdir(join(bufferRoot, DEAD_LETTER_DIR), { recursive: true });

    const metaPath = join(bufferRoot, META_FILE);
    try {
      await readFile(metaPath, 'utf8');
    } catch {
      await writeJsonAtomic(metaPath, createEmptyBufferMeta(role_id));
    }
  }

  async deleteAgent(role_id: string): Promise<void> {
    assertSafeRoleId(role_id);
    // 整个 Agent 状态目录（含 buffer 子目录）一并移除；不存在时静默成功
    await rm(join(this.agentStateRoot, role_id), { recursive: true, force: true });
  }

  async saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const meta = await this.readBufferMeta(role_id);

    const seq = meta.cursor + 1;
    meta.cursor = seq;
    meta.pending_count += 1;

    const storedSnapshot: BufferSnapshot = agentContext
      ? { ...snapshot, context_snapshot_ref: String(seq) }
      : snapshot;

    const storedAgentContext = agentContext
      ? {
          ...agentContext,
          driver_calls: agentContext.driver_calls.map((call) => ({
            ...call,
            driver_return_ref: reportFileName(seq),
          })),
        }
      : undefined;

    BufferSnapshotSchema.parse(storedSnapshot);
    await writeJsonAtomic(join(bufferRoot, PENDING_DIR, reportFileName(seq)), storedSnapshot);

    if (storedAgentContext) {
      AgentContextSnapshotSchema.parse(storedAgentContext);
      await writeJsonAtomic(
        join(bufferRoot, PENDING_DIR, contextFileName(seq)),
        storedAgentContext,
      );
    }

    await writeJsonAtomic(join(bufferRoot, META_FILE), meta);

    return {
      seq,
      snapshot: storedSnapshot,
      ...(storedAgentContext ? { agent_context_snapshot: storedAgentContext } : {}),
    };
  }

  async getBufferMeta(role_id: string): Promise<BufferMeta> {
    return this.readBufferMeta(role_id);
  }

  async markBufferProcessed(role_id: string, seq: number): Promise<void> {
    await this.markBuffer(role_id, seq, 'processed', 'total_processed');
  }

  async markBufferDeadLetter(role_id: string, seq: number): Promise<void> {
    await this.markBuffer(role_id, seq, 'dead_letter', 'total_dead_letters');
  }

  async updateBufferRating(role_id: string, seq: number, rating: UserRating): Promise<void> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const reportPath = join(bufferRoot, PENDING_DIR, reportFileName(seq));
    let rawReport: string;
    try {
      rawReport = await readFile(reportPath, 'utf8');
    } catch {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    const snapshot = BufferSnapshotSchema.parse(JSON.parse(rawReport));
    snapshot.user_rating = rating;
    await writeJsonAtomic(reportPath, snapshot);
  }

  async listPendingBufferSeqs(role_id: string): Promise<number[]> {
    const pendingDir = join(this.requireBufferRoot(role_id), PENDING_DIR);
    const entries = await readdirSafe(pendingDir);
    const seqs: number[] = [];

    for (const entry of entries) {
      const match = REPORT_FILE_PATTERN.exec(entry);
      if (match) {
        seqs.push(Number(match[1]));
      }
    }

    return seqs.sort((a, b) => a - b);
  }

  async listDeadLetterSeqs(role_id: string): Promise<number[]> {
    const deadLetterDir = join(this.requireBufferRoot(role_id), DEAD_LETTER_DIR);
    const entries = await readdirSafe(deadLetterDir);
    const seqs: number[] = [];

    for (const entry of entries) {
      const match = REPORT_FILE_PATTERN.exec(entry);
      if (match) {
        seqs.push(Number(match[1]));
      }
    }

    return seqs.sort((a, b) => a - b);
  }

  async restoreDeadLetter(role_id: string, seq: number): Promise<void> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const deadLetterReportPath = join(bufferRoot, DEAD_LETTER_DIR, reportFileName(seq));

    let rawReport: string;
    try {
      rawReport = await readFile(deadLetterReportPath, 'utf8');
    } catch {
      throw new Error(`Dead-letter buffer not found: seq=${seq}`);
    }

    const snapshot = BufferSnapshotSchema.parse(JSON.parse(rawReport));
    snapshot.extraction_status = 'pending';
    // dead_letter → pending（写回时一并更新提取状态）
    await moveFile(
      deadLetterReportPath,
      join(bufferRoot, PENDING_DIR, reportFileName(seq)),
      snapshot,
    );
    try {
      await moveFile(
        join(bufferRoot, DEAD_LETTER_DIR, contextFileName(seq)),
        join(bufferRoot, PENDING_DIR, contextFileName(seq)),
      );
    } catch {
      // context 文件可选，缺失时不阻塞恢复
    }

    const meta = await this.readBufferMeta(role_id);
    meta.pending_count += 1;
    meta.total_dead_letters = Math.max(0, meta.total_dead_letters - 1);
    await writeJsonAtomic(join(bufferRoot, META_FILE), meta);
  }

  async getPendingBuffer(
    role_id: string,
    seq: number,
  ): Promise<{ snapshot: BufferSnapshot; agentContext?: AgentContextSnapshot } | undefined> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const reportPath = join(bufferRoot, PENDING_DIR, reportFileName(seq));

    let rawReport: string;
    try {
      rawReport = await readFile(reportPath, 'utf8');
    } catch {
      return undefined;
    }

    const snapshot = BufferSnapshotSchema.parse(JSON.parse(rawReport));
    const contextPath = join(bufferRoot, PENDING_DIR, contextFileName(seq));

    try {
      const rawContext = await readFile(contextPath, 'utf8');
      const agentContext = AgentContextSnapshotSchema.parse(JSON.parse(rawContext));
      return { snapshot, agentContext };
    } catch {
      return { snapshot };
    }
  }

  private bufferRoot(role_id: string): string {
    assertSafeRoleId(role_id);
    return join(this.agentStateRoot, role_id, BUFFER_DIR);
  }

  private requireBufferRoot(role_id: string): string {
    assertSafeRoleId(role_id);
    return join(this.agentStateRoot, role_id, BUFFER_DIR);
  }

  private async readBufferMeta(role_id: string): Promise<BufferMeta> {
    const metaPath = join(this.requireBufferRoot(role_id), META_FILE);
    try {
      const raw = await readFile(metaPath, 'utf8');
      return BufferMetaSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(`Buffer store not found for agent: ${role_id}`);
    }
  }

  private async markBuffer(
    role_id: string,
    seq: number,
    targetStatus: 'processed' | 'dead_letter',
    totalField: 'total_processed' | 'total_dead_letters',
  ): Promise<void> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const pendingReportPath = join(bufferRoot, PENDING_DIR, reportFileName(seq));
    const pendingContextPath = join(bufferRoot, PENDING_DIR, contextFileName(seq));

    let rawReport: string;
    try {
      rawReport = await readFile(pendingReportPath, 'utf8');
    } catch {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }

    const snapshot = BufferSnapshotSchema.parse(JSON.parse(rawReport));
    snapshot.extraction_status = targetStatus;

    const targetDir = targetStatus === 'processed' ? PROCESSED_DIR : DEAD_LETTER_DIR;
    await moveFile(pendingReportPath, join(bufferRoot, targetDir, reportFileName(seq)), snapshot);

    try {
      await moveFile(pendingContextPath, join(bufferRoot, targetDir, contextFileName(seq)));
    } catch {
      // context 文件可选，缺失时不阻塞迁移
    }

    const meta = await this.readBufferMeta(role_id);
    meta.pending_count = Math.max(0, meta.pending_count - 1);
    meta[totalField] += 1;
    await writeJsonAtomic(join(bufferRoot, META_FILE), meta);
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    throw new Error(`Buffer store not found for agent directory: ${dir}`);
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  try {
    await rename(tmpPath, filePath);
  } catch {
    await unlink(filePath).catch(() => undefined);
    await rename(tmpPath, filePath);
  }
}

async function moveFile(src: string, dest: string, rewritten?: unknown): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });

  if (rewritten !== undefined) {
    await writeJsonAtomic(dest, rewritten);
    await unlink(src).catch(() => undefined);
    return;
  }

  try {
    await rename(src, dest);
  } catch {
    await unlink(dest).catch(() => undefined);
    await rename(src, dest);
  }
}
