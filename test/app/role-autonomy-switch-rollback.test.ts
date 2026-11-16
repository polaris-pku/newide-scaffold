/**
 * 阶段 5 开关/回滚演练的回归门禁：在临时目录重跑 `scripts/phase5/switch-rollback-drill.ts`
 * 的同一套确定性场景，断言每个场景通过、证据文件可再读。
 *
 * 与脚本本身的分工：脚本负责把证据落到 `.newide/phase5/switch-rollback/`（人工可查），本测试
 * 负责在 CI/本地把它变成可失败的回归。两者共用一份实现，避免「脚本说的」和「测试测的」漂移。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SWITCH_ENV,
  runSwitchRollbackDrill,
  type SwitchRollbackDrillResult,
} from '../../scripts/phase5/switch-rollback-drill';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeEvidenceDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-switch-rollback-'));
  temporaryDirectories.push(directory);
  return directory;
}

const EXPECTED_SCENARIOS = [
  'fresh_run_switches_off_legacy',
  'fresh_run_candidate_switches_new_path',
  'frozen_run_survives_deployment_rollback',
  'frozen_run_target_binary_without_engine_explicit_end',
  'started_legacy_run_not_taken_over',
  'legacy_frozen_run_stays_legacy',
  'old_buffer_v1_readable',
  'v2_buffer_readable_by_v2_reader_after_rollback',
  'old_snapshot_readable_without_dispatch_fields',
  'illegal_switch_combination_rejected_at_startup',
];

describe('阶段 5 开关/回滚演练（确定性，无真实 Driver）', () => {
  it('全部回滚场景通过，并产出可再读的证据文件', async () => {
    const evidenceDir = await makeEvidenceDir();
    const result: SwitchRollbackDrillResult = await runSwitchRollbackDrill({
      evidence_dir: evidenceDir,
      now: new Date('2026-11-15T00:00:00.000Z'),
    });

    expect(result.scenarios.map((entry) => entry.id)).toEqual(EXPECTED_SCENARIOS);
    expect(
      result.scenarios.filter((entry) => !entry.ok).map((entry) => entry.failures),
    ).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ total: 10, passed: 10, failed: 0 });

    const evidence = JSON.parse(
      await fs.readFile(path.join(evidenceDir, 'drill-evidence.json'), 'utf8'),
    ) as SwitchRollbackDrillResult;
    expect(evidence.ok).toBe(true);
    expect(evidence.summary.failed).toBe(0);
    expect(evidence.constraints.join('\n')).toContain('回滚目标二进制必须 ≥ 阶段 3');
    // 回滚后 v2 Buffer 仍由 v2 reader 可读：file 适配器真实读写后的快照版本为 2。
    const v2 = evidence.scenarios.find(
      (entry) => entry.id === 'v2_buffer_readable_by_v2_reader_after_rollback',
    );
    expect(v2?.observed['buffer_version']).toBe(2);
    expect(v2?.observed['isBufferSnapshotV2']).toBe(true);
    // 已冻结 Run 在回滚目标二进制缺少 role-loop 时显式结束而不是偷换执行器。
    const explicitEnd = evidence.scenarios.find(
      (entry) => entry.id === 'frozen_run_target_binary_without_engine_explicit_end',
    );
    expect(explicitEnd?.observed['code']).toBe('role_loop_not_wired');
    // runbook 与 summary 文件可再读（证据留档路径约定）。
    await expect(fs.stat(path.join(evidenceDir, 'drill-summary.md'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(evidenceDir, 'rollback-runbook.md'))).resolves.toBeTruthy();
  });

  it('默认切换候选组合固定为 1/1/1（测试/脚本共享同一常量，避免两处漂移）', () => {
    expect(DEFAULT_SWITCH_ENV).toEqual({
      NEWIDE_ROLE_AUTONOMY: '1',
      NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
      NEWIDE_BUFFER_V2: '1',
    });
  });
});
