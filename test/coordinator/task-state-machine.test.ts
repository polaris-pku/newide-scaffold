import { describe, expect, it } from 'vitest';
import { TASK_STATUSES } from '../../src/core';
import {
  assertTaskRunStartTransition,
  assertTaskStatusTransition,
  isTerminalTaskStatus,
  listNonTerminalTaskStatuses,
  transitionTaskStatus,
} from '../../src/coordinator/task-state-machine';

describe('coordinator task state machine', () => {
  it('uses the single core TaskStatus contract', () => {
    expect(TASK_STATUSES).toEqual([
      'created',
      'triaged',
      'ready',
      'claimed',
      'running',
      'waiting_help',
      'waiting_input',
      'pending_gate',
      'pending_council',
      'reviewing',
      'blocked',
      'escalated',
      'merging',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect([...listNonTerminalTaskStatuses(), 'completed', 'failed', 'cancelled']).toEqual(
      TASK_STATUSES,
    );
  });

  it('allows the spec-c v0 happy path', () => {
    expect(transitionTaskStatus('created', 'claimed')).toMatchObject({
      previous_status: 'created',
      next_status: 'claimed',
    });
    expect(transitionTaskStatus('claimed', 'running').next_status).toBe('running');
    expect(transitionTaskStatus('running', 'reviewing').next_status).toBe('reviewing');
    expect(transitionTaskStatus('reviewing', 'merging').next_status).toBe('merging');
    expect(transitionTaskStatus('merging', 'completed').next_status).toBe('completed');
    expect(transitionTaskStatus('running', 'completed').next_status).toBe('completed');
  });

  it('allows the v0 waiting and blocked paths', () => {
    expect(transitionTaskStatus('running', 'waiting_input').next_status).toBe('waiting_input');
    expect(transitionTaskStatus('running', 'pending_gate').next_status).toBe('pending_gate');
    expect(transitionTaskStatus('running', 'pending_council').next_status).toBe('pending_council');
    expect(transitionTaskStatus('waiting_input', 'running').next_status).toBe('running');
    expect(transitionTaskStatus('pending_gate', 'running').next_status).toBe('running');
    expect(transitionTaskStatus('pending_gate', 'blocked').next_status).toBe('blocked');
    expect(transitionTaskStatus('pending_council', 'reviewing').next_status).toBe('reviewing');
    expect(transitionTaskStatus('pending_council', 'waiting_input').next_status).toBe(
      'waiting_input',
    );
    expect(transitionTaskStatus('pending_council', 'blocked').next_status).toBe('blocked');
    expect(transitionTaskStatus('reviewing', 'blocked').next_status).toBe('blocked');
    expect(transitionTaskStatus('blocked', 'running').next_status).toBe('running');
  });

  it('allows any non-terminal state to cancel and rejects terminal rollback', () => {
    const nonTerminalStates = [
      'created',
      'claimed',
      'running',
      'waiting_input',
      'pending_gate',
      'pending_council',
      'reviewing',
      'merging',
      'blocked',
    ] as const;

    for (const status of nonTerminalStates) {
      expect(transitionTaskStatus(status, 'cancelled').next_status).toBe('cancelled');
    }

    expect(isTerminalTaskStatus('completed')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('blocked')).toBe(false);
    expect(() => assertTaskStatusTransition('completed', 'running')).toThrow(
      'Invalid task status transition: completed -> running',
    );
  });

  it('rejects transitions outside the spec-c v0 state machine', () => {
    expect(() => assertTaskStatusTransition('created', 'running')).toThrow(
      'Invalid task status transition: created -> running',
    );
    expect(() => assertTaskStatusTransition('waiting_input', 'completed')).toThrow(
      'Invalid task status transition: waiting_input -> completed',
    );
    expect(() => assertTaskStatusTransition('pending_gate', 'completed')).toThrow(
      'Invalid task status transition: pending_gate -> completed',
    );
  });

  it('allows an active run to fail during review or merge', () => {
    expect(transitionTaskStatus('reviewing', 'failed').next_status).toBe('failed');
    expect(transitionTaskStatus('merging', 'failed').next_status).toBe('failed');
  });

  it('allows completed -> running only for an explicit Council refinement Run', () => {
    expect(() => assertTaskStatusTransition('completed', 'running')).toThrow();
    expect(() => assertTaskRunStartTransition('completed', 'council_refinement')).not.toThrow();
    expect(() => assertTaskRunStartTransition('failed', 'council_refinement')).toThrow();
    expect(() => assertTaskRunStartTransition('blocked', 'checkpoint_resume')).not.toThrow();
  });
});
