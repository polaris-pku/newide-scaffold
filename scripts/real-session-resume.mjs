// Real production backend only. Usage/configuration: scripts/real-session-resume.md.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.env.NEWIDE_ACCEPTANCE_MODE ?? 'single_agent';
assert(['single_agent', 'council'].includes(mode));
assert(!['1', 'true'].includes(process.env.NEWIDE_EPHEMERAL_ACP_SESSIONS), 'Ephemeral sessions cannot pass this acceptance');
const root = mkdtempSync(path.join(tmpdir(), 'newide-session-reload-'));
const workspace = path.join(root, 'workspace');
const state = path.join(root, 'state');
mkdirSync(workspace); mkdirSync(state);
for (const args of [['init', '-q'], ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@newide.local', 'commit', '--allow-empty', '-qm', 'baseline']]) {
  execFileSync('git', ['-C', workspace, ...args]);
}
const env = { ...process.env, NEWIDE_EPHEMERAL_ACP_SESSIONS: '0', NEWIDE_STATE_ROOT: state,
  NEWIDE_COORDINATION_DB: path.join(state, 'coordination.sqlite'), NEWIDE_B_APP_STATE_ROOT: path.join(state, 'b') };
const evidence = { mode, root, status: 'running', processes: [] };
const events = [];
let proc;
let nextId = 0;
const pending = new Map();
const timeout = Number(process.env.NEWIDE_ACCEPTANCE_TIMEOUT_MS ?? 1200000);
const save = () => writeFileSync(path.join(root, 'acceptance.json'), JSON.stringify(evidence, null, 2));
const readAudit = (id) => readFileSync(path.join(state, 'runs', id, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
function start() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
  evidence.processes.push(child.pid);
  let buffer = '';
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) { if (message.params?.event) events.push(message.params.event); continue; }
      const waiter = pending.get(message.id); if (!waiter) continue;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
    }
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Backend exited during RPC')); }
    pending.clear();
  });
  return child;
}
function call(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function waitFor(check) {
  const deadline = Date.now() + timeout;
  let lastProgress = 0;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    if (Date.now() - lastProgress > 30000) {
      console.log(JSON.stringify({ phase: 'waiting', last_event: events.at(-1)?.type, time: new Date().toISOString() }));
      lastProgress = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Acceptance deadline reached; this is not a pass');
}
async function stop() {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGINT');
  await exited;
}
try {
  console.log(`EVIDENCE_ROOT=${root}`); save();
  proc = start(); await call('system.ping');
  const created = await call('task.create', {
    workspace_path: workspace, mode,
    spec: 'Build a playable browser Snake game in index.html with keyboard controls, score, food, game over and restart. Use snake.mjs for pure game logic and node:test tests in snake.test.mjs. No external dependencies. Run node --test snake.test.mjs before finishing.',
    completion_criteria: ['Playable Snake game with keyboard controls and restart', 'node --test snake.test.mjs passes'],
  });
  const taskId = created.task.task_id;
  evidence.task_id = taskId;
  const originalRun = created.current_run.run_id;
  await call('task.subscribe', { task_id: taskId });
  const interruptedTool = await waitFor(async () => {
    const tool = events.find(e => e.type === 'driver.tool_started' &&
      (!process.env.NEWIDE_INTERRUPT_ROLE || e.payload.role_id === process.env.NEWIDE_INTERRUPT_ROLE));
    if (tool) return tool;
    const snapshot = await call('task.get', { task_id: taskId });
    assert(snapshot.current_run, 'Task ended before the requested interruption point');
  });
  evidence.interrupted_tool = interruptedTool;
  evidence.before_stop = await call('task.get', { task_id: taskId });
  await stop();
  evidence.original_events = readAudit(originalRun).filter(e => /turn_started|handler.started|run.interrupted|checkpoint.saved/.test(e.type));
  evidence.restarted_at = new Date().toISOString();
  proc = start(); await call('system.ping');
  evidence.after_restart = await call('task.get', { task_id: taskId });
  assert.equal(evidence.after_restart.task.status, 'blocked');
  const resumed = await call('task.resume', { task_id: taskId });
  const resumedRun = resumed.current_run.run_id;
  await call('task.subscribe', { task_id: taskId });
  evidence.terminal = await waitFor(async () => {
    const snapshot = await call('task.get', { task_id: taskId });
    return !snapshot.current_run && snapshot;
  });
  await stop();
  assert.equal(evidence.terminal.task.status, 'completed');
  evidence.resumed_events = readAudit(resumedRun).filter(e => /turn_started|handler.started/.test(e.type));
  const originalTurns = evidence.original_events.filter(e => e.type === 'driver.turn_started');
  const activeRole = interruptedTool.payload.role_id;
  const interruptedSession = originalTurns.filter(e => e.payload.role_id === activeRole).at(-1)?.payload.session_id;
  assert(interruptedSession, 'No original Driver session evidence');
  const resumedTurns = evidence.resumed_events.filter(e => e.type === 'driver.turn_started' && e.payload.role_id === activeRole);
  assert(resumedTurns.length, 'Interrupted role did not resume');
  assert(resumedTurns.every(e => e.payload.session_id === interruptedSession), 'Driver opened a replacement session');
  evidence.session_id = interruptedSession;
  const driverEnvFile = process.env.ACP_DRIVER_ENV_FILE ?? path.join(repo, '../acp-client-prototype/.env');
  const driverConfigDir = readFileSync(driverEnvFile, 'utf8').split('\n').find(line => line.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length).trim();
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? driverConfigDir ?? '', 'projects');
  assert(existsSync(projects), 'Set CLAUDE_CONFIG_DIR to inspect native Claude session continuity');
  const nativeRelative = readdirSync(projects, { recursive: true }).find(name => name.endsWith(`${interruptedSession}.jsonl`));
  assert(nativeRelative, 'Native session transcript missing');
  const nativePath = path.join(projects, nativeRelative);
  const messages = readFileSync(nativePath, 'utf8').trim().split('\n').map(JSON.parse).filter(m => m.uuid && m.timestamp);
  const beforeIds = new Set(messages.filter(m => m.timestamp < evidence.restarted_at).map(m => m.uuid));
  const after = messages.filter(m => m.timestamp >= evidence.restarted_at);
  const links = after.filter(m => beforeIds.has(m.parentUuid));
  assert(links.length, 'No native parent linkage across restart; equal session IDs are insufficient');
  evidence.native_session = { path: nativePath, records_before: beforeIds.size, records_after: after.length,
    links: links.map(m => ({ uuid: m.uuid, parentUuid: m.parentUuid, timestamp: m.timestamp, sessionId: m.sessionId })) };
  if (mode === 'council') {
    assert.equal(evidence.terminal.council?.result?.role_failure_count, 0, 'Council role failed');
    assert.equal(evidence.terminal.council?.result?.fallback_used, false, 'Council used fallback');
  }
  assert(existsSync(path.join(workspace, 'index.html')));
  evidence.game_tests = execFileSync(process.execPath, ['--test', 'snake.test.mjs'], { cwd: workspace, encoding: 'utf8' });
  evidence.status = 'native_session_reload_and_task_completed';
  console.log(JSON.stringify({ status: evidence.status, task_id: taskId, session_id: interruptedSession, evidence: path.join(root, 'acceptance.json') }, null, 2));
} catch (error) {
  evidence.status = 'failed'; evidence.error = String(error); process.exitCode = 1;
  console.error(error);
} finally {
  await stop().catch(error => { evidence.shutdown_error = String(error); process.exitCode = 1; });
  save();
}
