/**
 * role-divergence — 跑后注入门禁的判定语义
 *
 * 单列一个无依赖模块，是因为它要被离线测试直接 import：`run.ts` 顶层会调 `main()`
 * 起后端，测试不能碰它。
 *
 * 门禁回答的问题是「操纵变量（该 role_id 名下的技能/persona）有没有真的进这一格」。
 * 角色格注入为空即判失败；但**白板对照格**（`role_neutral`）名下按定义没有任何技能，
 * 它的零注入就是控制条件本身，必须放行——判错它会连坐 `review_neutral` /
 * `review_role`（两者都拿这份白板 plan 当被审对象），整轮在第一个 plan 格就崩掉。
 */
import type { PartyKey } from './types';

export type InjectionGateOutcome =
  | { kind: 'ok' }
  | { kind: 'control' }
  | { kind: 'zero_forbidden'; reason: string };

/**
 * @param roleKey     该格的角色键（`neutral` 为白板对照）
 * @param skillCount  跑后从 context pack 读回的真实注入技能数
 * @param allowEmpty  CLI `--allow-empty-injection`：明知角色格注入为空仍要看产出
 * @param queryHits   `query_memory` 每次返回的技能条数，用于区分「没查」与「查了没命中」
 * @param roleId      用于诊断信息的 role_id
 */
export function evaluateInjectionGate(input: {
  roleKey: PartyKey;
  skillCount: number;
  allowEmpty: boolean;
  queryHits?: readonly number[] | undefined;
  roleId?: string | undefined;
}): InjectionGateOutcome {
  // 对照格：零注入是控制条件，永远放行（也不该被 --allow-empty-injection 掩盖，
  // 它本来就不需要那个开关）。
  if (input.roleKey === 'neutral') return { kind: 'control' };

  if (input.skillCount > 0 || input.allowEmpty) return { kind: 'ok' };

  return {
    kind: 'zero_forbidden',
    reason:
      `zero injected skills: the manipulated variable is absent from this cell ` +
      `(role_id=${input.roleId ?? input.roleKey}, ` +
      `query_memory hits=${JSON.stringify(input.queryHits ?? [])}); ` +
      `pass --allow-empty-injection to accept it deliberately`,
  };
}
