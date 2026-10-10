/**
 * delivery-error-classification — 把异常映射成「可重试吗」与规范化失败码
 *
 * `failDelivery({ retryable })` 的判定入口是消费方给的，但「哪些异常算可重试」不该每个
 * worker 各写一遍：上下文消费者与反馈消费者对同一个 ZodError 的判断必须一致，否则同一类
 * 坏输入在一条通道上进死信、在另一条上无谓重试三次。
 *
 * 判据刻意只用**结构特征**，不猜异常文本：
 * - 校验失败（ZodError）→ 输入坏了，重投多少次都一样 → 不可重试
 * - 连接/超时类 errno 与 AbortError → 下游或网络的问题 → 可重试
 * - 权限/路径类 errno → 配置永久错 → 不可重试
 * - 其余一律 `unknown` + 可重试：**有上限的重试本身是安全的**（用满次数就进死信），
 *   而把一次瞬时抖动判成永久失败会让交付直接消失。消费方若掌握更多信息（例如知道
 *   这是「策略明确拒绝」），仍可显式传 `retryable: false` 覆盖。
 *
 * 返回的 `message` 已经带上原始原因，直接落进 `last_error` 即可——没有 message 的
 * 失败码在排查时等于没有线索。
 */
import { ZodError } from 'zod';
import type { MaintenanceFailureCode } from '../schemas';

/** 可重试的 errno：对端/网络/瞬时资源问题 */
const TRANSIENT_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAGAIN',
  'EBUSY',
  'EMFILE',
  'ENFILE',
]);

/** 不可重试的 errno：权限、路径与编码问题——重投不会改变结论 */
const PERMANENT_ERRNO = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'EISDIR',
  'ENOTDIR',
  'ENOENT',
  'EINVAL',
  'ENAMETOOLONG',
]);

/** 判定结果：`retryable` 决定退避重投还是直接进死信 */
export interface DeliveryFailureClassification {
  retryable: boolean;
  code: MaintenanceFailureCode;
  message: string;
}

/** 把一个异常（或任意抛出物）分类 */
export function classifyDeliveryFailure(error: unknown): DeliveryFailureClassification {
  if (error instanceof ZodError) {
    return {
      retryable: false,
      code: 'payload_unreadable',
      message: `Delivery payload failed schema validation: ${error.message}`,
    };
  }

  const code = errnoOf(error);
  if (code !== undefined) {
    if (TRANSIENT_ERRNO.has(code)) {
      return { retryable: true, code: 'downstream_unavailable', message: describe(error, code) };
    }
    if (PERMANENT_ERRNO.has(code)) {
      return { retryable: false, code: 'storage_error', message: describe(error, code) };
    }
  }

  if (isAbortError(error)) {
    return { retryable: true, code: 'downstream_unavailable', message: describe(error, 'aborted') };
  }

  return { retryable: true, code: 'unknown', message: describe(error, undefined) };
}

/** 只要那一个问题「要不要重投」时用这个；需要落盘失败码时用 classifyDeliveryFailure */
export function isRetryableDeliveryFailure(error: unknown): boolean {
  return classifyDeliveryFailure(error).retryable;
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function describe(error: unknown, code: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  return code === undefined ? message : `${code}: ${message}`;
}
