/**
 * lease-heartbeat — 长任务的 lease 续租心跳
 *
 * 交付的 claim 带租约：处理时间超过租约、又不续租的记录，会被启动恢复判成「持有者
 * 不见了」而回收给别人。所以任何可能跑得比租约久的消费者都必须续租——而续租失败的
 * 含义只有一个：**这条记录已经不归我了**。它可能已经被别人接手，只是我自己还不知道。
 * 于是心跳把「续租被拒」收敛成一个状态位交给调用方，由调用方决定不再写终态（见
 * context-delivery-processor）：这是 fencing 在消费者一侧的落点。
 *
 * 定时器可注入：测试用一份手动触发的实现就能精确制造「续租成功 / 续租失败 / 处理途中
 * 租约被抢走」，不必依赖真实时钟。停止是异步的——它等当前在途的那次续租结束，这样
 * 「停下来之后看 lost」不会读到还没落地的结果。
 */

/**
 * 心跳用的定时器接口。
 *
 * 只声明这一对方法（而不是接收整个 `setInterval`），是为了让测试能塞一份完全同步、
 * 由用例手动触发的实现：`vi.useFakeTimers()` 与异步续租混在一起时，断言「第 N 次
 * 续租发生了什么」要反复冲洗微任务队列，很容易写出偶发失败的测试。
 */
export interface LeaseTimers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 生产实现：真定时器，且不把进程钉在事件循环上——心跳是保活，不是待办工作 */
export const SYSTEM_LEASE_TIMERS: LeaseTimers = {
  setInterval: (handler, ms) => {
    const handle = setInterval(handler, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * 续租间隔：租约的三分之一。
 *
 * 留两次余量给慢调用与调度抖动——按「租约一半」去续，一次续租卡住就正好踩在过期线上；
 * 三分之一意味着连续两次续租都能失败才有记录被回收的风险。
 */
export function leaseRenewIntervalMs(lease_ms: number): number {
  return Math.max(1, Math.floor(lease_ms / 3));
}

export interface LeaseHeartbeat {
  /**
   * 是否已经失去租约：续租被拒（凭据失效 / 租约已过期）或续租抛错。
   *
   * 一旦为 true 就不再翻转——失去的持有权不会自己回来，重新拿到要靠下一次 claim 与
   * 一个新的 token。
   */
  readonly lost: boolean;
  /** 停止心跳并等待在途的续租结束；可重复调用 */
  stop(): Promise<void>;
}

export interface LeaseHeartbeatOptions {
  /** 续租一次；返回 false 表示写不进去（凭据不再有效） */
  renew: () => Promise<boolean>;
  interval_ms: number;
  timers?: LeaseTimers;
  /** 续租抛错时的回调（诊断用）；缺省只体现为 lost */
  onError?: (error: unknown) => void;
}

/**
 * 起一个心跳。
 *
 * 每次 tick 串在同一个 promise 链上：续租慢的时候不会堆叠出并发调用（对同一条记录
 * 连发两次续租没有意义，还会放大存储压力）。异常与「返回 false」在调用方看来是同一件
 * 事——租约没了——但异常仍交给 onError，免得存储故障被静默地读成「正常被抢走」。
 */
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): LeaseHeartbeat {
  const timers = options.timers ?? SYSTEM_LEASE_TIMERS;
  let lost = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    if (stopped || lost) return;
    inFlight = inFlight.then(async () => {
      if (stopped || lost) return;
      try {
        if (!(await options.renew())) lost = true;
      } catch (error) {
        lost = true;
        options.onError?.(error);
      }
    });
  };

  const handle = timers.setInterval(tick, options.interval_ms);

  return {
    get lost(): boolean {
      return lost;
    },
    async stop(): Promise<void> {
      stopped = true;
      timers.clearInterval(handle);
      await inFlight;
    },
  };
}
