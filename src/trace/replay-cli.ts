/**
 * trace:replay CLI — render a run's trajectory.jsonl as a waterfall tree.
 *
 * Usage: pnpm trace:replay <run-id> [--root <runs-root>]
 * The default runs root is `.newide/runs` relative to the working directory.
 */
import { pathToFileURL } from 'node:url';
import { FileTrajectoryWriter } from './trace-writer';
import { replayTrajectory } from './replay';

export async function main(args = process.argv.slice(2)): Promise<number> {
  const runId = args[0];
  if (!runId) {
    process.stderr.write('Usage: pnpm trace:replay <run-id> [--root <runs-root>]\n');
    return 2;
  }
  const rootIndex = args.indexOf('--root');
  const runsRoot = rootIndex >= 0 && args[rootIndex + 1] ? args[rootIndex + 1]! : '.newide/runs';

  const writer = new FileTrajectoryWriter(runsRoot);
  const records = await writer.load(runId);
  if (records.length === 0) {
    process.stderr.write(`No trajectory found for run ${runId} under ${runsRoot}\n`);
    return 1;
  }
  const replay = replayTrajectory(records, runId);
  process.stdout.write(`run ${replay.run_id} — ${replay.records.length} records, ${replay.spans.length} spans\n\n`);
  process.stdout.write(`${replay.rendered}\n`);
  return 0;
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
