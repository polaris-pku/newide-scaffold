/**
 * `run.getPayload` 的读取端口：按 `payload_ref` 把 driver 事件流的原始行取回来。
 *
 * 为什么需要它：投影时超过 8 KiB 的大字段（工具 `raw_input` / `raw_output` / content、
 * 长 stderr、大 chunk）**不内联**，只在载荷里留一个指回 `driver-stream.jsonl` 原始行的
 * 引用。取回工具（`resolveDriverStreamRef`）一直存在，但此前**没有对外出口**——
 * 于是前端能看见「有个引用」，却永远拿不到引用指向的内容。
 *
 * 与 `RunArtifactContentReader` 同款：窄端口 + 文件实现，由组装点注入。
 */
import type { DriverStreamEvent } from '../driver/contract';
import { resolveDriverStreamRef } from './driver-stream-refs';

export interface RunPayloadReader {
  read(runId: string, payloadRef: string): Promise<DriverStreamEvent | undefined>;
}

export class FileRunPayloadReader implements RunPayloadReader {
  constructor(private readonly runsRoot = '.newide/runs') {}

  read(runId: string, payloadRef: string): Promise<DriverStreamEvent | undefined> {
    return resolveDriverStreamRef(this.runsRoot, runId, payloadRef);
  }
}
