import type { TaskCreateRequest } from '../core';

export function createDefaultTaskRequest(spec?: string): TaskCreateRequest {
  return {
    spec: spec || 'Run the integration v0 flow',
    role_id: 'role_ts_engineer',
    risk_level: 'low',
    affected_paths: ['src/**'],
    completion_criteria: ['integration v0 flow completes successfully'],
  };
}
