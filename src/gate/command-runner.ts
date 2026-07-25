import { BaseGateRunner } from './runner';
import type { GateRequest, GateResult, GateDefinition } from './gate';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class CommandRunner extends BaseGateRunner {
  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
  ) {
    super(gate_id);
  }

  async run(request: GateRequest): Promise<GateResult> {
    const cmd = this.definition.command;
    if (!cmd) {
      return this.buildResult(
        request,
        'deny',
        'CommandRunner failed: No command specified in definition.',
      );
    }

    try {
      // Execute the command string
      // definition.timeout is seconds; execAsync expects ms
      const timeout =
        this.definition.timeout != null
          ? this.definition.timeout * 1000
          : (request.timeout_ms ?? 30000);
      await execAsync(cmd, {
        timeout,
      });

      // Command succeeded (exit code 0)
      return this.buildResult(request, 'allow', 'Command executed successfully.', {
        required_actions: [],
        audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
      });
    } catch (error: unknown) {
      // Command failed (exit code non-zero or other error)
      let exitCode = 1;
      let message = 'Unknown command execution error';

      if (error && typeof error === 'object') {
        if ('code' in error && typeof error.code === 'number') {
          exitCode = error.code;
        }
        if ('message' in error && typeof error.message === 'string') {
          message = error.message;
        }
      }

      const onFailDecision = this.definition.outputConfig.on_fail ?? 'deny';
      return this.buildResult(
        request,
        onFailDecision,
        `Command execution failed with exit code ${exitCode}. Error: ${message}`,
        {
          required_actions: ['inspect-logs'],
          audit_ref: `audit://command/${this.gate_id}/${request.request_id}`,
        },
      );
    }
  }
}
