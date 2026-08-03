/**
 * Skill Review 调用示例 — reviewSkill 端到端演示
 *
 * 展示 Skill 晋升后的审批链路：
 *   种子经验 → ruleBasedSkillPromotion 晋升为 pending Skill
 *   → 列出 pending Skills
 *   → reviewSkill 批准其中一条（approved）
 *   → reviewSkill 拒绝另一条（rejected，并解除来源经验 promoted_to）
 *   → 验证 approved Skill 从下一次任务起自动进入检索
 *
 * 运行：npx tsx src/memory/mvp/skill-review-demo.ts
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import { reviewSkill } from '../services/skill-review';
import { retrieveMemoriesForTask } from '../adapters/memory-retrieval';
import type { ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';

const ROLE_ID = 'role_fe';
const REVIEWER = 'human-ops';

/** 构造一条高置信度正经验（满足晋升门槛 confidence > 0.95） */
function makeExperience(description: string, tags: string[]): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description,
    description_embedding: [],
    content: `已验证的解决方案：${description}`,
    confidence: 0.99,
    tags,
    agent_id: ROLE_ID,
    confidence_history: [{ value: 0.99, updated_at: now, reason: 'seed' }],
    referenced_count: 5,
    source_task_id: 'task_seed',
    source_driver: 'code-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
  };
}

async function main(): Promise<void> {
  const embedding = new HashEmbeddingProvider();
  const repository = new InMemoryRepository(embedding);
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id: ROLE_ID, name: '前端工程师', tags: ['css'] });
  const memory = createAgentMemoryScope(repository, bufferRepository, ROLE_ID);

  // ── Step 1: 种子经验 + 晋升为 pending Skill ──
  const expA = makeExperience('使用 CSS Grid 实现响应式布局', ['css', 'layout']);
  const expB = makeExperience('用 Flexbox 修复表单按钮错位', ['css', 'form']);
  await repository.saveExperience(ROLE_ID, expA);
  await repository.saveExperience(ROLE_ID, expB);

  const task: AgentTaskRequest = { spec: 'CSS 布局修复', task_id: 'task_001' };
  const outcomeA = await ruleBasedSkillPromotion(memory, task, [expA]);
  const outcomeB = await ruleBasedSkillPromotion(memory, task, [expB]);

  if (!outcomeA.skill || !outcomeB.skill) {
    console.error('晋升失败，预期两条 pending Skill');
    process.exitCode = 1;
    return;
  }

  console.log('=== 1. 晋升结果（均为 pending，等待审批）===');
  for (const outcome of [outcomeA, outcomeB]) {
    console.log(`  [pending] ${outcome.skill!.description}  (id=${outcome.skill!.id})`);
  }

  // ── Step 2: 审批 — 批准一条、拒绝一条 ──
  const approved = await reviewSkill(repository, {
    role_id: ROLE_ID,
    skill_id: outcomeA.skill.id,
    decision: 'approved',
    reviewer: REVIEWER,
  });
  const rejected = await reviewSkill(repository, {
    role_id: ROLE_ID,
    skill_id: outcomeB.skill.id,
    decision: 'rejected',
    reviewer: REVIEWER,
  });

  console.log('\n=== 2. reviewSkill 审批结果 ===');
  console.log(`  [approved] ${approved.description}`);
  console.log(`    review_status=${approved.review_status}, reviewed_by=${approved.reviewed_by}, reviewed_at=${approved.reviewed_at}`);
  console.log(`  [rejected] ${rejected.description}`);
  console.log(`    review_status=${rejected.review_status}, reviewed_by=${rejected.reviewed_by}`);

  // ── Step 3: 拒绝后来源经验 promoted_to 已解除，可重新晋升 ──
  const expBAfter = (await repository.listExperiences(ROLE_ID)).find((e) => e.id === expB.id);
  console.log('\n=== 3. 拒绝后的来源经验绑定 ===');
  console.log(`  expB.promoted_to = ${expBAfter!.promoted_to ?? 'undefined（已解除，可重新晋升）'}`);

  // ── Step 4: 下一次任务检索 — 只有 approved 进入 Context ──
  const retrieval = await retrieveMemoriesForTask(memory, { task_query: 'css 布局 修复' });
  console.log('\n=== 4. 下一次 Agent 任务的记忆检索 ===');
  console.log(`  入选 skills: ${retrieval.skills.length} 个`);
  for (const skill of retrieval.skills) {
    console.log(`    [retrieved] ${skill.description} (review_status=${skill.review_status})`);
  }

  // ── Step 5: 状态机校验 — 非 pending 再审批会抛错 ──
  console.log('\n=== 5. 严格状态机：重复审批已 approved 的 Skill ===');
  try {
    await reviewSkill(repository, {
      role_id: ROLE_ID,
      skill_id: approved.id,
      decision: 'rejected',
      reviewer: REVIEWER,
    });
  } catch (error) {
    console.log(`  [throws] ${(error as Error).message}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
