import { BaseGateRunner } from './runner';
import type { GateRequest, GateResult, GateDefinition, GateDecision, Finding } from './gate';
import { parseGateOutput } from './output-parser';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ExecError extends Error {
  code?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

export class CommandRunner extends BaseGateRunner {
  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
  ) {
    super(gate_id);
  }

  async run(request: GateRequest): Promise<GateResult> {
    const cmd = this.definition.command;
    if (!cmd) {
      return this.buildResult(
        request,
        'deny',
        'CommandRunner failed: No command specified in definition.',
      );
    }

    const timeout =
      this.definition.timeout != null
        ? this.definition.timeout * 1000
        : (request.timeout_ms ?? 30000);

    // Execute command, capturing stdout/stderr regardless of exit code
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = 0;
    let timedOut = false;

    try {
      const result = await execAsync(cmd, { timeout });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      const execErr = error as ExecError;
      stdout = execErr.stdout ?? '';
      stderr = execErr.stderr ?? '';
      exitCode = execErr.code ?? 1;
      timedOut = execErr.killed === true;
    }

    const format = this.definition.outputConfig.format;

    // ── Format-driven path: parse stdout → apply severity_map/threshold ──
    if (format) {
      return this.evaluateWithFormat(request, stdout, stderr, exitCode, timedOut, format);
    }

    // ── Backward-compatible path: exit-code only ──
    if (exitCode === 0 && !timedOut) {
      return this.buildResult(request, 'allow', 'Command executed successfully.', {
        required_actions: [],
        audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
      });
    }

    const onFailDecision = this.definition.outputConfig.on_fail ?? 'deny';
    const message = timedOut
      ? `Command timed out after ${timeout}ms.`
      : `Command execution failed with exit code ${String(exitCode)}. Stderr: ${stderr.slice(0, 500)}`;

    return this.buildResult(request, onFailDecision, message, {
      required_actions: ['inspect-logs'],
      audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
    });
  }

  // ── Format-driven evaluation ─────────────────────────────────

  private evaluateWithFormat(
    request: GateRequest,
    stdout: string,
    _stderr: string,
    exitCode: number | null,
    timedOut: boolean,
    format: NonNullable<typeof this.definition.outputConfig.format>,
  ): GateResult {
    const config = this.definition.outputConfig;

    // If the command itself failed badly (timeout, crash), respect on_fail
    if (timedOut) {
      const decision = config.on_fail ?? 'deny';
      return this.buildResult(
        request,
        decision,
        `Command timed out. Format-driven evaluation skipped.`,
        {
          required_actions: ['inspect-logs'],
          audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
        },
      );
    }

    if (exitCode !== 0 && stdout.trim().length === 0) {
      const decision = config.on_fail ?? 'deny';
      return this.buildResult(
        request,
        decision,
        `Command failed with exit code ${String(exitCode)} and produced no stdout.`,
        {
          required_actions: ['inspect-logs'],
          audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
        },
      );
    }

    // Parse stdout
    let parsed;
    try {
      parsed = parseGateOutput(stdout, format);
    } catch {
      const decision = config.on_fail ?? 'deny';
      return this.buildResult(
        request,
        decision,
        `Failed to parse command output as ${format}.`,
        {
          required_actions: ['inspect-logs'],
          audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
        },
      );
    }

    // Coverage path: apply threshold
    if (parsed.coverage) {
      return this.evaluateCoverage(request, parsed.coverage.line, parsed.coverage.branch);
    }

    // Findings path: apply severity_map
    const findings = parsed.findings ?? [];
    if (findings.length === 0) {
      // No findings at all → allow
      return this.buildResult(
        request,
        'allow',
        `${format} output contained no findings. Exit code: ${String(exitCode)}.`,
        {
          required_actions: [],
          audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
        },
      );
    }

    // Map each finding through severity_map → most strict decision
    const decisions = findings.map((f) => this.mapSeverity(f.severity, config));
    const strictest = this.pickStrictest(decisions);
    const reason = this.buildFindingsReason(findings, decisions, strictest);

    return this.buildResult(
      request,
      strictest,
      reason,
      {
        required_actions: strictest === 'allow' ? [] : ['inspect-gate-findings'],
        audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
      },
    );
  }

  private evaluateCoverage(
    request: GateRequest,
    lineCoverage: number,
    branchCoverage: number,
  ): GateResult {
    const config = this.definition.outputConfig;
    const threshold = config.threshold ?? {};
    const lineBelow = threshold.line !== undefined && lineCoverage < threshold.line;
    const branchBelow = threshold.branch !== undefined && branchCoverage < threshold.branch;

    if (lineBelow || branchBelow) {
      const decision = config.on_below_threshold ?? 'deny';
      const parts: string[] = [];
      if (threshold.line !== undefined) parts.push(`line ${lineCoverage}% < ${threshold.line}%`);
      if (threshold.branch !== undefined) parts.push(`branch ${branchCoverage}% < ${threshold.branch}%`);
      return this.buildResult(
        request,
        decision,
        `Coverage below threshold: ${parts.join(', ')}. Decision: ${decision}.`,
        {
          required_actions: ['improve-coverage'],
          audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
        },
      );
    }

    return this.buildResult(
      request,
      'allow',
      `Coverage meets thresholds (line: ${lineCoverage}%, branch: ${branchCoverage}%).`,
      {
        required_actions: [],
        audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
      },
    );
  }

  // ── Helpers ──────────────────────────────────────────────────

  private pickStrictest(decisions: GateDecision[]): GateDecision {
    const rank: Record<GateDecision, number> = { allow: 0, defer: 1, ask: 2, deny: 3 };
    return decisions.reduce((worst, d) => (rank[d] > rank[worst] ? d : worst), 'allow' as GateDecision);
  }

  private buildFindingsReason(
    findings: Finding[],
    decisions: GateDecision[],
    finalDecision: GateDecision,
  ): string {
    const severityCounts = new Map<string, { count: number; decision: GateDecision }>();
    for (let i = 0; i < findings.length; i++) {
      const sev = findings[i].severity.toLowerCase();
      const existing = severityCounts.get(sev);
      if (existing) {
        existing.count++;
      } else {
        severityCounts.set(sev, { count: 1, decision: decisions[i] });
      }
    }

    const breakdown = Array.from(severityCounts.entries())
      .map(([sev, { count, decision }]) => `${count} ${sev}(→${decision})`)
      .join(', ');

    return `${findings.length} finding(s): ${breakdown}. Final decision: ${finalDecision}.`;
  }
}
