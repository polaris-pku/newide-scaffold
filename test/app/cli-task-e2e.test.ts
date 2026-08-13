/**
 * CLI task E2E — 用真实生产组合实际执行一次任务。
 *
 * 目标不是单元测试某个函数，而是验证 memory-cycle 的依赖注入重构
 * （extractBuffer/promoteExperiencesForAgent 改传 extractor/promoter 实例）
 * 在完整 C→B→A 生产链路上没有破坏行为：
 *
 *   1. 任务跑完（run 达到 completed，agent.execution_completed 落盘）
 *   2. B maintenance 自动用 LlmExperienceExtractor 提取经验并持久化
 *   3. 显式 promoteSkills 通过 LlmSkillPromotion 把高置信度经验晋升为 Skill
 *
 * 复用 backend-rpc-stdio.test.ts 的注入配方：fake ACP driver runner +
 * in-memory B runtime + mock LLM，走 createProductionBackendService 真实组合。
 * 不触网、不依赖 PG/docker、CI 可跑。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionBackendService } from '../../src/app/backend-rpc-stdio';
import type { BackendBRuntime } from '../../src/app/production-b-runtime';
import type { BMemoryMaintenanceEvidence } from '../../src/app/b-memory-maintenance-runner';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type EmbeddingProvider,
  type LlmClient,
  type ToolCallingClient,
} from '../../src/memory';
import { writeFakeAcpRunnerBuild } from '../fixtures/fake-acp-runner-build';

const WORKSPACE_AGENT_IDS = ['role_fullstack_engineer', 'role_ts_engineer'] as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI task E2E through the production composition', () => {
  it('runs one task: experience auto-extracted by maintenance and promoted to a Skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-cli-task-e2e-'));
    roots.push(root);
    const runnerDir = path.join(root, 'runner');
    const workspaceDir = path.join(root, 'workspace');
    await mkdir(runnerDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(runnerDir, 'package.json'),
      '{"scripts":{"driver:run":"node fake-driver.mjs"}}',
    );
    await writeFile(path.join(runnerDir, '.env'), 'NEWIDE_B_DATABASE_URL=should-not-leak\n');
    await writeFile(
      path.join(runnerDir, 'fake-driver.mjs'),
      fakeDriverSource,
    );
    writeFakeAcpRunnerBuild(runnerDir, { importFromRunnerRoot: 'fake-driver.mjs' });

    const repository = new InMemoryRepository(alwaysRelevantEmbedding());
    const bufferRepository = new InMemoryBufferRepository();
    const bRuntime: BackendBRuntime = {
      repository,
      bufferRepository,
      app_state_root: path.join(root, '.newide'),
      market_agent_ids: [...WORKSPACE_AGENT_IDS],
      embedding_info: {
        provider: 'test-embedding',
        model: 'test-embedding',
        dimensions: 4,
        readiness: 'verified',
      },
      close: async () => undefined,
    };

    let service: Awaited<ReturnType<typeof createProductionBackendService>> | undefined;
    try {
      service = await createProductionBackendService(
        {
          ACP_DRIVER_RUNNER_DIR: runnerDir,
          NEWIDE_COORDINATION_DB: ':memory:',
          NEWIDE_B_SKILL_AUTO_APPROVE: '1',
        },
        {
          bRuntime,
          agentLlm: invokeDriverLlm(),
          memoryLlm: memoryMaintenanceLlm(),
        },
      );

      // ── 1. 跑一次真实任务（fake driver 执行，走完整 C→B→A） ──
      const created = await service.createRun({
        prompt: 'Create a greeting file and capture a reusable lesson.',
        workspace_path: workspaceDir,
        mode: 'single_agent',
      });
      await service.waitForTerminal(created.run_id);
      const snapshot = service.getSnapshot(created.run_id);

      expect(snapshot.status).toBe('completed');
      const executionCompleted = snapshot.events.find(
        (event) => event.type === 'agent.execution_completed',
      );
      expect(executionCompleted).toMatchObject({
        payload: {
          agent_id: expect.any(String),
          context_pack_ref: expect.stringMatching(/^context_pack_[a-f0-9]{24}$/),
          memory_buffer_ref: expect.stringMatching(/^role_[a-z_]+:[1-9]\d*$/),
          driver_run_result_id: 'driver_result_cli_e2e',
        },
      });
      const agentId = executionCompleted?.payload?.agent_id as string;
      expect(WORKSPACE_AGENT_IDS).toContain(agentId);

      // ── 2. maintenance 自动提取经验并持久化 ──
      const maintenance = await waitForMaintenance(
        service,
        agentId,
        created.run_id,
        10_000,
      );
      expect(maintenance.status).toBe('completed');
      expect(maintenance.kind).toBe('experience_extraction');
      expect(maintenance.experiences.length).toBeGreaterThan(0);

      const experiences = await repository.listExperiences(agentId);
      const promotedCandidate = experiences.find(
        (experience) => experience.confidence > 0.95,
      );
      expect(promotedCandidate).toBeDefined();
      expect(promotedCandidate).toMatchObject({
        content: 'Fake ACP completed the request.',
        promoted_to: undefined,
      });

      // ── 3. 显式晋升：评测配置将高置信度正经验自动批准为可复用 Skill ──
      const promotion = await service.promoteMemorySkills(agentId, 'cli-task-e2e');
      expect(promotion.status).toBe('completed');
      expect(promotion.kind).toBe('skill_promotion');
      expect(promotion.skills.length).toBeGreaterThan(0);

      const promotedSkill = promotion.skills[0];
      expect(promotedSkill).toMatchObject({
        review_status: 'approved',
        reviewed_by: 'system:auto-approval',
        reviewed_at: expect.any(String),
        promoted_from: promotedCandidate!.id,
        content: 'Fake ACP completed the request.',
        market_status: 'available',
      });

      const storedSkills = await repository.listSkills(agentId);
      expect(storedSkills.some((skill) => skill.id === promotedSkill?.id)).toBe(true);
      const storedExperience = (await repository.listExperiences(agentId)).find(
        (experience) => experience.id === promotedCandidate!.id,
      );
      expect(storedExperience?.promoted_to).toBe(promotedSkill?.id);

      // 晋升证据已通过真实的 FileBMemoryMaintenanceEvidenceStore 落盘
      // （组合根在 bRuntime.app_state_root/b/maintenance 下构造）。
      const persistedEvidence = JSON.parse(
        await readFile(
          path.join(root, '.newide', 'b', 'maintenance', `${promotion.maintenance_ref}.json`),
          'utf8',
        ),
      ) as BMemoryMaintenanceEvidence;
      expect(persistedEvidence.status).toBe('completed');
      expect(persistedEvidence.evidence_uri).toContain('maintenance');
    } finally {
      await service?.close();
    }
  }, 30_000);
});

async function waitForMaintenance(
  service: Awaited<ReturnType<typeof createProductionBackendService>>,
  roleId: string,
  runId: string,
  timeoutMs: number,
): Promise<BMemoryMaintenanceEvidence> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evidence = (await service.listMemoryMaintenance(roleId)).find(
      (item) => item.kind === 'experience_extraction' && item.run_id === runId,
    );
    if (evidence && ['completed', 'skipped', 'failed'].includes(evidence.status)) {
      return evidence;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for B maintenance for run ${runId}`);
    }
    await sleep(200);
  }
}

function invokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      const userMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === 'user');
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `cli_e2e_tool_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction:
                  typeof userMessage?.content === 'string'
                    ? userMessage.content.replace(/^Task:\s*/, '')
                    : 'Execute the task.',
              }),
            },
          },
        ],
      };
    },
  };
}

function memoryMaintenanceLlm(): LlmClient {
  let calls = 0;
  return {
    async complete() {
      calls += 1;
      if (calls % 2 === 1) {
        // LlmExperienceExtractor 的提取响应
        return JSON.stringify({
          experiences: [
            {
              description: 'CLI task E2E reusable lesson',
              content: 'Fake ACP completed the request.',
              type: 'positive',
              confidence: 0.99,
              tags: ['cli-e2e'],
            },
          ],
        });
      }
      // LlmSkillPromotion 的晋升响应
      return JSON.stringify({
        description: 'Promoted CLI task E2E lesson',
        content: 'Fake ACP completed the request.',
        tags: ['cli-e2e', 'promoted'],
      });
    },
  };
}

function alwaysRelevantEmbedding(): EmbeddingProvider {
  return {
    dimensions: 4,
    async embed() {
      return [1, 0, 0, 0];
    },
    cosineSimilarity() {
      return 1;
    },
  };
}

const fakeDriverSource = `
import { appendFileSync } from 'node:fs';
let body = '';
process.stdin.on('data', (chunk) => (body += chunk));
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  appendFileSync(new URL('./invocations.log', import.meta.url), 'invoke\\n');
  appendFileSync(new URL('./b-env.log', import.meta.url), Object.hasOwn(process.env, 'NEWIDE_B_DATABASE_URL') ? 'present\\n' : 'absent\\n');
  const created_at = new Date().toISOString();
  const artifact = {
    artifact_id: 'artifact_cli_e2e',
    type: 'driver_result',
    uri: 'artifact://cli-e2e/result',
    producer_id: 'claude-fake',
    task_id: input.task_id,
    created_at,
    schema_version: input.schema_version,
  };
  const transcript = {
    artifact_id: 'transcript_cli_e2e',
    type: 'transcript',
    uri: 'artifact://cli-e2e/transcript',
    producer_id: 'claude-fake',
    task_id: input.task_id,
    created_at,
    schema_version: input.schema_version,
  };
  process.stdout.write(JSON.stringify({
    driver_run_result_id: 'driver_result_cli_e2e',
    session_id: 'session_cli_e2e',
    status: 'succeeded',
    response: 'Fake ACP completed the request.',
    artifacts: [artifact],
    transcript_ref: transcript,
    tool_events: [],
    diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] },
    created_at,
    schema_version: input.schema_version,
  }));
});
`;
