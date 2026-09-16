/**
 * repo-checkout — 给 driver 一份**只读的、钉在 base_commit 的**仓库副本
 *
 * 背景：角色分歧实验早期完全不给 driver 仓库（工作区是空目录），agent 只能凭题目文本
 * 推测文件路径；`plan.md` 自己也标注了「File paths below are the expected locations」。
 * 本模块让 driver 真正能读代码，同时不破坏实验的两条控制：
 *
 * 1. **不泄漏金标**：副本由 `ensureRepoMirror` + `prepareEphemeralWorktree` 产出，
 *    `prepareEphemeralWorktree` 刻意做 `--no-tags --single-branch` 并删 remote/reflog，
 *    所以 agent 无法通过 git 历史读到目标 release 的 diff（`eval/prepare-worktree.ts` 注释）。
 * 2. **不污染工作区快照**：副本**挂在工作区之外**，再用 junction/symlink 挂到
 *    `<workspace>/repo`。Node 的 `readdir(..., {withFileTypes:true})` 对 Windows junction
 *    报 `isSymbolicLink()=true, isDirectory()=false`（本机实测），而
 *    `snapshotWorkspaceFiles` 只收 `entry.isFile()`，因此**不会遍历**这棵子树——
 *    每格两次全仓 stat 扫描的成本被完全避开，交付物里也不会混进仓库文件。
 *
 * 前提：镜像里必须有该 instance 的 `base_commit`。本地没有镜像时先跑
 * `pnpm eval:ensure-sweevo-mirrors`（需要网络取 dask/dask）。
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SweEvoInstance } from '../types';
import { ensureRepoMirror, mirrorPathForRepo } from '../ensure-repo-mirror';
import { prepareEphemeralWorktree } from '../prepare-worktree';

const execFileAsync = promisify(execFile);

/** 挂进工作区的目录名；prompt 模板里逐字承诺过这个名字 */
export const REPO_MOUNT_NAME = 'repo';

/**
 * 一次实验内所有单元共用的仓库副本根：`<result_root>/driver-repos/<owner__name>@<sha12>`。
 *
 * **必须带 commit 后缀**：`full` 阶段的三个实例都是 `dask/dask`，只是 base_commit 不同。
 * 只按仓库名取名会让三份副本争同一个目录——`ensureDriverRepo` 会发现里面没有本实例的
 * commit，于是每换一个实例就把副本整个拆掉重建（实测一次约 8 MB 网络取数）。
 * 批次是按角色切的、每批都含全部实例，所以这种抖动会发生在**几乎每一格**上。
 * 带上 commit 后每个实例各有一份，建一次、之后逐格复用。
 */
export function driverRepoRoot(resultRoot: string, repo: string, baseCommit?: string): string {
  const base = repo.replaceAll('/', '__');
  const suffix = baseCommit?.trim() ? `@${baseCommit.trim().slice(0, 12)}` : '';
  return path.join(resultRoot, 'driver-repos', `${base}${suffix}`);
}

export interface PreparedDriverRepo {
  /** 共享的只读副本（一个 instance 一份，不是每格一份） */
  canonicalPath: string;
  /** 本格工作区里的挂载点 `<workspace>/repo` */
  mountPath: string;
  base_commit: string;
  head_commit: string;
}

export interface EnsureDriverRepoOptions {
  /** 本地 dask clone 的路径；省略则用/建 mirror（需要网络） */
  sourceRepo?: string;
  /** mirror 根覆盖；默认 `.newide/eval-mirrors` */
  mirrorsRoot?: string;
  log?: (message: string) => void;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 100 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return stdout.trim();
}

/**
 * 不稳网络下的 git 设置。
 *
 * 实测过：`git clone` 一个完整 dask 镜像会中途死于
 * `curl 56 OpenSSL SSL_read: unexpected eof` / `early EOF`——单个约 100 MB 的 pack 被
 * 长连接中断。这里用**环境变量**而不是 `git config --global`：后者要写
 * `~/.gitconfig`，文件被占用或只读时会直接报 `could not lock config file` 并中断。
 * 环境变量只影响本次子进程，无副作用、不碰用户全局配置。
 *
 * 实测：真正解决问题的是 `fetchSingleCommitMirror` 的浅取（8.2 MB vs ~100 MB），
 * 这几条只是让**回落的全量 clone** 在抖动网络下更容易成功，所以全是尽力而为。
 */
function networkGitEnv(): NodeJS.ProcessEnv {
  return {
    GIT_HTTP_VERSION: 'HTTP/1.1',
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '60',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * 只取**需要的那一个 commit**，而不是整部历史。
 *
 * 全量 clone 在长连接被掐时会整体失败；这里改取 `--depth=1 --single-branch`，
 * 传输量降到"一棵工作树"量级。代价是镜像变成 shallow（无历史）——对本实验无害：
 * prompt 明确禁止用 git 历史，而且 shallow 反而更彻底地挡掉了目标 release 的 diff。
 *
 * `--depth=1 <sha>` 需要服务端允许按 SHA 浅取（GitHub 支持）。失败就返回 undefined，
 * 由调用方回落到全量 clone，所以这条路径不会让事情变得更糟。
 */
async function fetchSingleCommitMirror(
  repo: string,
  baseCommit: string,
  mirrorPath: string,
  log?: (message: string) => void,
): Promise<boolean> {
  await fs.rm(mirrorPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
  const url = `https://github.com/${repo.trim()}.git`;
  const env = networkGitEnv();
  try {
    log?.(`targeted fetch: --depth=1 at ${baseCommit.slice(0, 12)} (avoids the full history)`);
    // 空仓 + 浅取单个 commit：传输量≈一棵工作树，而不是整部历史
    // （实测 dask @ 0cbc46ac：8.2 MB / 9 秒，且 blob 随树一起到手，checkout 不必再联网）
    //
    // **非 bare**：`prepareEphemeralWorktree` 的 `findGitRoot` 用
    // `git rev-parse --show-toplevel` 定位源仓库，而这对 bare 仓库必然失败
    // （bare 没有工作树）。`git clean`/`clone --no-checkout` 两者在这个形态下同样可用，
    // 所以这里保持与 `ensureRepoMirror` 一致的"有工作树目录、但不检出内容"。
    await git('.', ['init', mirrorPath]);
    await git(mirrorPath, ['remote', 'add', 'origin', url]);
    await git(mirrorPath, ['fetch', '--depth', '1', 'origin', baseCommit], env);
    // `--no-local` 克隆需要一个可解析的 ref，而不只是 FETCH_HEAD
    await git(mirrorPath, ['update-ref', 'refs/heads/newide-base', 'FETCH_HEAD']);
    return true;
  } catch (error) {
    log?.(`targeted fetch failed (${String(error).slice(0, 140)}); retrying with a full clone`);
    await fs.rm(mirrorPath, { recursive: true, force: true });
    return false;
  }
}

/** 该路径是否是一个可用的、含 `baseCommit` 的 git 仓库 */
async function usableSource(candidate: string, baseCommit: string): Promise<boolean> {
  if (!existsSync(candidate)) return false;
  try {
    await git(candidate, ['rev-parse', '--verify', `${baseCommit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 保证存在一份钉在 `base_commit` 的仓库副本。幂等：已有且 commit 正确就直接复用。
 *
 * 解析顺序：显式 `sourceRepo` → 本地 mirror → 建 mirror（联网）。
 */
export async function ensureDriverRepo(
  instance: SweEvoInstance,
  resultRoot: string,
  options: EnsureDriverRepoOptions = {},
): Promise<string> {
  const baseCommit = instance.base_commit?.trim();
  if (!baseCommit) {
    throw new Error(
      `Instance ${instance.instance_id} has no base_commit; cannot check out a repo for the driver.`,
    );
  }
  const canonicalPath = driverRepoRoot(resultRoot, instance.repo, baseCommit);

  if (await usableSource(canonicalPath, baseCommit)) return canonicalPath;

  // 全量克隆回落到 `ensureRepoMirror`，它内部自己 spawn git——把网络设置放进 process.env，
  // 让那条路径也享受同样的抖动容忍（子进程默认继承）。
  Object.assign(process.env, networkGitEnv());

  const explicit = options.sourceRepo?.trim();
  const mirrorPath = mirrorPathForRepo(instance.repo, options.mirrorsRoot);
  /** 解析得到的源；`shallow` 标记它是"省流量"的可选优化，失败可以退回全量 */
  let source: { path: string; shallow: boolean };

  if (explicit) {
    if (!(await usableSource(explicit, baseCommit))) {
      throw new Error(
        `--repo-source "${explicit}" is not a git repo containing ${baseCommit}. ` +
          'Point it at a clone of the instance repo (e.g. a local dask checkout with full history).',
      );
    }
    source = { path: explicit, shallow: false };
    options.log?.(`repo source (explicit): ${explicit}`);
  } else if (await usableSource(mirrorPath, baseCommit)) {
    source = { path: mirrorPath, shallow: false };
    options.log?.(`repo source (mirror): ${mirrorPath}`);
  } else {
    // 先试「只取一个 commit」：全量 clone 在长连接被掐时会整体失败（实测过
    // `curl 56 … unexpected eof`），而本实验只需要 base_commit 那一棵树。
    const targeted = await fetchSingleCommitMirror(
      instance.repo,
      baseCommit,
      mirrorPath,
      options.log,
    );
    if (targeted && (await usableSource(mirrorPath, baseCommit))) {
      source = { path: mirrorPath, shallow: true };
      options.log?.(`repo source (shallow mirror @ ${baseCommit.slice(0, 12)}): ${mirrorPath}`);
    } else {
      options.log?.(
        `fetching full mirror ${instance.repo} (needs network, may take minutes; retry is safe)`,
      );
      const mirror = await ensureRepoMirror({
        repo: instance.repo,
        baseCommit,
        ...(options.mirrorsRoot ? { mirrorsRoot: options.mirrorsRoot } : {}),
      });
      source = { path: mirror.mirrorPath, shallow: false };
      options.log?.(`repo source (fresh full mirror): ${source.path}`);
    }
  }

  const runId = `role-divergence-${instance.instance_id}`.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
  const prepareFrom = async (sourceRepo: string): Promise<string> => {
    options.log?.(`preparing read-only checkout at ${baseCommit.slice(0, 12)} …`);
    const prepared = await prepareEphemeralWorktree({
      sourceRepo,
      baseCommit,
      runId,
      outRoot: path.dirname(canonicalPath),
    });
    // prepareEphemeralWorktree 固定产出 <outRoot>/repo；搬成我们约定的名字
    if (path.resolve(prepared.worktreePath) !== path.resolve(canonicalPath)) {
      await fs.rm(canonicalPath, { recursive: true, force: true });
      await fs.rename(prepared.worktreePath, canonicalPath).catch(async () => {
        // 跨设备 rename 会失败：退化为复制
        await fs.cp(prepared.worktreePath, canonicalPath, { recursive: true });
        await fs.rm(prepared.worktreePath, { recursive: true, force: true });
      });
    }
    return canonicalPath;
  };

  // 浅源只是省流量的优化，不是正确性前提。而且它的失败模式与全量镜像**不同**——
  // 实测过一次：mirror 用 `git init --bare` 建时，下游 `findGitRoot` 的
  // `rev-parse --show-toplevel` 对 bare 仓库必然失败。所以这里对任何准备失败都回落，
  // 而不是只对"浅"这一种情况特判。
  try {
    return await prepareFrom(source.path);
  } catch (error) {
    if (explicit) {
      // 源是用户显式给的，回落到联网镜像会掩盖配置错误
      throw error;
    }
    options.log?.(
      `preparing a worktree from ${source.shallow ? 'the shallow' : 'the local mirror'} source ` +
        `failed (${String(error).slice(0, 160)}); falling back to a full mirror`,
    );
  }

  await fs.rm(mirrorPath, { recursive: true, force: true });
  const mirror = await ensureRepoMirror({
    repo: instance.repo,
    baseCommit,
    ...(options.mirrorsRoot ? { mirrorsRoot: options.mirrorsRoot } : {}),
  });
  options.log?.(`repo source (full mirror retry): ${mirror.mirrorPath}`);
  return prepareFrom(mirror.mirrorPath);
}

async function mountInto(target: string, source: string, kind: 'junction' | 'dir'): Promise<void> {
  // 同 run.ts 的工作区清理：Windows 上刚被放开的目录可能仍报 EBUSY/EPERM，
  // 默认 0 次重试会把一次瞬时占用升级成整轮失败。
  await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (kind === 'junction') {
    try {
      await fs.symlink(source, target, 'junction');
      return;
    } catch {
      // 无权限/文件系统不支持 → 退化为复制
    }
  }
  await fs.cp(source, target, { recursive: true });
}

/**
 * 把仓库挂进本格工作区（幂等），返回可写进证据的来源信息。
 *
 * 挂在**工作区之外**的 canonical 副本上，工作区里只留一个链接；`snapshotWorkspaceFiles`
 * 不会遍历链接（见文件头注释），所以既无扫描成本、也不会把仓库文件当交付物。
 */
export async function mountDriverRepo(
  instance: SweEvoInstance,
  workspace: string,
  resultRoot: string,
  options: EnsureDriverRepoOptions = {},
): Promise<PreparedDriverRepo> {
  const canonicalPath = await ensureDriverRepo(instance, resultRoot, options);
  const mountPath = path.join(workspace, REPO_MOUNT_NAME);

  await mountInto(mountPath, canonicalPath, 'junction');
  if (!existsSync(path.join(mountPath, 'setup.py')) && !existsSync(path.join(mountPath, 'pyproject.toml'))) {
    // junction 失败后 mountInto 已退化为复制；再确认一次内容确实在
    throw new Error(`Repo mount at ${mountPath} looks empty; checkout may have failed.`);
  }
  const head = await git(mountPath, ['rev-parse', 'HEAD']).catch(() => 'unknown');
  return {
    canonicalPath,
    mountPath,
    base_commit: instance.base_commit,
    head_commit: head,
  };
}
