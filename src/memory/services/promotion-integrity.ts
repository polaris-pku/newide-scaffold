/**
 * promotion-integrity — 晋升回写那条跨实体引用的完整性规则
 *
 * `completePromotion(outcome='promoted')` 往经验上写 `promoted_to`，而它指向的记录在**另一张
 * 存储里**（内存实现是另一个 AgentStore 的 skills，PG 是 memory_skills 表）。这条引用有几个
 * 必须成立的条件：技能存在、归属同一个 role、且 `promoted_from` 就是这条经验。少了任何一条，
 * 经验上留下的就是一个指向不存在 / 别人的 / 别的来源的技能的指针——它不会自己变好，也没有
 * 任何东西会来修它。
 *
 * 判据写在这里**一次**，两个适配器都调它：适配器只负责「按 id 把技能的事实查出来」（各自的
 * 存储不同），本模块负责「事实算不算合规」以及**不合规时抛什么**。各自实现一遍判据的后果是
 * 内存实现漏掉「来源不符」而 PG 漏掉「存在性」，测试替身于是掩盖了生产差异——这正是 port
 * 契约测试要防的那类事故。
 *
 * 查不出来就传 undefined（读作「不存在」）：调用方因此不必区分「查不动」与「没有」，两者都
 * 不该继续往下写。
 *
 * 抛出的错误是**不可重试**的，种类（以及查到的现状值）放在错误对象上而不是只塞进 message：
 * 递来的是一条不成立的引用，重投多少次它都不成立，能修它的只有人。三个种类分开是为了让
 * 排查的人一眼看出是「技能没了」「技能是别人的」还是「技能来自另一条经验」，而不是去库里
 * 反查。
 */

/** 引用不成立的三种形状 */
export type PromotedSkillViolation = 'missing' | 'other_role' | 'other_source';

/** 技能侧与归属校验有关的事实（适配器查出来交给本模块判） */
export interface PromotedSkillFacts {
  /** 这条技能当前归属的 role_id（被转移到市场池后就是市场池的 role） */
  role_id: string;
  /** 这条技能的来源经验；市场导入等没有来源的技能为 undefined */
  promoted_from?: string | undefined;
}

/** 判据的输入：这条经验想指向哪条技能 */
export interface PromotedSkillExpectation {
  /** 经验归属的 role */
  role_id: string;
  /** 要写入 promoted_to 的那条经验 */
  experience_id: string;
  /** 经验要指向的那条技能 */
  skill_id: string;
}

/** 错误对象上的稳定标识：跨进程/跨实例比对时不必依赖 instanceof */
export const PROMOTION_SKILL_INTEGRITY_CODE = 'promotion_skill_integrity';

/**
 * 「经验要写的那个技能引用」不成立。
 *
 * `code` 是给按字符串判别的调用方（错误可能穿过多层包装）用的稳定标识，`violation` 与
 * 三个现状值给排查的人用。
 */
export class PromotionSkillIntegrityError extends Error {
  readonly code = PROMOTION_SKILL_INTEGRITY_CODE;
  readonly violation: PromotedSkillViolation;
  readonly role_id: string;
  readonly experience_id: string;
  readonly skill_id: string;
  /** 技能实际归属的 role；只在这个技能真的存在时有值 */
  readonly found_role_id?: string | undefined;
  /** 技能实际的来源经验；技能不存在或没有来源时为 undefined */
  readonly found_promoted_from?: string | undefined;

  constructor(
    message: string,
    details: {
      violation: PromotedSkillViolation;
      role_id: string;
      experience_id: string;
      skill_id: string;
      found_role_id?: string | undefined;
      found_promoted_from?: string | undefined;
    },
  ) {
    super(message);
    this.name = 'PromotionSkillIntegrityError';
    this.violation = details.violation;
    this.role_id = details.role_id;
    this.experience_id = details.experience_id;
    this.skill_id = details.skill_id;
    this.found_role_id = details.found_role_id;
    this.found_promoted_from = details.found_promoted_from;
  }
}

/** 这条错误是不是「晋升引用不成立」（按类与稳定 code 双重判定） */
export function isPromotionSkillIntegrityError(
  error: unknown,
): error is PromotionSkillIntegrityError {
  if (error instanceof PromotionSkillIntegrityError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === PROMOTION_SKILL_INTEGRITY_CODE;
}

/**
 * 引用不成立就抛 `PromotionSkillIntegrityError`，成立则什么都不做。
 *
 * 调用方必须让这次判定与最终那笔写入同处一个一致性边界内（内存实现是同一段无 await 的临界区，
 * PG 是 role 临界区加带同样条件的条件写）——在边界之外「先查再写」留下的是一个技能被删掉或
 * 被转走之后引用照样落库的窗口，而那正是本模块要挡的东西。
 */
export function assertPromotedSkillReference(
  expected: PromotedSkillExpectation,
  skill: PromotedSkillFacts | undefined,
): void {
  if (!skill) {
    throw new PromotionSkillIntegrityError(
      `Promotion integrity: skill ${expected.skill_id} does not exist, so experience ${expected.experience_id} cannot be promoted to it.`,
      { violation: 'missing', ...expected },
    );
  }
  if (skill.role_id !== expected.role_id) {
    throw new PromotionSkillIntegrityError(
      `Promotion integrity: skill ${expected.skill_id} belongs to agent ${skill.role_id}, not ${expected.role_id}; experience ${expected.experience_id} cannot be promoted to it.`,
      { violation: 'other_role', ...expected, found_role_id: skill.role_id },
    );
  }
  if (skill.promoted_from !== expected.experience_id) {
    throw new PromotionSkillIntegrityError(
      `Promotion integrity: skill ${expected.skill_id} was promoted from ${skill.promoted_from ?? 'nothing'}, not from experience ${expected.experience_id}.`,
      {
        violation: 'other_source',
        ...expected,
        found_role_id: skill.role_id,
        found_promoted_from: skill.promoted_from,
      },
    );
  }
}
