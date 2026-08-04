import { describe, it, expect } from 'vitest';
import { createId } from '../../src/core';
import {
  parseHookConfigYaml,
  loadHookConfigFromFile,
  loadMergedHookConfig,
  mergeHookConfigs,
  HookConfigValidationError,
} from '../../src/hook/loader';
import {
  DEFAULT_HOOK_VERSION,
  DEFAULT_HOOK_SETTINGS,
} from '../../src/hook/constants';
import type { HookConfig } from '../../src/hook/config';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function minimalYaml(overrides?: string): string {
  return `
version: "hook-0.1"
gates:
  test_gate:
    type: command
    command: "echo ok"
hooks:
  task.completed:
    - gate: test_gate
${overrides ?? ''}
`.trim();
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `hook-loader-test-${createId('tmp')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTempYaml(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// ──────────────────────────────────────────────
// parseHookConfigYaml
// ──────────────────────────────────────────────

describe('parseHookConfigYaml', () => {
  it('should parse a minimal valid YAML config', () => {
    const yaml = minimalYaml();
    const config = parseHookConfigYaml(yaml);
    expect(config.version).toBe('hook-0.1');
    expect(config.settings).toEqual(DEFAULT_HOOK_SETTINGS);
    expect(config.gates).toHaveProperty('test_gate');
    expect(config.gates['test_gate']!.type).toBe('command');
    expect(config.hooks).toHaveProperty('task.completed');
  });

  it('should fill defaults for empty YAML object', () => {
    const config = parseHookConfigYaml('{}');
    expect(config.version).toBe(DEFAULT_HOOK_VERSION);
    expect(config.settings).toEqual(DEFAULT_HOOK_SETTINGS);
    expect(config.gates).toEqual({});
    expect(config.hooks).toEqual({});
  });

  it('should fill defaults when settings section is missing', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates: {}
hooks: {}
`);
    expect(config.settings).toEqual(DEFAULT_HOOK_SETTINGS);
  });

  it('should merge partial settings with defaults', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
settings:
  fail_fast: true
  default_timeout: 120
`);
    expect(config.settings.fail_fast).toBe(true);
    expect(config.settings.default_timeout).toBe(120);
    // Unspecified keys keep defaults
    expect(config.settings.parallel).toBe(DEFAULT_HOOK_SETTINGS.parallel);
    expect(config.settings.emergency_env_var).toBe(DEFAULT_HOOK_SETTINGS.emergency_env_var);
  });

  it('should parse gate config with all fields', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  full_gate:
    type: prompt
    prompt: "Check this code for issues"
    model: claude-sonnet-5
    timeout: 60
    retry_threshold: 5
    output:
      format: json
      severity_map:
        error: deny
        warning: ask
`);
    const gate = config.gates['full_gate']!;
    expect(gate.type).toBe('prompt');
    expect(gate.prompt).toBe('Check this code for issues');
    expect(gate.model).toBe('claude-sonnet-5');
    expect(gate.timeout).toBe(60);
    expect(gate.retry_threshold).toBe(5);
    expect(gate.output).toMatchObject({ format: 'json' });
    expect(gate.output?.severity_map).toEqual({ error: 'deny', warning: 'ask' });
  });

  it('should parse output config with threshold, on_fail, and on_below_threshold', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  coverage_gate:
    type: command
    command: "pytest --cov"
    output:
      format: coverage_json
      threshold:
        line: 80
        branch: 50
      on_fail: ask
      on_below_threshold: defer
`);
    const gate = config.gates['coverage_gate']!;
    expect(gate.output).toBeDefined();
    expect(gate.output!.format).toBe('coverage_json');
    expect(gate.output!.threshold).toEqual({ line: 80, branch: 50 });
    expect(gate.output!.on_fail).toBe('ask');
    expect(gate.output!.on_below_threshold).toBe('defer');
  });

  it('should parse composite gate with sub-gate references (YAML `gate` field)', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  composite_gate:
    type: composite
    gates:
      - gate: sub_a
        required: true
      - gate: sub_b
hooks:
  task.completed:
    - gate: composite_gate
`);
    const gate = config.gates['composite_gate']!;
    expect(gate.type).toBe('composite');
    expect(gate.gates).toHaveLength(2);
    expect(gate.gates![0]!.gate_id).toBe('sub_a');
    expect(gate.gates![0]!.required).toBe(true);
    expect(gate.gates![1]!.gate_id).toBe('sub_b');
    expect(gate.gates![1]!.required).toBeUndefined();
  });

  it('should accept short-form sub-gate refs (bare gate name string)', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  composite_gate:
    type: composite
    gates:
      - sub_a
      - sub_b
hooks:
  task.completed:
    - gate: composite_gate
`);
    const gate = config.gates['composite_gate']!;
    expect(gate.gates![0]!.gate_id).toBe('sub_a');
    expect(gate.gates![1]!.gate_id).toBe('sub_b');
  });

  it('should parse hook binding entries with all fields', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo test"
hooks:
  task.completed:
    - name: "my-binding"
      gate: my_gate
      priority: 85
      if: "affected_paths matches '*.ts'"
      timeout: 45
      on_failure: ask
`);
    const entries = config.hooks['task.completed']!;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.name).toBe('my-binding');
    expect(entry.gate).toBe('my_gate');
    expect(entry.priority).toBe(85);
    expect(entry.if).toBe("affected_paths matches '*.ts'");
    expect(entry.timeout).toBe(45);
    expect(entry.on_failure).toBe('ask');
  });

  it('should parse multiple event bindings', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  gate_a:
    type: command
    command: "echo a"
  gate_b:
    type: command
    command: "echo b"
hooks:
  task.created:
    - gate: gate_a
  task.completed:
    - gate: gate_a
    - gate: gate_b
`);
    expect(config.hooks['task.created']).toHaveLength(1);
    expect(config.hooks['task.completed']).toHaveLength(2);
  });

  it('should throw on invalid YAML syntax', () => {
    expect(() => parseHookConfigYaml('version: [unclosed')).toThrow();
  });

  it('should throw on non-object YAML root', () => {
    expect(() => parseHookConfigYaml('["array", "root"]')).toThrow(HookConfigValidationError);
  });
});

// ──────────────────────────────────────────────
// validateHookConfig — error cases
// ──────────────────────────────────────────────

describe('validateHookConfig — validation errors', () => {
  it('should reject unknown gate type', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  bad_gate:
    type: unknown_type
hooks:
  task.completed:
    - gate: bad_gate
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject missing gate reference', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates: {}
hooks:
  task.completed:
    - gate: nonexistent_gate
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject unknown event name', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  invalid.event.name:
    - gate: my_gate
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject binding entries without gate field', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  task.completed:
    - name: "no-gate"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject hooks section that is not an object', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
hooks: "not_an_object"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject hooks event value that is not an array', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  task.completed: "not_an_array"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should report multiple errors at once', () => {
    try {
      parseHookConfigYaml(`
version: "hook-0.1"
gates: {}
hooks:
  invalid.event:
    - gate: missing_gate
  task.completed:
    - name: "also-missing-gate"
`);
      expect.fail('Expected validation error');
    } catch (err) {
      expect(err).toBeInstanceOf(HookConfigValidationError);
      const verr = err as HookConfigValidationError;
      // Should have at least: unknown event name, 1x missing gate ref in task.completed
      expect(verr.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should reject invalid output format', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  bad_gate:
    type: command
    command: "echo"
    output:
      format: xml
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject invalid on_fail decision', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  bad_gate:
    type: command
    command: "echo"
    output:
      on_fail: reject
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject invalid on_below_threshold decision', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  bad_gate:
    type: command
    command: "echo"
    output:
      on_below_threshold: maybe
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject invalid severity_map value', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  bad_gate:
    type: command
    command: "echo"
    output:
      severity_map:
        critical: block
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject invalid on_failure in hook binding entry', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: my_gate
      on_failure: reject
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject command gate without command field', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    timeout: 30
hooks:
  task.completed:
    - gate: lint
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject prompt gate without prompt field', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  reviewer:
    type: prompt
    model: claude-sonnet-5
hooks:
  task.completed:
    - gate: reviewer
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject http gate without http field', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  webhook:
    type: http
    timeout: 10
hooks:
  task.completed:
    - gate: webhook
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject composite gate without gates field', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  checker:
    type: composite
hooks:
  task.completed:
    - gate: checker
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject negative gate timeout', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
    timeout: -5
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject negative gate retry_threshold', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
    retry_threshold: -1
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject negative binding timeout', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
      timeout: 0
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should report unknown gate key as error', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    comand: "echo"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should report unknown binding key as error', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
      prioirty: 100
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should report unknown top-level key as error', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
setings:
  fail_fast: true
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject non-positive default_timeout in settings', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
settings:
  default_timeout: 0
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject empty emergency_env_var in settings', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
settings:
  emergency_env_var: ""
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject fields that are not allowed for the gate type', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
    prompt: "extra"
hooks:
  task.completed:
    - gate: lint
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject non-string severity_map value', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
    output:
      severity_map:
        critical: 123
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject threshold line out of [0, 100]', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
    output:
      threshold:
        line: 101
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject invalid if expression syntax', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
      if: "this is ! not @ valid # syntax"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject non-number priority', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
      priority: "100"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject non-number timeout', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
      timeout: "30"
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject non-string name', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: lint
      name: 123
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject empty gate reference', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  lint:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: ""
`),
    ).toThrow(HookConfigValidationError);
  });

  it('should reject empty composite sub-gate reference', () => {
    expect(() =>
      parseHookConfigYaml(`
version: "hook-0.1"
gates:
  comp:
    type: composite
    gates:
      - ""
hooks:
  task.completed:
    - gate: comp
`),
    ).toThrow(HookConfigValidationError);
  });
});

// ──────────────────────────────────────────────
// validateHookConfig — priority clamping
// ──────────────────────────────────────────────

describe('validateHookConfig — priority clamping', () => {
  it('should clamp priority below 1 to 1', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: my_gate
      priority: -5
`);
    expect(config.hooks['task.completed']![0]!.priority).toBe(1);
  });

  it('should clamp priority above 999 to 999', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: my_gate
      priority: 5000
`);
    expect(config.hooks['task.completed']![0]!.priority).toBe(999);
  });

  it('should accept priority in valid range', () => {
    const config = parseHookConfigYaml(`
version: "hook-0.1"
gates:
  my_gate:
    type: command
    command: "echo"
hooks:
  task.completed:
    - gate: my_gate
      priority: 500
`);
    expect(config.hooks['task.completed']![0]!.priority).toBe(500);
  });

  it('should default priority to DEFAULT_PRIORITY when omitted', () => {
    const config = parseHookConfigYaml(minimalYaml());
    expect(config.hooks['task.completed']![0]!.priority).toBeUndefined();
    // undefined means the engine will use DEFAULT_PRIORITY at runtime
  });
});

// ──────────────────────────────────────────────
// mergeHookConfigs
// ──────────────────────────────────────────────

describe('mergeHookConfigs', () => {
  const baseConfig: HookConfig = {
    version: 'hook-0.1',
    settings: { ...DEFAULT_HOOK_SETTINGS, fail_fast: false, default_timeout: 30 },
    gates: {
      gate_a: { type: 'command', command: 'echo a' },
      gate_b: { type: 'command', command: 'echo b' },
    },
    hooks: {
      'task.completed': [{ gate: 'gate_a', priority: 100 }],
    },
  };

  it('should override settings with shallow merge', () => {
    const override: HookConfig = {
      version: 'hook-0.1',
      settings: { ...DEFAULT_HOOK_SETTINGS, fail_fast: true, default_timeout: 60 },
      gates: {},
      hooks: {},
    };
    const merged = mergeHookConfigs(baseConfig, override);
    expect(merged.settings.fail_fast).toBe(true);
    expect(merged.settings.default_timeout).toBe(60);
    // Unspecified keys retain base values
    expect(merged.settings.emergency_env_var).toBe(baseConfig.settings.emergency_env_var);
  });

  it('should override same-name gates', () => {
    const override: HookConfig = {
      version: 'hook-0.1',
      settings: { ...DEFAULT_HOOK_SETTINGS },
      gates: {
        gate_a: { type: 'prompt', prompt: 'updated prompt', model: 'sonnet' },
      },
      hooks: {},
    };
    const merged = mergeHookConfigs(baseConfig, override);
    expect(merged.gates['gate_a']!.type).toBe('prompt');
    expect(merged.gates['gate_a']!.prompt).toBe('updated prompt');
    // gate_b is unchanged from base
    expect(merged.gates['gate_b']!.type).toBe('command');
  });

  it('should append hook bindings for same event', () => {
    const override: HookConfig = {
      version: 'hook-0.1',
      settings: { ...DEFAULT_HOOK_SETTINGS },
      gates: {},
      hooks: {
        'task.completed': [{ gate: 'gate_b', priority: 50 }],
      },
    };
    const merged = mergeHookConfigs(baseConfig, override);
    expect(merged.hooks['task.completed']).toHaveLength(2);
    expect(merged.hooks['task.completed']![0]!.gate).toBe('gate_a');
    expect(merged.hooks['task.completed']![1]!.gate).toBe('gate_b');
  });

  it('should add new event bindings from override', () => {
    const override: HookConfig = {
      version: 'hook-0.1',
      settings: { ...DEFAULT_HOOK_SETTINGS },
      gates: {},
      hooks: {
        'task.created': [{ gate: 'gate_a' }],
      },
    };
    const merged = mergeHookConfigs(baseConfig, override);
    expect(merged.hooks['task.completed']).toHaveLength(1);
    expect(merged.hooks['task.created']).toHaveLength(1);
  });

  it('should adopt override version', () => {
    const override: HookConfig = {
      version: 'hook-0.2',
      settings: { ...DEFAULT_HOOK_SETTINGS },
      gates: {},
      hooks: {},
    };
    const merged = mergeHookConfigs(baseConfig, override);
    expect(merged.version).toBe('hook-0.2');
  });

  it('should re-validate merged config when override invalidates a base gate', () => {
    const override: HookConfig = {
      version: 'hook-0.1',
      settings: { ...DEFAULT_HOOK_SETTINGS },
      gates: {
        gate_a: { type: 'command' }, // missing command — invalid
      },
      hooks: {},
    };
    // baseConfig has a binding that references gate_a. After merge, gate_a is
    // overridden by an invalid definition, so re-validation must fail.
    expect(() => mergeHookConfigs(baseConfig, override)).toThrow(HookConfigValidationError);
  });
});

// ──────────────────────────────────────────────
// loadHookConfigFromFile
// ──────────────────────────────────────────────

describe('loadHookConfigFromFile', () => {
  it('should load a valid YAML config from disk', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeTempYaml(dir, 'hooks.yaml', minimalYaml());
      const config = loadHookConfigFromFile(filePath);
      expect(config.version).toBe('hook-0.1');
      expect(config.gates).toHaveProperty('test_gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw when file does not exist', () => {
    expect(() => loadHookConfigFromFile('/nonexistent/path/hooks.yaml')).toThrow();
  });

  it('should throw when file contains invalid YAML', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeTempYaml(dir, 'bad.yaml', '{invalid: [yaml');
      expect(() => loadHookConfigFromFile(filePath)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should throw with validation errors for invalid config', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeTempYaml(
        dir,
        'hooks.yaml',
        `
version: "hook-0.1"
gates: {}
hooks:
  task.completed:
    - gate: missing_gate
`,
      );
      expect(() => loadHookConfigFromFile(filePath)).toThrow(HookConfigValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────
// loadMergedHookConfig — multi-layer merge
// ──────────────────────────────────────────────

describe('loadMergedHookConfig', () => {
  it('should load a single project-level config', () => {
    const dir = makeTempDir();
    try {
      const agentDir = join(dir, '.agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'hooks.yaml'), minimalYaml(), 'utf-8');

      const config = loadMergedHookConfig({ projectRoot: dir });
      expect(config.version).toBe('hook-0.1');
      expect(config.gates).toHaveProperty('test_gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should merge project-level and user-level configs', () => {
    const projectDir = makeTempDir();
    const userDir = makeTempDir();
    try {
      // Project-level config
      const projectAgentDir = join(projectDir, '.agent');
      mkdirSync(projectAgentDir, { recursive: true });
      writeFileSync(
        join(projectAgentDir, 'hooks.yaml'),
        `
version: "hook-0.1"
settings:
  fail_fast: false
gates:
  project_gate:
    type: command
    command: "echo project"
hooks:
  task.completed:
    - gate: project_gate
      priority: 100
`,
        'utf-8',
      );

      // User-level config — adds another gate and binding
      const userAgentDir = join(userDir, '.agent');
      mkdirSync(userAgentDir, { recursive: true });
      writeFileSync(
        join(userAgentDir, 'hooks.yaml'),
        `
version: "hook-0.1"
settings:
  fail_fast: true
gates:
  user_gate:
    type: command
    command: "echo user"
hooks:
  task.completed:
    - gate: user_gate
      priority: 50
`,
        'utf-8',
      );

      // We need to mock homedir — but for now, test the merge logic directly
      // by loading individual configs and merging manually
      const projectConfig = loadHookConfigFromFile(join(projectAgentDir, 'hooks.yaml'));
      const userConfig = loadHookConfigFromFile(join(userAgentDir, 'hooks.yaml'));
      const merged = mergeHookConfigs(projectConfig, userConfig);

      // settings: user overrides project
      expect(merged.settings.fail_fast).toBe(true);

      // gates: both present
      expect(merged.gates).toHaveProperty('project_gate');
      expect(merged.gates).toHaveProperty('user_gate');

      // hooks: bindings appended
      expect(merged.hooks['task.completed']).toHaveLength(2);
      expect(merged.hooks['task.completed']![0]!.gate).toBe('project_gate');
      expect(merged.hooks['task.completed']![1]!.gate).toBe('user_gate');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  it('should throw when no config layer is found', () => {
    const emptyDir = makeTempDir();
    try {
      expect(() =>
        loadMergedHookConfig({
          projectRoot: emptyDir,
        }),
      ).toThrow('No hook configuration found');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});