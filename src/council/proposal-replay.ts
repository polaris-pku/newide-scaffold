/**
 * 提案冻结 / 回放。
 *
 * "同流程、开 / 关评审"的对照实验要求两臂共享同一份提案，只差评审环节；但提案由
 * LLM 生成，两次运行不可能一致，连提案者的记忆检索与 context pack 都不同。
 *
 * 这里从一次已完成的 Council 运行读回它的提案包（synthesizer pack：
 * `<pack>/proposals.json` 加 `<pack>/inputs/<artifact_id>/<target_path>`），重建
 * `CouncilRunRequest` 的 proposals 与 candidate_artifacts。provider 见到
 * agent_id 已在 input.proposals 中的提案者会跳过该角色，于是本轮的提案阶段不再
 * 重新生成，评审者看到的方案文件也与冻结时逐字节相同。
 *
 * 只读取，不写入源包；回放不改变席位映射、合成契约或评审开关。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../core';
import type { CouncilRunRequest, Proposal } from './contract';

export const COUNCIL_REPLAY_ENV = 'NEWIDE_COUNCIL_REPLAY_DIR';
export const COUNCIL_REPLAY_PROPOSALS_FILE = 'proposals.json';
/** 契约产物在执行者工作区的相对目录：`inputs/<artifact_id>/<target_path>`。 */
export const COUNCIL_REPLAY_INPUTS_DIR = 'inputs';

export interface CouncilProposalReplay {
  source_dir: string;
  proposals: Proposal[];
  candidate_artifacts: ArtifactRef[];
}

/** 环境变量里的冻结包目录；未设置或空白返回 undefined。 */
export function readCouncilProposalReplayDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[COUNCIL_REPLAY_ENV]?.trim();
  return raw ? raw : undefined;
}

/**
 * 读取冻结包。任何会让"两臂提案一致"这一前提失效的情况都直接抛错，不做兜底：
 * 缺 proposals.json、提案缺 agent_id（会导致该提案者重新生成提案）、产物没有
 * 恰好一个落盘文件。
 */
export async function loadCouncilProposalReplay(dir: string): Promise<CouncilProposalReplay> {
  const sourceDir = path.resolve(dir);
  const proposalsPath = path.join(sourceDir, COUNCIL_REPLAY_PROPOSALS_FILE);
  const proposals = normalizeReplayProposals(await readJsonFile(proposalsPath), proposalsPath);

  const candidateArtifacts: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const proposal of proposals) {
    for (const artifactId of proposal.artifact_refs) {
      if (seen.has(artifactId)) continue;
      seen.add(artifactId);
      candidateArtifacts.push(await rebuildArtifact(sourceDir, artifactId, proposal));
    }
  }
  if (candidateArtifacts.length === 0) {
    throw new Error(`Council replay pack ${sourceDir} lists no proposal artifacts`);
  }
  return { source_dir: sourceDir, proposals, candidate_artifacts: candidateArtifacts };
}

/** 用冻结提案替换本轮提案与候选产物，其余字段逐字保留。 */
export async function applyCouncilProposalReplay(
  input: CouncilRunRequest,
  dir: string,
): Promise<CouncilRunRequest> {
  const replay = await loadCouncilProposalReplay(dir);
  return {
    ...input,
    proposals: replay.proposals,
    candidate_artifacts: replay.candidate_artifacts,
  };
}

function normalizeReplayProposals(value: unknown, source: string): Proposal[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.proposals)
      ? value.proposals
      : undefined;
  if (!list || list.length === 0) {
    throw new Error(`Council replay pack ${source} contains no proposals array`);
  }
  return list.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Council replay pack ${source} proposal #${String(index)} is not an object`);
    }
    const agentId = typeof entry.agent_id === 'string' ? entry.agent_id.trim() : '';
    if (!agentId) {
      throw new Error(
        `Council replay pack ${source} proposal #${String(index)} has no agent_id; replaying it would regenerate the proposal instead of reusing it`,
      );
    }
    const artifactRefs = Array.isArray(entry.artifact_refs)
      ? entry.artifact_refs.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    if (artifactRefs.length === 0) {
      throw new Error(
        `Council replay pack ${source} proposal ${String(entry.proposal_id ?? index)} has no artifact_refs`,
      );
    }
    return entry as unknown as Proposal;
  });
}

async function rebuildArtifact(
  sourceDir: string,
  artifactId: string,
  proposal: Proposal,
): Promise<ArtifactRef> {
  const artifactDir = path.join(sourceDir, COUNCIL_REPLAY_INPUTS_DIR, artifactId);
  const staged = await listRelativeFiles(artifactDir);
  if (staged.length === 0) {
    throw new Error(
      `Council replay pack ${sourceDir} has no staged file for artifact ${artifactId} under ${artifactDir}`,
    );
  }
  if (staged.length > 1) {
    throw new Error(
      `Council replay pack ${sourceDir} artifact ${artifactId} has ${String(staged.length)} staged files (${staged.join(', ')}); replay requires exactly one per artifact`,
    );
  }
  const targetPath = staged[0]!;
  return {
    artifact_id: artifactId,
    // 与 collectWorkspaceArtifacts 落库时的形状一致：type=patch + kind=file + target_path。
    type: 'patch',
    uri: `artifact://council-replay/${artifactId}`,
    producer_id: proposal.agent_id ?? 'council_replay',
    ...(proposal.task_id ? { task_id: proposal.task_id } : {}),
    content: {
      kind: 'file',
      content_ref: pathToFileURL(path.join(artifactDir, targetPath)).href,
      target_path: targetPath,
      media_type: 'text/markdown',
    },
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!entries) return [];
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await listRelativeFiles(full)) {
        found.push(path.posix.join(entry.name, nested));
      }
    } else if (entry.isFile()) {
      found.push(entry.name);
    }
  }
  return found.sort();
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Council replay pack ${file} not found; point NEWIDE_COUNCIL_REPLAY_DIR at a completed Council pack directory`,
      );
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
