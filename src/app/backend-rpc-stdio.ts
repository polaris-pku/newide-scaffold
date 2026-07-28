/**
 * NewIDE 后端 JSON-RPC stdio 入口。
 *
 * 这个文件只管理进程流和连接生命周期，业务方法由 NewideBackendService 提供。
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { IntegrationV0CoordinatorRunner } from '../coordinator/coordinator-runner';
import { SelectAgentHandler } from '../coordinator/handlers/select-agent-handler';
import { SynthesisAgentCouncilProvider } from '../council';
import { CommandDriverTransport, ExternalDriverRuntime } from '../driver';
import {
  LiteLLMClientAdapter,
  LiteLLMToolCallingClient,
  RepositoryAgentBoardQuery,
  type LlmClient,
  type ToolCallingClient,
} from '../memory';
import { BAgentProjectionAdapter, FileMarketEvidenceStore } from '../market';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../rpc/json-rpc-dispatcher';
import { RunRpcMethods } from '../rpc/run-methods';
import { TaskRpcMethods } from '../rpc/task-methods';
import { MailboxRpcMethods } from '../rpc/mailbox-methods';
import { MemoryRpcMethods } from '../rpc/memory-methods';
import { SqliteCoordinationStore } from '../persistence';
import { DriverRuntimeAgentExecutionFacade } from './driver-runtime-agent-execution-facade';
import { FileAgentExecutionEvidenceStore } from './agent-execution-evidence-store';
import { NewideBackendService } from './newide-backend-service';
import { InMemoryRunRegistry } from './run-registry';
import { FileRunAuditWriter } from './run-audit-writer';
import { FileRunRequestStore } from './run-request-store';
import { FileRunTerminalOutputWriter } from './run-terminal-output-writer';
import { TaskProcessor } from './task-processor';
import { PersistentMailboxService } from './persistent-mailbox-service';
import { createProductionBRuntime, type BackendBRuntime } from './production-b-runtime';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from './b-memory-maintenance-runner';
import { BMemoryBackendService } from './b-memory-backend-service';

export interface BackendRpcServerOptions {
  input: Readable;
  writeLine: (line: string) => void;
  service: NewideBackendService;
  logError?: (message: string) => void;
}

export interface BackendRpcServer {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface ProductionBackendServiceDependencies {
  agentLlm?: ToolCallingClient;
  memoryLlm?: LlmClient;
  memoryMaintenance?: BMemoryMaintenanceRunner;
  bRuntime?: BackendBRuntime;
}

export async function createProductionBackendService(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionBackendServiceDependencies = {},
): Promise<NewideBackendService> {
  const repoRoot = process.cwd();
  const runnerDir = path.resolve(
    env.ACP_DRIVER_RUNNER_DIR ?? path.join(repoRoot, '..', 'acp-client-prototype'),
  );
  if (!existsSync(runnerDir)) {
    throw new Error(`ACP driver runner directory not found: ${runnerDir}`);
  }
  if (!statSync(runnerDir).isDirectory()) {
    throw new Error(`ACP driver runner path is not a directory: ${runnerDir}`);
  }
  const packagePath = path.join(runnerDir, 'package.json');
  const runnerPackage = readJson(packagePath);
  if (!hasDriverRunScript(runnerPackage)) {
    throw new Error(`ACP driver runner has no driver:run script: ${runnerDir}`);
  }

  const driverEnv = loadEnvFile(env.ACP_DRIVER_ENV_FILE ?? path.join(runnerDir, '.env'));
  const driver = new ExternalDriverRuntime({
    driver_id: 'acp-external',
    capabilities: {
      supports_acp_extension: true,
      supports_session_load: true,
      supports_tool_events: true,
    },
    transport: new CommandDriverTransport({
      command: 'pnpm',
      args: ['--dir', runnerDir, 'driver:run'],
      cwd: repoRoot,
      env: {
        ...driverEnv,
        COREPACK_ENABLE_PROJECT_SPEC: env.COREPACK_ENABLE_PROJECT_SPEC ?? '0',
        PNPM_CONFIG_PM_ON_FAIL: env.PNPM_CONFIG_PM_ON_FAIL ?? 'ignore',
        ACP_AGENT_ID: env.ACP_AGENT_ID ?? 'claude',
        ACP_WORKSPACE: env.ACP_WORKSPACE ?? path.join(repoRoot, '.newide', 'test-workspace'),
      },
      unsetEnv: [
        'NEWIDE_B_DATABASE_URL',
        ...MODEL_OVERRIDE_ENV.filter((key) => driverEnv[key] === undefined),
      ],
      timeoutMs: readDriverTimeout(env.ACP_DRIVER_TIMEOUT_MS),
    }),
  });
  let bRuntime: BackendBRuntime | undefined;
  let memoryMaintenance: BMemoryMaintenanceRunner | undefined;
  let coordinationStore: SqliteCoordinationStore | undefined;
  const closeRuntime = onceAsync(async () => {
    const failures: unknown[] = [];
    for (const close of [
      () => driver.shutdown(),
      () => memoryMaintenance?.waitForIdle(),
      () => bRuntime?.close(),
      () => coordinationStore?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to close production backend resources');
    }
  });

  try {
    bRuntime = dependencies.bRuntime ?? (await createProductionBRuntime(env, { repoRoot }));
    assertValidMarketAgentIds(bRuntime.market_agent_ids);
    memoryMaintenance =
      dependencies.memoryMaintenance ??
      new BMemoryMaintenanceRunner({
        repository: bRuntime.repository,
        bufferRepository: bRuntime.bufferRepository,
        llm: dependencies.memoryLlm ?? new LiteLLMClientAdapter('memory-query'),
        evidenceStore: new FileBMemoryMaintenanceEvidenceStore(
          path.join(bRuntime.app_state_root ?? path.join(repoRoot, '.newide'), 'b', 'maintenance'),
        ),
      });
    try {
      await memoryMaintenance.replayPending();
    } catch {
      throw new Error('Production B Agent manager readiness check failed');
    }
    const agentExecutionFacade = new DriverRuntimeAgentExecutionFacade({
      driver,
      repository: bRuntime.repository,
      bufferRepository: bRuntime.bufferRepository,
      llm: dependencies.agentLlm ?? new LiteLLMToolCallingClient(),
      memoryMaintenance,
      evidenceStore: new FileAgentExecutionEvidenceStore({
        root: path.join(repoRoot, '.newide', 'b', 'context-packs'),
      }),
    });
    const selectAgentHandler = new SelectAgentHandler({
      projectionSource: new BAgentProjectionAdapter({
        competitionQuery: agentExecutionFacade,
        boardQuery: new RepositoryAgentBoardQuery(bRuntime.repository),
        ensureAgent: (agentId) => agentExecutionFacade.ensureAgent(agentId),
        allowedAgentIds: bRuntime.market_agent_ids,
      }),
      evidenceStore: new FileMarketEvidenceStore({
        root: path.join(repoRoot, '.newide', 'market'),
      }),
    });
    const runner = new IntegrationV0CoordinatorRunner({
      driver,
      agentExecutionFacade,
      selectAgentHandler,
      councilProvider: new SynthesisAgentCouncilProvider({ agentExecutionFacade }),
    });
    const bMemoryService = new BMemoryBackendService(bRuntime.repository, memoryMaintenance);

    try {
      await agentExecutionFacade.ready();
    } catch {
      throw new Error('Production B Agent manager readiness check failed');
    }

    const runsRoot = path.join(repoRoot, '.newide', 'runs');
    const configuredDatabasePath =
      env.NEWIDE_COORDINATION_DB ?? path.join(repoRoot, '.newide', 'coordination.sqlite');
    const databasePath =
      configuredDatabasePath === ':memory:'
        ? configuredDatabasePath
        : path.resolve(configuredDatabasePath);
    coordinationStore = new SqliteCoordinationStore(databasePath);
    const taskProcessor = new TaskProcessor(coordinationStore);
    taskProcessor.recoverInterruptedTasks();
    const mailboxService = new PersistentMailboxService(coordinationStore, agentExecutionFacade);
    const mailboxRecovery = mailboxService.replayPendingDeliveries();
    try {
      await mailboxRecovery;
    } catch {
      throw new Error('Production mailbox recovery failed');
    }
    return new NewideBackendService(
      runner,
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      new FileRunRequestStore(runsRoot),
      taskProcessor,
      mailboxService,
      mailboxRecovery,
      closeRuntime,
      bMemoryService,
    );
  } catch (error) {
    await closeRuntime().catch(() => undefined);
    throw error;
  }
}

const MODEL_OVERRIDE_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

function readDriverTimeout(value: string | undefined): number {
  if (value === undefined) return 120_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('ACP_DRIVER_TIMEOUT_MS must be a positive integer');
  }
  return timeout;
}

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`ACP driver runner package.json is invalid: ${filePath}`, { cause: error });
  }
}

function hasDriverRunScript(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const scripts = Reflect.get(value, 'scripts');
  const command = scripts && typeof scripts === 'object' && Reflect.get(scripts, 'driver:run');
  return typeof command === 'string' && command.trim().length > 0;
}

export function startBackendRpcServer(options: BackendRpcServerOptions): BackendRpcServer {
  const dispatcher = new JsonRpcDispatcher();
  const session = new JsonRpcLineSession(dispatcher, options.writeLine);
  const service = options.service;
  const runMethods = new RunRpcMethods(service, (method, params) =>
    session.sendNotification(method, params),
  );
  const taskMethods = new TaskRpcMethods(service, (method, params) =>
    session.sendNotification(method, params),
  );
  const mailboxMethods = new MailboxRpcMethods(service);
  const memoryMethods = new MemoryRpcMethods(service);
  runMethods.register(dispatcher);
  taskMethods.register(dispatcher);
  mailboxMethods.register(dispatcher);
  memoryMethods.register(dispatcher);

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let pending = Promise.resolve();
  let inputClosed = false;
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  lines.on('line', (line) => {
    pending = pending
      .then(() => session.handleLine(line))
      .catch((error: unknown) => options.logError?.(String(error)));
  });
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(async () => {
        runMethods.dispose();
        taskMethods.dispose();
        if (!inputClosed) lines.close();
        await pending;
        await service.close();
      });
      closePromise.then(resolveClosed, rejectClosed);
    }
    return closePromise;
  };
  lines.once('close', () => {
    inputClosed = true;
    void close().catch((error: unknown) => options.logError?.(String(error)));
  });

  return { closed, close };
}

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};

  return parseDriverEnv(readFileSync(filePath, 'utf8'));
}

export function loadRuntimeEnvDefaults(
  env: NodeJS.ProcessEnv,
  filePath = path.join(process.cwd(), '.env.local'),
): NodeJS.ProcessEnv {
  const merged = loadEnvFile(filePath);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export function parseDriverEnv(content: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .flatMap((line) => {
        if (!line || line.startsWith('#')) return [];
        const separator = line.indexOf('=');
        if (separator <= 0) return [];
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return [];
        const value = line.slice(separator + 1).trim();
        return [[key, value.replace(/^(["'])(.*)\1$/, '$2')]];
      }),
  );
}

async function runMain(): Promise<void> {
  let service: NewideBackendService | undefined;
  let server: BackendRpcServer | undefined;
  let shutdownRequested = false;
  const close = () => {
    shutdownRequested = true;
    const closing = server ? server.close() : service?.close();
    void closing?.catch(() => undefined);
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  try {
    service = await createProductionBackendService(loadRuntimeEnvDefaults(process.env));
    if (shutdownRequested) {
      await service.close();
      return;
    }
    server = startBackendRpcServer({
      input: process.stdin,
      writeLine: (line) => process.stdout.write(`${line}\n`),
      service,
      logError: (message) => process.stderr.write(`${message}\n`),
    });
    await server.closed;
  } finally {
    process.off('SIGTERM', close);
    process.off('SIGINT', close);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(operation));
}

function assertValidMarketAgentIds(value: unknown): asserts value is readonly string[] {
  const agentIds = Array.isArray(value) ? Array.from(value) : [];
  const valid =
    agentIds.length > 0 &&
    agentIds.every(
      (agentId) =>
        typeof agentId === 'string' && agentId.length > 0 && agentId.trim() === agentId,
    ) &&
    new Set(agentIds).size === agentIds.length;
  if (!valid) {
    throw new Error('Production B runtime must provide non-empty, unique market_agent_ids');
  }
}
