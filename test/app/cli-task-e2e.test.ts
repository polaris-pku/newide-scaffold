/**
 * CLI task E2E — 用真实生产组合实际执行一次任务，验证交付边界。
 *
 * 验证的是「任务流程只生产输入，外部系统拥有记忆更新」这条边界在完整
 * C→B→A 生产链路上成立：
 *
 *   1. 任务跑完（run 达到 completed，agent.execution_completed 落盘）
 *   2. 本进程**不**提取经验、不晋升、不演化 Persona（没有消融标签 = 生产路径）
 *   3. 下游能按稳定引用读回完整 DriverReturn + AgentContextSnapshot
 *   4. 人工入口 memory.promoteSkills 仍在，但主链没有隐式副作用
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
  InMemoryMemoryDeliveryRepository,
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
  it('runs one task: hands the downstream system a delivery and never waits for it', async () => {
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
      deliveryRepository: new InMemoryMemoryDeliveryRepository(),
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

      // ── 1b. Run 创建点冻结的 driver 配置逐 Run 落进 request.json ──
      // 零配置下就是那个历史 driver，并且是**非敏感投影**：只有 id 与 agent。
      const persistedRequest = JSON.parse(
        await readFile(
          path.join(process.cwd(), '.newide', 'runs', created.run_id, 'request.json'),
          'utf8',
        ),
      ) as { driver_config?: Record<string, unknown> };
      expect(persistedRequest.driver_config).toMatchObject({
        default_driver: 'acp-external',
        drivers: { 'acp-external': 'claude' },
      });
      expect(Object.keys(persistedRequest.driver_config ?? {}).sort()).toEqual([
        'default_driver',
        'drivers',
      ]);

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

      // ── 2. 任务流程不在本进程加工记忆 ──
      // 生产路径只交付上下文；Experience 提取 / Skill 晋升 / Persona 演化由外部
      // Memory Maintenance 系统负责。这条运行没有任何消融标签，所以走后一条路。
      expect(await repository.listExperiences(agentId)).toEqual([]);
      expect(await repository.listSkills(agentId)).toEqual([]);

      const deliveryEvidence = (await service.listMemoryMaintenance(agentId)).find(
        (item) => item.run_id === created.run_id,
      );
      expect(deliveryEvidence).toMatchObject({
        kind: 'context_delivery',
        status: 'scheduled',
        role_id: agentId,
      });

      // ── 3. 下游能从稳定引用读回完整输入 ──
      const deliveries = await service.listMemoryContextDeliveries({ role_id: agentId });
      expect(deliveries).toHaveLength(1);
      const delivery = deliveries[0]!;
      expect(delivery.task_id).toBe(executionCompleted?.payload?.task_id ?? delivery.task_id);
      expect(delivery.memory_buffer_ref).toBe(`${agentId}:${String(delivery.buffer_seq)}`);
      expect(delivery.context_snapshot_ref).toBe(String(delivery.buffer_seq));

      const payload = await service.getMemoryContextDelivery(agentId, delivery.delivery_id);
      expect(payload?.payload_available).toBe(true);
      // DriverReturn 由驱动器自报（fake ACP 未给六字段报告，转换器按构造补全）
      expect(String(payload?.driver_return?.summary)).toContain('claude-fake');
      expect(payload?.driver_return?.artifacts).toHaveLength(1);
      // 上下文集成了对：清理器把顶层对话压成了 thinking/planning 两段
      expect(String(payload?.agent_context?.thinking_trace)).toContain('Cleaned the top-level');
      expect(payload?.agent_context?.source_task_id).toBe(delivery.task_id);

      // ── 4. 人工晋升入口仍在，但主链没有隐式副作用：没有经验可晋升就是空结果 ──
      const promotion = await service.promoteMemorySkills(agentId, 'cli-task-e2e');
      expect(promotion.status).toBe('completed');
      expect(promotion.kind).toBe('skill_promotion');
      expect(promotion.skills).toEqual([]);
      expect(await repository.listSkills(agentId)).toEqual([]);

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

/**
 * B 侧文本 LLM 的替身。
 *
 * 按**提示词里问的是什么**分派，不按调用次序分派：这条链上现在有三个消费者
 * （上下文清理 / 经验提取 / 技能晋升），谁先谁后是执行路径的实现细节，
 * 用奇偶轮次认人会在下一个消费者接进来时静默答错题。
 */
function memoryMaintenanceLlm(): LlmClient {
  return {
    async complete(input) {
      const userMessage = input.messages.find((message) => message.role === 'user')?.content ?? '';
      if (userMessage.includes('## Raw Agent Context')) {
        // LlmContextCleaner 的清理响应
        return JSON.stringify({
          thinking_trace: 'Cleaned the top-level context for the CLI task E2E run.',
          planning_trace: 'Step 1: delegate to the driver. Step 2: report the lesson.',
        });
      }
      if (userMessage.includes('## Experience to promote')) {
        // LlmSkillPromotion 的晋升响应
        return JSON.stringify({
          description: 'Promoted CLI task E2E lesson',
          content: 'Fake ACP completed the request.',
          tags: ['cli-e2e', 'promoted'],
        });
      }
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
