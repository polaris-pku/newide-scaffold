/**
 * PromptRunner — LLM-driven gate evaluation.
 *
 * Sends the gate's prompt + event payload to an LLM via LiteLLMClient
 * and parses the response into a GateDecision.
 *
 * - Model selection is entirely delegated to litellm (task "prompt-gate" → cheap profile)
 * - Registers a programmatic "prompt-gate" task if no YAML config exists
 * - Enforces timeout via Promise.race (soft timeout)
 * - Falls back to outputConfig.on_fail on LLM call failure
 * - Retries per retry_threshold when LLM response cannot be parsed; defaults to deny
 */
import { BaseGateRunner } from './runner';
import type { GateRequest, GateResult, GateDefinition, GateDecision } from './gate';
import { LiteLLMClient } from '../litellm';
import type { LiteLLMTaskConfig } from '../litellm';

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const PROMPT_GATE_TASK = 'prompt-gate';

interface GateDecisionOutput {
  decision: GateDecision;
  reason: string;
  required_actions?: string[];
}

// ──────────────────────────────────────────────
// PromptRunner
// ──────────────────────────────────────────────

export class PromptRunner extends BaseGateRunner {
  private client: LiteLLMClient | null = null;

  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
  ) {
    super(gate_id);
  }

  /** Lazily initialise the LiteLLMClient and ensure a prompt-gate task exists. */
  private getClient(): LiteLLMClient {
    if (!this.client) {
      this.client = new LiteLLMClient();
      this.client.loadConfig();

      // Register a programmatic fallback task if no YAML config covers prompt-gate yet.
      if (!this.client.modelPool.config.has(PROMPT_GATE_TASK)) {
        const taskConfig: LiteLLMTaskConfig = {
          task: PROMPT_GATE_TASK,
          profile: 'cheap',
          temperature: 0.1,
          maxTokens: 500,
        };
        this.client.modelPool.config.register(taskConfig);
      }
    }
    return this.client;
  }

  async run(request: GateRequest): Promise<GateResult> {
    const prompt = this.definition.prompt;
    if (!prompt) {
      return this.buildResult(
        request,
        'deny',
        'PromptRunner failed: No prompt specified in gate definition.',
        { required_actions: ['fix-gate-config'] },
      );
    }

    // Build timeout: definition.timeout is seconds; convert to ms
    const timeoutMs =
      this.definition.timeout != null
        ? this.definition.timeout * 1000
        : (request.timeout_ms ?? 30_000);

    const systemPrompt = buildSystemPrompt(prompt, this.definition.outputConfig);

    try {
      const client = this.getClient();
      const maxRetries = this.definition.retry_threshold ?? 0;
      let lastParseError: string | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const completionPromise = client.complete({
          task: PROMPT_GATE_TASK,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content:
                attempt === 0
                  ? JSON.stringify(request.payload ?? {}, null, 2)
                  : buildRetryUserMessage(
                      JSON.stringify(request.payload ?? {}, null, 2),
                      lastParseError!,
                    ),
            },
          ],
          temperature: 0.1,
          maxTokens: 500,
        });

        const response = await withTimeout(completionPromise, timeoutMs);

        try {
          const output = parseGateDecision(response.content);
          const decision = this.mapSeverity(output.decision, this.definition.outputConfig);
          return this.buildResult(request, decision, output.reason, {
            required_actions: output.required_actions ?? [],
            audit_ref: `audit://prompt/${this.gate_id}/${request.request_id}`,
          });
        } catch (parseError: unknown) {
          lastParseError = parseError instanceof Error ? parseError.message : String(parseError);
        }
      }

      // All parse retries exhausted — default deny
      return this.buildResult(
        request,
        'deny',
        `PromptRunner failed to parse LLM response after ${maxRetries + 1} attempt(s). Last error: ${lastParseError}`,
        {
          required_actions: ['inspect-prompt-logs'],
          audit_ref: `audit://prompt/${this.gate_id}/${request.request_id}`,
        },
      );
    } catch (error: unknown) {
      const onFailDecision = this.definition.outputConfig.on_fail ?? 'deny';
      const message =
        error instanceof Error
          ? error.message === 'TIMEOUT'
            ? `PromptRunner timed out after ${timeoutMs}ms`
            : `PromptRunner LLM call failed: ${error.message}`
          : `PromptRunner LLM call failed: ${String(error)}`;

      return this.buildResult(request, onFailDecision, message, {
        required_actions: ['inspect-prompt-logs'],
        audit_ref: `audit://prompt/${this.gate_id}/${request.request_id}`,
      });
    }
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms)),
  ]);
}

function buildSystemPrompt(
  userPrompt: string,
  outputConfig: GateDefinition['outputConfig'],
): string {
  const severityLines = outputConfig.severity_map
    ? Object.entries(outputConfig.severity_map)
        .map(([sev, dec]) => `- ${sev} → ${dec}`)
        .join('\n')
    : '';

  return [
    userPrompt,
    '',
    '---',
    'You are a gate evaluation assistant. Based on the criteria above,',
    'evaluate the provided event payload and return a JSON object with:',
    '',
    '  {',
    '    "decision": "allow" | "deny" | "ask" | "defer",',
    '    "reason": "<concise explanation>",',
    '    "required_actions": ["<action-1>", ...]  // optional',
    '  }',
    '',
    severityLines ? `Severity-to-decision mapping:\n${severityLines}\n` : '',
    'Respond ONLY with the JSON object. No markdown, no extra text.',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRetryUserMessage(payloadJson: string, lastError: string): string {
  return [
    payloadJson,
    '',
    '---',
    `Your previous response could not be parsed as valid JSON. Error: ${lastError}`,
    'Please ensure you return ONLY a valid JSON object with the required fields.',
  ].join('\n');
}

function parseGateDecision(raw: string): GateDecisionOutput {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    const end = cleaned.indexOf('\n');
    cleaned = cleaned.slice(end + 1);
    const close = cleaned.lastIndexOf('```');
    if (close >= 0) cleaned = cleaned.slice(0, close);
    cleaned = cleaned.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Response is not valid JSON');
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.decision !== 'string') {
    throw new Error('Response missing required field: decision');
  }

  const validDecisions = new Set(['allow', 'deny', 'ask', 'defer']);
  const decision = obj.decision.toLowerCase();
  if (!validDecisions.has(decision)) {
    throw new Error(`Invalid decision "${obj.decision}". Must be one of: allow, deny, ask, defer.`);
  }

  const output: GateDecisionOutput = {
    decision: decision as GateDecision,
    reason: typeof obj.reason === 'string' ? obj.reason : 'No reason provided.',
  };
  if (Array.isArray(obj.required_actions)) {
    output.required_actions = obj.required_actions.filter(
      (a): a is string => typeof a === 'string',
    );
  }
  return output;
}
