import { describe, expect, it } from 'vitest';
import { parseIntegrationV0CliArgs } from '../../src/examples/integration-v0-options';

describe('parseIntegrationV0CliArgs', () => {
  it('parses synthesis-agent council provider without treating provider value as prompt', () => {
    expect(
      parseIntegrationV0CliArgs([
        '--external-driver',
        '--enable-council',
        '--council-provider',
        'synthesis-agent',
        'Fix login bug',
      ]),
    ).toEqual({
      enableCouncil: true,
      useExternalDriver: true,
      councilProviderMode: 'synthesis-agent',
      driverPrompt: 'Fix login bug',
    });
  });

  it('supports equals syntax for council provider', () => {
    expect(
      parseIntegrationV0CliArgs(['--enable-council', '--council-provider=synthesis-agent']),
    ).toMatchObject({
      enableCouncil: true,
      councilProviderMode: 'synthesis-agent',
    });
  });

  it('parses external driver timeout in milliseconds', () => {
    expect(parseIntegrationV0CliArgs(['--external-driver-timeout-ms', '45000'])).toMatchObject({
      externalDriverTimeoutMs: 45000,
    });
  });

  it('parses memory ablation and worktree path for eval contract', () => {
    expect(
      parseIntegrationV0CliArgs([
        '--ablation',
        'B1',
        '--worktree-path',
        '../tmp/swe-worktree',
        'Fix memory',
      ]),
    ).toMatchObject({
      memoryAblation: 'B1',
      worktreePath: '../tmp/swe-worktree',
      driverPrompt: 'Fix memory',
    });
  });

  it('keeps mock council as the default provider mode', () => {
    expect(parseIntegrationV0CliArgs(['Refactor task runner'])).toEqual({
      enableCouncil: false,
      useExternalDriver: false,
      councilProviderMode: 'mock',
      driverPrompt: 'Refactor task runner',
    });
  });

  it('rejects unknown council provider modes', () => {
    expect(() => parseIntegrationV0CliArgs(['--council-provider', 'nway-diff'])).toThrow(
      'Unsupported council provider: nway-diff',
    );
  });
});
