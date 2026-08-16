/**
 * integration-v0 示例命令的参数解析。
 *
 * 这里只负责 CLI 字符串到运行选项的转换，不创建 driver / council provider。
 */
export type IntegrationV0CouncilProviderMode = 'mock' | 'synthesis-agent';

export interface IntegrationV0CliOptions {
  enableCouncil: boolean;
  useExternalDriver: boolean;
  councilProviderMode: IntegrationV0CouncilProviderMode;
  externalDriverTimeoutMs?: number;
  driverPrompt: string;
  memoryAblation?: 'B0' | 'B1' | 'B2' | 'B3';
  worktreePath?: string;
  /** Record the run trajectory to NEWIDE_TRACE_ROOT (default .newide/runs) and print the replay. */
  trace: boolean;
  traceRoot?: string;
}

const DEFAULT_PROMPT = 'Produce a mock patch artifact for integration v0 test';

export function parseIntegrationV0CliArgs(args: string[]): IntegrationV0CliOptions {
  const parsed = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    if (arg.includes('=')) {
      const [key, value] = arg.split('=', 2);
      parsed.set(key!, value ?? true);
      continue;
    }

    if (arg === '--council-provider') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--council-provider requires a value');
      }
      parsed.set(arg, value);
      index += 1;
      continue;
    }

    if (arg === '--external-driver-timeout-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--external-driver-timeout-ms requires a value');
      }
      parsed.set(arg, value);
      index += 1;
      continue;
    }

    if (arg === '--ablation' || arg === '--worktree-path' || arg === '--trace-root') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      parsed.set(arg, value);
      index += 1;
      continue;
    }

    parsed.set(arg, true);
  }

  const councilProviderMode = readCouncilProviderMode(parsed.get('--council-provider'));
  const externalDriverTimeoutMs = readPositiveInteger(
    parsed.get('--external-driver-timeout-ms'),
    '--external-driver-timeout-ms',
  );
  const memoryAblation = readMemoryAblation(parsed.get('--ablation'));
  const worktreePath = readOptionalString(parsed.get('--worktree-path'));
  const traceRoot = readOptionalString(parsed.get('--trace-root'));
  return {
    enableCouncil: Boolean(parsed.get('--enable-council')) || councilProviderMode !== 'mock',
    useExternalDriver: Boolean(parsed.get('--external-driver')),
    councilProviderMode,
    ...(externalDriverTimeoutMs !== undefined ? { externalDriverTimeoutMs } : {}),
    ...(memoryAblation ? { memoryAblation } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    trace: Boolean(parsed.get('--trace')),
    ...(traceRoot ? { traceRoot } : {}),
    driverPrompt: positional[0] ?? DEFAULT_PROMPT,
  };
}

function readCouncilProviderMode(
  value: string | boolean | undefined,
): IntegrationV0CouncilProviderMode {
  if (value === undefined || value === false) {
    return 'mock';
  }
  if (value === 'mock' || value === 'synthesis-agent') {
    return value;
  }
  throw new Error(`Unsupported council provider: ${String(value)}`);
}

function readPositiveInteger(
  value: string | boolean | undefined,
  label: string,
): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readMemoryAblation(
  value: string | boolean | undefined,
): 'B0' | 'B1' | 'B2' | 'B3' | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === 'B0' || value === 'B1' || value === 'B2' || value === 'B3') {
    return value;
  }
  throw new Error(`Unsupported --ablation: ${String(value)} (expected B0|B1|B2|B3)`);
}

function readOptionalString(value: string | boolean | undefined): string | undefined {
  if (value === undefined || value === false || typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
