/**
 * Gate output format parsers.
 *
 * Each parser extracts structured findings or coverage data from
 * command stdout so that severity_map and threshold rules can be
 * applied by the runner.
 */
import type { Finding, ParsedGateOutput, GateOutputFormat } from './gate';

// ──────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────

/** Parse command stdout according to the declared output format. */
export function parseGateOutput(stdout: string, format: GateOutputFormat): ParsedGateOutput {
  switch (format) {
    case 'sarif':
      return parseSarif(stdout);
    case 'junit':
      return parseJunit(stdout);
    case 'json':
      return parseJson(stdout);
    case 'text':
      return parseText(stdout);
    case 'coverage_json':
      return parseCoverageJson(stdout);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported gate output format: ${String(exhaustive)}`);
    }
  }
}

// ──────────────────────────────────────────────
// SARIF (Static Analysis Results Interchange Format)
// ──────────────────────────────────────────────

function parseSarif(stdout: string): ParsedGateOutput {
  const findings: Finding[] = [];

  try {
    const report = JSON.parse(stdout);
    const runs = report?.runs ?? [];

    for (const run of runs) {
      const rules = new Map<string, string>();
      const toolRules = run?.tool?.driver?.rules ?? [];
      for (const rule of toolRules) {
        if (rule?.id) {
          rules.set(rule.id, rule.defaultConfiguration?.level ?? 'warning');
        }
      }

      const results = run?.results ?? [];
      for (const result of results) {
        const ruleId = result?.ruleId ?? '';
        const ruleIndex = typeof result?.ruleIndex === 'number' ? result.ruleIndex : -1;
        const ruleIndexStr = String(ruleIndex);
        const severity =
          result?.level ??
          rules.get(ruleId) ??
          rules.get(ruleIndexStr) ??
          'warning';

        const message =
          result?.message?.text ??
          (typeof result?.message === 'string' ? result.message : '') ??
          '';

        const locations = result?.locations ?? [];
        const primaryLocation = locations[0]?.physicalLocation;
        const file = primaryLocation?.artifactLocation?.uri;
        const line = primaryLocation?.region?.startLine;
        const column = primaryLocation?.region?.startColumn;

        findings.push({
          severity,
          message,
          ...(file !== undefined ? { file } : {}),
          ...(line !== undefined ? { line } : {}),
          ...(column !== undefined ? { column } : {}),
        });
      }
    }
  } catch {
    // If SARIF parsing fails, fall back to plain text
    findings.push({ severity: 'error', message: stdout.slice(0, 1000) });
  }

  return { findings };
}

// ──────────────────────────────────────────────
// JUnit XML
// ──────────────────────────────────────────────

function parseJunit(stdout: string): ParsedGateOutput {
  const findings: Finding[] = [];
  let total = 0;
  let failures = 0;
  let errors = 0;

  // Find all <testsuite> opening tags and extract numeric attributes
  const suiteTagRegex = /<testsuite\b([^>]*)>/gi;
  for (const tagMatch of Array.from(stdout.matchAll(suiteTagRegex))) {
    const attrs = tagMatch[1];
    total += extractIntAttr(attrs, 'tests');
    failures += extractIntAttr(attrs, 'failures');
    errors += extractIntAttr(attrs, 'errors');
  }

  // Find <testcase> elements and check for <failure> or <error> children
  const tcRegex = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/gi;
  for (const tc of Array.from(stdout.matchAll(tcRegex))) {
    const attrs = tc[1];
    const body = tc[2];
    const name = extractStrAttr(attrs, 'name');
    const className = extractStrAttr(attrs, 'classname');

    const hasFailure = /<failure\b/i.test(body);
    const hasError = /<error\b/i.test(body);

    if (hasFailure || hasError) {
      let message = `${className}.${name} failed`;
      const failureBodyMatch = body.match(/<failure[^>]*>([\s\S]*?)<\/failure>/i);
      const errorBodyMatch = body.match(/<error[^>]*>([\s\S]*?)<\/error>/i);
      if (failureBodyMatch?.[1]?.trim()) message = failureBodyMatch[1].trim();
      else if (errorBodyMatch?.[1]?.trim()) message = errorBodyMatch[1].trim();

      findings.push({
        severity: 'error',
        message,
        file: className.replace(/\./g, '/'),
      });
    }
  }

  // If we have aggregate counts but no individual details, report summary
  if (findings.length === 0 && (failures > 0 || errors > 0)) {
    findings.push({
      severity: 'error',
      message: `${failures} test(s) failed, ${errors} error(s) out of ${total} total`,
    });
  }

  return {
    findings,
    raw_summary: `tests=${total} failures=${failures} errors=${errors}`,
  };
}

function extractIntAttr(attrs: string, name: string): number {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"(\\d+)"`, 'i'));
  return m ? Number(m[1]) : 0;
}

function extractStrAttr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

// ──────────────────────────────────────────────
// Generic JSON
// ──────────────────────────────────────────────

function parseJson(stdout: string): ParsedGateOutput {
  const findings: Finding[] = [];

  try {
    const data = JSON.parse(stdout);

    // npm audit style: { "advisories": { ... }, "metadata": { "vulnerabilities": {...} } }
    if (data?.advisories && typeof data.advisories === 'object') {
      for (const [key, adv] of Object.entries(data.advisories as Record<string, Record<string, unknown>>)) {
        findings.push({
          severity: String(adv?.severity ?? 'moderate'),
          message: `${String(adv?.title ?? key)} (${String(adv?.module_name ?? '')}) — ${String(adv?.recommendation ?? '')}`,
          file: adv?.findings?.[0]?.paths?.[0] as string | undefined,
        });
      }
      return { findings };
    }

    // Generic: check for top-level findings / results / violations array
    const candidates = data?.findings ?? data?.results ?? data?.violations ?? data?.issues ?? data?.diagnostics;
    if (Array.isArray(candidates)) {
      for (const item of candidates) {
        if (typeof item === 'object' && item !== null) {
          const sev = item?.severity ?? item?.level ?? item?.category ?? item?.type ?? 'warning';
          const msg = item?.message ?? item?.description ?? item?.title ?? item?.text ?? JSON.stringify(item);
          findings.push({
            severity: String(sev),
            message: typeof msg === 'string' ? msg : JSON.stringify(msg),
            ...(item?.file ? { file: String(item.file) } : {}),
            ...(item?.filePath ? { file: String(item.filePath) } : {}),
            ...(item?.line !== undefined && typeof item.line === 'number' ? { line: item.line } : {}),
            ...(item?.column !== undefined && typeof item.column === 'number' ? { column: item.column } : {}),
          });
        }
      }
      return { findings };
    }

    // Fallback: treat entire JSON as a single finding
    findings.push({
      severity: 'info',
      message: stdout.slice(0, 1000),
    });
  } catch {
    findings.push({ severity: 'error', message: stdout.slice(0, 1000) });
  }

  return { findings };
}

// ──────────────────────────────────────────────
// Plain Text
// ──────────────────────────────────────────────

function parseText(stdout: string): ParsedGateOutput {
  return {
    findings: [],
    raw_summary: stdout.slice(0, 1000),
  };
}

// ──────────────────────────────────────────────
// Coverage JSON (e.g. pytest-cov --cov-report=json, nyc)
// ──────────────────────────────────────────────

function parseCoverageJson(stdout: string): ParsedGateOutput {
  try {
    const data = JSON.parse(stdout);

    // pytest-cov / coverage.py format: { "totals": { "percent_covered": 85.2, ... } }
    if (data?.totals) {
      const line = data.totals?.percent_covered ?? data.totals?.covered_percent;
      const branch = data.totals?.percent_covered ?? line; // coverage.py doesn't always track branch separately
      return {
        coverage: {
          line: typeof line === 'number' ? line : 0,
          branch: typeof branch === 'number' ? branch : 0,
        },
        raw_summary: `line=${line}% branch=${branch}%`,
      };
    }

    // NYC / Istanbul format: { "total": { "lines": { "pct": 85.2 }, "branches": { "pct": 75.0 } } }
    if (data?.total) {
      const line = data.total?.lines?.pct ?? 0;
      const branch = data.total?.branches?.pct ?? 0;
      return {
        coverage: {
          line: typeof line === 'number' ? line : 0,
          branch: typeof branch === 'number' ? branch : 0,
        },
        raw_summary: `line=${line}% branch=${branch}%`,
      };
    }

    // Generic: search for coverage-like fields
    const linePct =
      data?.line_rate !== undefined
        ? Number(data.line_rate) * 100
        : data?.line_coverage ?? data?.line_percent ?? data?.percent_covered;
    const branchPct =
      data?.branch_rate !== undefined
        ? Number(data.branch_rate) * 100
        : data?.branch_coverage ?? data?.branch_percent ?? linePct ?? 0;

    if (linePct !== undefined) {
      return {
        coverage: {
          line: Number(linePct),
          branch: Number(branchPct ?? 0),
        },
        raw_summary: `line=${linePct}% branch=${branchPct}%`,
      };
    }
  } catch {
    // Not valid JSON — fall through
  }

  return {
    findings: [{ severity: 'error', message: 'Failed to parse coverage output as JSON' }],
  };
}
