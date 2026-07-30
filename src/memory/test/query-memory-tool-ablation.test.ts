import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import {
  resolveMemoryAblationPolicy,
  runWithMemoryAblationPolicy,
} from '../ablation-policy';
import { QueryMemoryTool } from '../runtime/tools/query-memory-tool';
import type { ExperienceRecord, SkillRecord } from '../schemas';

describe('QueryMemoryTool ablation', () => {
  it('respects ALS include_skills / include_recent_experience', async () => {
    const repository = new InMemoryRepository();
    const buffer = new InMemoryBufferRepository();
    const roleId = 'role_ablation';
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    await buffer.ensureAgent(roleId);

    const skill: SkillRecord = {
      id: 'skill_1',
      description: 'Runtime skill for ablation query',
      description_embedding: [],
      content: 'Skill content must not leak under B1.',
      version: '1.0.0',
      review_status: 'approved',
      tags: ['runtime', 'ablation'],
      promoted_at: new Date().toISOString(),
      agent_id: roleId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const experience: ExperienceRecord = {
      id: 'exp_1',
      description: 'Runtime experience for ablation query',
      description_embedding: [],
      content: 'Experience content is allowed under B1.',
      confidence: 0.9,
      tags: ['runtime', 'ablation'],
      agent_id: roleId,
      confidence_history: [],
      referenced_count: 0,
      source_task_id: 'task_seed',
      source_driver: 'seed',
      type: 'positive',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await repository.saveSkill(roleId, skill);
    await repository.saveExperience(roleId, experience);

    const tool = new QueryMemoryTool(createAgentMemoryScope(repository, buffer, roleId));
    const query = 'runtime ablation query';

    const b1 = await runWithMemoryAblationPolicy(resolveMemoryAblationPolicy('B1'), () =>
      tool.execute({ query }),
    );
    expect(b1.skills).toHaveLength(0);
    expect(b1.experiences.length).toBeGreaterThan(0);

    const b0 = await runWithMemoryAblationPolicy(resolveMemoryAblationPolicy('B0'), () =>
      tool.execute({ query }),
    );
    expect(b0.skills).toHaveLength(0);
    expect(b0.experiences).toHaveLength(0);

    const b2 = await runWithMemoryAblationPolicy(resolveMemoryAblationPolicy('B2'), () =>
      tool.execute({ query }),
    );
    expect(b2.skills.length).toBeGreaterThan(0);
    expect(b2.experiences.length).toBeGreaterThan(0);
  });
});
