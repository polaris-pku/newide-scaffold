/**
 * Agent trace demo: drive the real DriverRuntimeAgentExecutionFacade (top-level
 * Agent tool-calling loop) with a scripted LLM + MockDriver, trace enabled, and
 * replay the run's trajectory as a waterfall — showing the full depth added by
 * agent.execution / agent.turn / agent.tool / driver.run spans.
 *
 * Usage: pnpm example:agent-trace
 * Trajectory file: .newide/runs/<run_id>/trajectory.jsonl
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, createId } from '../core';
import { DriverRuntimeAgentExecutionFacade } from '../app/driver-runtime-agent-execution-facade';
import { MockDriver } from '../driver/mock-driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type ToolCallResult,
  type ToolCallingClient,
} from '../memory';
import { FileTrajectoryWriter, TraceProjector, replayTrajectory } from '../trace';

/** Scripted tool-calling LLM: round 1 calls tools, round 2 finishes the task. */
class ScriptedToolCallingClient implements ToolCallingClient {
  private callCount = 0;

  async completeWithTools(): Promise<ToolCallResult> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        content: 'Let me query memory and dispatch the driver.',
        tool_calls: [
          {
            id: 'call_query_memory',
            type: 'function',
            function: {
              name: 'query_memory',
              arguments: JSON.stringify({ query: 'relevant past experience for this task' }),
            },
          },
          {
            id: 'call_invoke_driver',
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({ instruction: 'Implement the mock feature end to end.' }),
            },
          },
        ],
      };
    }
    return { content: 'Task completed. [done]', tool_calls: undefined };
  }
}

export async function main(): Promise<number> {
  const runsRoot = path.resolve(process.env.NEWIDE_TRACE_ROOT ?? '.newide/runs');
  const writer = new FileTrajectoryWriter(runsRoot);
  const projector = new TraceProjector(writer);

  const roleId = 'role_ts_engineer';
  const taskId = createId('task');
  const runId = createId('run');
  const facade = new DriverRuntimeAgentExecutionFacade({
    driver: new MockDriver(),
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    llm: new ScriptedToolCallingClient(),
    trace: projector,
  });
  await facade.ready();
  await facade.ensureAgent(roleId);

  const result = await facade.runAgent({
    task_id: taskId,
    run_id: runId,
    role_id: roleId,
    instruction:
      'Implement the mock feature: query relevant memory, dispatch the driver, and report back.',
    input_artifact_refs: [],
    context_policy: 'production_task_loop',
    schema_version: SCHEMA_VERSION,
  });

  await writer.flush(runId);
  const records = await writer.load(runId);
  const replay = replayTrajectory(records, runId);
  process.stdout.write(
    `run ${replay.run_id} — ${replay.records.length} records, ${replay.spans.length} spans ` +
      `(agent_run ${result.agent_run_id}, status ${result.status})\n\n`,
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
