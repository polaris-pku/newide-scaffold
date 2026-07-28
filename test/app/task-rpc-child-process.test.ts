import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AppRunEvent } from '../../src/app/run-registry';
import type { TaskSnapshot } from '../../src/protocol/task-snapshot';

describe('Task-first JSON-RPC child process acceptance', () => {
  it('runs create and autonomous Council under one durable Task', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-task-rpc-runner-'));
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'newide-task-rpc-workspace-'));
    const createdRunIds = new Set<string>();
    const marketDirectories = new Set<string>();
    writeFakeDriver(runnerDir);
    const client = new RpcChildClient(spawnBackend(runnerDir));
    let restartedClient: RpcChildClient | undefined;

    try {
      await expect(client.call('system.ping')).resolves.toMatchObject({ status: 'ok' });
      const created = await client.call<TaskSnapshot>('task.create', {
        spec: 'Produce a result and then validate it with Council',
        completion_criteria: ['The autonomous Council produces a final artifact'],
        workspace_path: workspace,
      });
      expect(created.task.status).toBe('running');
      expect(created.current_run?.task_id).toBe(created.task.task_id);
      collectEvidence(created, createdRunIds, marketDirectories);

      const firstTerminal = await waitForTerminalTask(client, created.task.task_id);
      expect(firstTerminal.task.status).toBe('completed');
      expect(firstTerminal.run_history).toHaveLength(1);
      collectEvidence(firstTerminal, createdRunIds, marketDirectories);
      const firstExperiences = await waitForExperiences(
        client,
        'role_ts_engineer',
        created.task.task_id,
      );
      expect(firstExperiences).toMatchObject({
        experiences: [expect.objectContaining({ source_task_id: created.task.task_id })],
      });
      await client.call('task.subscribe', { task_id: created.task.task_id });

      const councilStarted = await client.call<TaskSnapshot>('task.startCouncil', {
        task_id: created.task.task_id,
      });
      expect(councilStarted.task.task_id).toBe(created.task.task_id);
      expect(councilStarted.current_run).toMatchObject({ mode: 'council', status: 'running' });
      expect(councilStarted.run_history).toHaveLength(1);
      collectEvidence(councilStarted, createdRunIds, marketDirectories);

      const councilTerminal = await waitForTerminalTask(client, created.task.task_id);
      collectEvidence(councilTerminal, createdRunIds, marketDirectories);
      expect(councilTerminal.task.status).toBe('completed');
      expect(councilTerminal.run_history).toHaveLength(2);
      expect(councilTerminal.council).toMatchObject({
        status: 'completed',
        result: {
          quality: expect.stringMatching(/^(verified|best_effort)$/),
          final_artifact_ref: expect.any(String),
          final_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(readFileSync(path.join(workspace, 'council-output.txt'), 'utf-8')).toContain(
        'COUNCIL_FINAL',
      );

      const agents = await client.call<{ agents: Array<{ role_id: string }> }>(
        'memory.listAgents',
        {},
      );
      expect(agents.agents.map((agent) => agent.role_id)).toEqual(
        expect.arrayContaining([
          'role_ts_engineer',
          'proposer_a',
          'proposer_b',
          'reviewer',
          'synthesizer',
        ]),
      );
      const maintenance = await waitForMaintenance(client, [
        'role_ts_engineer',
        'proposer_a',
        'proposer_b',
        'reviewer',
        'synthesizer',
      ]);
      expect(maintenance.maintenance.map((item) => item.role_id)).toEqual(
        expect.arrayContaining([
          'role_ts_engineer',
          'proposer_a',
          'proposer_b',
          'reviewer',
          'synthesizer',
        ]),
      );
      expect(maintenance.maintenance).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'completed', evidence_uri: expect.stringMatching(/^file:/) }),
        ]),
      );
      await expect(
        client.call('memory.promoteSkills', {
          role_id: 'role_ts_engineer',
          requested_by: 'acceptance',
        }),
      ).resolves.toMatchObject({
        maintenance: {
          status: 'completed',
          skills: expect.arrayContaining([
            expect.objectContaining({ review_status: 'pending' }),
          ]),
        },
      });
      await expect(
        client.call('memory.listSkills', { role_id: 'role_ts_engineer' }),
      ).resolves.toMatchObject({
        skills: expect.arrayContaining([
          expect.objectContaining({ review_status: 'pending' }),
        ]),
      });

      const liveCouncilEvents = client.taskEvents(created.task.task_id);
      const replayCursor = liveCouncilEvents.find((event) => event.type === 'run.created');
      expect(replayCursor).toBeDefined();
      expect(liveCouncilEvents.at(-1)).toMatchObject({ type: 'run.completed' });

      await client.close();
      restartedClient = new RpcChildClient(spawnBackend(runnerDir));
      await expect(restartedClient.call('system.ping')).resolves.toMatchObject({ status: 'ok' });
      await expect(
        restartedClient.call<TaskSnapshot>('task.get', { task_id: created.task.task_id }),
      ).resolves.toEqual(councilTerminal);
      const replayed = await restartedClient.call<{ replay_events: AppRunEvent[] }>(
        'task.subscribe',
        {
          task_id: created.task.task_id,
          after_event_id: replayCursor?.event_id,
        },
      );
      expect(replayed.replay_events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'run.completed' })]),
      );

      const listed = await restartedClient.call<{ tasks: TaskSnapshot[] }>('task.list', {});
      expect(
        listed.tasks.filter((task) => task.task.task_id === created.task.task_id),
      ).toHaveLength(1);
    } finally {
      await client.close();
      await restartedClient?.close();
      rmSync(runnerDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      for (const runId of createdRunIds) {
        rmSync(path.join('.newide', 'runs', runId), { recursive: true, force: true });
        rmSync(path.join('.newide', 'council', runId), { recursive: true, force: true });
      }
      for (const directory of marketDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it('blocks an interrupted process and resumes it explicitly under the same Task', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-task-resume-runner-'));
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'newide-task-resume-workspace-'));
    const holdPath = path.join(runnerDir, 'hold-first-invocation');
    const enteredPath = path.join(runnerDir, 'first-invocation-entered');
    const sessionLogPath = path.join(runnerDir, 'sessions.log');
    const runIds = new Set<string>();
    const marketDirectories = new Set<string>();
    writeInterruptibleFakeDriver(runnerDir);
    writeFileSync(holdPath, 'hold');
    const firstClient = new RpcChildClient(spawnBackend(runnerDir));
    let resumedClient: RpcChildClient | undefined;

    try {
      const created = await firstClient.call<TaskSnapshot>('task.create', {
        spec: 'Resume this Task after the backend process is interrupted',
        completion_criteria: ['The same Task completes in a new Run after explicit resume'],
        workspace_path: workspace,
        session_id: 'session_resume_e2e',
      });
      expect(created).toMatchObject({
        task: { status: 'running' },
        current_run: { status: 'running', session_id: 'session_resume_e2e' },
      });
      collectEvidence(created, runIds, marketDirectories);
      await waitForFile(enteredPath);

      await firstClient.kill();
      rmSync(holdPath, { force: true });
      resumedClient = new RpcChildClient(spawnBackend(runnerDir));
      await expect(resumedClient.call('system.ping')).resolves.toMatchObject({ status: 'ok' });

      const blocked = await resumedClient.call<TaskSnapshot>('task.get', {
        task_id: created.task.task_id,
      });
      expect(blocked).toMatchObject({
        task: { task_id: created.task.task_id, status: 'blocked' },
        run_history: [
          {
            run_id: created.current_run?.run_id,
            status: 'interrupted',
            session_id: 'session_resume_e2e',
          },
        ],
        waiting_reason: 'The backend process ended before the active run reached a terminal state.',
      });
      expect(blocked.current_run).toBeUndefined();
      collectEvidence(blocked, runIds, marketDirectories);

      const resumed = await resumedClient.call<TaskSnapshot>('task.resume', {
        task_id: created.task.task_id,
      });
      expect(resumed.task.task_id).toBe(created.task.task_id);
      collectEvidence(resumed, runIds, marketDirectories);

      const terminal = await waitForTerminalTask(resumedClient, created.task.task_id);
      collectEvidence(terminal, runIds, marketDirectories);
      expect(terminal).toMatchObject({
        task: { task_id: created.task.task_id, status: 'completed' },
        run_history: [
          {
            status: 'completed',
            session_id: 'session_resume_e2e',
          },
          {
            run_id: created.current_run?.run_id,
            status: 'interrupted',
            session_id: 'session_resume_e2e',
          },
        ],
      });
      expect(terminal.run_history[0]?.run_id).not.toBe(created.current_run?.run_id);
      expect(readFileSync(sessionLogPath, 'utf8').trim().split('\n')).toEqual([
        'session_resume_e2e',
        'session_resume_e2e',
      ]);
    } finally {
      await firstClient.close();
      await resumedClient?.close();
      rmSync(runnerDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      for (const runId of runIds) {
        rmSync(path.join('.newide', 'runs', runId), { recursive: true, force: true });
      }
      for (const directory of marketDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it('replays durable Mailbox deliveries across restarts and supports reply', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-mailbox-rpc-runner-'));
    writeFakeDriver(runnerDir);
    const firstClient = new RpcChildClient(spawnBackend(runnerDir));
    let secondClient: RpcChildClient | undefined;
    let thirdClient: RpcChildClient | undefined;

    try {
      const sent = await firstClient.call<{
        message: { message_id: string; thread_id: string };
        deliveries: Array<{ delivery_id: string; status: string; retry_count: number }>;
      }>('mailbox.send', {
        thread_id: 'thread_mailbox_e2e',
        from_agent_id: 'agent_source',
        to: [{ role_id: 'role_mailbox_recipient' }],
        type: 'ask_help',
        payload: { question: 'Review this durable message' },
        requires_ack: true,
        deadline_seconds: 60,
      });
      expect(sent.message.thread_id).toBe('thread_mailbox_e2e');
      expect(sent.deliveries).toMatchObject([
        { status: 'pending', retry_count: 1 },
      ]);
      const deliveryId = sent.deliveries[0]?.delivery_id;
      expect(deliveryId).toBeTruthy();

      await firstClient.close();
      secondClient = new RpcChildClient(spawnBackend(runnerDir));
      const inbox = await secondClient.call<{
        deliveries: Array<{
          delivery: { delivery_id: string; status: string; retry_count: number };
          message: { message_id: string };
        }>;
      }>('mailbox.inbox', { role_id: 'role_mailbox_recipient' });
      expect(inbox.deliveries).toMatchObject([
        { delivery: { delivery_id: deliveryId, status: 'delivered', retry_count: 2 } },
      ]);

      await expect(
        secondClient.call('mailbox.ack', {
          delivery_id: deliveryId,
          role_id: 'role_mailbox_recipient',
        }),
      ).resolves.toMatchObject({ delivery_id: deliveryId, status: 'acknowledged' });

      const reply = await secondClient.call<{
        source_delivery: { delivery_id: string; status: string };
        reply: {
          message: { message_id: string; reply_to_message_id?: string };
          deliveries: Array<{ delivery_id: string; status: string; retry_count: number }>;
        };
      }>('mailbox.reply', {
        source_delivery_id: deliveryId,
        source_recipient: { role_id: 'role_mailbox_recipient' },
        from_agent_id: 'agent_mailbox_recipient',
        to: [{ agent_id: 'agent_source' }],
        type: 'decision_response',
        payload: { answer: 'Reviewed' },
        requires_ack: false,
      });
      expect(reply.source_delivery).toMatchObject({
        delivery_id: deliveryId,
        status: 'acknowledged',
      });
      expect(reply.reply).toMatchObject({
        message: { reply_to_message_id: sent.message.message_id },
        deliveries: [{ status: 'pending', retry_count: 1 }],
      });
      const replyDeliveryId = reply.reply.deliveries[0]?.delivery_id;
      expect(replyDeliveryId).toBeTruthy();

      await secondClient.close();
      thirdClient = new RpcChildClient(spawnBackend(runnerDir));
      const replyInbox = await thirdClient.call<{
        deliveries: Array<{ delivery: { delivery_id: string; status: string; retry_count: number } }>;
      }>('mailbox.inbox', { agent_id: 'agent_source' });
      expect(replyInbox.deliveries).toMatchObject([
        { delivery: { delivery_id: replyDeliveryId, status: 'delivered', retry_count: 2 } },
      ]);
      await expect(
        thirdClient.call('mailbox.ack', {
          delivery_id: replyDeliveryId,
          agent_id: 'agent_source',
        }),
      ).resolves.toMatchObject({ delivery_id: replyDeliveryId, status: 'acknowledged' });
    } finally {
      await firstClient.close();
      await secondClient?.close();
      await thirdClient?.close();
      rmSync(runnerDir, { recursive: true, force: true });
    }
  }, 20_000);
});

class RpcChildClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stderr = '';
  private readonly notifications: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (message.id === undefined) {
        if (message.method)
          this.notifications.push({ method: message.method, params: message.params });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`JSON-RPC ${String(message.error.code)}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf-8');
    });
    child.once('exit', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Backend exited before response. stderr: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await once(this.child, 'exit');
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGKILL');
    await once(this.child, 'exit');
  }

  taskEvents(taskId: string): AppRunEvent[] {
    return this.notifications.flatMap((notification) => {
      if (notification.method !== 'task.event') return [];
      const params = notification.params as { task_id?: unknown; event?: unknown } | undefined;
      return params?.task_id === taskId && params.event ? [params.event as AppRunEvent] : [];
    });
  }
}

function spawnBackend(runnerDir: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx', path.join(process.cwd(), 'test/fixtures/task-rpc-server.ts')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        NEWIDE_COORDINATION_DB: path.join(runnerDir, 'coordination.sqlite'),
        NEWIDE_B_APP_STATE_ROOT: path.join(runnerDir, 'b-state'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

async function waitForTerminalTask(client: RpcChildClient, taskId: string): Promise<TaskSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await client.call<TaskSnapshot>('task.get', { task_id: taskId });
    if (!snapshot.current_run) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Task ${taskId} did not reach terminal state`);
}

async function waitForExperiences(
  client: RpcChildClient,
  roleId: string,
  sourceTaskId: string,
): Promise<{ experiences: Array<{ source_task_id: string }> }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.call<{ experiences: Array<{ source_task_id: string }> }>(
      'memory.listExperiences',
      { role_id: roleId },
    );
    if (result.experiences.some((experience) => experience.source_task_id === sourceTaskId)) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for B Experience from ${sourceTaskId}`);
}

async function waitForMaintenance(
  client: RpcChildClient,
  roleIds: readonly string[],
): Promise<{
  maintenance: Array<{ role_id: string; status: string; evidence_uri?: string }>;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.call<{
      maintenance: Array<{ role_id: string; status: string; evidence_uri?: string }>;
    }>('memory.listMaintenance', {});
    const completedRoles = new Set(
      result.maintenance
        .filter((item) => item.status === 'completed')
        .map((item) => item.role_id),
    );
    if (roleIds.every((roleId) => completedRoles.has(roleId))) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for B maintenance for ${roleIds.join(', ')}`);
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function collectEvidence(
  snapshot: TaskSnapshot,
  runIds: Set<string>,
  marketDirectories: Set<string>,
): void {
  if (snapshot.current_run) runIds.add(snapshot.current_run.run_id);
  for (const run of snapshot.run_history) runIds.add(run.run_id);
  if (snapshot.market?.ledger_ref.startsWith('file:')) {
    marketDirectories.add(path.dirname(fileURLToPath(snapshot.market.ledger_ref)));
  }
}

function writeFakeDriver(runnerDir: string): void {
  writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"node fake.mjs"}}');
  writeFileSync(
    path.join(runnerDir, 'fake.mjs'),
    `import { createHash } from 'node:crypto';
let body='';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  const created_at = new Date().toISOString();
  const councilRole = String(input.workspace_path || '').includes('.newide/council');
  const suffix = createHash('sha256').update(JSON.stringify([input.task_id, input.workspace_path, input.prompt, input.instruction, input.agent_id])).digest('hex').slice(0, 16);
  const artifact = { artifact_id: 'artifact_' + suffix, type: councilRole ? 'diff' : 'driver_result', uri: 'artifact://fake/result', producer_id: 'fake-acp', task_id: input.task_id, ...(councilRole ? { content: { kind: 'text', content_ref: 'data:text/plain,COUNCIL_FINAL%0A', target_path: 'council-output.txt', media_type: 'text/plain' } } : {}), created_at, schema_version: input.schema_version };
  process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_' + suffix, session_id: 'session_fake', status: 'succeeded', response: 'Fake ACP completed.', artifacts: [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_' + suffix, type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'fake-acp', duration_ms: 1, notes: [] }, created_at, schema_version: input.schema_version }));
});
`,
  );
  expect(existsSync(path.join(runnerDir, 'fake.mjs'))).toBe(true);
}

function writeInterruptibleFakeDriver(runnerDir: string): void {
  writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"node fake.mjs"}}');
  writeFileSync(
    path.join(runnerDir, 'fake.mjs'),
    `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let body='';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  appendFileSync(new URL('./sessions.log', import.meta.url), String(input.session_id || '') + '\\n');
  const complete = () => {
    const created_at = new Date().toISOString();
    const suffix = createHash('sha256').update(JSON.stringify([input.task_id, input.prompt, input.session_id])).digest('hex').slice(0, 16);
    const artifact = { artifact_id: 'artifact_' + suffix, type: 'driver_result', uri: 'artifact://fake/resumed', producer_id: 'fake-acp', task_id: input.task_id, created_at, schema_version: input.schema_version };
    process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_' + suffix, session_id: input.session_id, status: 'succeeded', response: 'Resumed fake ACP completed.', artifacts: [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_' + suffix, type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'fake-acp', duration_ms: 1, notes: [] }, created_at, schema_version: input.schema_version }));
  };
  const hold = new URL('./hold-first-invocation', import.meta.url);
  if (!existsSync(hold)) return complete();
  writeFileSync(new URL('./first-invocation-entered', import.meta.url), 'entered');
  const timer = setInterval(() => {
    if (existsSync(hold) && process.ppid !== 1) return;
    clearInterval(timer);
    if (existsSync(hold)) process.exit(0);
    complete();
  }, 25);
});
process.stdout.on('error', () => process.exit(0));
`,
  );
}
