/**
 * plan — 阶段 → 批次的编排（无副作用，可单测）
 *
 * 「批次」= 一个后端进程 + 它名下的若干单元。抽出来的原因有二：run.ts 在被 import
 * 时就会执行 main()，不宜被测试引用；而阶段规模与交叉矩阵是最该被机器守住的东西。
 */
import type { CorpusRole } from '../../src/memory';
import type { SweEvoInstance } from '../types';
import { buildReviewCells } from './shuffle';
import type { CellKey, PartyKey } from './types';

export type Stage = 'probe' | 'minimal' | 'full';

export interface Batch {
  roleKey: PartyKey;
  keys: CellKey[];
}

export function buildBatches(
  stage: Exclude<Stage, 'probe'>,
  instances: SweEvoInstance[],
  roles: CorpusRole[],
): Batch[] {
  if (stage === 'minimal') {
    const instance = instances[0]!;
    return roles.map((role) => ({
      roleKey: role,
      keys: [{ experiment: 'plan_role', instance_id: instance.instance_id, role_key: role }],
    }));
  }

  const planNeutral: Batch = {
    roleKey: 'neutral',
    keys: instances.map((instance) => ({
      experiment: 'plan_neutral' as const,
      instance_id: instance.instance_id,
      role_key: 'neutral' as const,
    })),
  };
  // plan 批必须全部先跑完：评审批要读它们的产出
  const planBatches: Batch[] = roles.map((role) => ({
    roleKey: role,
    keys: instances.map((instance) => ({
      experiment: 'plan_role' as const,
      instance_id: instance.instance_id,
      role_key: role,
    })),
  }));
  const reviewBatches: Batch[] = roles.map((role) => ({
    roleKey: role,
    keys: [
      ...instances.map((instance) => ({
        experiment: 'review_neutral' as const,
        instance_id: instance.instance_id,
        role_key: role,
      })),
      ...instances.flatMap((instance) =>
        buildReviewCells(instance.instance_id, roles)
          .filter((pair) => pair.reviewer === role)
          .map((pair) => ({
            experiment: 'review_role' as const,
            instance_id: instance.instance_id,
            role_key: pair.reviewer,
            author_key: pair.author,
          })),
      ),
    ],
  }));

  return [planNeutral, ...planBatches, ...reviewBatches];
}
