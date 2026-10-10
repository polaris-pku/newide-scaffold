/**
 * 交付失败分类测试（Phase 0）
 *
 * 分类只认结构特征（ZodError / errno / AbortError），所以每条用例都用真实的异常形状
 * 构造，而不是靠 message 文本对号入座——文本一改，按文本判定的测试会静默失效。
 *
 * 最要紧的一条是「未知一律可重试」：把一次瞬时抖动判成永久失败，交付就直接消失了；
 * 反过来只是多试几次（次数有上限，用满即死信）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  classifyDeliveryFailure,
  isRetryableDeliveryFailure,
} from '../services/delivery-error-classification';

function errno(code: string): Error {
  return Object.assign(new Error(`${code} from the downstream store`), { code });
}

describe('classifyDeliveryFailure', () => {
  it('校验失败不可重试：输入坏了，重投多少次都一样', () => {
    const error = new z.ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        path: ['delivery_id'],
        message: 'Required',
      },
    ]);
    const classified = classifyDeliveryFailure(error);
    expect(classified).toMatchObject({ retryable: false, code: 'payload_unreadable' });
    expect(classified.message).toContain('schema validation');
  });

  it('连接与超时类 errno 可重试', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']) {
      expect(classifyDeliveryFailure(errno(code))).toMatchObject({
        retryable: true,
        code: 'downstream_unavailable',
      });
    }
  });

  it('权限与路径类 errno 不可重试：重投改不了结论', () => {
    for (const code of ['EACCES', 'EPERM', 'ENOENT', 'EINVAL']) {
      expect(classifyDeliveryFailure(errno(code))).toMatchObject({
        retryable: false,
        code: 'storage_error',
      });
    }
  });

  it('中止/超时的 AbortError 可重试', () => {
    const aborted = Object.assign(new Error('operation was aborted'), { name: 'AbortError' });
    expect(classifyDeliveryFailure(aborted)).toMatchObject({
      retryable: true,
      code: 'downstream_unavailable',
    });
    // 消息里带上标记，排查时看得出这是被中断而不是普通的失败
    expect(classifyDeliveryFailure(aborted).message).toContain('aborted');
  });

  it('认不出来的失败一律可重试：宁可多重投几次（有上限），也不让交付无声消失', () => {
    expect(classifyDeliveryFailure(new Error('something odd'))).toMatchObject({
      retryable: true,
      code: 'unknown',
    });
    expect(classifyDeliveryFailure('thrown as a bare string')).toMatchObject({
      retryable: true,
      code: 'unknown',
    });
    expect(classifyDeliveryFailure(undefined)).toMatchObject({
      retryable: true,
      code: 'unknown',
    });
  });

  it('isRetryableDeliveryFailure 是与分类器同一套判断的便捷入口', () => {
    expect(isRetryableDeliveryFailure(errno('ECONNREFUSED'))).toBe(true);
    expect(isRetryableDeliveryFailure(errno('EACCES'))).toBe(false);
  });
});
