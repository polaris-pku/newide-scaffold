/**
 * Full-trajectory demo: run the real integration-v0 flow (task creation ->
 * agent execution -> driver -> gate -> artifact selection -> materialization ->
 * checkpoint -> completion) with the B AgentExecutionFacade (scripted LLM +
 * MockDriver) so the trajectory covers the WHOLE chain, not just the agent
 * subtree. One shared TraceProjector feeds both the event projection
 * (orchestrator) and the explicit facade spans, so the per-run sequence stays
 * monotonic across both sources.
 *
 * Usage: pnpm example:full-trajectory
 * Trajectory file: .newide/runs/<run_id>/trajectory.jsonl
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DriverRuntimeAgentExecutionFacade } from '../app/driver-runtime-agent-execution-facade';
import { runIntegrationV0Flow } from '../coordinator';
import { MockDriver } from '../driver/mock-driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type ToolCallResult,
  type ToolCallingClient,
} from '../memory';
import {
  FileTrajectoryWriter,
  TraceProjector,
  analyzeTrajectory,
  renderDiagnostics,
  replayTrajectory,
} from '../trace';

/** Scripted tool-calling LLM: round 1 invokes the driver, round 2 finishes. */
class ScriptedToolCallingClient implements ToolCallingClient {
  private callCount = 0;

  async completeWithTools(): Promise<ToolCallResult> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        content: 'Dispatching the driver to implement the feature.',
        tool_calls: [
          {
            id: 'call_invoke_driver',
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: 'Implement src/mock/feature-flag.ts with enable/disable helpers.',
              }),
            },
          },
        ],
        // Fake context usage so the diagnostics view has a curve to draw.
        usage: {
          tokens_in: 4200,
          tokens_out: 380,
          context_size: 26_400,
          context_limit: 128_000,
          context_pct: 21,
        },
      };
    }
    return {
      content: 'Task completed. [done]',
      tool_calls: undefined,
      usage: {
        tokens_in: 9000,
        tokens_out: 210,
        context_size: 58_300,
        context_limit: 128_000,
        context_pct: 46,
      },
    };
  }
}

export async function main(): Promise<number> {
  const runsRoot = path.resolve(process.env.NEWIDE_TRACE_ROOT ?? '.newide/runs');
  const writer = new FileTrajectoryWriter(runsRoot);
  const projector = new TraceProjector(writer);

  const facade = new DriverRuntimeAgentExecutionFacade({
    driver: new MockDriver(),
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    llm: new ScriptedToolCallingClient(),
    trace: projector,
  });
  await facade.ready();

  const result = await runIntegrationV0Flow({
    traceProjector: projector,
    agentExecutionFacade: facade,
    taskRequest: {
      spec: 'Implement a mock feature-flag module and wire it into the CLI entry.',
      completion_criteria: [
        'src/mock/feature-flag.ts exists with enable/disable helpers',
        'CLI entry references the new module',
        'unit test covers both helpers',
      ],
      risk_level: 'low',
      affected_paths: ['src/mock', 'src/cli'],
    },
  });

  const runId = result.run_id;
  await writer.flush(runId);
  const records = await writer.load(runId);
  const replay = replayTrajectory(records, runId);
  const diag = analyzeTrajectory(records);
  process.stdout.write(
    `run ${replay.run_id} — ${replay.records.length} records, ${replay.spans.length} spans ` +
      `(status ${result.summary.status})\n\n`,
  );
  process.stdout.write(`${replay.rendered}\n`);
  process.stdout.write(`\n${renderDiagnostics(diag)}\n`);
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
