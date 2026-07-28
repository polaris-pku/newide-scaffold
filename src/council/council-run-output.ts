/**
 * Council run output helper.
 *
 * 只负责 `.newide/runs/<run_id>/council/` 下 CouncilRunResult 相关文件的路径和写入。
 * 不创建 decision，不调用 provider，也不参与 C runner 主流程决策。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunId } from '../core';
import type { CouncilRunResult } from './contract';

export interface CouncilRunOutputPaths {
  council_dir: string;
  proposals_path: string;
  reviews_path: string;
  synthesis_path: string;
  decision_path: string;
  output_path: string;
  result_path: string;
}

export interface WriteCouncilRunOutputsInput {
  paths: CouncilRunOutputPaths;
  result: CouncilRunResult;
}

export function buildCouncilRunOutputPaths(
  runId: RunId,
  runsRoot = '.newide/runs',
): CouncilRunOutputPaths {
  const councilDir = path.join(runsRoot, runId, 'council');
  return {
    council_dir: councilDir,
    proposals_path: path.join(councilDir, 'proposals.json'),
    reviews_path: path.join(councilDir, 'reviews.json'),
    synthesis_path: path.join(councilDir, 'synthesis.json'),
    decision_path: path.join(councilDir, 'decision.json'),
    output_path: path.join(councilDir, 'output.json'),
    result_path: path.join(councilDir, 'result.json'),
  };
}

export async function writeCouncilRunOutputs(
  input: WriteCouncilRunOutputsInput,
): Promise<CouncilRunOutputPaths> {
  await fs.mkdir(input.paths.council_dir, { recursive: true });
  await fs.writeFile(
    input.paths.proposals_path,
    JSON.stringify(input.result.proposals, null, 2),
    'utf-8',
  );
  await fs.writeFile(
    input.paths.reviews_path,
    JSON.stringify(input.result.reviews, null, 2),
    'utf-8',
  );
  if (input.result.synthesis) {
    await fs.writeFile(
      input.paths.synthesis_path,
      JSON.stringify(input.result.synthesis, null, 2),
      'utf-8',
    );
  }
  await fs.writeFile(
    input.paths.decision_path,
    JSON.stringify(input.result.decision, null, 2),
    'utf-8',
  );
  if (input.result.output) {
    await fs.writeFile(
      input.paths.output_path,
      JSON.stringify(input.result.output, null, 2),
      'utf-8',
    );
  }
  if (input.result.result) {
    await fs.writeFile(
      input.paths.result_path,
      JSON.stringify(input.result.result, null, 2),
      'utf-8',
    );
  }
  return input.paths;
}
