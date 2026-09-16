/**
 * cache — 单元证据的落盘、跳过与汇总
 *
 * 目录约定（均相对 `<result_root>`）：
 *   cells/<cell_id>.json        单元证据（原子写：先 .tmp 再 rename）
 *   workspaces/<cell_id>/      driver 的 scratch 工作区（含 plan.md / review.md）
 *   backend/<role_key>/        后端 state_root 与 runs/
 *   injection/<key>.json       注入证据
 *   cells.jsonl / summary.json 汇总，运行结束整体重写（不做追加，避免重跑重复）
 *
 * 「跳过已完成」是本次实验的防 API 漂移手段：同一单元重跑不重复调用，除非 --force。
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { CellEvidence } from './types';

export function cellsDir(root: string): string {
  return path.join(root, 'cells');
}

export function cellPath(root: string, cellIdValue: string): string {
  return path.join(cellsDir(root), `${sanitize(cellIdValue)}.json`);
}

export function workspacePath(root: string, cellIdValue: string): string {
  return path.join(root, 'workspaces', sanitize(cellIdValue));
}

export function injectionPath(root: string, key: string): string {
  return path.join(root, 'injection', `${sanitize(key)}.json`);
}

/** 某角色的后端 state_root（B 记忆的运行产物、context pack 都在其下） */
export function backendStateRoot(root: string, roleKey: string): string {
  return path.join(root, 'backend', sanitize(roleKey));
}

/** 某角色后端写出的 context pack 目录 */
export function contextPacksDir(root: string, roleKey: string): string {
  return path.join(backendStateRoot(root, roleKey), 'b', 'context-packs');
}

export async function readCell(filePath: string): Promise<CellEvidence | undefined> {
  return readJson<CellEvidence>(filePath);
}

export async function writeCell(filePath: string, evidence: CellEvidence): Promise<void> {
  await writeJson(filePath, evidence);
}

/** 递归收集全部单元证据，按 cell_id 稳定排序 */
export async function collectCells(root: string): Promise<CellEvidence[]> {
  const directory = cellsDir(root);
  if (!existsSync(directory)) return [];
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const cells: CellEvidence[] = [];
  for (const name of files) {
    const cell = await readJson<CellEvidence>(path.join(directory, name));
    if (cell) cells.push(cell);
  }
  return cells;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, 'utf8');
}

/**
 * driver 工作区内生效的 Claude Code 权限 deny 规则。
 *
 * **读工具是否可用，取决于本轮实验形态：**
 *
 * - **无仓库形态（默认，历史行为）**：工作区是空 scratch 目录，读与跑命令都无意义，
 *   于是整类关掉。本任务只需**写出**一个 plan / review 文件——问题陈述与待审 plan
 *   都由 prompt 送进来。**只关 `Bash` 不够**：`Read ../../../role-divergence-runs/cells.jsonl`
 *   照样通，读工具必须一起关。写保护 `.claude/**` 是防止 agent 反手改掉这份 deny 列表。
 * - **有仓库形态（`--repo-checkout`）**：仓库只读挂在 `<workspace>/repo`，driver 需要
 *   `Read`/`Glob`/`Grep` 去真读代码，才能给出有依据的 plan。此时只留 `Bash` 与网络工具
 *   被禁——`Bash` 是当年烧穿预算的元凶（agent 会无限 `ls/find` 找东西），读工具则是本轮
 *   的目的；网络必须继续封，否则 `WebFetch` 抓得到上游 PR diff，等于把金标喂进 plan。
 *
 * 执行者是 Claude Code 自己：claude-agent-acp 的 SettingsManager 监视
 * `<workspace>/.claude/settings.json` 并解析 `permissions.deny`，不经 ACP 权限门。
 */
export const DRIVER_WORKSPACE_DENY_RULES = [
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Write(./.claude/**)',
  'Edit(./.claude/**)',
];

/**
 * 有仓库形态的 deny 列表：放开读工具，仍封 `Bash`/网络/仓库写。
 *
 * `Write(./repo/**)`/`Edit(./repo/**)` 是**双保险**：副本本身在工作区之外，
 * agent 即便写也只改到副本，不会污染 canonical 树；但显式禁掉能让「只读」变成契约
 * 而不是巧合，也让 `.claude` 的 deny 列表自成一份可审计的说明。
 */
export const DRIVER_WORKSPACE_DENY_RULES_WITH_REPO = [
  'Bash',
  'WebFetch',
  'WebSearch',
  'Write(./.claude/**)',
  'Edit(./.claude/**)',
  'Write(./repo/**)',
  'Edit(./repo/**)',
];

export function driverWorkspaceSettings(
  options: { repoCheckout?: boolean } = {},
): { permissions: { deny: string[] } } {
  return {
    permissions: {
      deny: [
        ...(options.repoCheckout
          ? DRIVER_WORKSPACE_DENY_RULES_WITH_REPO
          : DRIVER_WORKSPACE_DENY_RULES),
      ],
    },
  };
}

/** driver 启动前，把权限 deny 列表写进它的工作区 */
export async function writeDriverWorkspaceSettings(
  workspace: string,
  options: { repoCheckout?: boolean } = {},
): Promise<void> {
  await writeJson(
    path.join(workspace, '.claude', 'settings.json'),
    driverWorkspaceSettings(options),
  );
}

/** 清空一个已完成单元，供 --force 重跑 */
export async function clearCell(root: string, cellIdValue: string): Promise<void> {
  const file = cellPath(root, cellIdValue);
  if (existsSync(file)) await fs.rm(file);
}

export function sanitize(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
}
