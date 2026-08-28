/**
 * NewIDE 后端 JSON-RPC stdio 入口。
 *
 * 这个文件只管理进程流和连接生命周期，业务方法由 NewideBackendService 提供。
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { IntegrationV0CoordinatorRunner } from '../coordinator/coordinator-runner';
import { SelectAgentHandler } from '../coordinator/handlers/select-agent-handler';
import {
  AgentBoardCouncilParticipantResolver,
  createCouncilStrategyProvider,
  readCouncilSeatAssignments,
  readCouncilStrategy,
  SynthesisAgentCouncilProvider,
} from '../council';
import { CommandDriverTransport, ExternalDriverRuntime } from '../driver';
import {
  LiteLLMToolCallingClient,
  type LlmClient,
  type ToolCallingClient,
} from '../memory';
import { BAgentProjectionAdapter, FileMarketEvidenceStore } from '../market';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../rpc/json-rpc-dispatcher';
import { RunRpcMethods } from '../rpc/run-methods';
import { TaskRpcMethods } from '../rpc/task-methods';
import { MailboxRpcMethods } from '../rpc/mailbox-methods';
import { MemoryRpcMethods } from '../rpc/memory-methods';
import { FileRunEvidenceStore, SqliteCoordinationStore } from '../persistence';
import { DriverRuntimeAgentExecutionFacade } from './driver-runtime-agent-execution-facade';
import { FileAgentExecutionEvidenceStore } from './agent-execution-evidence-store';
import { NewideBackendService } from './newide-backend-service';
import { InMemoryRunRegistry } from './run-registry';
import { FileRunAuditWriter } from './run-audit-writer';
import { FileDriverStreamAuditWriter } from './driver-stream-audit-writer';
import { ProductionGateExecutor } from './production-gate-executor';
import type { IntegrationV0GateExecutor } from '../coordinator/gate-executor';
import { FileRunRequestStore } from './run-request-store';
import { FileRunTerminalOutputWriter } from './run-terminal-output-writer';
import {
  PersistentParticipantSessionRegistry,
  TaskExecutionLoop,
  TaskProcessor,
} from '../coordination';
import { MailboxDeliveryWorker, PersistentMailboxService } from '../mailbox';
import { createProductionBRuntime, type BackendBRuntime } from './production-b-runtime';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from './b-memory-maintenance-runner';
import { BMemoryBackendService } from './b-memory-backend-service';
import { createBPublicCapabilities } from './b-public-capabilities';
import { createAgentCatalogProvider } from './agent-catalog';
import { createProductionStageExecutors } from './production-stage-executors';
import {
  marketAuctionCompletedPayload,
  marketAuctionStartedPayload,
  type MarketEventContext,
} from './market-event-payload';
import { SystemRpcMethods } from '../rpc/system-methods';
import { ArtifactRpcMethods } from '../rpc/artifact-methods';
import { createProductionSystemStatusService } from './system-status-service';
import { AgentMaintenanceScheduler } from './agent-maintenance-scheduler';
import { FileRunArtifactContentReader } from './run-artifact-content-reader';

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
  gateExecutor?: IntegrationV0GateExecutor;
}

export async function createProductionBackendService(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionBackendServiceDependencies = {},
): Promise<NewideBackendService> {
  const repoRoot = process.cwd();
  const stateRoot = path.resolve(env.NEWIDE_STATE_ROOT?.trim() || path.join(repoRoot, '.newide'));
  const runsRoot = path.join(stateRoot, 'runs');
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
  const runnerPackageIdentity = readPackageIdentity(
    runnerPackage,
    'acp-external-runner',
    'unknown',
  );
  if (!hasDriverRunScript(runnerPackage)) {
    throw new Error(`ACP driver runner has no driver:run script: ${runnerDir}`);
  }

  const driverRunnerJs = path.join(runnerDir, 'dist', 'src', 'driver', 'contract-runner.js');
  if (!existsSync(driverRunnerJs)) {
    throw new Error(
      `ACP driver runner build missing: ${driverRunnerJs} (run pnpm --dir ${runnerDir} build)`,
    );
  }

  const driverEnvFile = env.ACP_DRIVER_ENV_FILE
    ? path.resolve(repoRoot, env.ACP_DRIVER_ENV_FILE)
    : path.join(runnerDir, '.env');
  const driverEnv = loadEnvFile(driverEnvFile);
  const productionLlm = resolveProductionLlmRuntime(env, driverEnv);
  const ephemeralAcpSessions =
    env.NEWIDE_EPHEMERAL_ACP_SESSIONS === '1' ||
    env.NEWIDE_EPHEMERAL_ACP_SESSIONS?.toLowerCase() === 'true';
  const driver = new ExternalDriverRuntime({
    driver_id: 'acp-external',
    capabilities: {
      supports_acp_extension: true,
      supports_session_load: !ephemeralAcpSessions,
      supports_tool_events: true,
    },
    transport: new CommandDriverTransport({
      // Invoke node directly — Windows `spawn('pnpm'/'pnpm.cmd')` is unreliable without shell.
      command: process.execPath,
      args: [driverRunnerJs],
      cwd: runnerDir,
      env: {
        ...driverEnv,
        COREPACK_ENABLE_PROJECT_SPEC: env.COREPACK_ENABLE_PROJECT_SPEC ?? '0',
        PNPM_CONFIG_PM_ON_FAIL: env.PNPM_CONFIG_PM_ON_FAIL ?? 'ignore',
        ACP_AGENT_ID: env.ACP_AGENT_ID ?? 'claude',
        ACP_WORKSPACE: env.ACP_WORKSPACE ?? path.join(stateRoot, 'test-workspace'),
        // Offline evals execute the already-installed ACP adapter entrypoint
        // instead of letting npx resolve/download a package inside the jail.
        ...(env.CLAUDE_CLI_COMMAND !== undefined
          ? { CLAUDE_CLI_COMMAND: env.CLAUDE_CLI_COMMAND }
          : {}),
        ...(env.CLAUDE_CLI_ARGS !== undefined ? { CLAUDE_CLI_ARGS: env.CLAUDE_CLI_ARGS } : {}),
        // Non-interactive eval / batch runs must not block on ACP permission prompts.
        AUTO_APPROVE: env.AUTO_APPROVE ?? '1',
        // NewIDE owns benchmark policy; ACP receives only generic enforcement settings.
        ...(env.ACP_DENY_NETWORK_TOOLS !== undefined
          ? { ACP_DENY_NETWORK_TOOLS: env.ACP_DENY_NETWORK_TOOLS }
          : {}),
        ...(env.ACP_DENY_PATH_SUBSTRINGS_JSON !== undefined
          ? { ACP_DENY_PATH_SUBSTRINGS_JSON: env.ACP_DENY_PATH_SUBSTRINGS_JSON }
          : {}),
        ...(env.ACP_PROCESS_SANDBOX !== undefined
          ? { ACP_PROCESS_SANDBOX: env.ACP_PROCESS_SANDBOX }
          : {}),
        ...(env.ACP_PROCESS_SANDBOX_BWRAP !== undefined
          ? { ACP_PROCESS_SANDBOX_BWRAP: env.ACP_PROCESS_SANDBOX_BWRAP }
          : {}),
        ...(env.ACP_PROCESS_SANDBOX_NPM_CACHE !== undefined
          ? { ACP_PROCESS_SANDBOX_NPM_CACHE: env.ACP_PROCESS_SANDBOX_NPM_CACHE }
          : {}),
        ...(env.ACP_PROCESS_SANDBOX_EXTRA_RO_BINDS_JSON !== undefined
          ? {
              ACP_PROCESS_SANDBOX_EXTRA_RO_BINDS_JSON:
                env.ACP_PROCESS_SANDBOX_EXTRA_RO_BINDS_JSON,
            }
          : {}),
        ...(env.ACP_PROCESS_SANDBOX_RO_PATHS_JSON !== undefined
          ? { ACP_PROCESS_SANDBOX_RO_PATHS_JSON: env.ACP_PROCESS_SANDBOX_RO_PATHS_JSON }
          : {}),
        ...(env.ACP_PROCESS_SANDBOX_HIDE_PYTHON_PACKAGES !== undefined
          ? {
              ACP_PROCESS_SANDBOX_HIDE_PYTHON_PACKAGES:
                env.ACP_PROCESS_SANDBOX_HIDE_PYTHON_PACKAGES,
            }
          : {}),
      },
      unsetEnv: [
        'NEWIDE_B_DATABASE_URL',
        ...MODEL_OVERRIDE_ENV.filter(
          (key) => driverEnv[key] === undefined && env[key] === undefined,
        ),
      ],
      timeoutMs: readDriverTimeout(env.ACP_DRIVER_TIMEOUT_MS),
    }),
  });
  let bRuntime: BackendBRuntime | undefined;
  let memoryMaintenance: BMemoryMaintenanceRunner | undefined;
  let coordinationStore: SqliteCoordinationStore | undefined;
  let maintenanceScheduler: AgentMaintenanceScheduler | undefined;
  const closeRuntime = onceAsync(async () => {
    const failures: unknown[] = [];
    for (const close of [
      () => maintenanceScheduler?.stop(),
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
    bRuntime =
      dependencies.bRuntime ??
      (await createProductionBRuntime(env, { repoRoot, appStateRoot: stateRoot }));
    assertValidMarketAgentIds(bRuntime.market_agent_ids);
    // B 侧文本 LLM：memoryMaintenance 与 BMemoryBackendService（persona 重生成）共享
    const memoryLlm =
      dependencies.memoryLlm ??
      new ProductionTextLlmAdapter(createProductionToolCallingClient(productionLlm, env));
    memoryMaintenance =
      dependencies.memoryMaintenance ??
      new BMemoryMaintenanceRunner({
        repository: bRuntime.repository,
        bufferRepository: bRuntime.bufferRepository,
        llm: memoryLlm,
        evidenceStore: new FileBMemoryMaintenanceEvidenceStore(
          path.join(bRuntime.app_state_root ?? path.join(repoRoot, '.newide'), 'b', 'maintenance'),
        ),
        runsRoot,
        promotion: {
          confidenceThreshold: readNumberEnv(
            env.NEWIDE_B_PROMOTION_CONFIDENCE_THRESHOLD,
            0.95,
          ),
          autoApprove: env.NEWIDE_B_SKILL_AUTO_APPROVE === '1',
        },
      });
    try {
      await memoryMaintenance.replayPending();
    } catch {
      throw new Error('Production B Agent manager readiness check failed');
    }
    const bCapabilities = createBPublicCapabilities(bRuntime, memoryMaintenance);
    // 动态 Agent 目录：选人 / 议会 / 邮箱协作每次使用时查询当前注册 Agent，
    // 使 memory.createAgent 新增的 Agent 无需重启即可进入协作流程。
    const agentCatalogProvider = createAgentCatalogProvider(
      bCapabilities.boardQuery,
      bRuntime.market_agent_ids,
    );
    const configuredDatabasePath =
      env.NEWIDE_COORDINATION_DB ?? path.join(stateRoot, 'coordination.sqlite');
    const databasePath =
      configuredDatabasePath === ':memory:'
        ? configuredDatabasePath
        : path.resolve(configuredDatabasePath);
    coordinationStore = new SqliteCoordinationStore(databasePath);
    const mailboxService = new PersistentMailboxService(coordinationStore);
    const participantSessions = new PersistentParticipantSessionRegistry(coordinationStore);
    const agentExecutionFacade = new DriverRuntimeAgentExecutionFacade({
      driver,
      repository: bCapabilities.repository,
      bufferRepository: bCapabilities.bufferRepository,
      ...(bRuntime.embedding ? { embedding: bRuntime.embedding } : {}),
      llm:
        dependencies.agentLlm ??
        new ProductionAgentToolCallingClient(
          createProductionToolCallingClient(productionLlm, env),
        ),
      memoryMaintenance: bCapabilities.maintenance,
      evidenceStore: new FileAgentExecutionEvidenceStore({
        root: path.join(stateRoot, 'b', 'context-packs'),
      }),
      mailbox: {
        service: mailboxService,
        allowedRoleIds: bRuntime.market_agent_ids,
        ...(ephemeralAcpSessions ? {} : { sessionRegistry: participantSessions }),
      },
    });
    const selectAgentHandler = new SelectAgentHandler({
      projectionSource: new BAgentProjectionAdapter({
        competitionQuery: agentExecutionFacade,
        boardQuery: bCapabilities.boardQuery,
        ensureAgent: (agentId) => agentExecutionFacade.ensureAgent(agentId),
        candidateSource: 'allowed_catalog',
      }),
      evidenceStore: new FileMarketEvidenceStore({
        root: path.join(stateRoot, 'market'),
      }),
    });
    const councilSeatAssignments = readCouncilSeatAssignments(env.NEWIDE_COUNCIL_SEATS);
    const councilAuctionEnabled = readCouncilAuctionEnabled(env.NEWIDE_COUNCIL_AUCTION_ENABLED);
    const councilProposerCount = readCouncilProposerCount(env.NEWIDE_COUNCIL_PROPOSERS);
    const baseCouncilProvider = new SynthesisAgentCouncilProvider({
      agentExecutionFacade,
      councilRoot: path.join(stateRoot, 'council'),
      participantResolver: new AgentBoardCouncilParticipantResolver({
        boardQuery: bCapabilities.boardQuery,
        resolveAllowedAgentIds: agentCatalogProvider,
        ensureAgent: (agentId) => agentExecutionFacade.ensureAgent(agentId),
        ...(councilSeatAssignments ? { seatAssignments: councilSeatAssignments } : {}),
        ...(!councilSeatAssignments && councilAuctionEnabled
          ? {
              auctionEnabled: true,
              proposerCount: councilProposerCount,
              auctionSelector: async (input) => {
                const marketContext: MarketEventContext = {
                  selection_scope: 'council_seat',
                  selection_mode: 'auction',
                  seat: input.seat,
                  seat_index: input.seat_index,
                };
                const result = await selectAgentHandler.execute(
                  {
                    task_id: input.task_id,
                    task_description: input.question,
                    bootstrap_agent_ids: input.candidate_agent_ids,
                    seed: `${input.run_id}:${input.seat}:${input.seat_index}`,
                  },
                  {
                    onCandidatesCollected: async (collected) => {
                      await input.on_lifecycle_event?.({
                        type: 'market.auction.started',
                        payload: marketAuctionStartedPayload({
                          context: marketContext,
                          auction_id: collected.auction_id,
                          task_description: collected.market_task.task_description,
                          requirement_profile: collected.market_task.requirement_profile,
                          candidates: collected.candidates,
                        }),
                      });
                    },
                  },
                );
                await input.on_lifecycle_event?.({
                  type: 'market.auction.completed',
                  payload: marketAuctionCompletedPayload({
                    context: marketContext,
                    result,
                  }),
                });
                return {
                  agent_id: result.winner_agent_id,
                  selection_refs: [result.ledger_ref, result.audit_ref],
                };
              },
            }
          : {}),
      }),
    });
    const councilProvider = createCouncilStrategyProvider(
      baseCouncilProvider,
      readCouncilStrategy(env.NEWIDE_COUNCIL_STRATEGY),
    );
    const gateExecutor =
      dependencies.gateExecutor ??
      new ProductionGateExecutor({
        runsRoot,
        env,
      });
    const runner = new IntegrationV0CoordinatorRunner({
      driver,
      agentExecutionFacade,
      selectAgentHandler,
      councilProvider,
      gateExecutor,
    });
    const bMemoryService = new BMemoryBackendService(
      bCapabilities,
      bRuntime.embedding_info,
      { autoApprovePromotedSkills: env.NEWIDE_B_SKILL_AUTO_APPROVE === '1' },
      bRuntime.repository,
      {
        retireAgent: (roleId, options) => agentExecutionFacade.retireAgent(roleId, options),
        runRetirementScan: (roleId) => agentExecutionFacade.runRetirementScan(roleId),
        createAgent: (spec) => agentExecutionFacade.createAgent(spec),
        updateAgent: (roleId, patch) => agentExecutionFacade.updateAgent(roleId, patch),
        deleteAgent: (roleId, options) => agentExecutionFacade.deleteAgent(roleId, options),
      },
      bRuntime.embedding,
      memoryLlm,
    );

    try {
      await agentExecutionFacade.ready();
    } catch {
      throw new Error('Production B Agent manager readiness check failed');
    }

    // 定时维护：退休检查（默认只出报告，不自动退休）+ 存活 Agent 市场自学习
    maintenanceScheduler = new AgentMaintenanceScheduler(
      {
        repository: bRuntime.repository,
        ...(bRuntime.embedding ? { embedding: bRuntime.embedding } : {}),
        retirement: {
          retireAgent: (roleId, options) => agentExecutionFacade.retireAgent(roleId, options),
          runRetirementScan: (roleId) => agentExecutionFacade.runRetirementScan(roleId),
        },
      },
      {
        autoRetire: env.NEWIDE_B_AUTO_RETIRE === '1',
        retireConfidenceFloor: readNumberEnv(env.NEWIDE_B_RETIRE_CONFIDENCE_FLOOR, 0.5),
        autoLearn: env.NEWIDE_B_AUTO_LEARN !== '0',
        learning: {
          minPersonaSimilarity: readNumberEnv(env.NEWIDE_B_LEARN_PERSONA_FLOOR, 0.3),
          tagWeight: readNumberEnv(env.NEWIDE_B_LEARN_TAG_WEIGHT, 0.4),
          personaWeight: readNumberEnv(env.NEWIDE_B_LEARN_PERSONA_WEIGHT, 0.6),
          learnThreshold: readNumberEnv(env.NEWIDE_B_LEARN_THRESHOLD, 0.45),
          maxSkillsPerAgentPerCycle: readIntEnv(env.NEWIDE_B_LEARN_MAX_PER_CYCLE, 3),
        },
      },
    );
    maintenanceScheduler.start(readIntEnv(env.NEWIDE_MAINTENANCE_INTERVAL_MS, 3600_000));

    const taskProcessor = new TaskProcessor(coordinationStore, {
      runsRoot,
      mailboxStore: coordinationStore,
      participantSessions,
    });
    taskProcessor.recoverInterruptedTasks();
    const taskExecutionLoop = new TaskExecutionLoop({
      processor: taskProcessor,
      evidence_store: new FileRunEvidenceStore({ root: runsRoot }),
      executors: createProductionStageExecutors({
        selectAgentHandler,
        agentExecutionFacade,
        councilProvider,
        gateExecutor,
        bootstrapAgentIds: agentCatalogProvider,
        auctionEnabled: readAuctionEnabled(env.NEWIDE_AUCTION_ENABLED),
        ...(env.NEWIDE_PRIMARY_AGENT_ID?.trim()
          ? { primaryAgentId: env.NEWIDE_PRIMARY_AGENT_ID.trim() }
          : {}),
        runsRoot,
        councilRoot: path.join(stateRoot, 'council'),
        worktreesRoot: path.join(stateRoot, 'worktrees'),
      }),
    });
    const mailboxRecovery = mailboxService.replayPendingDeliveries();
    try {
      await mailboxRecovery;
    } catch {
      throw new Error('Production mailbox recovery failed');
    }
    const backendPackageIdentity = readPackageIdentity(
      readJson(path.join(repoRoot, 'package.json')),
      'newide-bcd',
      'unknown',
    );
    const systemStatusService = createProductionSystemStatusService({
      package_name: backendPackageIdentity.name,
      package_version: backendPackageIdentity.version,
      build_commit: env.NEWIDE_BUILD_COMMIT?.trim() || 'dev',
      coordination_durable: databasePath !== ':memory:',
      driver_provider_id: runnerPackageIdentity.name,
      driver_provider_version: runnerPackageIdentity.version,
      b_repository_mode: dependencies.bRuntime ? 'host-injected' : 'postgresql',
      b_embedding: bRuntime.embedding_info ?? {
        provider: 'host-managed repository',
        readiness: 'host_managed',
      },
    });
    const service = new NewideBackendService(
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
      new FileDriverStreamAuditWriter(runsRoot),
      taskExecutionLoop,
      systemStatusService,
      new MailboxDeliveryWorker(
        mailboxService,
        agentExecutionFacade,
        participantSessions,
      ),
      (input) => agentExecutionFacade.provisionParticipantSession(input),
      new FileRunArtifactContentReader(runsRoot),
    );
    await service.recoverMailboxWaits();
    return service;
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

export interface ProductionLlmRuntime {
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI-compatible base URL without the trailing `/v1`. */
  readonly baseUrl: string;
}

/**
 * The ACP runner is the local source of truth for the coding model. Reuse its
 * MiniMax credentials for B's text/tool calls so one Council does not silently
 * split between MiniMax for Driver work and a stale DeepSeek configuration for
 * planning or maintenance.
 */
export function resolveProductionLlmRuntime(
  env: NodeJS.ProcessEnv,
  driverEnv: NodeJS.ProcessEnv,
): ProductionLlmRuntime | undefined {
  const model = firstNonBlank(
    env.NEWIDE_AGENT_LLM_MODEL,
    driverEnv.ANTHROPIC_MODEL,
  );
  const apiKey = firstNonBlank(
    env.OPENAI_API_KEY,
    driverEnv.ANTHROPIC_AUTH_TOKEN,
    driverEnv.ANTHROPIC_API_KEY,
  );
  const baseUrl = firstNonBlank(
    toOpenAiCompatibleBaseUrl(env.OPENAI_BASE_URL),
    toOpenAiCompatibleBaseUrl(driverEnv.ANTHROPIC_BASE_URL),
  );

  if (!model || !apiKey || !baseUrl) return undefined;
  return { model, apiKey, baseUrl };
}

function createProductionToolCallingClient(
  runtime: ProductionLlmRuntime | undefined,
  env: NodeJS.ProcessEnv,
): LiteLLMToolCallingClient {
  if (runtime) {
    return new LiteLLMToolCallingClient({
      model: runtime.model,
      apiKey: runtime.apiKey,
      baseUrl: runtime.baseUrl,
    });
  }
  return new LiteLLMToolCallingClient({
    ...(env.NEWIDE_AGENT_LLM_MODEL?.trim()
      ? { model: env.NEWIDE_AGENT_LLM_MODEL.trim() }
      : {}),
  });
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value?.trim()))?.trim();
}

function toOpenAiCompatibleBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\/+$/, '');
  if (!normalized) return undefined;
  return normalized.replace(/\/(?:anthropic|v1)$/i, '');
}

function readDriverTimeout(value: string | undefined): number {
  if (value === undefined) return 120_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('ACP_DRIVER_TIMEOUT_MS must be a positive integer');
  }
  return timeout;
}

/** 读取带默认值的浮点环境变量；非法值抛错。 */
function readNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env value: ${value}`);
  }
  return parsed;
}

/** 读取带默认值的整数环境变量（>=0）；非法值抛错。 */
function readIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid integer env value: ${value}`);
  }
  return Number(value.trim());
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

function readPackageIdentity(
  value: unknown,
  fallbackName: string,
  fallbackVersion: string,
): { name: string; version: string } {
  if (!value || typeof value !== 'object') {
    return { name: fallbackName, version: fallbackVersion };
  }
  const rawName = Reflect.get(value, 'name');
  const rawVersion = Reflect.get(value, 'version');
  return {
    name:
      typeof rawName === 'string' && rawName.trim().length > 0
        ? rawName.trim()
        : fallbackName,
    version:
      typeof rawVersion === 'string' && rawVersion.trim().length > 0
        ? rawVersion.trim()
        : fallbackVersion,
  };
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
  const systemMethods = new SystemRpcMethods(service);
  const artifactMethods = new ArtifactRpcMethods(service);
  systemMethods.register(dispatcher);
  runMethods.register(dispatcher);
  taskMethods.register(dispatcher);
  mailboxMethods.register(dispatcher);
  memoryMethods.register(dispatcher);
  artifactMethods.register(dispatcher);

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

export async function runBackendRpcMain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
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
    const runtimeEnv = materializeRuntimeEnv(loadRuntimeEnvDefaults(env));
    service = await createProductionBackendService(runtimeEnv);
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

export function materializeRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  return env;
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
      (agentId) => typeof agentId === 'string' && agentId.length > 0 && agentId.trim() === agentId,
    ) &&
    new Set(agentIds).size === agentIds.length;
  if (!valid) {
    throw new Error('Production B runtime must provide non-empty, unique market_agent_ids');
  }
}

export class ProductionAgentToolCallingClient implements ToolCallingClient {
  constructor(private readonly delegate: ToolCallingClient) {}

  async completeWithTools(
    input: Parameters<ToolCallingClient['completeWithTools']>[0],
  ): Promise<Awaited<ReturnType<ToolCallingClient['completeWithTools']>>> {
    const exposesDriver = input.tools.some((tool) => tool.function.name === 'invoke_driver');
    const driverAlreadyInvoked = input.messages.some((message) =>
      message.tool_calls?.some((toolCall) => toolCall.function.name === 'invoke_driver'),
    );
    let result: Awaited<ReturnType<ToolCallingClient['completeWithTools']>>;
    try {
      result = await this.completeWithRetry(input);
    } catch (error) {
      if (exposesDriver && !driverAlreadyInvoked && isMalformedToolArgumentsError(error)) {
        return forcedDriverToolCall(input);
      }
      throw error;
    }
    if (!exposesDriver || driverAlreadyInvoked || result.tool_calls?.length) return result;

    let prompted: Awaited<ReturnType<ToolCallingClient['completeWithTools']>>;
    try {
      prompted = await this.completeWithRetry({
        ...input,
        messages: [
          ...input.messages,
          {
            role: 'user',
            content:
              'The production task is not complete. Call invoke_driver now and delegate the concrete task.',
          },
        ],
      });
    } catch (error) {
      if (isMalformedToolArgumentsError(error)) return forcedDriverToolCall(input);
      throw error;
    }
    if (prompted.tool_calls?.length) return prompted;

    // A text-only response cannot satisfy the production execution contract.
    // Keep the fallback inside the Agent tool loop so it still invokes the
    // real Driver and produces the ordinary B buffer evidence.
    return forcedDriverToolCall(input, prompted.content);
  }

  private async completeWithRetry(
    input: Parameters<ToolCallingClient['completeWithTools']>[0],
  ): Promise<Awaited<ReturnType<ToolCallingClient['completeWithTools']>>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.delegate.completeWithTools(input);
      } catch (error) {
        if (attempt === 0 && isMalformedToolArgumentsError(error)) continue;
        throw error;
      }
    }
    throw new Error('Unreachable ToolCallingClient retry state');
  }
}

function isMalformedToolArgumentsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid function arguments json string/i.test(message);
}

function fallbackDriverInstruction(
  input: Parameters<ToolCallingClient['completeWithTools']>[0],
): string {
  const message = input.messages.find(
    (candidate) => candidate.role === 'user' && typeof candidate.content === 'string',
  )?.content;
  const match = message?.match(/(?:^|\n)Task:\s*([\s\S]*?)(?:\n\n(?:Retrieved memory|Collaboration brief):|$)/);
  return match?.[1]?.trim() || 'Execute the assigned production task.';
}

function forcedDriverToolCall(
  input: Parameters<ToolCallingClient['completeWithTools']>[0],
  content?: string | null,
): Awaited<ReturnType<ToolCallingClient['completeWithTools']>> {
  return {
    content: content ?? null,
    tool_calls: [
      {
        id: `production_forced_driver_${String(input.messages.length)}`,
        type: 'function',
        function: {
          name: 'invoke_driver',
          arguments: JSON.stringify({ instruction: fallbackDriverInstruction(input) }),
        },
      },
    ],
  };
}

/**
 * B maintenance only needs text completion. Keeping this adapter in the
 * composition layer lets it share the production MiniMax tool client without
 * changing B's own memory implementation.
 */
class ProductionTextLlmAdapter implements LlmClient {
  constructor(private readonly delegate: ToolCallingClient) {}

  async complete(input: Parameters<LlmClient['complete']>[0]): Promise<string> {
    const result = await this.delegate.completeWithTools({
      messages: input.messages,
      tools: [],
      tool_choice: 'none',
    });
    if (!result.content?.trim()) {
      throw new Error('Production LLM returned an empty maintenance response');
    }
    return result.content;
  }
}

/**
 * NEWIDE_AUCTION_ENABLED 解析：默认 true；"0"/"false" 关闭竞标。
 */
export function readAuctionEnabled(value: string | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return true;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  throw new Error(`Invalid NEWIDE_AUCTION_ENABLED: ${value}. Expected 0/1/true/false.`);
}

export function readCouncilAuctionEnabled(value: string | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  if (raw === '0' || raw.toLowerCase() === 'false') return false;
  if (raw === '1' || raw.toLowerCase() === 'true') return true;
  throw new Error(
    `Invalid NEWIDE_COUNCIL_AUCTION_ENABLED: ${value}. Expected 0/1/true/false.`,
  );
}

export function readCouncilProposerCount(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return 2;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid NEWIDE_COUNCIL_PROPOSERS: ${value}. Expected an integer >= 2.`);
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 2) {
    throw new Error(`Invalid NEWIDE_COUNCIL_PROPOSERS: ${value}. Expected an integer >= 2.`);
  }
  return count;
}
