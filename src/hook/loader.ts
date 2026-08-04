import { parse as parseYaml } from 'yaml';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { HookConfig, HookSettings, GateConfig, HookBindingEntry } from './config';
import {
  ALL_HOOK_POINTS,
  DEFAULT_HOOK_VERSION,
  DEFAULT_HOOK_SETTINGS,
} from './constants';
import { validateConditionSyntax } from './hook';
import { VALID_DECISIONS, VALID_GATE_OUTPUT_FORMATS, type GateDecision, type GateOutputFormat, type SubGateRef } from '../gate';

// ──────────────────────────────────────────────
// Error types
// ──────────────────────────────────────────────

/** Aggregated validation errors thrown by {@link validateHookConfig} */
export class HookConfigValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Hook config validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'HookConfigValidationError';
    this.errors = errors;
  }
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Parse a YAML string into a validated {@link HookConfig}.
 *
 * @throws {HookConfigValidationError} When the parsed config fails validation.
 * @throws {Error} When the YAML string itself is syntactically invalid.
 */
export function parseHookConfigYaml(yamlContent: string, sourcePath?: string): HookConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (cause) {
    throw new Error(`Failed to parse YAML content: ${String(cause)}`, { cause });
  }
  return validateHookConfig(raw, sourcePath);
}

/**
 * Read a YAML file from disk and parse it into a validated {@link HookConfig}.
 *
 * @throws {HookConfigValidationError} When the parsed config fails validation.
 * @throws {Error} When the file cannot be read or contains invalid YAML.
 */
export function loadHookConfigFromFile(filePath: string): HookConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (cause) {
    throw new Error(`Failed to read hook config file "${filePath}": ${String(cause)}`, { cause });
  }

  try {
    return parseHookConfigYaml(content, filePath);
  } catch (cause) {
    if (cause instanceof HookConfigValidationError) {
      throw cause;
    }
    throw new Error(`Failed to parse YAML in "${filePath}": ${String(cause)}`, { cause });
  }
}

/**
 * Options for {@link loadMergedHookConfig}.
 */
export interface LoadMergedOptions {
  /**
   * Project root directory.
   * @default process.cwd()
   */
  projectRoot?: string;
}

/**
 * Load hook configuration using the three-layer merge strategy defined in RFC §5.1.
 *
 * Layers (later overrides earlier):
 * 1. `<projectRoot>/.agent/hooks.yaml`   — project-level (team-shared, version-controlled)
 * 2. `~/.agent/hooks.yaml`               — user-level (personal preference)
 * 3. `~/.agent/hooks.local.yaml`         — local-level (not committed, personal override)
 *
 * Merge rules:
 * - `settings`: shallow merge, later layer wins per key
 * - `gates`:    spread merge, later layer's gate of the same name overwrites
 * - `hooks`:    per-event append — bindings from later layers are appended after earlier ones
 *
 * Missing layers are silently skipped. At least one layer must be present.
 *
 * @throws {Error} When no configuration layer is found.
 * @throws {HookConfigValidationError} When a layer fails validation.
 */
export function loadMergedHookConfig(options: LoadMergedOptions = {}): HookConfig {
  const projectRoot = options.projectRoot ?? process.cwd();
  const home = homedir();

  const layers: Array<{ path: string; required: boolean }> = [
    { path: join(projectRoot, '.agent', 'hooks.yaml'), required: false },
    { path: join(home, '.agent', 'hooks.yaml'), required: false },
    { path: join(home, '.agent', 'hooks.local.yaml'), required: false },
  ];

  let merged: HookConfig | null = null;

  for (const layer of layers) {
    if (!existsSync(layer.path)) {
      continue;
    }
    const config = loadHookConfigFromFile(layer.path);

    if (merged === null) {
      merged = config;
    } else {
      merged = mergeHookConfigs(merged, config);
    }
  }

  if (merged === null) {
    throw new Error(
      'No hook configuration found. Expected at least one of:\n' +
        layers.map((l) => `  - ${l.path}`).join('\n'),
    );
  }

  // Re-validate the merged configuration: a gate referenced by a base-layer
  // binding may have been removed/overridden in a later layer.
  return validateHookConfig(merged);
}

/**
 * Merge two {@link HookConfig} objects with the following rules:
 * - `settings`: shallow merge (override wins per key)
 * - `gates`:    spread merge (override's gate of the same name replaces base's)
 * - `hooks`:    per-event append — override bindings are appended after base bindings
 */
export function mergeHookConfigs(base: HookConfig, override: HookConfig): HookConfig {
  const merged = {
    version: override.version,
    settings: { ...base.settings, ...override.settings },
    gates: { ...base.gates, ...override.gates },
    hooks: mergeHooksSection(base.hooks, override.hooks),
  };
  // Re-validate after merge to catch references that became dangling.
  return validateHookConfig(merged);
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

const VALID_GATE_TYPES = new Set(['command', 'prompt', 'composite', 'http']);
const VALID_HOOK_POINTS = new Set<string>(ALL_HOOK_POINTS);
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 999;

/**
 * Validate a raw (post-YAML-parse) value against the {@link HookConfig} schema.
 *
 * Validation rules (RFC §9.2):
 * - Top-level must be an object with optional `version`, `settings`, `gates`, `hooks`
 * - Missing `settings` keys are filled from {@link DEFAULT_HOOK_SETTINGS}
 * - Every gate referenced in `hooks` must exist in `gates`
 * - Every event name in `hooks` must be a known {@link HookPoint}
 * - `priority` is clamped to [1, 999]
 * - Invalid `if` expression syntax is warned (fail-closed: treated as false at runtime)
 *
 * @param raw          The value returned by `yaml.parse()`.
 * @param _sourcePath  Optional file path used in error messages (not used for reading).
 * @throws {HookConfigValidationError} When validation fails.
 */
export function validateHookConfig(raw: unknown, _sourcePath?: string): HookConfig {
  const errors: string[] = [];
  const prefix = _sourcePath ? `[${_sourcePath}] ` : '';

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HookConfigValidationError([`${prefix}Config must be a YAML object, got ${Array.isArray(raw) ? 'array' : typeof raw}`]);
  }

  const obj = raw as Record<string, unknown>;

  // ── version ──────────────────────────────────
  const version = typeof obj['version'] === 'string' ? obj['version'] : DEFAULT_HOOK_VERSION;

  // ── settings ─────────────────────────────────
  const settings = parseSettings(obj['settings'], errors, prefix);

  // ── gates ────────────────────────────────────
  const gates = parseGates(obj['gates'], errors, prefix);

  // ── hooks ────────────────────────────────────
  const hooks = parseHookBindings(obj['hooks'], gates, errors, prefix);

  // ── top-level unknown keys ───────────────────
  reportUnknownKeys(obj, KNOWN_TOP_KEYS, `${prefix}<root>`, errors);

  if (errors.length > 0) {
    throw new HookConfigValidationError(errors);
  }

  return { version, settings, gates, hooks };
}

// ──────────────────────────────────────────────
// Internal parsing helpers
// ──────────────────────────────────────────────

function parseSettings(
  raw: unknown,
  errors: string[],
  prefix: string,
): HookSettings {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_HOOK_SETTINGS };
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}settings must be an object, got ${typeof raw}`);
    return { ...DEFAULT_HOOK_SETTINGS };
  }

  const s = raw as Record<string, unknown>;
  const result = { ...DEFAULT_HOOK_SETTINGS };

  if ('fail_fast' in s) {
    if (typeof s['fail_fast'] === 'boolean') result.fail_fast = s['fail_fast'];
    else errors.push(`${prefix}settings.fail_fast must be a boolean, got ${typeof s['fail_fast']}; using default (${DEFAULT_HOOK_SETTINGS.fail_fast})`);
  }
  if ('default_timeout' in s) {
    if (typeof s['default_timeout'] === 'number') {
      if (s['default_timeout'] > 0) {
        result.default_timeout = s['default_timeout'];
      } else {
        errors.push(`${prefix}settings.default_timeout must be > 0, got ${s['default_timeout']}; using default (${DEFAULT_HOOK_SETTINGS.default_timeout})`);
      }
    } else {
      errors.push(`${prefix}settings.default_timeout must be a number, got ${typeof s['default_timeout']}; using default (${DEFAULT_HOOK_SETTINGS.default_timeout})`);
    }
  }
  if ('parallel' in s) {
    if (typeof s['parallel'] === 'boolean') result.parallel = s['parallel'];
    else errors.push(`${prefix}settings.parallel must be a boolean, got ${typeof s['parallel']}; using default (${DEFAULT_HOOK_SETTINGS.parallel})`);
  }
  if ('output_format' in s) {
    if (typeof s['output_format'] === 'string') result.output_format = s['output_format'];
    else errors.push(`${prefix}settings.output_format must be a string, got ${typeof s['output_format']}; using default (${DEFAULT_HOOK_SETTINGS.output_format})`);
  }
  if ('emergency_env_var' in s) {
    if (typeof s['emergency_env_var'] === 'string') {
      if (s['emergency_env_var'].length > 0) {
        result.emergency_env_var = s['emergency_env_var'];
      } else {
        errors.push(`${prefix}settings.emergency_env_var must be a non-empty string; using default (${DEFAULT_HOOK_SETTINGS.emergency_env_var})`);
      }
    } else {
      errors.push(`${prefix}settings.emergency_env_var must be a string, got ${typeof s['emergency_env_var']}; using default (${DEFAULT_HOOK_SETTINGS.emergency_env_var})`);
    }
  }

  reportUnknownKeys(s, KNOWN_SETTINGS_KEYS, `${prefix}settings`, errors);
  return result;
}

function parseGates(
  raw: unknown,
  errors: string[],
  prefix: string,
): Record<string, GateConfig> {
  if (raw === undefined || raw === null) {
    return {};
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}gates must be an object, got ${typeof raw}`);
    return {};
  }

  const gatesObj = raw as Record<string, unknown>;
  const gates: Record<string, GateConfig> = {};

  for (const [name, gateRaw] of Object.entries(gatesObj)) {
    gates[name] = parseGateConfig(name, gateRaw, errors, prefix);
  }

  return gates;
}

function parseGateConfig(
  name: string,
  raw: unknown,
  errors: string[],
  prefix: string,
): GateConfig {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${prefix}gates.${name} must be an object, got ${typeof raw}`);
    return { type: 'command', command: '', retry_threshold: 3 };
  }

  const g = raw as Record<string, unknown>;
  const type = g['type'];
  let typeValid = true;

  if (typeof type !== 'string' || !VALID_GATE_TYPES.has(type)) {
    errors.push(
      `${prefix}gates.${name}.type must be one of [${[...VALID_GATE_TYPES].join(', ')}], got "${String(type)}"`,
    );
    typeValid = false;
  }

  const gate: GateConfig = {
    type: (VALID_GATE_TYPES.has(type as string) ? type : 'command') as GateConfig['type'],
  };

  // ── type-specific fields ──
  if (typeof g['command'] === 'string') gate.command = g['command'];
  if (typeof g['prompt'] === 'string') gate.prompt = g['prompt'];
  if (typeof g['model'] === 'string') gate.model = g['model'];
  if (typeof g['http'] === 'string') gate.http = g['http'];

  // gates — sub-gate references for composite type
  // YAML uses `gate` field name or short-form string; SubGateRef uses `gate_id`
  if (Array.isArray(g['gates'])) {
    const refs = g['gates'].map((item: unknown, idx: number) =>
      parseSubGateRef(item, name, idx, errors, prefix),
    );
    if (refs.length > 0) {
      gate.gates = refs;
    }
  }

  // output — full GateOutputConfig (format, severity_map, threshold, on_fail, on_below_threshold)
  if (typeof g['output'] === 'object' && g['output'] !== null) {
    const out = g['output'] as Record<string, unknown>;
    const outputConfig: GateConfig['output'] = {};

    // format — must be a known GateOutputFormat value
    if (typeof out['format'] === 'string') {
      if (VALID_GATE_OUTPUT_FORMATS.has(out['format'])) {
        outputConfig.format = out['format'] as GateOutputFormat;
      } else {
        errors.push(
          `${prefix}gates.${name}.output.format must be one of [${[...VALID_GATE_OUTPUT_FORMATS].join(', ')}], got "${out['format']}"`,
        );
      }
    }

    // severity_map — values must be valid GateDecision
    if (typeof out['severity_map'] === 'object' && out['severity_map'] !== null) {
      const sm = out['severity_map'] as Record<string, unknown>;
      const severityMap: Record<string, GateDecision> = {};
      for (const [sev, decision] of Object.entries(sm)) {
        if (typeof decision === 'string' && VALID_DECISIONS.has(decision)) {
          severityMap[sev] = decision as GateDecision;
        } else if (typeof decision === 'string') {
          errors.push(
            `${prefix}gates.${name}.output.severity_map.${sev} must be a valid decision (allow|deny|ask|defer), got "${decision}"`,
          );
        } else {
          errors.push(
            `${prefix}gates.${name}.output.severity_map.${sev} must be a string decision (allow|deny|ask|defer), got ${typeof decision}`,
          );
        }
      }
      if (Object.keys(severityMap).length > 0) {
        outputConfig.severity_map = severityMap;
      }
    } else if ('severity_map' in out) {
      // severity_map is present but not an object — report once
      errors.push(`${prefix}gates.${name}.output.severity_map must be an object`);
    }

    // threshold — coverage thresholds (percentages in [0, 100])
    if (typeof out['threshold'] === 'object' && out['threshold'] !== null) {
      const t = out['threshold'] as Record<string, unknown>;
      const threshold: { line?: number; branch?: number } = {};
      if (typeof t['line'] === 'number') {
        if (t['line'] >= 0 && t['line'] <= 100) {
          threshold.line = t['line'];
        } else {
          errors.push(`${prefix}gates.${name}.output.threshold.line must be in [0, 100], got ${t['line']}`);
        }
      } else if ('line' in t) {
        errors.push(`${prefix}gates.${name}.output.threshold.line must be a number, got ${typeof t['line']}`);
      }
      if (typeof t['branch'] === 'number') {
        if (t['branch'] >= 0 && t['branch'] <= 100) {
          threshold.branch = t['branch'];
        } else {
          errors.push(`${prefix}gates.${name}.output.threshold.branch must be in [0, 100], got ${t['branch']}`);
        }
      } else if ('branch' in t) {
        errors.push(`${prefix}gates.${name}.output.threshold.branch must be a number, got ${typeof t['branch']}`);
      }
      if (Object.keys(threshold).length > 0) {
        outputConfig.threshold = threshold;
      }
    } else if ('threshold' in out) {
      errors.push(`${prefix}gates.${name}.output.threshold must be an object`);
    }

    // on_fail — must be a valid GateDecision
    if (typeof out['on_fail'] === 'string') {
      if (VALID_DECISIONS.has(out['on_fail'])) {
        outputConfig.on_fail = out['on_fail'] as GateDecision;
      } else {
        errors.push(
          `${prefix}gates.${name}.output.on_fail must be a valid decision (allow|deny|ask|defer), got "${out['on_fail']}"`,
        );
      }
    }

    // on_below_threshold — must be a valid GateDecision
    if (typeof out['on_below_threshold'] === 'string') {
      if (VALID_DECISIONS.has(out['on_below_threshold'])) {
        outputConfig.on_below_threshold = out['on_below_threshold'] as GateDecision;
      } else {
        errors.push(
          `${prefix}gates.${name}.output.on_below_threshold must be a valid decision (allow|deny|ask|defer), got "${out['on_below_threshold']}"`,
        );
      }
    }

    reportUnknownKeys(out, KNOWN_OUTPUT_KEYS, `${prefix}gates.${name}.output`, errors);

    if (Object.keys(outputConfig).length > 0) {
      gate.output = outputConfig;
    }
  }

  if (typeof g['timeout'] === 'number') {
    if (g['timeout'] > 0) {
      gate.timeout = g['timeout'];
    } else {
      errors.push(`${prefix}gates.${name}.timeout must be > 0, got ${g['timeout']}`);
    }
  }
  if (typeof g['retry_threshold'] === 'number') {
    if (g['retry_threshold'] >= 0) {
      gate.retry_threshold = g['retry_threshold'];
    } else {
      errors.push(`${prefix}gates.${name}.retry_threshold must be >= 0, got ${g['retry_threshold']}`);
    }
  }

  reportUnknownKeys(g, KNOWN_GATE_KEYS, `${prefix}gates.${name}`, errors);

  // ── cross-field validation: type must have its required field and no disallowed fields ──
  // Only run when type was valid — if type was missing/invalid, the error
  // above already covers it, and defaulting to 'command' would produce a
  // misleading second error.
  if (typeValid) {
    const allowed = new Set(ALLOWED_FIELDS_PER_TYPE[gate.type]);
    for (const key of Object.keys(g)) {
      if (!allowed.has(key)) {
        errors.push(`${prefix}gates.${name}: field "${key}" is not allowed for type "${gate.type}"`);
      }
    }

    switch (gate.type) {
      case 'command':
        if (!gate.command) {
          errors.push(`${prefix}gates.${name}: type is "command" but no "command" field provided`);
        }
        break;
      case 'prompt':
        if (!gate.prompt) {
          errors.push(`${prefix}gates.${name}: type is "prompt" but no "prompt" field provided`);
        }
        break;
      case 'http':
        if (!gate.http) {
          errors.push(`${prefix}gates.${name}: type is "http" but no "http" field provided`);
        }
        break;
      case 'composite':
        if (!gate.gates || gate.gates.length === 0) {
          errors.push(`${prefix}gates.${name}: type is "composite" but no "gates" field provided`);
        }
        break;
    }
  }

  return gate;
}

function parseSubGateRef(
  item: unknown,
  gateName: string,
  idx: number,
  errors: string[],
  prefix: string,
): SubGateRef {
  if (typeof item === 'string') {
    // Short form: just the gate name as a string
    if (item === '') {
      errors.push(
        `${prefix}gates.${gateName}.gates[${idx}] must be a non-empty string`,
      );
    }
    return { gate_id: item };
  }

  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    // YAML uses `gate` field; map to SubGateRef.gate_id
    const gateId =
      typeof obj['gate'] === 'string'
        ? obj['gate']
        : typeof obj['gate_id'] === 'string'
          ? obj['gate_id']
          : undefined;

    if (!gateId) {
      errors.push(
        `${prefix}gates.${gateName}.gates[${idx}] must have a "gate" field referencing a gate name`,
      );
    }

    const ref: SubGateRef = { gate_id: gateId ?? '' };
    if (typeof obj['required'] === 'boolean') ref.required = obj['required'];

    reportUnknownKeys(obj, KNOWN_SUB_GATE_KEYS, `${prefix}gates.${gateName}.gates[${idx}]`, errors);
    return ref;
  }

  errors.push(
    `${prefix}gates.${gateName}.gates[${idx}] must be a string or object, got ${typeof item}`,
  );
  return { gate_id: '' };
}

function parseHookBindings(
  raw: unknown,
  gates: Record<string, GateConfig>,
  errors: string[],
  prefix: string,
): HookConfig['hooks'] {
  if (raw === undefined || raw === null) {
    return {};
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}hooks must be an object, got ${typeof raw}`);
    return {};
  }

  const hooksObj = raw as Record<string, unknown>;
  const hooks: Record<string, HookBindingEntry[]> = {};

  for (const [eventName, bindingsRaw] of Object.entries(hooksObj)) {
    // Validate event name — unknown events can never match at runtime, skip
    if (!VALID_HOOK_POINTS.has(eventName)) {
      errors.push(
        `${prefix}hooks.${eventName}: unknown event name. Valid hook points include: ${ALL_HOOK_POINTS.join(', ')}`,
      );
      continue;
    }

    if (!Array.isArray(bindingsRaw)) {
      errors.push(
        `${prefix}hooks.${eventName} must be an array of binding entries, got ${typeof bindingsRaw}`,
      );
      continue;
    }

    const entries: HookBindingEntry[] = [];
    for (let i = 0; i < bindingsRaw.length; i++) {
      entries.push(parseBindingEntry(eventName, i, bindingsRaw[i], gates, errors, prefix));
    }
    hooks[eventName] = entries;
  }

  return hooks as HookConfig['hooks'];
}

function parseBindingEntry(
  eventName: string,
  idx: number,
  raw: unknown,
  gates: Record<string, GateConfig>,
  errors: string[],
  prefix: string,
): HookBindingEntry {
  const loc = `${prefix}hooks.${eventName}[${idx}]`;

  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${loc} must be an object, got ${typeof raw}`);
    return { gate: '' };
  }

  const b = raw as Record<string, unknown>;

  // gate — required reference to a defined gate
  const gateRef = typeof b['gate'] === 'string' ? b['gate'] : undefined;
  if (gateRef === undefined) {
    errors.push(`${loc}: missing required field "gate"`);
  } else if (gateRef.length === 0) {
    errors.push(`${loc}: "gate" must be a non-empty string`);
  } else if (!(gateRef in gates)) {
    errors.push(
      `${loc}: references gate "${gateRef}" which is not defined in the gates section. ` +
        `Defined gates: [${Object.keys(gates).join(', ') || '(none)'}]`,
    );
  }

  const entry: HookBindingEntry = {
    gate: gateRef ?? '',
  };

  // name — optional human-readable label
  if ('name' in b) {
    if (typeof b['name'] === 'string') {
      entry.name = b['name'];
    } else {
      errors.push(`${loc}: name must be a string, got ${typeof b['name']}`);
    }
  }

  // priority — clamp to [1, 999] (out-of-range values are silently clamped)
  if ('priority' in b) {
    if (typeof b['priority'] === 'number') {
      entry.priority = Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, b['priority']));
    } else {
      errors.push(`${loc}: priority must be a number, got ${typeof b['priority']}`);
    }
  }

  // if — condition expression
  if ('if' in b) {
    if (typeof b['if'] === 'string') {
      const syntaxError = validateConditionSyntax(b['if']);
      if (syntaxError) {
        errors.push(`${loc}: invalid condition expression: ${syntaxError}`);
      } else {
        entry.if = b['if'];
      }
    } else {
      errors.push(`${loc}: if must be a string, got ${typeof b['if']}`);
    }
  }

  // timeout — per-binding override in seconds (must be > 0)
  if ('timeout' in b) {
    if (typeof b['timeout'] === 'number') {
      if (b['timeout'] > 0) {
        entry.timeout = b['timeout'];
      } else {
        errors.push(`${loc}: timeout must be > 0, got ${b['timeout']}`);
      }
    } else {
      errors.push(`${loc}: timeout must be a number, got ${typeof b['timeout']}`);
    }
  }

  // on_failure — fallback decision (must be valid GateDecision)
  if (typeof b['on_failure'] === 'string') {
    if (VALID_DECISIONS.has(b['on_failure'])) {
      entry.on_failure = b['on_failure'] as GateDecision;
    } else {
      errors.push(
        `${loc}: on_failure must be a valid decision (allow|deny|ask|defer), got "${b['on_failure']}"`,
      );
    }
  }

  reportUnknownKeys(b, KNOWN_BINDING_KEYS, loc, errors);
  return entry;
}

// ──────────────────────────────────────────────
// Internal utilities
// ──────────────────────────────────────────────

/** Known keys per parser context, used for unknown-key detection. */
const KNOWN_TOP_KEYS = ['version', 'settings', 'gates', 'hooks'];
const KNOWN_SETTINGS_KEYS = ['fail_fast', 'default_timeout', 'parallel', 'output_format', 'emergency_env_var'];
const KNOWN_GATE_KEYS = ['type', 'command', 'prompt', 'model', 'http', 'gates', 'output', 'timeout', 'retry_threshold'];
const KNOWN_OUTPUT_KEYS = ['format', 'severity_map', 'threshold', 'on_fail', 'on_below_threshold'];
const KNOWN_SUB_GATE_KEYS = ['gate', 'gate_id', 'required'];
const KNOWN_BINDING_KEYS = ['gate', 'name', 'priority', 'if', 'timeout', 'on_failure'];

/** Fields allowed per gate type. Used to detect fields that are meaningless for the declared type. */
const ALLOWED_FIELDS_PER_TYPE: Record<GateConfig['type'], string[]> = {
  command: ['type', 'command', 'output', 'timeout', 'retry_threshold'],
  prompt: ['type', 'prompt', 'model', 'output', 'timeout', 'retry_threshold'],
  http: ['type', 'http', 'output', 'timeout', 'retry_threshold'],
  composite: ['type', 'gates', 'output', 'timeout', 'retry_threshold'],
};

/**
 * Report any keys in `obj` that are not in `knownKeys`.
 * Includes a best-effort "did you mean" hint for likely typos.
 */
function reportUnknownKeys(
  obj: Record<string, unknown>,
  knownKeys: readonly string[],
  location: string,
  errors: string[],
): void {
  const known = new Set(knownKeys);
  for (const key of Object.keys(obj)) {
    if (known.has(key)) continue;
    const hint = closestMatch(key, knownKeys);
    errors.push(
      `${location}: unknown key "${key}"` +
        (hint ? `; did you mean "${hint}"?` : '') +
        `. Known keys: [${knownKeys.join(', ')}]`,
    );
  }
}

/** Return the closest known key within edit distance 2, or null. */
function closestMatch(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= 2 ? best : null;
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j]!;
  }
  return curr[n]!;
}

function mergeHooksSection(
  base: HookConfig['hooks'],
  override: HookConfig['hooks'],
): HookConfig['hooks'] {
  const merged: Record<string, HookBindingEntry[]> = { ...base };

  for (const [eventName, entries] of Object.entries(override)) {
    if (merged[eventName]) {
      merged[eventName] = [...merged[eventName]!, ...entries];
    } else {
      merged[eventName] = entries;
    }
  }

  return merged as HookConfig['hooks'];
}
