/**
 * trace:replay CLI — render a run's trajectory.jsonl as a waterfall tree and,
 * with --analyze, run the replay-time diagnostics (findings / stage timeline /
 * message flow / context usage / final-report schema check). --compare loads
 * several runs side by side so successful and failed runs can be diffed.
 *
 * Usage:
 *   pnpm trace:replay <run-id> [--root <runs-root>] [--analyze] [--final]
 *   pnpm trace:replay <run-id> --compare <run2-id> [<run3-id> ...] [--analyze]
 * The default runs root is `.newide/runs` relative to the working directory.
 */
import { pathToFileURL } from 'node:url';
import { FileTrajectoryWriter } from './trace-writer';
import { replayTrajectory } from './replay';
import { analyzeTrajectory, type TrajectoryDiagnostics } from './analysis';
import { renderDiagnostics, renderFinalReport, summarizeDiagnostics } from './render';

interface CliOptions {
  runIds: string[];
  runsRoot: string;
  analyze: boolean;
  finalOnly: boolean;
  compare: boolean;
}

function parseArgs(args: string[]): CliOptions | undefined {
  const rootIndex = args.indexOf('--root');
  const runsRoot = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1]! : '.newide/runs';
  const rootValueIndex = rootIndex >= 0 ? rootIndex + 1 : -1;
  const positionals = args.filter(
    (arg, index) => !arg.startsWith('--') && index !== rootIndex && index !== rootValueIndex,
  );
  if (positionals.length === 0) {
    process.stderr.write(
      'Usage: pnpm trace:replay <run-id> [--root <runs-root>] [--analyze] [--final]\n' +
        '       pnpm trace:replay <run-id> --compare <run2-id> [<run3-id> ...] [--analyze]\n',
    );
    return undefined;
  }
  return {
    runIds: positionals,
    runsRoot,
    analyze: args.includes('--analyze'),
    finalOnly: args.includes('--final'),
    compare: args.includes('--compare'),
  };
}

async function loadRuns(
  writer: FileTrajectoryWriter,
  runIds: string[],
): Promise<Array<{ runId: string; records: Awaited<ReturnType<FileTrajectoryWriter['load']>> }>> {
  const loaded = await Promise.all(
    runIds.map(async (runId) => ({ runId, records: await writer.load(runId) })),
  );
  const available = loaded.filter((run) => run.records.length > 0);
  if (available.length === 0) {
    process.stderr.write(`No trajectory found for ${runIds.join(', ')} under ${writer.runsRoot()}\n`);
  }
  return available;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (!options) return 2;
  const writer = new FileTrajectoryWriter(options.runsRoot);
  const runs = await loadRuns(writer, options.runIds);
  if (runs.length === 0) return 1;

  if (options.compare) {
    const rows = runs.map((run) => ({
      run,
      replay: replayTrajectory(run.records, run.runId),
      diag: analyzeTrajectory(run.records),
    }));
    process.stdout.write('── run comparison ─────────────────────────────────────────────\n');
    process.stdout.write(
      `  ${'run'.padEnd(38)} ${'records'.padStart(8)} ${'spans'.padStart(6)} ${'status'.padStart(9)}  findings\n`,
    );
    for (const row of rows) {
      process.stdout.write(
        `  ${row.run.runId.padEnd(38)} ${String(row.replay.records.length).padStart(8)} ` +
          `${String(row.replay.spans.length).padStart(6)} ${statusOf(row.diag).padStart(9)}  ` +
          `${summarizeDiagnostics(row.diag)}\n`,
      );
    }
    if (options.analyze) {
      for (const row of rows) {
        process.stdout.write(
          `\n════ run ${row.run.runId} ═══════════════════════════════════════\n`,
        );
        process.stdout.write(`${renderDiagnostics(row.diag)}\n`);
      }
    }
    return 0;
  }

  const run = runs[0]!;
  const replay = replayTrajectory(run.records, run.runId);
  const diag = analyzeTrajectory(run.records);
  process.stdout.write(
    `run ${replay.run_id} — ${replay.records.length} records, ${replay.spans.length} spans` +
      ` — ${summarizeDiagnostics(diag)}\n\n`,
  );
  if (options.finalOnly) {
    process.stdout.write(`${renderFinalReport(diag.finalReport)}\n`);
    return 0;
  }
  process.stdout.write(`${replay.rendered}\n`);
  if (options.analyze) {
    process.stdout.write(`\n${renderDiagnostics(diag)}\n`);
  }
  return 0;
}

/** Best-effort run status for the compare table (last run/task.run span status). */
function statusOf(diag: TrajectoryDiagnostics): string {
  const statuses = diag.stages
    .filter((stage) => stage.name === 'run' || stage.name === 'task.run')
    .flatMap((stage) => stage.spans.map((span) => span.status))
    .filter((status): status is NonNullable<typeof status> => status !== undefined);
  return statuses.at(-1) ?? '?';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
