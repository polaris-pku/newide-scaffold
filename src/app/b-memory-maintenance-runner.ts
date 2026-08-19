import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, nowTimestamp } from '../core';
import {
  LlmExperienceExtractor,
  LlmSkillPromotion,
  createAgentMemoryScope,
  processPendingBuffer,
  promoteExperiencesForAgent,
  resolveMemoryAblationPolicy,
  type BufferRepository,
  type LlmClient,
  type MemoryAblation,
  type MemoryRepository,
} from '../memory';
import type { SkillRecord } from '../memory/schemas';
import {
  isDriverStreamUsage,
  preferDriverUsage,
  projectTaskDriverUsage,
} from './driver-usage-projector';
import {
  collectClaudeSessionUsage,
  isPopulatedRunTokenUsage,
  mergeTokenUsageSummaries,
  runWithLlmUsageLedger,
  snapshotRunLedgerUsage,
} from '../telemetry';

export interface BMemoryMaintenanceRequest {
  task_id: string;
  run_id: string;
  role_id: string;
  buffer_seq: number;
  /** RFC §1.2 ablation; B2/B3 enable inline skill promotion with auto-approve. */
  memory_ablation?: MemoryAblation;
}

export interface BSkillPromotionRequest {
  role_id: string;
  requested_by: string;
}

export type BMemoryMaintenanceStatus =
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed';

export interface BMemoryMaintenanceEvidence {
  maintenance_ref: string;
  kind: 'experience_extraction' | 'skill_promotion';
  status: BMemoryMaintenanceStatus;
  role_id: string;
  task_id?: string;
  run_id?: string;
  buffer_seq?: number;
  requested_by?: string;
  experiences: unknown[];
  skills: unknown[];
  warnings: string[];
  error?: string;
  evidence_uri?: string;
  created_at: string;
  completed_at: string;
  schema_version: string;
}

export interface BMemoryMaintenancePort {
  scheduleBuffer(input: BMemoryMaintenanceRequest): Promise<BMemoryMaintenanceEvidence>;
}

export interface BMemoryMaintenanceEvidenceStore {
  save(evidence: BMemoryMaintenanceEvidence): Promise<{ uri: string }>;
  get(maintenanceRef: string): Promise<BMemoryMaintenanceEvidence | undefined>;
  list(roleId?: string): Promise<BMemoryMaintenanceEvidence[]>;
}

export interface BMemoryMaintenanceRunnerOptions {
  repository: MemoryRepository;
  bufferRepository: BufferRepository;
  llm: LlmClient;
  evidenceStore: BMemoryMaintenanceEvidenceStore;
  /** When set, completed maintenance rewrites summary.json token_usage for the run. */
  runsRoot?: string;
}

export class BMemoryMaintenanceRunner implements BMemoryMaintenancePort {
  private readonly extractor: LlmExperienceExtractor;
  private readonly promoter: LlmSkillPromotion;
  private readonly roleQueues = new Map<string, Promise<void>>();
  private readonly scheduleFlights = new Map<string, Promise<BMemoryMaintenanceEvidence>>();
  private readonly jobs = new Map<string, Promise<BMemoryMaintenanceEvidence>>();

  constructor(private readonly options: BMemoryMaintenanceRunnerOptions) {
    this.extractor = new LlmExperienceExtractor(options.llm);
    this.promoter = new LlmSkillPromotion(options.llm);
  }

  scheduleBuffer(input: BMemoryMaintenanceRequest): Promise<BMemoryMaintenanceEvidence> {
    const maintenanceRef = extractionRef(input);
    const inFlight = this.scheduleFlights.get(maintenanceRef);
    if (inFlight) return inFlight;

    const scheduling = this.scheduleBufferOnce(input, maintenanceRef);
    this.scheduleFlights.set(maintenanceRef, scheduling);
    const clearSchedule = () => {
      if (this.scheduleFlights.get(maintenanceRef) === scheduling) {
        this.scheduleFlights.delete(maintenanceRef);
      }
    };
    void scheduling.then(clearSchedule, clearSchedule);
    return scheduling;
  }

  private async scheduleBufferOnce(
    input: BMemoryMaintenanceRequest,
    maintenanceRef: string,
  ): Promise<BMemoryMaintenanceEvidence> {
    const active = this.jobs.get(maintenanceRef);
    if (active) {
      return (
        (await this.options.evidenceStore.get(maintenanceRef)) ??
        this.scheduledEvidence(input, maintenanceRef)
      );
    }
    const existing = await this.options.evidenceStore.get(maintenanceRef);
    if (existing?.status === 'completed' || existing?.status === 'skipped') return existing;

    const scheduled = await this.persist(this.scheduledEvidence(input, maintenanceRef));
    const job = this.enqueueRole(input.role_id, () => this.processBuffer(input)).catch(
      async (error: unknown) =>
        this.persist({
          ...scheduled,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completed_at: nowTimestamp(),
        }),
    );
    this.jobs.set(maintenanceRef, job);
    const clearJob = () => {
      if (this.jobs.get(maintenanceRef) === job) this.jobs.delete(maintenanceRef);
    };
    void job.then(clearJob, clearJob);
    return scheduled;
  }

  async processBuffer(input: BMemoryMaintenanceRequest): Promise<BMemoryMaintenanceEvidence> {
    const maintenanceRef = extractionRef(input);
    const existing = await this.options.evidenceStore.get(maintenanceRef);
    if (existing?.status === 'completed') return existing;

    const startedAt = nowTimestamp();
    if (!Number.isInteger(input.buffer_seq) || input.buffer_seq <= 0) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'skipped',
        ...input,
        experiences: [],
        skills: [],
        warnings: ['Agent execution did not produce a durable pending Buffer.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    const memory = createAgentMemoryScope(
      this.options.repository,
      this.options.bufferRepository,
      input.role_id,
    );
    const pending = await memory.getPendingBuffer(input.buffer_seq);
    if (!pending) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'skipped',
        ...input,
        experiences: [],
        skills: [],
        warnings: ['Pending Buffer is no longer available for extraction.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    try {
      const evidence = await runWithLlmUsageLedger(
        {
          case_id: input.task_id,
          run_id: input.run_id,
          task_id: input.task_id,
          scaffold_variant: 'full_system',
        },
        async () => {
          const ablationPolicy = resolveMemoryAblationPolicy(input.memory_ablation);
          const result = await processPendingBuffer(memory, input.buffer_seq, {
            task: {
              task_id: input.task_id,
              call_id: `maintenance:${input.run_id}:${String(input.buffer_seq)}`,
              source_driver: pending.snapshot.source_driver,
              spec: pending.snapshot.task_description,
            },
            extractor: this.extractor,
            promote: async () => ({
              check: {
                eligible: false,
                auto_approved: false,
                reasons: ['Skill promotion is exposed as a separate application operation.'],
                blocking_rules: [],
              },
            }),
          });

          let skills: SkillRecord[] = [];
          const warnings: string[] = [];
          if (ablationPolicy.promote_skills) {
            const outcomes = await promoteExperiencesForAgent(
              input.role_id,
              (role_id) =>
                createAgentMemoryScope(
                  this.options.repository,
                  this.options.bufferRepository,
                  role_id,
                ),
              this.promoter,
            );
            skills = [];
            for (const outcome of outcomes) {
              if (!outcome.skill) continue;
              const approved: SkillRecord = {
                ...outcome.skill,
                review_status: 'approved',
              };
              await memory.updateSkill(approved);
              skills.push(approved);
            }
            if (skills.length === 0) {
              warnings.push('Ablation B2/B3 promote ran but no eligible Experience was promoted.');
            } else {
              warnings.push(
                'Ablation B2/B3 auto-approved promoted Skills so they are retrievable in subsequent tasks.',
              );
            }
          }

          return this.persist({
            maintenance_ref: maintenanceRef,
            kind: 'experience_extraction',
            status: 'completed',
            task_id: input.task_id,
            run_id: input.run_id,
            role_id: input.role_id,
            buffer_seq: input.buffer_seq,
            experiences: result.extraction.experiences,
            skills,
            warnings,
            created_at: startedAt,
            completed_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          });
        },
      );
      await this.refreshRunTokenUsage(input.run_id);
      return evidence;
    } catch (error) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'failed',
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: input.role_id,
        buffer_seq: input.buffer_seq,
        experiences: [],
        skills: [],
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }
  }

  promoteSkills(input: BSkillPromotionRequest): Promise<BMemoryMaintenanceEvidence> {
    return this.enqueueRole(input.role_id, () => this.promoteSkillsNow(input));
  }

  private async promoteSkillsNow(
    input: BSkillPromotionRequest,
  ): Promise<BMemoryMaintenanceEvidence> {
    const startedAt = nowTimestamp();
    const maintenanceRef = `b_maintenance_${randomUUID()}`;
    try {
      const outcomes = await promoteExperiencesForAgent(
        input.role_id,
        (role_id) =>
          createAgentMemoryScope(
            this.options.repository,
            this.options.bufferRepository,
            role_id,
          ),
        this.promoter,
      );
      const skills = outcomes.flatMap((outcome) => (outcome.skill ? [outcome.skill] : []));
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'skill_promotion',
        status: 'completed',
        ...input,
        experiences: [],
        skills,
        warnings:
          skills.length === 0
            ? ['No eligible Experience was promoted.']
            : ['Promoted Skills remain pending until B exposes an approval transition.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    } catch (error) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'skill_promotion',
        status: 'failed',
        ...input,
        experiences: [],
        skills: [],
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }
  }

  async replayPending(): Promise<BMemoryMaintenanceEvidence[]> {
    const results: BMemoryMaintenanceEvidence[] = [];
    const roleIds = (await this.options.repository.listAgentIds()).sort(compareCodeUnits);
    for (const roleId of roleIds) {
      const memory = createAgentMemoryScope(
        this.options.repository,
        this.options.bufferRepository,
        roleId,
      );
      for (const seq of await memory.listPendingBufferSeqs()) {
        const pending = await memory.getPendingBuffer(seq);
        if (!pending) continue;
        results.push(
          await this.scheduleBuffer({
            task_id: pending.snapshot.source_task_id,
            run_id: `replay:${pending.snapshot.source_task_id}`,
            role_id: roleId,
            buffer_seq: seq,
          }),
        );
      }
    }
    return results;
  }

  listEvidence(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.options.evidenceStore.list(roleId);
  }

  async waitForIdle(): Promise<void> {
    while (this.scheduleFlights.size > 0 || this.jobs.size > 0 || this.roleQueues.size > 0) {
      await Promise.allSettled([
        ...this.scheduleFlights.values(),
        ...this.jobs.values(),
        ...this.roleQueues.values(),
      ]);
    }
  }

  private scheduledEvidence(
    input: BMemoryMaintenanceRequest,
    maintenanceRef: string,
  ): BMemoryMaintenanceEvidence {
    const createdAt = nowTimestamp();
    return {
      maintenance_ref: maintenanceRef,
      kind: 'experience_extraction',
      status: 'scheduled',
      ...input,
      experiences: [],
      skills: [],
      warnings: [],
      created_at: createdAt,
      completed_at: createdAt,
      schema_version: SCHEMA_VERSION,
    };
  }

  private enqueueRole<T>(roleId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roleQueues.get(roleId) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.roleQueues.set(roleId, settled);
    void settled.then(() => {
      if (this.roleQueues.get(roleId) === settled) this.roleQueues.delete(roleId);
    });
    return running;
  }

  private async persist(
    evidence: BMemoryMaintenanceEvidence,
  ): Promise<BMemoryMaintenanceEvidence> {
    const saved = await this.options.evidenceStore.save(evidence);
    return { ...evidence, evidence_uri: saved.uri };
  }

  private async refreshRunTokenUsage(runId: string): Promise<void> {
    const runsRoot = this.options.runsRoot;
    if (!runsRoot) return;
    const summaryPath = path.join(runsRoot, runId, 'summary.json');
    try {
      const raw = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
      const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;
      const proxy = snapshotRunLedgerUsage(runId);
      const worktreePath =
        typeof raw.worktree_path === 'string' && raw.worktree_path.length > 0
          ? raw.worktree_path
          : undefined;
      const sessionId =
        typeof raw.session_id === 'string' && raw.session_id.length > 0
          ? raw.session_id
          : undefined;
      const claude = worktreePath
        ? await collectClaudeSessionUsage({
            worktreePath,
            ...(sessionId ? { sessionId } : {}),
          })
        : undefined;
      const billed = claude ? mergeTokenUsageSummaries([proxy, claude]) : proxy;
      const driverUsage = preferDriverUsage(
        isDriverStreamUsage(raw.driver_usage) ? raw.driver_usage : raw.token_usage,
        taskId ? await projectTaskDriverUsage(runsRoot, taskId) : undefined,
      );
      if (driverUsage) raw.driver_usage = driverUsage;
      if (isPopulatedRunTokenUsage(billed)) {
        raw.token_usage = billed;
      } else if (isDriverStreamUsage(raw.token_usage)) {
        delete raw.token_usage;
      }
      await fs.writeFile(summaryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Non-fatal: maintenance evidence already persisted.
    }
  }
}

export class FileBMemoryMaintenanceEvidenceStore implements BMemoryMaintenanceEvidenceStore {
  constructor(private readonly root: string) {}

  async save(evidence: BMemoryMaintenanceEvidence): Promise<{ uri: string }> {
    await fs.mkdir(this.root, { recursive: true });
    const filePath = this.filePath(evidence.maintenance_ref);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const uri = pathToFileURL(filePath).href;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ ...evidence, evidence_uri: uri }, null, 2)}\n`,
      'utf8',
    );
    await fs.rename(temporaryPath, filePath);
    return { uri };
  }

  async get(maintenanceRef: string): Promise<BMemoryMaintenanceEvidence | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(maintenanceRef), 'utf8')) as BMemoryMaintenanceEvidence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const evidence = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.get(entry.slice(0, -'.json'.length))),
    );
    return evidence
      .filter((item): item is BMemoryMaintenanceEvidence => Boolean(item))
      .filter((item) => !roleId || item.role_id === roleId)
      .sort((left, right) => left.completed_at.localeCompare(right.completed_at));
  }

  private filePath(maintenanceRef: string): string {
    if (!/^b_maintenance_[a-zA-Z0-9-]+$/.test(maintenanceRef)) {
      throw new Error('Invalid B maintenance reference');
    }
    return path.join(this.root, `${maintenanceRef}.json`);
  }
}

function extractionRef(input: BMemoryMaintenanceRequest): string {
  const digest = createHash('sha256')
    .update(`${input.role_id}\u0000${String(input.buffer_seq)}\u0000${input.task_id}`)
    .digest('hex')
    .slice(0, 24);
  return `b_maintenance_${digest}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
