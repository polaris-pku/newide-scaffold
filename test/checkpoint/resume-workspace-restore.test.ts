import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { TaskProcessor } from '../../src/coordination';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import type { CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { SqliteCoordinationStore } from '../../src/persistence';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(workspace: string): void {
  git(workspace, ['init', '-q']);
  git(workspace, ['config', 'user.email', 'test@example.com']);
  git(workspace, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');
  git(workspace, ['add', '-A']);
  git(workspace, ['commit', '-qm', 'base']);
}

describe('resume restores workspace content from the checkpoint anchor', () => {
  it('restores agent output that was lost after the interrupt, and audits it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-resume-restore-'));
    const workspace = await realpath(root);
    const runsRoot = path.join(root, '.runs');
    const databasePath = path.join(root, 'coordination.sqlite');
    initRepo(workspace);

    const store = new SqliteCoordinationStore(databasePath);
    const processor = new TaskProcessor(store);
    const requestStore = new FileRunRequestStore(runsRoot);

    let resumeRunnerCalls = 0;
    const runner: CoordinatorRunner = {
      run: async (request) => {
        resumeRunnerCalls += 1;
        request.onRunCreated?.({
          run_id: `run_${resumeRunnerCalls}`,
          task_id: request.task_id ?? 'task_restore',
        });
        return new Promise<IntegrationV0Result>(() => undefined);
      },
    };
    const service = new NewideBackendService(
      runner,
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      requestStore,
      processor,
    );

    try {
      processor.beginRun({
        task_id: 'task_restore',
        run_id: 'run_interrupted',
        task_request: {
          spec: 'Produce a file, get killed, resume',
          completion_criteria: ['agent output survives the interrupt'],
        },
        workspace_path: workspace,
        mode: 'single_agent',
      });

      // The agent produces output, then the backend is interrupted. The safepoint
      // written during recovery is what must capture this content.
      writeFileSync(path.join(workspace, 'agent-output.txt'), 'expensive result\n');
      writeFileSync(path.join(workspace, 'seed.txt'), 'agent edited seed\n');
      processor.recoverInterruptedTasks();

      const checkpoint = store.getLatestCheckpoint('task_restore');
      expect(checkpoint?.mechanical_snapshot.snapshot_commit).toMatch(/^[0-9a-f]{40}$/);

      // Simulate losing the workspace state: output deleted, edit reverted.
      await rm(path.join(workspace, 'agent-output.txt'));
      writeFileSync(path.join(workspace, 'seed.txt'), 'seed\n');

      await service.resumeTask('task_restore');

      expect(readFileSync(path.join(workspace, 'agent-output.txt'), 'utf8')).toBe(
        'expensive result\n',
      );
      expect(readFileSync(path.join(workspace, 'seed.txt'), 'utf8')).toBe('agent edited seed\n');

      const restoreEvent = processor
        .listTaskEvents('task_restore')
        .find((event) => event.type === 'checkpoint.workspace_restored');
      expect(restoreEvent).toBeDefined();
      expect(restoreEvent?.payload).toMatchObject({
        status: 'restored',
        checkpoint_id: checkpoint?.checkpoint_id,
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records a skipped restore instead of pretending, for a non-Git workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-resume-plain-'));
    const workspace = await realpath(root);
    const runsRoot = path.join(root, '.runs');

    const store = new SqliteCoordinationStore(path.join(root, 'coordination.sqlite'));
    const processor = new TaskProcessor(store);
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_plain', task_id: 'task_plain' });
          return new Promise<IntegrationV0Result>(() => undefined);
        },
      },
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      processor,
    );

    try {
      processor.beginRun({
        task_id: 'task_plain',
        run_id: 'run_interrupted',
        task_request: { spec: 'No git here', completion_criteria: ['resume still proceeds'] },
        workspace_path: workspace,
        mode: 'single_agent',
      });
      processor.recoverInterruptedTasks();

      await service.resumeTask('task_plain');

      const restoreEvent = processor
        .listTaskEvents('task_plain')
        .find((event) => event.type === 'checkpoint.workspace_restored');
      expect(restoreEvent?.payload).toMatchObject({
        status: 'skipped',
        reason: 'anchor_not_recoverable',
      });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
