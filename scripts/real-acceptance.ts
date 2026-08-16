/**
 * 真实链路验收脚本（不注入 fake B LLM，不使用 fake ACP runner）。
 *
 * 用真实 production composition（createProductionBackendService 经 Node stdio backend
 * 子进程）执行五个场景：memory / market / council / subagent / restart。
 * 结果打印到控制台，并留档到 .newide/acceptance/<timestamp>/。
 *
 * 用法：
 *   pnpm acceptance:real -- --workspace /absolute/path --scenario all
 *   pnpm acceptance:real -- --workspace /absolute/path --scenario council \
 *     --existing-run run_xxx
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Scenario = 'memory' | 'market' | 'council' | 'subagent' | 'restart' | 'resume';

interface CliOptions {
  workspace: string;
  scenarios: Scenario[];
  existingRunId?: string;
}

interface ScenarioReport {
  scenario: Scenario;
  status: 'passed' | 'failed';
  details: Record<string, unknown>;
  errors: string[];
}

const repoRoot = process.cwd();
const stateRoot = path.resolve(
  process.env.NEWIDE_STATE_ROOT?.trim() || path.join(repoRoot, '.newide'),
);
const options = parseCli(process.argv.slice(2));
const startedAt = new Date();
const acceptanceDir = path.resolve(
  repoRoot,
  '.newide',
  'acceptance',
  startedAt.toISOString().replace(/[:.]/g, '-'),
);
const runTimeoutMs = readPositiveInt(process.env.ACCEPTANCE_RUN_TIMEOUT_MS, 900_000);

await fs.mkdir(options.workspace, { recursive: true });
await fs.mkdir(acceptanceDir, { recursive: true });

log(`workspace: ${options.workspace}`);
log(`acceptance dir: ${acceptanceDir}`);
log(`scenarios: ${options.scenarios.join(', ')}`);

const reports: ScenarioReport[] = [];
for (const scenario of options.scenarios) {
  log('');
  log(`=== scenario: ${scenario} ===`);
  const report =
    scenario === 'memory'
      ? await runMemoryScenario()
      : scenario === 'market'
        ? await runMarketScenario()
      : scenario === 'council'
        ? await runCouncilScenario()
        : scenario === 'subagent'
          ? await runSubagentScenario()
          : scenario === 'restart'
            ? await runRestartScenario()
            : await runResumeScenario();
  reports.push(report);
  await fs.writeFile(
    path.join(acceptanceDir, `${scenario}.json`),
    JSON.stringify(report, null, 2),
    'utf-8',
  );
  log(`--- ${scenario}: ${report.status} ---`);
}

const summary = {
  schema_version: 'v0',
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  workspace: options.workspace,
  repo_root: repoRoot,
  acceptance_dir: acceptanceDir,
  scenarios: reports,
};
const summaryPath = path.join(acceptanceDir, 'summary.json');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

log('');
log('=== acceptance summary ===');
for (const report of reports) {
  log(`${report.scenario}: ${report.status}`);
  for (const error of report.errors) log(`  error: ${error}`);
}
log(`summary.json: ${summaryPath}`);
if (reports.some((report) => report.status === 'failed')) {
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runMemoryScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  let backend: BackendClient | undefined;
  try {
    backend = await startBackend('memory');
    const capabilityResponse = await backend.request<{ capabilities?: unknown }>(
      'memory.getCapabilities',
      {},
    );
    const capabilities = asRecord(capabilityResponse.capabilities) ?? {};
    const embedding = asRecord(capabilities.embedding) ?? {};
    const skillReview = asRecord(capabilities.skill_review) ?? {};
    const operations = asRecord(capabilities.operations) ?? {};
    details.capabilities = capabilities;
    validateMemoryCapabilities(operations, embedding, skillReview, errors);

    const listed = await backend.request<{ agents?: Array<{ role_id?: string }> }>(
      'memory.listAgents',
      {},
    );
    const agentIds = (listed.agents ?? []).flatMap((agent) =>
      typeof agent.role_id === 'string' ? [agent.role_id] : [],
    );
    details.available_agent_ids = agentIds;
    if (agentIds.length === 0) throw new Error('memory.listAgents returned no real Agents');

    const beforeExperienceIds = await readRecordIdsByAgent(
      backend,
      agentIds,
      'memory.listExperiences',
      'experiences',
    );
    const beforeSkillIds = await readRecordIdsByAgent(
      backend,
      agentIds,
      'memory.listSkills',
      'skills',
    );

    const first = await runMemoryTask(
      backend,
      [
        '在工作区创建 b-memory-reuse-first.ts，使用 TypeScript 实现 normalizeProjectSlug(input: string)。',
        '实现必须处理空白、大小写和连续分隔符，并真实写入文件。',
        '完成时明确总结一条可复用工程经验：先统一 trim/lowercase，再折叠所有非字母数字字符为单个连字符，最后移除首尾连字符。',
      ].join(''),
    );
    const firstAgentId = requireSelectedAgent(first.snapshot);
    const firstMaintenance = await waitForMaintenanceEvidence(
      backend,
      first.created.run_id,
      firstAgentId,
      runTimeoutMs,
    );
    const firstExperiences = await listMemoryRecords(
      backend,
      'memory.listExperiences',
      'experiences',
      firstAgentId,
    );
    const firstExperienceIds = recordIds(firstExperiences).filter(
      (id) => !beforeExperienceIds[firstAgentId]?.includes(id),
    );
    const firstExecution = findCompletedAgentExecution(first.snapshot, firstAgentId);
    const personaRef = readPersonaRef(firstExecution);
    const persona = await backend.request<{ agent?: unknown }>('memory.getAgent', {
      role_id: firstAgentId,
    });

    const promotion = await backend.request<{ maintenance?: unknown }>(
      'memory.promoteSkills',
      {
        role_id: firstAgentId,
        requested_by: 'real-acceptance',
      },
    );
    const promotionEvidence = asRecord(promotion.maintenance) ?? {};
    const skillsAfterPromotion = await listMemoryRecords(
      backend,
      'memory.listSkills',
      'skills',
      firstAgentId,
    );
    const promotedSkills = skillsAfterPromotion.filter((skill) => {
      const id = typeof skill.id === 'string' ? skill.id : undefined;
      return id && !beforeSkillIds[firstAgentId]?.includes(id);
    });
    const second = await runMemoryTask(
      backend,
      [
        '在工作区创建 b-memory-reuse-second.ts，使用 TypeScript 实现 normalizePackageSlug(input: string)。',
        '它与上一任务属于同类规范化问题：处理空白、大小写、连续分隔符和首尾连字符，并真实写入文件。',
        '请复用已有 Agent 记忆中的相关工程经验完成实现。',
      ].join(''),
    );
    const secondAgentId = requireSelectedAgent(second.snapshot);
    const secondMaintenance = await waitForMaintenanceEvidence(
      backend,
      second.created.run_id,
      secondAgentId,
      runTimeoutMs,
    );
    const secondExecution = findCompletedAgentExecution(second.snapshot, secondAgentId);
    const secondContextPack = await readContextPack(secondExecution?.context_pack_ref);
    const retrieval = asRecord(secondContextPack?.retrieval) ?? {};
    const retrievedExperienceIds = recordIds(
      Array.isArray(retrieval.experiences)
        ? retrieval.experiences.map(asRecord).filter(isRecord)
        : [],
    );
    const retrievedSkillIds = recordIds(
      Array.isArray(retrieval.skills)
        ? retrieval.skills.map(asRecord).filter(isRecord)
        : [],
    );
    const reusedExperienceIds = firstExperienceIds.filter((id) =>
      retrievedExperienceIds.includes(id),
    );
    const promotedSkillStates = promotedSkills.map((skill) => ({
      id: skill.id,
      review_status: skill.review_status,
      market_status: skill.market_status,
      reusable: skill.review_status === 'approved' && skill.market_status !== 'superseded',
      retrieved_by_second_task:
        typeof skill.id === 'string' && retrievedSkillIds.includes(skill.id),
    }));

    details.first_task = {
      task_id: first.created.task_id,
      run_id: first.created.run_id,
      status: first.snapshot.status,
      selected_agent_id: firstAgentId,
      persona_ref: personaRef,
      persona: asRecord(persona.agent)?.persona ?? null,
      maintenance: firstMaintenance,
      generated_experience_ids: firstExperienceIds,
      context_pack_ref: firstExecution?.context_pack_ref ?? null,
    };
    details.second_task = {
      task_id: second.created.task_id,
      run_id: second.created.run_id,
      status: second.snapshot.status,
      selected_agent_id: secondAgentId,
      maintenance: secondMaintenance,
      context_pack_ref: secondExecution?.context_pack_ref ?? null,
      retrieved_experience_ids: retrievedExperienceIds,
      reused_first_experience_ids: reusedExperienceIds,
      retrieved_skill_ids: retrievedSkillIds,
    };
    details.embedding = {
      provider: embedding.provider ?? null,
      model: embedding.model ?? null,
      dimensions: embedding.dimensions ?? null,
      readiness: embedding.readiness ?? null,
    };
    details.skill_promotion = {
      maintenance: promotionEvidence,
      skills: promotedSkillStates,
      approval_transition_available:
        asRecord(operations.approve_skill)?.status === 'available',
    };

    if (first.snapshot.status !== 'completed') {
      errors.push(`first memory run ended as ${String(first.snapshot.status)}`);
    }
    if (second.snapshot.status !== 'completed') {
      errors.push(`second memory run ended as ${String(second.snapshot.status)}`);
    }
    if (firstAgentId !== secondAgentId) {
      errors.push(
        `similar tasks selected different Agents: ${firstAgentId} -> ${secondAgentId}`,
      );
    }
    if (!personaRef) errors.push('first Agent execution did not expose a Persona ref');
    if (firstMaintenance.status !== 'completed') {
      errors.push(`first memory maintenance ended as ${String(firstMaintenance.status)}`);
    }
    if (secondMaintenance.status !== 'completed') {
      errors.push(`second memory maintenance ended as ${String(secondMaintenance.status)}`);
    }
    if (firstExperienceIds.length === 0) {
      errors.push('first task produced no new persisted Experience');
    }
    if (reusedExperienceIds.length === 0) {
      errors.push('second task did not retrieve any Experience generated by the first task');
    }
    if (promotionEvidence.status !== 'completed') {
      errors.push(`Skill promotion ended as ${String(promotionEvidence.status)}`);
    }
    if (promotedSkills.length === 0) {
      errors.push('Skill promotion produced no persisted Skill');
    }
    if (!promotedSkillStates.some((skill) => skill.reusable)) {
      errors.push('Skill approval produced no reusable approved Skill');
    }
    if (!promotedSkillStates.some((skill) => skill.retrieved_by_second_task)) {
      errors.push('second task did not retrieve an approved promoted Skill');
    }

    log(`memory first run: ${first.created.run_id} agent=${firstAgentId}`);
    log(`memory first experiences: ${firstExperienceIds.join(', ') || '(none)'}`);
    log(`memory second run: ${second.created.run_id} agent=${secondAgentId}`);
    log(`memory reused experiences: ${reusedExperienceIds.join(', ') || '(none)'}`);
    log(
      `memory promoted Skills: ${promotedSkillStates
        .map((skill) => `${String(skill.id)}:${String(skill.review_status)}`)
        .join(', ') || '(none)'}`,
    );
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await backend?.close();
  }
  return {
    scenario: 'memory',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

async function runMarketScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  const backend = await startBackend('market');
  try {
    const before = await snapshotWorkspaceFiles();
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt: [
        '在工作区创建 market-probe.ts。',
        '导出函数 marketProbe(): string，且固定返回 MARKET_DISPATCH_OK。',
        '必须真实写入该文件。',
      ].join(''),
      mode: 'single_agent',
      workspace_path: options.workspace,
    });
    log(`market run created: ${created.run_id}`);
    await backend.subscribeAndLog(created.run_id);
    const snapshot = await backend.waitForTerminal(created.run_id, runTimeoutMs);
    const after = await snapshotWorkspaceFiles();
    const workspaceChanges = diffWorkspace(before, after);
    const market = asRecord(snapshot.market);
    const timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
    const marketEvent = timeline.map(asRecord).find((event) => event?.type === 'market.selected');
    const executionRequested = timeline
      .map(asRecord)
      .find((event) => event?.type === 'agent.execution_requested');
    const agentRuns = Array.isArray(snapshot.agent_runs) ? snapshot.agent_runs : [];
    const executionCompleted = agentRuns
      .map(asRecord)
      .find((event) => event?.type === 'agent.execution_completed');
    const ledgerEvidence = await readMarketEvidence(market?.ledger_ref);
    const auditEvidence = await readMarketEvidence(market?.audit_ref);
    const ledger = asRecord(ledgerEvidence?.value);
    const audit = asRecord(auditEvidence?.value);
    const finalOutput = asRecord(snapshot.final_output) ?? {};

    details.run_id = created.run_id;
    details.task_id = created.task_id;
    details.status = snapshot.status;
    details.market = market ?? null;
    details.market_event = marketEvent ?? null;
    details.execution_requested = executionRequested ?? null;
    details.execution_completed = executionCompleted ?? null;
    details.ledger = ledger ?? null;
    details.audit = audit ?? null;
    details.market_files = {
      ledger: ledgerEvidence?.path ?? null,
      audit: auditEvidence?.path ?? null,
    };
    details.response = finalOutput.response ?? '';
    details.changed_files = finalOutput.changed_files ?? [];
    details.workspace_changes = workspaceChanges;
    details.errors_from_run = snapshot.errors ?? [];

    if (snapshot.status !== 'completed') {
      errors.push(`market run ended as ${String(snapshot.status)}`);
    }
    if (!market) {
      errors.push('run.getSnapshot did not expose market evidence');
    } else {
      if (market.seed !== created.run_id) errors.push('market seed does not equal run_id');
      if (market.policy_version !== 'market-v0') errors.push('unexpected market policy version');
      if (ledger?.winner_agent_id !== market.winner_agent_id) {
        errors.push('BidLedger winner does not match snapshot market winner');
      }
      if (audit?.winner_agent_id !== market.winner_agent_id) {
        errors.push('MarketAudit winner does not match snapshot market winner');
      }
      if (!Array.isArray(ledger?.bids) || ledger.bids.length === 0) {
        errors.push('BidLedger contains no bids');
      }
      if (!Array.isArray(audit?.probabilities) || audit.probabilities.length === 0) {
        errors.push('MarketAudit contains no selection probabilities');
      }
      const requestPayload = asRecord(executionRequested?.payload);
      if (requestPayload?.role_id !== market.winner_agent_id) {
        errors.push('Market winner did not drive B execution dispatch');
      }
      if (
        typeof executionCompleted?.agent_id !== 'string' ||
        executionCompleted.agent_id !== market.winner_agent_id
      ) {
        errors.push('completed B Agent identity does not match Market winner');
      }
    }
    if (!marketEvent) errors.push('market.selected event is missing');
    if (!ledgerEvidence) errors.push('BidLedger file reference is unreadable');
    if (!auditEvidence) errors.push('MarketAudit file reference is unreadable');
    if (!hasBExecutionEvidence(executionCompleted)) {
      errors.push('B execution evidence is incomplete');
    }
    const probeFile = workspaceChanges.find((file) => file.endsWith('market-probe.ts'));
    details.probe_file = probeFile ?? null;
    if (!probeFile) {
      errors.push('market-probe.ts was not materialized in the user workspace');
    } else {
      details.probe_file_content = await fs.readFile(
        path.join(options.workspace, probeFile),
        'utf-8',
      );
    }

    log(`market winner: ${String(market?.winner_agent_id)}`);
    log(`market bids: ${String(Array.isArray(ledger?.bids) ? ledger.bids.length : 0)}`);
    log(`workspace changes: ${workspaceChanges.join(', ') || '(none)'}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await backend.close();
  }
  return {
    scenario: 'market',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

async function runCouncilScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  let backend: BackendClient | undefined;
  try {
    let runId: string;
    let taskId: string;
    let snapshot: Record<string, unknown>;
    let workspaceChanges: string[];

    if (options.existingRunId) {
      runId = options.existingRunId;
      const persistedSnapshot = asRecord(
        await readJsonIfExists(path.join(stateRoot, 'runs', runId, 'result.json')),
      );
      if (!persistedSnapshot) {
        throw new Error(`persisted Council result not found for ${runId}`);
      }
      snapshot = persistedSnapshot;
      taskId = typeof snapshot.task_id === 'string' ? snapshot.task_id : '';
      const persistedOutput = asRecord(snapshot.final_output) ?? {};
      workspaceChanges = Array.isArray(persistedOutput.changed_files)
        ? persistedOutput.changed_files.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      log(`verifying persisted council run: ${runId}`);
    } else {
      backend = await startBackend('council');
      const before = await snapshotWorkspaceFiles();
      const prompt = [
        '在工作区实现一个最小的 TypeScript 工具函数文件。',
        '要求：创建 council-final.ts，导出函数 slugify(input: string): string，',
        '将任意字符串转换为小写连字符 slug。候选与最终文件都必须真实写入工作区。',
      ].join('');
      const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
        prompt,
        mode: 'council',
        workspace_path: options.workspace,
      });
      runId = created.run_id;
      taskId = created.task_id;
      log(`council run created: ${runId}`);
      await backend.subscribeAndLog(runId);
      snapshot = await backend.waitForTerminal(runId, runTimeoutMs);
      const after = await snapshotWorkspaceFiles();
      workspaceChanges = diffWorkspace(before, after);
    }

    const council = asRecord(snapshot.council) ?? {};
    const councilResult = asRecord(council.result);
    const councilOutcome = asRecord(council.outcome);
    const proposals = Array.isArray(council.proposals) ? council.proposals : [];
    const participants = Array.isArray(council.participants) ? council.participants : [];
    const runDir = path.join(stateRoot, 'runs', runId);
    const councilStagePath = path.join(runDir, 'stages', 'council.json');
    const councilStage = asRecord(await readJsonIfExists(councilStagePath));
    const legacyCouncilDir = path.join(runDir, 'council');
    const decision =
      asRecord(councilStage?.decision) ??
      asRecord(await readJsonIfExists(path.join(legacyCouncilDir, 'decision.json')));
    const legacyReviews = await readJsonIfExists(path.join(legacyCouncilDir, 'reviews.json'));
    const reviews = Array.isArray(council.reviews) ? council.reviews : legacyReviews;
    const synthesis =
      asRecord(council.synthesis) ??
      asRecord(await readJsonIfExists(path.join(legacyCouncilDir, 'synthesis.json')));
    const persistedCouncilResult =
      councilResult ??
      asRecord(await readJsonIfExists(path.join(legacyCouncilDir, 'result.json')));
    const finalOutput = asRecord(snapshot.final_output) ?? {};

    details.run_id = runId;
    details.task_id = taskId;
    details.status = snapshot.status;
    details.decision_id = council.decision_id ?? decision?.decision_id ?? null;
    details.verdict = council.verdict ?? null;
    details.decision_semantics =
      'CouncilDecision is advisory evidence; it is NOT a MergeAuthorization ' +
      '(can_create_merge_authorization=false).';
    details.can_create_merge_authorization = council.can_create_merge_authorization ?? null;
    details.proposal_count = proposals.length;
    details.review_count = Array.isArray(reviews) ? reviews.length : 0;
    details.synthesis = synthesis;
    details.council_result = councilResult ?? persistedCouncilResult;
    details.council_outcome = councilOutcome ?? null;
    details.selected_artifact_refs = council.selected_artifact_refs ?? [];
    details.response = finalOutput.response ?? '';
    details.session_id = finalOutput.session_id ?? null;
    details.changed_files = finalOutput.changed_files ?? [];
    details.files_written = finalOutput.files_written ?? [];
    details.tool_event_count = Array.isArray(finalOutput.tool_events)
      ? finalOutput.tool_events.length
      : 0;
    details.tool_events = finalOutput.tool_events ?? [];
    details.workspace_changes = workspaceChanges;
    details.council_files = {
      result: path.join(runDir, 'result.json'),
      frontend_snapshot: path.join(runDir, 'frontend-snapshot.json'),
      stage: councilStagePath,
      production_stage_state: path.join(runDir, 'production-stage-state.json'),
    };
    const participantIds = participants
      .map((value) => asRecord(value)?.participant_id)
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0 && path.basename(value) === value,
      );
    details.council_role_directories = ['primary', ...participantIds].map((participantId) =>
      path.join(stateRoot, 'council', runId, participantId),
    );
    details.run_dir = runDir;
    details.errors_from_run = snapshot.errors ?? [];

    if (snapshot.status !== 'completed') {
      errors.push(`council run ended as ${String(snapshot.status)}`);
    }
    if (!decision) errors.push('Council decision was not persisted in the canonical stage state');
    if (proposals.length < 2) errors.push('council snapshot has fewer than two proposals');
    if (!Array.isArray(reviews) || reviews.length === 0) {
      errors.push('council has no structured reviews');
    } else if (!reviews.every(isStructuredReview)) {
      errors.push('council review payload is not structured');
    }
    if (!synthesis) errors.push('Council synthesis was not persisted in the run snapshot');
    if (!councilResult && !persistedCouncilResult) {
      errors.push('CouncilResult was not returned or persisted');
    }
    if (!councilOutcome) {
      errors.push('strategy-independent CouncilOutcome was not returned or persisted');
    }
    const agentRuns = Array.isArray(snapshot.agent_runs) ? snapshot.agent_runs : [];
    const mainAgentRun = agentRuns.find((value) => {
      const record = asRecord(value);
      return record?.type === 'agent.execution_completed' && record.role_id === 'role_ts_engineer';
    });
    details.main_agent_evidence = mainAgentRun ?? null;
    if (!hasBExecutionEvidence(mainAgentRun)) {
      errors.push('main B execution evidence is incomplete');
    }
    for (const roleDirectory of details.council_role_directories as string[]) {
      if (!(await pathExists(roleDirectory))) {
        errors.push(`missing isolated Council role directory: ${roleDirectory}`);
      }
    }
    if (workspaceChanges.length === 0) {
      errors.push('no real files were created or modified in the workspace');
    }

    const finalCandidate = workspaceChanges.find((file) => file.endsWith('council-final.ts'));
    details.final_candidate_file = finalCandidate ?? null;
    if (finalCandidate) {
      const finalBytes = await fs.readFile(path.join(options.workspace, finalCandidate));
      const workspaceSha256 = createHash('sha256').update(finalBytes).digest('hex');
      details.final_candidate_content = finalBytes.toString('utf-8');
      details.workspace_sha256 = workspaceSha256;
      const resultRecord = councilResult ?? asRecord(persistedCouncilResult);
      if (resultRecord?.final_artifact_sha256 !== workspaceSha256) {
        errors.push('CouncilResult final_artifact_sha256 does not match the workspace file');
      }
      if (!['verified', 'best_effort'].includes(String(resultRecord?.quality))) {
        errors.push('CouncilResult quality is missing or invalid');
      }
    }

    log(`council decision_id: ${String(details.decision_id)}`);
    log(`council proposals: ${String(details.proposal_count)}`);
    log(`workspace changes: ${workspaceChanges.join(', ') || '(none)'}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await backend?.close();
  }
  return {
    scenario: 'council',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

function isStructuredReview(value: unknown): boolean {
  const review = asRecord(value);
  return Boolean(
    review &&
    typeof review.proposal_id === 'string' &&
    ['approve', 'reject', 'needs_revision'].includes(String(review.verdict)) &&
    typeof review.reason === 'string' &&
    Array.isArray(review.unmet_criteria) &&
    Array.isArray(review.evidence_refs),
  );
}

function hasBExecutionEvidence(value: unknown): boolean {
  const evidence = asRecord(value);
  return Boolean(
    evidence &&
    typeof evidence.agent_id === 'string' &&
    typeof evidence.context_pack_ref === 'string' &&
    typeof evidence.memory_buffer_ref === 'string' &&
    typeof evidence.driver_run_result_id === 'string' &&
    typeof evidence.session_id === 'string' &&
    Array.isArray(evidence.artifact_refs) &&
    typeof evidence.transcript_ref === 'string',
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function runSubagentScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  const backend = await startBackend('subagent');
  try {
    const before = await snapshotWorkspaceFiles();
    const prompt = [
      '这是一个 subagent 能力探针。你必须使用 Task 工具（subagent/子代理）来完成以下任务，',
      '而不是自己直接完成：派生一个子代理，让它在工作区创建 subagent-probe.txt，',
      '内容为一行 SUBAGENT_PROBE_OK。如果你无法使用 subagent，请直接创建该文件并在回复中说明原因。',
    ].join('');
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt,
      mode: 'single_agent',
      workspace_path: options.workspace,
    });
    log(`subagent probe run created: ${created.run_id}`);
    await backend.subscribeAndLog(created.run_id);
    const snapshot = await backend.waitForTerminal(created.run_id, runTimeoutMs);
    const after = await snapshotWorkspaceFiles();
    const workspaceChanges = diffWorkspace(before, after);

    const finalOutput = asRecord(snapshot.final_output) ?? {};
    const toolEvents = Array.isArray(finalOutput.tool_events) ? finalOutput.tool_events : [];
    // 只识别 A 真实上报的证据，绝不伪造 subagent 事件。
    const subagentEvidence = toolEvents.filter((event) => {
      const record = asRecord(event) ?? {};
      const haystack = [record.kind, record.title, record.tool_name, record.toolName]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      return /subagent|sub-agent|\btask\b|\bagent\b/.test(haystack);
    });
    const subagentObserved = subagentEvidence.length > 0;

    details.run_id = created.run_id;
    details.status = snapshot.status;
    details.subagent_observed = subagentObserved;
    details.visibility = subagentObserved ? 'observable' : 'opaque';
    details.subagent_evidence = subagentEvidence;
    details.tool_event_count = toolEvents.length;
    details.tool_events_raw = toolEvents;
    details.response = finalOutput.response ?? '';
    details.session_id = finalOutput.session_id ?? null;
    details.changed_files = finalOutput.changed_files ?? [];
    details.workspace_changes = workspaceChanges;
    details.run_dir = path.join(stateRoot, 'runs', created.run_id);
    details.errors_from_run = snapshot.errors ?? [];
    details.note =
      'Evidence above is the raw observable data returned by A. ' +
      'If A does not expose subagent identity, the backend cannot see it; we do not modify A.';

    const probeFile = workspaceChanges.find((file) => file.endsWith('subagent-probe.txt'));
    details.probe_file = probeFile ?? null;
    if (probeFile) {
      details.probe_file_content = await fs.readFile(
        path.join(options.workspace, probeFile),
        'utf-8',
      );
    }

    if (snapshot.status !== 'completed') {
      errors.push(`subagent probe run ended as ${String(snapshot.status)}`);
    }
    log(`subagent_observed=${String(subagentObserved)}`);
    log(`visibility=${subagentObserved ? 'observable' : 'opaque'}`);
    log(`tool events: ${String(toolEvents.length)}`);
    log(`workspace changes: ${workspaceChanges.join(', ') || '(none)'}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await backend.close();
  }
  return {
    scenario: 'subagent',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

async function runRestartScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  // 第一个后端进程：执行原始任务并落盘。
  const firstBackend = await startBackend('restart-first');
  let originalRunId = '';
  try {
    const prompt =
      '在工作区创建或覆盖 restart-proof.txt，内容为一行 RESTART_PROOF。不要创建其他文件。';
    const created = await firstBackend.request<{ run_id: string }>('run.create', {
      prompt,
      mode: 'single_agent',
      workspace_path: options.workspace,
    });
    originalRunId = created.run_id;
    log(`original run created: ${originalRunId}`);
    await firstBackend.subscribeAndLog(originalRunId);
    const snapshot = await firstBackend.waitForTerminal(originalRunId, runTimeoutMs);
    details.original_run_id = originalRunId;
    details.original_status = snapshot.status;
    const finalOutput = asRecord(snapshot.final_output) ?? {};
    details.original_session_id = finalOutput.session_id ?? null;
    if (snapshot.status !== 'completed') {
      errors.push(`original run ended as ${String(snapshot.status)}`);
    }
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    // 真实停止第一个后端进程。
    await firstBackend.close();
    log('first backend stopped');
  }

  if (errors.length > 0 || !originalRunId) {
    return { scenario: 'restart', status: 'failed', details, errors };
  }

  // 第二个后端进程：重启后从磁盘找到历史 run 并重新执行。
  const secondBackend = await startBackend('restart-second');
  try {
    const listed = await secondBackend.request<{ runs: Record<string, unknown>[] }>('run.list', {});
    const historical = listed.runs.find((entry) => entry.run_id === originalRunId);
    details.run_list_size = listed.runs.length;
    details.original_in_history = Boolean(historical);
    details.original_history_status = historical?.status ?? null;
    if (!historical) {
      errors.push('run.list after backend restart does not contain the original run');
    }

    const restarted = await secondBackend.request<{
      run_id: string;
      task_id: string;
      restarted_from_run_id: string;
      status: string;
    }>('run.restart', { run_id: originalRunId });
    log(`restarted as new run: ${restarted.run_id} (from ${restarted.restarted_from_run_id})`);
    await secondBackend.subscribeAndLog(restarted.run_id);
    const snapshot = await secondBackend.waitForTerminal(restarted.run_id, runTimeoutMs);
    const finalOutput = asRecord(snapshot.final_output) ?? {};

    details.new_run_id = restarted.run_id;
    details.restarted_from_run_id = restarted.restarted_from_run_id;
    details.new_status = snapshot.status;
    details.new_session_id = finalOutput.session_id ?? null;
    details.response = finalOutput.response ?? '';
    details.changed_files = finalOutput.changed_files ?? [];
    details.new_run_dir = path.join(stateRoot, 'runs', restarted.run_id);
    details.original_run_dir = path.join(stateRoot, 'runs', originalRunId);
    details.errors_from_run = snapshot.errors ?? [];

    const proofPath = path.join(options.workspace, 'restart-proof.txt');
    const proof = await fs.readFile(proofPath, 'utf-8').catch(() => undefined);
    details.proof_file = proofPath;
    details.proof_file_content = proof ?? null;

    if (restarted.run_id === originalRunId) {
      errors.push('run.restart reused the original run_id');
    }
    if (snapshot.status !== 'completed') {
      errors.push(`restarted run ended as ${String(snapshot.status)}`);
    }
    if (!proof?.includes('RESTART_PROOF')) {
      errors.push('restart-proof.txt does not contain RESTART_PROOF after the restarted run');
    }
    log(`original run: ${originalRunId} -> new run: ${restarted.run_id}`);
    log(`proof file: ${proofPath}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await secondBackend.close();
    log('second backend stopped');
  }
  return {
    scenario: 'restart',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

/**
 * 崩溃恢复验收：SIGKILL 打断执行中的 task，重启后端，task.resume 从 checkpoint 续跑。
 *
 * 与 restart 场景的区别：restart 走 run.restart（整条 run 重放，等于从头再做一遍），
 * 这里走 task.resume（从 checkpoint 的 cursor 续跑）。两者验证的是不同的东西，
 * 所以是两个场景而不是把 restart 改掉。
 *
 * 三条必须在终端上看得见的证据：
 *   1. 被杀前已落盘的 safepoint，其 resume_cursor 已经越过 execute_agent；
 *   2. resume 前人为删掉的 agent 产物文件，在 resume 后被 file anchor 还原；
 *   3. 整个 task 生命周期内 agent 执行只发生过一次（没有因为 resume 而重复副作用）。
 */
async function runResumeScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  const proofPath = path.join(options.workspace, 'resume-proof.txt');
  const spec =
    '在工作区创建或覆盖 resume-proof.txt，内容为一行 RESUME_PROOF。不要创建或修改其他文件。';

  await fs.rm(proofPath, { force: true });

  // ---- 阶段一：起后端、建 task、等到 safepoint 越过 execute_agent，然后 SIGKILL ----
  const firstBackend = await startBackend('resume-first');
  let taskId = '';
  let interruptedRunId = '';
  let killCursor = '';
  try {
    const created = await firstBackend.request<Record<string, unknown>>('task.create', {
      spec,
      completion_criteria: ['resume-proof.txt 内容为 RESUME_PROOF'],
      workspace_path: options.workspace,
      mode: 'single_agent',
    });
    taskId = String(asRecord(created.task)?.task_id ?? '');
    if (!taskId) throw new Error('task.create did not return a task_id');
    interruptedRunId = String(asRecord(created.current_run)?.run_id ?? '');
    details.task_id = taskId;
    log(`task created: ${taskId} (run ${interruptedRunId || 'n/a'})`);

    // 等一个"真干过活"的 safepoint：cursor 已越过 execute_agent，说明 agent 产物已落盘。
    // 250ms 轮询：kill 窗口是 safepoint 落盘到 task 跑完之间，抢得越快越可靠。
    const pastExecute = new Set(['council', 'gate', 'deliver']);
    const safepoint = await firstBackend.waitForTaskEvent(
      taskId,
      (event) => {
        if (event.type !== 'checkpoint.saved') return false;
        const cursor = asRecord(event.payload)?.resume_cursor;
        return typeof cursor === 'string' && pastExecute.has(cursor);
      },
      runTimeoutMs,
      250,
    );
    const safepointPayload = asRecord(safepoint.payload) ?? {};
    killCursor = String(safepointPayload.resume_cursor ?? '');
    interruptedRunId = String(safepoint.run_id ?? interruptedRunId);
    details.kill_checkpoint_id = safepointPayload.checkpoint_id ?? null;
    details.kill_resume_cursor = killCursor;
    details.interrupted_run_id = interruptedRunId;
    log(`safepoint reached at cursor=${killCursor}; sending SIGKILL`);

    // 硬杀：不 flush、不落盘收尾，磁盘上留下的就是真实的崩溃现场。
    await firstBackend.kill();
    log('first backend SIGKILLed');
    details.kill_signal = 'SIGKILL';
  } catch (error) {
    errors.push(toMessage(error));
    await firstBackend.kill().catch(() => undefined);
  }

  if (errors.length > 0 || !taskId) {
    return { scenario: 'resume', status: 'failed', details, errors };
  }

  // 崩溃后的产物状态：先记下来，再人为删除，用来证明 resume 真的还原了内容。
  const proofBeforeDelete = await fs.readFile(proofPath, 'utf-8').catch(() => undefined);
  details.proof_content_before_kill = proofBeforeDelete ?? null;
  await fs.rm(proofPath, { force: true });
  details.proof_deleted_before_resume = !(await pathExists(proofPath));
  log(`deleted ${proofPath} before resume (was ${proofBeforeDelete ? 'present' : 'absent'})`);

  // ---- 阶段二：重启后端，恢复中断 task，resume 续跑 ----
  const secondBackend = await startBackend('resume-second');
  try {
    // 后端启动时会 recoverInterruptedTasks()，把被杀的 task 标成 blocked。
    const recovered = await secondBackend.request<Record<string, unknown>>('task.get', {
      task_id: taskId,
    });
    const recoveredTask = asRecord(recovered.task) ?? {};
    details.status_after_restart = recoveredTask.status ?? null;
    details.current_run_after_restart = asRecord(recovered.current_run)?.run_id ?? null;
    if (recoveredTask.status === 'completed') {
      // kill 窗口没抢到：task 在 SIGKILL 之前已经跑完，本次运行没有真实中断可恢复。
      errors.push(
        'task had already completed before the SIGKILL landed; the kill window was missed, ' +
          'so this run proves nothing about resume. Re-run with a heavier spec.',
      );
    } else if (recoveredTask.status !== 'blocked') {
      errors.push(
        `task status after restart is ${String(recoveredTask.status)}, expected blocked ` +
          '(recoverInterruptedTasks did not pick up the killed task)',
      );
    }
    if (recovered.current_run) {
      errors.push('current_run is still set after restart; the killed run was not closed out');
    }

    const resumed = await secondBackend.request<Record<string, unknown>>('task.resume', {
      task_id: taskId,
    });
    const resumedRunId = String(asRecord(resumed.current_run)?.run_id ?? '');
    details.resumed_run_id = resumedRunId || null;
    log(`resumed run: ${resumedRunId || 'n/a'}`);
    if (resumedRunId && resumedRunId === interruptedRunId) {
      errors.push('task.resume reused the interrupted run_id');
    }

    // 证据 2：文件被 anchor 还原（在 resume 返回之后立即可见，早于新 stage 产出）。
    const proofAfterResume = await fs.readFile(proofPath, 'utf-8').catch(() => undefined);
    details.proof_content_after_resume = proofAfterResume ?? null;
    if (proofBeforeDelete && !proofAfterResume) {
      errors.push('resume did not restore resume-proof.txt from the checkpoint file anchor');
    }
    log(`proof after resume: ${proofAfterResume ? JSON.stringify(proofAfterResume) : 'missing'}`);

    if (resumedRunId) {
      const snapshot = await secondBackend.waitForTerminal(resumedRunId, runTimeoutMs);
      details.resumed_run_status = snapshot.status;
      details.resumed_run_errors = snapshot.errors ?? [];
      if (snapshot.status !== 'completed') {
        errors.push(`resumed run ended as ${String(snapshot.status)}`);
      }
    }

    const finalTask = await secondBackend.request<Record<string, unknown>>('task.get', {
      task_id: taskId,
    });
    details.final_task_status = asRecord(finalTask.task)?.status ?? null;

    // 拉全量落盘事件，统计跨 run 的副作用次数。
    const allEvents = await secondBackend.listTaskEvents(taskId);
    const counts = countEventTypes(allEvents);
    details.event_type_counts = counts;

    const restoreEvent = allEvents.find((event) => event.type === 'checkpoint.workspace_restored');
    const restorePayload = asRecord(restoreEvent?.payload) ?? {};
    details.workspace_restore_event = restoreEvent ? restorePayload : null;
    if (!restoreEvent) {
      errors.push('no checkpoint.workspace_restored event was recorded for the resumed run');
    } else if (restorePayload.status !== 'restored') {
      errors.push(
        `workspace restore reported status=${String(restorePayload.status)} ` +
          `reason=${String(restorePayload.reason ?? 'n/a')}`,
      );
    }

    // 证据 3：越过 execute_agent 之后 resume，agent 执行与投放都不应再发生一次。
    for (const eventType of ['agent.execution_completed', 'artifact.delivered']) {
      const count = counts[eventType] ?? 0;
      details[`${eventType}_count`] = count;
      if (count > 1) {
        errors.push(
          `${eventType} fired ${count} times across the task; ` +
            'resume repeated a side effect instead of continuing from the cursor',
        );
      }
    }
    if ((counts['agent.execution_completed'] ?? 0) === 0) {
      errors.push('agent.execution_completed never fired; the task never did real work');
    }

    const proofFinal = await fs.readFile(proofPath, 'utf-8').catch(() => undefined);
    details.proof_file = proofPath;
    details.proof_content_final = proofFinal ?? null;
    if (!proofFinal?.includes('RESUME_PROOF')) {
      errors.push('resume-proof.txt does not contain RESUME_PROOF after resume');
    }
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await secondBackend.close();
    log('second backend stopped');
  }

  return {
    scenario: 'resume',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

function countEventTypes(events: readonly Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (typeof event.type !== 'string') continue;
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

interface MemoryTaskRun {
  created: { run_id: string; task_id: string };
  snapshot: Record<string, unknown>;
}

async function runMemoryTask(
  backend: BackendClient,
  prompt: string,
): Promise<MemoryTaskRun> {
  const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
    prompt,
    mode: 'single_agent',
    workspace_path: options.workspace,
  });
  await backend.subscribeAndLog(created.run_id);
  return {
    created,
    snapshot: await backend.waitForTerminal(created.run_id, runTimeoutMs),
  };
}

function validateMemoryCapabilities(
  operations: Record<string, unknown>,
  embedding: Record<string, unknown>,
  skillReview: Record<string, unknown>,
  errors: string[],
): void {
  for (const operation of [
    'list_agents',
    'get_agent_persona',
    'list_experiences',
    'list_skills',
    'list_maintenance',
    'promote_skills',
  ]) {
    if (asRecord(operations[operation])?.status !== 'available') {
      errors.push(`memory capability ${operation} is not available`);
    }
  }
  for (const operation of ['approve_skill', 'reject_skill']) {
    if (asRecord(operations[operation])?.status !== 'available') {
      errors.push(`memory capability ${operation} is not available`);
    }
  }
  for (const operation of ['update_persona']) {
    const capability = asRecord(operations[operation]);
    if (
      capability?.status !== 'unavailable' ||
      typeof capability.reason !== 'string' ||
      !capability.reason.trim()
    ) {
      errors.push(`memory capability ${operation} lacks an explicit unavailable reason`);
    }
  }
  if (typeof embedding.provider !== 'string' || !embedding.provider) {
    errors.push('embedding provider is missing from memory capabilities');
  }
  if (typeof embedding.model !== 'string' || !embedding.model) {
    errors.push('embedding model is missing from memory capabilities');
  }
  if (
    typeof embedding.dimensions !== 'number' ||
    !Number.isInteger(embedding.dimensions) ||
    embedding.dimensions <= 0
  ) {
    errors.push('embedding dimensions are missing or invalid');
  }
  if (skillReview.mode !== 'auto_approve') {
    errors.push('memory acceptance requires skill_review.mode=auto_approve');
  }
}

async function readRecordIdsByAgent(
  backend: BackendClient,
  agentIds: readonly string[],
  method: 'memory.listExperiences' | 'memory.listSkills',
  resultField: 'experiences' | 'skills',
): Promise<Record<string, string[]>> {
  const entries = await Promise.all(
    agentIds.map(async (agentId) => [
      agentId,
      recordIds(await listMemoryRecords(backend, method, resultField, agentId)),
    ] as const),
  );
  return Object.fromEntries(entries);
}

async function listMemoryRecords(
  backend: BackendClient,
  method: 'memory.listExperiences' | 'memory.listSkills',
  resultField: 'experiences' | 'skills',
  agentId: string,
): Promise<Record<string, unknown>[]> {
  const result = await backend.request<Record<string, unknown>>(method, {
    role_id: agentId,
  });
  const values = result[resultField];
  return Array.isArray(values) ? values.map(asRecord).filter(isRecord) : [];
}

async function waitForMaintenanceEvidence(
  backend: BackendClient,
  runId: string,
  agentId: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await backend.request<{ maintenance?: unknown[] }>(
      'memory.listMaintenance',
      { role_id: agentId },
    );
    const evidence = (result.maintenance ?? [])
      .map(asRecord)
      .filter(isRecord)
      .find(
        (item) =>
          item.kind === 'experience_extraction' &&
          item.run_id === runId &&
          item.role_id === agentId,
      );
    if (
      evidence &&
      ['completed', 'skipped', 'failed'].includes(String(evidence.status))
    ) {
      return evidence;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for B maintenance for run ${runId}`);
    }
    await sleep(500);
  }
}

function requireSelectedAgent(snapshot: Record<string, unknown>): string {
  const marketAgentId = asRecord(snapshot.market)?.winner_agent_id;
  if (typeof marketAgentId === 'string' && marketAgentId) return marketAgentId;
  const agentRuns = Array.isArray(snapshot.agent_runs) ? snapshot.agent_runs : [];
  for (const value of agentRuns) {
    const execution = asRecord(value);
    if (
      execution?.type === 'agent.execution_completed' &&
      typeof execution.agent_id === 'string'
    ) {
      return execution.agent_id;
    }
  }
  throw new Error('Run snapshot did not expose a selected B Agent');
}

function findCompletedAgentExecution(
  snapshot: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> | undefined {
  const agentRuns = Array.isArray(snapshot.agent_runs) ? snapshot.agent_runs : [];
  return agentRuns
    .map(asRecord)
    .filter(isRecord)
    .find(
      (execution) =>
        execution.type === 'agent.execution_completed' &&
        execution.agent_id === agentId,
    );
}

function readPersonaRef(execution: Record<string, unknown> | undefined): string | undefined {
  const diagnostics = asRecord(execution?.diagnostics);
  const agentRuntime = asRecord(diagnostics?.agent_runtime);
  return typeof agentRuntime?.persona_ref === 'string'
    ? agentRuntime.persona_ref
    : undefined;
}

async function readContextPack(reference: unknown): Promise<Record<string, unknown> | undefined> {
  if (
    typeof reference !== 'string' ||
    !/^context_pack_[a-f0-9]{24}$/.test(reference)
  ) {
    return undefined;
  }
  return asRecord(
    await readJsonIfExists(
      path.join(stateRoot, 'b', 'context-packs', `${reference}.json`),
    ),
  );
}

function recordIds(records: readonly Record<string, unknown>[]): string[] {
  return records.flatMap((record) =>
    typeof record.id === 'string' ? [record.id] : [],
  );
}

function isRecord(
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> {
  return value !== undefined;
}

// ---------------------------------------------------------------------------
// Backend process client
// ---------------------------------------------------------------------------

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  subscribeAndLog(runId: string): Promise<void>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  /**
   * task 的全量事件（来自 task.subscribe 回放，即已落盘的事件）。
   *
   * 必须走落盘回放而不是实时通知：checkpoint.saved 由 TaskProcessor 直接写 SQLite，
   * 不经过 run registry，因此永远不会作为 task.event 实时推送出来。
   */
  listTaskEvents(taskId: string): Promise<Record<string, unknown>[]>;
  /** 轮询落盘事件直到命中 predicate；返回该事件本体。 */
  waitForTaskEvent(
    taskId: string,
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs: number,
    pollMs?: number,
  ): Promise<Record<string, unknown>>;
  /** SIGKILL：模拟进程被硬杀，不给任何优雅退出的机会。 */
  kill(): Promise<void>;
  close(): Promise<void>;
}

async function startBackend(label: string): Promise<BackendClient> {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'],
    {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACP_DRIVER_TIMEOUT_MS: process.env.ACP_DRIVER_TIMEOUT_MS ?? '300000',
      NEWIDE_B_SKILL_AUTO_APPROVE: process.env.NEWIDE_B_SKILL_AUTO_APPROVE ?? '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });

  const messages: JsonRpcMessage[] = [];
  const waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // Ignore any unexpected non-JSON line.
    }
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });

  let nextId = 1;
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    const waiting = new Promise<JsonRpcMessage>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off('close', onClose);
        child.off('error', onError);
      };
      const resolveResponse = (message: JsonRpcMessage): void => {
        cleanup();
        resolve(message);
      };
      const rejectRequest = (error: Error): void => {
        if (!waiters.delete(waiter)) return;
        cleanup();
        reject(error);
      };
      const onClose = (code: number | null): void => {
        rejectRequest(
          new Error(
            `[${label}] backend exited with code ${String(code)} while waiting for ${method}. ` +
              `stderr=${stderr.join('')}`,
          ),
        );
      };
      const onError = (error: Error): void => {
        rejectRequest(
          new Error(
            `[${label}] backend failed while waiting for ${method}: ${error.message}. ` +
              `stderr=${stderr.join('')}`,
          ),
        );
      };
      const waiter = {
        predicate: (message: JsonRpcMessage) => message.id === id,
        resolve: resolveResponse,
      };
      waiters.add(waiter);
      child.once('close', onClose);
      child.once('error', onError);
      const timeout = setTimeout(() => {
        rejectRequest(
          new Error(`[${label}] timed out waiting for ${method}. stderr=${stderr.join('')}`),
        );
      }, 60_000);
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waiting;
    if (response.error) {
      throw new Error(
        `[${label}] ${method}: ${String(response.error.code)} ${response.error.message}`,
      );
    }
    return response.result as T;
  };

  // 启动探活。
  await request('system.ping', {});
  log(`backend started (${label})`);

  // 已在终端打印过的 task 事件，避免轮询时重复刷屏。
  const loggedTaskEvents = new Set<string>();
  const readTaskEvents = async (taskId: string): Promise<Record<string, unknown>[]> => {
    const result = await request<{ replay_events?: Record<string, unknown>[] }>('task.subscribe', {
      task_id: taskId,
    });
    const events = result.replay_events ?? [];
    for (const event of events) {
      const eventId = String(event.event_id ?? '');
      if (!eventId || loggedTaskEvents.has(eventId)) continue;
      loggedTaskEvents.add(eventId);
      if (typeof event.type === 'string') log(`  task event: ${event.type}`);
    }
    return events;
  };

  return {
    request,
    subscribeAndLog: async (runId: string) => {
      await request('run.subscribe', { run_id: runId });
      const seen = new Set<string>();
      const logEvent = (message: JsonRpcMessage) => {
        const params = asRecord(message.params);
        if (params?.run_id !== runId) return;
        const event = asRecord(params.event);
        const type = typeof event?.type === 'string' ? event.type : undefined;
        if (!type || seen.has(String(event?.event_id))) return;
        seen.add(String(event?.event_id));
        if (
          /^(run\.|market\.|council\.|driver\.run_result|agent\.execution|gate\.result|worktree\.)/.test(
            type,
          )
        ) {
          log(`  event: ${type}`);
        }
      };
      for (const message of messages) {
        if (message.method === 'run.event') logEvent(message);
      }
      waiters.add({
        predicate: (message) => {
          if (message.method === 'run.event') logEvent(message);
          return false; // 永不消费，仅观察
        },
        resolve: () => undefined,
      });
    },
    waitForTerminal: async (runId: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        if (snapshot.status !== 'running') return snapshot;
        await sleep(1_000);
      }
      throw new Error(`[${label}] run ${runId} did not reach a terminal state`);
    },
    listTaskEvents: readTaskEvents,
    waitForTaskEvent: async (taskId, predicate, timeoutMs, pollMs = 1_000) => {
      const deadline = Date.now() + timeoutMs;
      let seen: string[] = [];
      while (Date.now() < deadline) {
        const events = await readTaskEvents(taskId);
        const match = events.find((event) => predicate(event));
        if (match) return match;
        seen = events.map((event) => String(event.type));
        await sleep(pollMs);
      }
      throw new Error(
        `[${label}] task ${taskId} never emitted the awaited event. seen=${seen.join(',')}`,
      );
    },
    kill: async () => {
      child.kill('SIGKILL');
      await Promise.race([closed, sleep(5_000)]);
    },
    close: async () => {
      child.stdin?.end();
      const result = await Promise.race([closed, sleep(5_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') {
        child.kill('SIGTERM');
        const terminated = await Promise.race([
          closed,
          sleep(2_000).then(() => 'timeout' as const),
        ]);
        if (terminated === 'timeout') child.kill('SIGKILL');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function snapshotWorkspaceFiles(): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name === '.newide' || dirent.name === 'node_modules' || dirent.name === '.git') {
        continue;
      }
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(fullPath);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(fullPath).catch(() => undefined);
        if (stat) files.set(path.relative(options.workspace, fullPath), stat.mtimeMs);
      }
    }
  };
  await walk(options.workspace);
  return files;
}

function diffWorkspace(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [file, mtime] of after) {
    const previous = before.get(file);
    if (previous === undefined || previous !== mtime) changed.push(file);
  }
  return changed.sort();
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

async function readMarketEvidence(
  ref: unknown,
): Promise<{ path: string; value: unknown } | undefined> {
  if (typeof ref !== 'string' || !ref.startsWith('file:')) return undefined;
  try {
    const filePath = fileURLToPath(ref);
    return { path: filePath, value: JSON.parse(await fs.readFile(filePath, 'utf-8')) };
  } catch {
    return undefined;
  }
}

function parseCli(args: string[]): CliOptions {
  const workspaceIndex = args.indexOf('--workspace');
  const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error('--workspace must be an absolute path');
  }
  const scenarioIndex = args.indexOf('--scenario');
  const scenarioValue = scenarioIndex >= 0 ? (args[scenarioIndex + 1] ?? 'all') : 'all';
  const scenarios: Scenario[] =
    scenarioValue === 'all'
      ? ['memory', 'market', 'council', 'subagent', 'restart', 'resume']
      : scenarioValue === 'memory' ||
          scenarioValue === 'market' ||
          scenarioValue === 'council' ||
          scenarioValue === 'subagent' ||
          scenarioValue === 'restart' ||
          scenarioValue === 'resume'
        ? [scenarioValue]
        : (() => {
            throw new Error(`Invalid --scenario value: ${scenarioValue}`);
          })();
  const existingRunIndex = args.indexOf('--existing-run');
  const existingRunId = existingRunIndex >= 0 ? args[existingRunIndex + 1] : undefined;
  if (existingRunIndex >= 0 && (!existingRunId || !/^run_[a-zA-Z0-9-]+$/.test(existingRunId))) {
    throw new Error('--existing-run must be a valid run id');
  }
  if (existingRunId && (scenarios.length !== 1 || scenarios[0] !== 'council')) {
    throw new Error('--existing-run is only supported with --scenario council');
  }
  return { workspace: path.resolve(workspace), scenarios, existingRunId };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}
