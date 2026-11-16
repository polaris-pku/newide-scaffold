/** 未决 unknown 的收束语义：零变更的只读超时不应阻塞 completed。 */
import { describe, expect, it } from 'vitest';
import {
  resolveBlockingUnresolvedDispatchIds,
  resolveUnresolvedDispatchIds,
} from '../../src/app/role-autonomy-contract';
import type { DispatchRecord } from '../../src/driver';

function record(input: {
  id: string;
  status: DispatchRecord['status'];
  kind?: 'investigate' | 'execute' | 'verify';
  read_only?: boolean;
  changed?: string[];
  coverage?: 'complete' | 'partial' | 'unavailable';
  retry_of?: string;
}): DispatchRecord {
  return {
    dispatch_id: input.id,
    status: input.status,
    brief: {
      kind: input.kind ?? 'execute',
      retry_of: input.retry_of,
      read_only: input.read_only ?? false,
    },
    evidence:
      input.changed === undefined
        ? undefined
        : {
            workspace_delta: {
              changed_paths: input.changed,
              coverage: input.coverage ?? 'complete',
            },
          },
  } as unknown as DispatchRecord;
}

describe('resolveBlockingUnresolvedDispatchIds', () => {
  it('keeps an unknown with workspace changes as blocking', () => {
    const records = [
      record({ id: 'dsp_a', status: 'unknown', kind: 'verify', changed: ['a.py'] }),
    ];
    expect(resolveUnresolvedDispatchIds(records)).toEqual(['dsp_a']);
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual(['dsp_a']);
  });

  it('does not block on a verify unknown whose complete delta is empty', () => {
    const records = [record({ id: 'dsp_a', status: 'unknown', kind: 'verify', changed: [] })];
    expect(resolveUnresolvedDispatchIds(records)).toEqual(['dsp_a']);
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual([]);
  });

  it('does not block on a read-only investigate unknown whose complete delta is empty', () => {
    const records = [
      record({
        id: 'dsp_a',
        status: 'unknown',
        kind: 'investigate',
        read_only: true,
        changed: [],
      }),
    ];
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual([]);
  });

  it('keeps an execute unknown with an empty delta as blocking', () => {
    const records = [record({ id: 'dsp_a', status: 'unknown', changed: [] })];
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual(['dsp_a']);
  });

  it('keeps a verify unknown without evidence as blocking', () => {
    const records = [record({ id: 'dsp_a', status: 'unknown', kind: 'verify' })];
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual(['dsp_a']);
  });

  it('keeps a verify unknown with partial delta as blocking', () => {
    const records = [
      record({
        id: 'dsp_a',
        status: 'unknown',
        kind: 'verify',
        changed: [],
        coverage: 'partial',
      }),
    ];
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual(['dsp_a']);
  });

  it('treats a trusted retry as resolved before the harmless filter', () => {
    const records = [
      record({ id: 'dsp_a', status: 'unknown', kind: 'verify', changed: [] }),
      record({ id: 'dsp_b', status: 'succeeded', changed: [], retry_of: 'dsp_a' }),
    ];
    expect(resolveBlockingUnresolvedDispatchIds(records)).toEqual([]);
  });
});
