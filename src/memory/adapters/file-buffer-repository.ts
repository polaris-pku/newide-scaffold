/**
 * FileBufferRepository — BufferRepository 文件持久化适配器
 *
 * 将 Agent 的 buffer 队列落盘至应用状态目录（非用户工作区）：
 * `{agentStateRoot}/{role_id}/buffer/` 下的 pending / processed / dead_letter。
 * 仅负责存储与状态迁移，不做经验提取；处理由 processPendingBuffer 等上层服务完成。
 */
import type { Dirent } from 'node:fs';
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
import type {
  AgentContextReadStatus,
  BufferArchiveOutcome,
  BufferLocation,
  BufferRepository,
  DeadLetterEntry,
  PendingBufferRead,
  SaveBufferResult,
  StoredBuffer,
} from '../ports/buffer-repository';
import { nowTimestamp } from '../../core';

/** FileBufferRepository 构造选项 */
export interface FileBufferRepositoryOptions {
  /** Agent 状态根目录，由 runtime 注入（非工作区路径） */
  agentStateRoot: string;
  /**
   * 删除一个已经落盘文件的注入点，默认 `fs.unlink`。
   *
   * 两个用途：搬运时的「删源文件」，以及 report 写失败后清掉刚写的孤儿 context。
   * 之所以留出这个注入点，是因为这两条失败路径在真实文件系统上几乎不可能确定性复现
   * （Windows 会替你把只读属性清掉、POSIX 只看父目录写位，删不掉反而测不到），而它们
   * 恰恰是最需要回归的两条：**目标已写入、源还在**的半成品，以及**删不掉的孤儿 context**。
   * 注入后测试可以确定性地制造它们，生产装配不传、行为与直接调 unlink 完全一致。
   */
  removeSourceFile?: (path: string) => Promise<void>;
}

const BUFFER_DIR = 'buffer';
const META_FILE = 'buffer_meta.json';
const PENDING_DIR = 'pending';
const PROCESSED_DIR = 'processed';
const DEAD_LETTER_DIR = 'dead_letter';

const REPORT_FILE_PATTERN = /^report_(\d+)\.json$/;
const CONTEXT_FILE_PATTERN = /^context_(\d+)\.json$/;

/**
 * 「目标分区已写好、源分区那份还没删掉」的搬运失败。
 *
 * 搬运是两次写（复制 + 删除），删除失败意味着同一条 Buffer 同时存在于两个分区。这个
 * 错误专用来把这种**半成品**与普通失败区分开：调用方必须把它报成 failed/partial，
 * 绝不能报成 archived——`archived` 的含义是「它已经不在源分区了」。
 */
class PartialMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialMoveError';
  }
}

/**
 * 分区扫描结果：meta 里的每一个数字都从这里推导，没有一个是自己攒出来的。
 *
 * - 三个计数 = 三个分区里**报告文件**的条数（pending / processed / dead_letter）。
 * - `highest_seq` = 三个分区里出现过的最大 seq，**报告与 context 一起算**。
 *
 * context 必须计入，否则「context 落了、report 没落」的写入会留下一个匿名 seq：下一次
 * 分配看不到它，就会把同一个 seq 发给新 Buffer，而那个孤儿 context 还在原地——新 Buffer
 * 只要不带上下文（历史形态），读侧就可能把别人的上下文当成自己的。
 */
interface BufferStoreScan {
  pending_count: number;
  total_processed: number;
  total_dead_letters: number;
  highest_seq: number;
}

function bufferMetaEquals(left: BufferMeta, right: BufferMeta): boolean {
  return (
    left.role_id === right.role_id &&
    left.pending_count === right.pending_count &&
    left.cursor === right.cursor &&
    left.total_processed === right.total_processed &&
    left.total_dead_letters === right.total_dead_letters
  );
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
  /**
   * 按键串行化的操作队列。三类键：
   *
   * - `save:<role_id>`：**序号分配**必须串行。saveBufferSnapshot 是「读 meta → 算 seq →
   *   写 context → 写 report → 刷 meta」，第一个 await 之后两个并发调用会读到同一个
   *   cursor，算出同一个 seq，然后互相覆盖——后来的那份把先写的 Buffer 顶掉，而两者都
   *   报告成功。串行化后它们各自拿到不同的 seq。
   * - `<role_id>:<seq>`：归档是「搬 context → 搬 report → 刷 meta」三步，其中每一步都有
   *   await。两个调用同时进来时都会在报告被搬走之前读到它，于是各自「成功」搬一次，而
   *   total_processed 会被加两次。串行后先到的那个真正搬运，后到的再读时报告已不在
   *   pending，自然落到 already_archived。
   * - `meta:<role_id>`：meta 刷新是「读 meta + 扫目录 + 写回」的读-改-写。保存与归档走
   *   的是不同的键，两条路径的刷新因此可能交错，把对方刚数出来的计数覆盖回去。单独串行
   *   之后，每次落盘的都是「此刻目录的真实投影」。
   *
   * 跨进程并发不在本实现的能力范围内（单实例部署，见 readiness/capabilities）。
   */
  private readonly serialQueues = new Map<string, Promise<unknown>>();
  /** 删除搬运后源文件的操作（见 FileBufferRepositoryOptions.removeSourceFile） */
  private readonly removeSourceFile: (path: string) => Promise<void>;

  constructor(options: FileBufferRepositoryOptions) {
    this.agentStateRoot = options.agentStateRoot;
    this.removeSourceFile = options.removeSourceFile ?? ((path) => unlink(path));
  }

  async ensureAgent(role_id: string): Promise<void> {
    assertSafeRoleId(role_id);
    const bufferRoot = this.bufferRoot(role_id);
    await mkdir(join(bufferRoot, PENDING_DIR), { recursive: true });
    await mkdir(join(bufferRoot, PROCESSED_DIR), { recursive: true });
    await mkdir(join(bufferRoot, DEAD_LETTER_DIR), { recursive: true });

    if (!(await fileExists(join(bufferRoot, META_FILE)))) {
      // 初始化：meta 不存在就按目录推导一份写下来（全新目录推出来就是空计数）。
      // 写不进去就是初始化失败，照旧抛错——调用方需要知道这个 Agent 的 buffer 落不了盘。
      await this.writeDerivedBufferMeta(role_id);
      return;
    }

    // 已存在：启动时按目录把派生统计校正一遍——上一次 meta 写失败会让累计计数永久少计
    // （见 refreshBufferMetaAfterMove），这里是它唯一的自动修复时机之外的兜底。
    // best-effort：修不好不该让启动整体失败，读侧照样按报告与上下文取数据。
    await this.healBufferMeta(role_id);
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
    // 同一 role 的写入串行：序号分配是读-改-写，并发会撞出同一个 seq（见 serialQueues）
    return this.enqueue(`save:${role_id}`, () =>
      this.writeBufferSnapshot(role_id, snapshot, agentContext),
    );
  }

  /**
   * 落盘一条 pending Buffer。提交点是 **report 文件**：
   *
   * 1. 分配 seq（`max(meta.cursor, 目录里出现过的最大 seq) + 1`）。不只看 meta——meta
   *    可能落后于目录（上一次 meta 写入失败，或进程在上次 report 落盘与 meta 落盘之间
   *    崩了）。而「目录里出现过的最大 seq」**同时算报告与 context 文件**（见 scanStore）：
   *    配对写入先落 context 后落 report，所以只要 context 落过盘，那个 seq 就已经被用过，
   *    哪怕它对应的 report 一次都没写成功、孤儿 context 也删不掉。
   * 2. 成对时 **context 先落、report 后落**。report 是这条记录对外的存在标记：先落
   *    context 只会在 pending 里留一个没人引用的孤儿文件（读侧按 report 扫描看不到它，
   *    也不会把它绑到任何一条 report 上——只有声明了 context_snapshot_ref 的 report 才
   *    会去读它）；反过来先落 report 而 context 没跟上，读侧就会把一条声明过上下文的
   *    Buffer 误判成「上下文丢了」。
   * 3. context 一落盘就把游标推过这个 seq（best-effort，见 healBufferMeta）。这一步让
   *    「用过的 seq 不再复用」不依赖那个孤儿文件还在不在：即使随后的 report 写失败、连带
   *    清理也失败、甚至清理成功把孤儿删干净了，这个 seq 也已经烧掉。
   * 4. report 落盘即提交。之后 meta 只是派生统计（计数从目录重数），写不进去不该把一次
   *    已经落地的写入报成失败——否则调用方重试会以为没写成功，凭空多出一条 Buffer。
   */
  private async writeBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const meta = await this.readBufferMeta(role_id);

    const scan = await this.scanStore(bufferRoot);
    const seq = Math.max(meta.cursor, scan.highest_seq) + 1;

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

    const contextPath = join(bufferRoot, PENDING_DIR, contextFileName(seq));
    if (storedAgentContext) {
      AgentContextSnapshotSchema.parse(storedAgentContext);
      await writeJsonAtomic(contextPath, storedAgentContext);
      // 这个 seq 从此刻起就是「用过的」：先把它记进 meta，再谈 report 落不落得下。
      await this.healBufferMeta(role_id, seq);
    }

    try {
      await writeJsonAtomic(join(bufferRoot, PENDING_DIR, reportFileName(seq)), storedSnapshot);
    } catch (error) {
      // report 没落地 = 这次写入没有发生。顺手清掉刚写的孤儿 context（best-effort）：
      // 清得掉是干净收场，清不掉也不影响正确性——seq 已经烧掉（上一步），而这个孤儿
      // 不会被任何 report 认领（没有声明过的 ref 就不读文件，见 readAgentContextIfPresent），
      // 所以既不静默地把它伪装成「没有孤儿」，也不让它污染后续任何一条 Buffer。
      if (storedAgentContext) {
        await this.removeSourceFile(contextPath).catch(() => undefined);
      }
      throw error;
    }

    await this.healBufferMeta(role_id, seq);

    return {
      seq,
      snapshot: storedSnapshot,
      ...(storedAgentContext ? { agent_context_snapshot: storedAgentContext } : {}),
    };
  }

  /**
   * 写入 / 搬运之后的 meta 刷新：三个计数从目录**重数**，游标只前进。
   *
   * best-effort：report 与 context 才是事实来源，meta 是派生统计。写不进去不该把一次
   * 已经落地的动作翻成失败；而且只要 meta 里每个数字都是从目录推出来的，下一次成功
   * 写入就会把落后的计数整体校正回来（含 total_processed / total_dead_letters）。
   */
  private async healBufferMeta(role_id: string, cursorAtLeast = 0): Promise<void> {
    try {
      // 同一个 role 的 meta 写入串行：它是「读 meta + 扫目录 + 写回」的读-改-写，
      // 让保存路径与归档路径的刷新交错，就可能把对方刚写下的计数覆盖回去。
      await this.enqueue(`meta:${role_id}`, () =>
        this.writeDerivedBufferMeta(role_id, cursorAtLeast),
      );
    } catch {
      // 目录是权威；下一次成功写入或下次启动（ensureAgent）时自愈
    }
  }

  /**
   * 按目录推导 meta 并落盘：三个计数是分区里报告文件的条数，游标是「用过的最大 seq」。
   * 与现有值相同就不写（启动时校正不该在每次启动都产生一次无谓的写入）。
   */
  private async writeDerivedBufferMeta(role_id: string, cursorAtLeast = 0): Promise<void> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const current = await this.readBufferMetaOrUndefined(role_id);
    const scan = await this.scanStore(bufferRoot);
    const next: BufferMeta = {
      // 保留 meta 里那些不由目录推导出来的字段（如 last_extraction_*）：这里只校正计数与游标
      ...current,
      role_id,
      pending_count: scan.pending_count,
      // 游标只前进：它记的是「分配过的 seq 上界」，不会因为文件被搬走而回退
      cursor: Math.max(current?.cursor ?? 0, cursorAtLeast, scan.highest_seq),
      total_processed: scan.total_processed,
      total_dead_letters: scan.total_dead_letters,
    };
    if (current && bufferMetaEquals(current, next)) return;
    await writeJsonAtomic(join(bufferRoot, META_FILE), next);
  }

  /**
   * 扫三个分区，把 meta 需要的每个数字都数出来；分区目录缺失当作空目录
   * （分配 seq 的扫描不能因为某个分区没建起来就整体失败）。
   */
  private async scanStore(bufferRoot: string): Promise<BufferStoreScan> {
    const scan: BufferStoreScan = {
      pending_count: 0,
      total_processed: 0,
      total_dead_letters: 0,
      highest_seq: 0,
    };
    const partitions: ReadonlyArray<{ dir: string; countField: keyof BufferStoreScan }> = [
      { dir: PENDING_DIR, countField: 'pending_count' },
      { dir: PROCESSED_DIR, countField: 'total_processed' },
      { dir: DEAD_LETTER_DIR, countField: 'total_dead_letters' },
    ];

    for (const { dir, countField } of partitions) {
      for (const entry of await readEntriesIfPresent(join(bufferRoot, dir))) {
        // 只认**文件**：目录（哪怕是叫 report_3.json 的障碍目录）不是一条已经落盘的记录，
        // 把它算进计数或游标，会让「写失败」这种状态凭空占住一个 seq。
        if (!entry.isFile()) continue;
        const report = REPORT_FILE_PATTERN.exec(entry.name);
        const context = CONTEXT_FILE_PATTERN.exec(entry.name);
        if (!report && !context) continue;
        // 报告与 context 都算「这个 seq 出现过」——配对写入先落 context 后落 report，
        // 只数报告会漏掉「context 落了、report 没落」的那一个 seq。
        scan.highest_seq = Math.max(scan.highest_seq, Number((report ?? context)![1]));
        if (report) scan[countField] += 1;
      }
    }
    return scan;
  }

  /** 读 meta；不存在或读不出来都返回 undefined（调用方据此按目录重建）。 */
  private async readBufferMetaOrUndefined(role_id: string): Promise<BufferMeta | undefined> {
    try {
      return await this.readBufferMeta(role_id);
    } catch {
      return undefined;
    }
  }

  async getBufferMeta(role_id: string): Promise<BufferMeta> {
    return this.readBufferMeta(role_id);
  }

  async markBufferProcessed(role_id: string, seq: number): Promise<void> {
    await this.markBuffer(role_id, seq, 'processed');
  }

  async markBufferDeadLetter(role_id: string, seq: number, reason?: string): Promise<void> {
    await this.markBuffer(role_id, seq, 'dead_letter', reason);
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

  async listDeadLetterEntries(role_id: string): Promise<DeadLetterEntry[]> {
    const deadLetterDir = join(this.requireBufferRoot(role_id), DEAD_LETTER_DIR);
    const entries = await readdirSafe(deadLetterDir);
    const result: DeadLetterEntry[] = [];

    for (const entry of entries) {
      const match = REPORT_FILE_PATTERN.exec(entry);
      if (!match) {
        continue;
      }
      const seq = Number(match[1]);
      let rawReport: string;
      try {
        rawReport = await readFile(join(deadLetterDir, entry), 'utf8');
      } catch {
        continue;
      }
      // 直接读原始 JSON（不经 schema parse）：task_id 必在快照内，
      // reason / failed_at 是 markBufferDeadLetter 附加的死信字段。
      const parsed = JSON.parse(rawReport) as BufferSnapshot & {
        dead_letter_reason?: string;
        dead_letter_at?: string;
      };
      result.push({
        seq,
        task_id: parsed.task_id,
        ...(parsed.dead_letter_reason !== undefined
          ? { reason: parsed.dead_letter_reason }
          : {}),
        failed_at: parsed.dead_letter_at ?? nowTimestamp(),
      });
    }

    return result.sort((a, b) => a.seq - b.seq);
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
    // dead_letter → pending（写回时一并更新提取状态）。
    // 与 markBuffer 同一套配对规则：context 先回、report 后回。report 是存在标记，
    // 它留在 dead_letter 就等于这次恢复没落地；声明过引用的上下文搬不动就抛出去。
    if (snapshot.context_snapshot_ref !== undefined) {
      await moveFileIdempotent(
        join(bufferRoot, DEAD_LETTER_DIR, contextFileName(seq)),
        join(bufferRoot, PENDING_DIR, contextFileName(seq)),
      );
    }
    await moveFile(
      deadLetterReportPath,
      join(bufferRoot, PENDING_DIR, reportFileName(seq)),
      snapshot,
      this.removeSourceFile,
    );

    // 恢复这个事实已经落地；meta 只是它的投影，从目录重数（死信计数 = 现在还剩几条死信，
    // 而不是「一共死信过几条」的自减账——自减一遇到写失败就会永久偏）
    await this.healBufferMeta(role_id);
  }

  async getPendingBuffer(role_id: string, seq: number): Promise<PendingBufferRead | undefined> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const snapshot = await readSnapshotIfPresent(
      join(bufferRoot, PENDING_DIR, reportFileName(seq)),
    );
    if (!snapshot) {
      return undefined;
    }
    return withAgentContext(
      snapshot,
      await readAgentContextIfPresent(
        snapshot,
        seq,
        join(bufferRoot, PENDING_DIR, contextFileName(seq)),
      ),
    );
  }

  async getStoredBuffer(role_id: string, seq: number): Promise<StoredBuffer | undefined> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const partitions: ReadonlyArray<{ dir: string; location: BufferLocation }> = [
      { dir: PENDING_DIR, location: 'pending' },
      { dir: PROCESSED_DIR, location: 'processed' },
      { dir: DEAD_LETTER_DIR, location: 'dead_letter' },
    ];
    for (const { dir, location } of partitions) {
      const snapshot = await readSnapshotIfPresent(join(bufferRoot, dir, reportFileName(seq)));
      // 报告不在这个分区：继续找下一个（它可能刚刚被别的流程挪走）
      if (!snapshot) continue;
      const context = await readAgentContextIfPresent(
        snapshot,
        seq,
        join(bufferRoot, dir, contextFileName(seq)),
      );
      return {
        ...withAgentContext(snapshot, context),
        location,
      };
    }
    return undefined;
  }

  /**
   * 归档一条 Buffer，把「没归档成」的原因讲清楚（见 BufferArchiveOutcome）。
   *
   * markBufferProcessed 是「照做，做不到就抛」，这里把它包成判别式结果：失败时再读一次
   * 三个分区，分清「Buffer 早就不在 pending 了」（已完成，无需修复）与「归档动作真的没落地」
   * （Buffer 还在 pending，需要重试）。前者不该报成故障，后者不该报成成功。
   *
   * 同一 (role, seq) 上的并发调用被串行化（见 archiveQueues）：只有一个能真正搬动文件并
   * 让 total_processed +1，其余的在轮到时看到报告已进 processed，如实回 already_archived。
   * 跨进程并发不在本实现的能力范围内（单实例部署，见 readiness/capabilities）。
   */
  async archiveBuffer(role_id: string, seq: number): Promise<BufferArchiveOutcome> {
    return this.enqueue(`${role_id}:${String(seq)}`, async () => {
      try {
        await this.markBufferProcessed(role_id, seq);
        return { status: 'archived' } satisfies BufferArchiveOutcome;
      } catch (error) {
        return this.classifyArchiveFailure(role_id, seq, error);
      }
    });
  }

  /** 把同一 key 上的操作排成一条链；链上的每个操作都会等到前一个落定才开跑。 */
  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.serialQueues.get(key) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.serialQueues.set(key, settled);
    void settled.then(() => {
      if (this.serialQueues.get(key) === settled) this.serialQueues.delete(key);
    });
    return running;
  }

  private async classifyArchiveFailure(
    role_id: string,
    seq: number,
    error: unknown,
  ): Promise<BufferArchiveOutcome> {
    const reason = errorMessage(error);
    // 半成品必须单独说：目标分区已经写好了那份，只是源分区那份没删掉，于是同一个 Buffer
    // 现在同时躺在两个分区。它既不是 archived（还在 pending），也不是「归档动作没落地」
    // 那么单纯——重试是安全的（目标会被同内容重写、源删掉后才计数），但结果必须报 failed。
    if (error instanceof PartialMoveError) {
      return {
        status: 'failed',
        message: `Buffer ${role_id}:${String(seq)} archive is partial: ${error.message}`,
      };
    }
    let stored: StoredBuffer | undefined;
    try {
      stored = await this.getStoredBuffer(role_id, seq);
    } catch (locateError) {
      // 连位置都查不出来（报告本身损坏）：这仍然是一次没落地的归档，把两段原因都留下
      return {
        status: 'failed',
        message:
          `Buffer ${role_id}:${String(seq)} could not be archived (${reason}); ` +
          `locating it failed as well (${errorMessage(locateError)}).`,
      };
    }
    if (!stored) {
      return {
        status: 'missing',
        message:
          `Buffer ${role_id}:${String(seq)} is in no partition, so there was nothing to ` +
          `archive (${reason}).`,
      };
    }
    if (stored.location === 'processed') {
      return this.classifyProcessedArchive(role_id, seq, stored, reason);
    }
    if (stored.location === 'dead_letter') {
      return {
        status: 'not_pending',
        location: 'dead_letter',
        message:
          `Buffer ${role_id}:${String(seq)} is dead-lettered, not pending, so archiving does ` +
          `not apply to it (${reason}).`,
      };
    }
    // 仍在 pending：归档确实没落地，交给调用方重试
    return {
      status: 'failed',
      message: `Buffer ${role_id}:${String(seq)} is still pending after the archive attempt: ${reason}`,
    };
  }

  /**
   * 报告已经在 processed 分区：正常情况下就是 already_archived（无需修复）。
   *
   * 但若这是一条**配对 Buffer**、而它声明的 AgentContextSnapshot 没跟着过来，那它是旧实现
   * 留下的半成品（先搬 report、context 卡在 pending 还被 catch 吞掉）。这种状态必须报
   * failed 而不是 already_archived——ack 看起来成功、上下文却再没人看得到，正是要修的缺口。
   * 只要上下文还躺在别的分区，这里顺手把它补搬过去（幂等）；补得成算修好，补不成如实报 failed。
   */
  private async classifyProcessedArchive(
    role_id: string,
    seq: number,
    stored: StoredBuffer,
    reason: string,
  ): Promise<BufferArchiveOutcome> {
    if (
      stored.snapshot.context_snapshot_ref === undefined ||
      stored.agentContextStatus === 'present'
    ) {
      return { status: 'already_archived' };
    }
    let repaired = false;
    try {
      repaired = await this.repairStrandedContext(role_id, seq);
    } catch {
      // 补搬过程中的 I/O 失败同样只是「没修好」：archiveBuffer 从不抛错，只如实报 failed
      repaired = false;
    }
    if (repaired) {
      return { status: 'archived' };
    }
    return {
      status: 'failed',
      message:
        `Buffer ${role_id}:${String(seq)} has its report in processed, but the ` +
        `AgentContextSnapshot declared by context_snapshot_ref=` +
        `${stored.snapshot.context_snapshot_ref} is in no partition, so the archive is ` +
        `incomplete (${reason}).`,
    };
  }

  /**
   * 把散落在 pending / dead_letter 的配对 context 补搬到 processed。
   *
   * **「文件在」不等于「修好了」**：目标那份必须真的能读出来（JSON 可解析且通过
   * AgentContextSnapshotSchema）。损坏 / schema 不匹配的文件若被当成「已经修好了」，
   * ack 就再也看不到它坏了——下游以为自己拿到了完整输入，而实际少了一半。搬过来的那份
   * 同样要重新校验：源文件本身可能就是坏的。任一步读不出来即返回 false，由调用方报 failed。
   */
  private async repairStrandedContext(role_id: string, seq: number): Promise<boolean> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const dest = join(bufferRoot, PROCESSED_DIR, contextFileName(seq));
    if (await isReadableAgentContext(dest)) {
      return true;
    }
    for (const dir of [PENDING_DIR, DEAD_LETTER_DIR]) {
      const src = join(bufferRoot, dir, contextFileName(seq));
      if (!(await fileExists(src))) continue;
      await moveFileIdempotent(src, dest);
      if (await isReadableAgentContext(dest)) {
        return true;
      }
    }
    return false;
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
    reason?: string,
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

    // 配对 Buffer（声明了 context_snapshot_ref）把 report 与 context 当一个单元搬：
    // **context 先走、report 后走**。顺序是关键——report 是这条记录在对外的「存在标记」，
    // 只要它还留在 pending，归档就没有算数，archiveBuffer 会如实报 failed 且缺口可查
    // （交付已 processed + Buffer 仍 pending → archive_backlog）；反过来（先搬 report）
    // 会造出「报告已进 processed、上下文还留在 pending」的半成品，被 already_archived
    // 掩盖成成功，上下文就此变成没有人再看得到的孤儿。
    //
    // 配对上下文声明过引用就必须跟着走——搬不动就抛出去，绝不 catch {} 吞掉。历史 Buffer
    // （没有 context_snapshot_ref）才允许缺 context 归档，保持兼容。
    if (snapshot.context_snapshot_ref !== undefined) {
      await moveFileIdempotent(
        pendingContextPath,
        join(bufferRoot, targetDir, contextFileName(seq)),
      );
    }

    // 死信额外字段直接附加到快照对象（写盘时一并持久化；读取用原始 JSON）
    const rewritten = targetStatus === 'dead_letter' && reason !== undefined
      ? {
          ...snapshot,
          dead_letter_reason: reason,
          dead_letter_at: nowTimestamp(),
        }
      : snapshot;
    await moveFile(
      pendingReportPath,
      join(bufferRoot, targetDir, reportFileName(seq)),
      rewritten,
      this.removeSourceFile,
    );

    await this.refreshBufferMetaAfterMove(role_id);
  }

  /**
   * 搬运之后刷新 meta：三个计数都从目录**重数**，不再对 total_processed /
   * total_dead_letters 做 `+= 1`。
   *
   * 自增版本有两个缺口。其一，写 meta 失败时那次自增就永远丢了，而累计计数没有别的
   * 事实来源，于是 total_processed 会永久少计——启动时也不会自己好。其二，重复归档
   * （重试、或半成品重试）会把它加两次。重数把这两个缺口一起补上：分区里报告文件的条数
   * 本身就是累计事实，重算既不会少计也不会重复计，而且**下一次任何成功写入都会顺手把它
   * 校正回来**（ensureAgent 启动时也会，见该处）。
   *
   * best-effort：归档已经落地（报告与上下文都离开了 pending），写计数器失败不该把
   * 它翻成 failed——那只会在 archive_backlog 里造出一条假的缺口。
   */
  private async refreshBufferMetaAfterMove(role_id: string): Promise<void> {
    await this.healBufferMeta(role_id);
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    throw new Error(`Buffer store not found for agent directory: ${dir}`);
  }
}

/** 读目录条目（含类型）；不存在时返回空表（分配 seq 的扫描不能因为某个分区缺失就整体失败）。 */
async function readEntriesIfPresent(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 读一条报告快照：不在（ENOENT）返回 undefined，在但读不出来则抛错。
 *
 * 「缺席」与「损坏」必须分开：缺席是「这个 seq 现在不在这个分区」，调用方可以继续
 * 找别处或当作没有；损坏是「有一份记录躺在这里但没法用」，跳过它等于把故障藏起来，
 * 而启动恢复恰恰需要把这一条报出来。错误消息带上路径（含 role 与 seq），
 * 才够定位到是哪条 Buffer 坏了。
 */
async function readSnapshotIfPresent(filePath: string): Promise<BufferSnapshot | undefined> {
  let rawReport: string;
  try {
    rawReport = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Unreadable buffer report at ${filePath}: ${errorMessage(error)}`);
  }
  try {
    return BufferSnapshotSchema.parse(JSON.parse(rawReport));
  } catch (error) {
    throw new Error(`Unreadable buffer report at ${filePath}: ${errorMessage(error)}`);
  }
}

/** 上下文读取的中间结果：状态 + 可选的快照或失败原因 */
interface AgentContextRead {
  agentContextStatus: AgentContextReadStatus;
  agentContext?: AgentContextSnapshot;
  agentContextError?: string;
}

/**
 * 读配对的 AgentContextSnapshot，并**把「缺席」与「读不出来」分开**。
 *
 * 分界由快照自己的 `context_snapshot_ref` 决定——那是写入侧在真写下了 context 文件时
 * 才留下的标记（见 saveBufferSnapshot）：
 *
 * - 没有引用 = 历史 Buffer 的正常形态（写入侧确实没做上下文清理），报 `absent`，
 *   允许兼容性降级。**没有引用就一个字都不读**：同一个 seq 上躺着的 `context_N.json`
 *   只可能是「那次写入没提交成功」留下的孤儿，把它读回来当成这条 Buffer 的上下文，
 *   等于把一份不相干的上下文硬绑到一条从没声明过它的报告上。
 * - 有引用但文件缺失 / JSON 损坏 / schema 不匹配 / 引用与所在 seq 对不上 = 声明过的
 *   上下文丢了，一律报 `unreadable` 并带上路径与原因。降级成「本次没有上下文」等于把
 *   丢失藏起来：下游会以为自己拿到的是完整的 DriverReturn + AgentContextSnapshot。
 *
 * 这里刻意**不抛错**：报告那一半仍然可读，调用方需要的是「这一半不可用」这个事实，
 * 而不是连报告一起拿不到。
 */
async function readAgentContextIfPresent(
  snapshot: BufferSnapshot,
  seq: number,
  filePath: string,
): Promise<AgentContextRead> {
  const declaredRef = snapshot.context_snapshot_ref;
  if (declaredRef === undefined) {
    return { agentContextStatus: 'absent' };
  }
  if (declaredRef !== String(seq)) {
    return {
      agentContextStatus: 'unreadable',
      agentContextError:
        `Agent context declared by context_snapshot_ref=${declaredRef} does not belong to Buffer ` +
        `seq=${String(seq)}; refusing to bind ${filePath} to it.`,
    };
  }
  let rawContext: string;
  try {
    rawContext = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      agentContextStatus: 'unreadable',
      agentContextError:
        `Agent context declared by context_snapshot_ref=${declaredRef} is missing or ` +
        `unreadable at ${filePath}: ${errorMessage(error)}`,
    };
  }
  try {
    return {
      agentContextStatus: 'present',
      agentContext: AgentContextSnapshotSchema.parse(JSON.parse(rawContext)),
    };
  } catch (error) {
    return {
      agentContextStatus: 'unreadable',
      agentContextError: `Unreadable agent context at ${filePath}: ${errorMessage(error)}`,
    };
  }
}

function withAgentContext(
  snapshot: BufferSnapshot,
  read: AgentContextRead,
): PendingBufferRead {
  return { snapshot, ...read };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** 先写临时文件再 rename：读侧要么看到旧内容、要么看到新内容，不会读到写了一半的文件。 */
async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, text, 'utf8');

  try {
    await rename(tmpPath, filePath);
  } catch {
    await unlink(filePath).catch(() => undefined);
    await rename(tmpPath, filePath);
  }
}

/**
 * 把 src 搬成 dest，并保证「搬完了」的含义完整：**dest 已写入 且 src 不再存在**。
 *
 * 两个动作是分开的写：先落 dest，再删 src。删 src 失败就是「同一条 Buffer 同时存在于两个
 * 分区」——这不能当成成功：调用方会据此认为它已经离开源分区，而重试又会读到源文件、
 * 再搬一次并重复计数。所以这里抛 PartialMoveError，由调用方如实报成 failed/partial。
 * 重试是安全的：dest 会被同样内容重写（幂等），src 删成功之后才推进计数、才返回成功。
 *
 * src 已经不在了（ENOENT）视作目标态已达成——那正是删除想要的结果，不是失败。
 */
async function moveFile(
  src: string,
  dest: string,
  rewritten?: unknown,
  removeSource: (path: string) => Promise<void> = (path) => unlink(path),
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });

  if (rewritten === undefined) {
    // 无重写：rename 一步到位（src 随 rename 消失）。跨设备 rename 会失败，退化成复制 + 删除。
    try {
      await rename(src, dest);
      return;
    } catch {
      const raw = await readFile(src, 'utf8');
      await writeTextAtomic(dest, raw);
      await removeMovedSource(src, dest, removeSource);
      return;
    }
  }

  await writeJsonAtomic(dest, rewritten);
  await removeMovedSource(src, dest, removeSource);
}

/** 删除搬运后的源文件；删不掉即半成品，抛 PartialMoveError 而不是静默成功。 */
async function removeMovedSource(
  src: string,
  dest: string,
  removeSource: (path: string) => Promise<void>,
): Promise<void> {
  try {
    await removeSource(src);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 源本来就不在：目标态已经达成（上一次尝试删掉了它，或两个调用竞争）
      return;
    }
    throw new PartialMoveError(
      `Buffer was copied to ${dest} but its source copy at ${src} could not be removed ` +
        `(${errorMessage(error)}); it currently exists in both partitions.`,
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读一份配对的 AgentContextSnapshot 并校验它真的可用（JSON 可解析 + schema 通过）。
 *
 * 「文件在」与「内容能用」是两件事：损坏 / schema 不匹配的文件同样算不可用——把
 * 「存在」当成「修好了」，ack 之后这条上下文的损坏就再也没人看得见了。
 */
async function isReadableAgentContext(filePath: string): Promise<boolean> {
  try {
    AgentContextSnapshotSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
    return true;
  } catch {
    return false;
  }
}

/**
 * 搬运配对的 context 文件，并**容忍「上一次尝试已经把它搬过去了」**（幂等重试）。
 *
 * 归档/恢复是两次写（report + context）而不是一个事务。按配对规则，context 先搬、
 * report 后搬，于是「context 已经进了目标分区、report 那一半还没搬」是一个正常的中间态：
 * 重试时 context 的源已经不在、目标却在，这里必须认出来当作已完成，而不是报 ENOENT
 * 让整次重试失败。源与目标都不在才说明上下文真的丢了——那就抛出去，由调用方报 failed。
 */
async function moveFileIdempotent(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (await fileExists(dest))) {
      // 源已不在、目标已在：上一次已经搬过（幂等命中）
      return;
    }
    // 目标已存在（Windows rename 不覆盖）或跨设备：删掉目标再重试一次
    await unlink(dest).catch(() => undefined);
    await rename(src, dest);
  }
}
