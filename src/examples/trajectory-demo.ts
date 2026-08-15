/**
 * Trajectory demo: run the v0 basic flow with trace recording enabled, then
 * replay the run's trajectory.jsonl as a waterfall — the 复盘 view.
 *
 * Usage: pnpm example:trajectory
 * Trajectory file: .newide/runs/<run_id>/trajectory.jsonl
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBasicFlow } from '../coordinator';
import { FileTrajectoryWriter, replayTrajectory } from '../trace';

export async function main(): Promise<number> {
  const runsRoot = path.resolve(process.env.NEWIDE_TRACE_ROOT ?? '.newide/runs');
  const writer = new FileTrajectoryWriter(runsRoot);

  const result = await runBasicFlow({ trace: writer });
  const runCreated = result.events.find((event) => event.event_type === 'run.created');
  const runId = runCreated?.run_id;
  if (!runId) {
    throw new Error('basic flow did not emit a run.created event');
  }

  await writer.flush(runId);
  const records = await writer.load(runId);
  const replay = replayTrajectory(records, runId);
  process.stdout.write(
    `run ${replay.run_id} — ${replay.records.length} records, ${replay.spans.length} spans\n\n`,
  );
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
