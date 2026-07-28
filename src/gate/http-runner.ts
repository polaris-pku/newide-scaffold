import { BaseGateRunner } from './runner';
import {
  type GateRequest,
  type GateResult,
  type GateDefinition,
  type GateDecision,
  VALID_DECISIONS,
} from './gate';

export class HttpRunner extends BaseGateRunner {
  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
  ) {
    super(gate_id);
  }

  async run(request: GateRequest): Promise<GateResult> {
    const url = this.definition.http ?? this.definition.input;
    if (!url) {
      return this.buildResult(
        request,
        'deny',
        'HttpRunner failed: No URL specified in definition (set `http` or `input`).',
      );
    }

    const timeout =
      this.definition.timeout != null
        ? this.definition.timeout * 1000
        : (request.timeout_ms ?? 30_000);
    const maxRetries = this.definition.retry_threshold ?? 0;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gate_id: request.gate_id,
            gate_point: request.gate_point,
            request_id: request.request_id,
            subject_id: request.subject_id,
            priority: request.priority,
            payload: request.payload,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Try to parse a JSON decision body
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          try {
            const body = (await response.json()) as Record<string, unknown>;
            const decision = this.parseDecision(body, response.status);
            const reason = (body.reason as string) ?? `HTTP ${response.status}: ${decision}`;
            const overrides: Parameters<typeof this.buildResult>[3] = {
              required_actions: (body.required_actions as string[]) ?? [],
              audit_ref:
                (body.audit_ref as string) ?? `audit://http/${this.gate_id}/${request.request_id}`,
            };
            const ts = body.target_state;
            if (typeof ts === 'string') {
              overrides.target_state = ts;
            }
            return this.buildResult(request, decision, reason, overrides);
          } catch {
            // JSON parse failed — fall through to status-code mapping below
          }
        }

        // Status-code-based fallback
        if (response.ok) {
          return this.buildResult(request, 'allow', `HTTP ${response.status}: Request succeeded.`, {
            audit_ref: `audit://http/${this.gate_id}/${request.request_id}`,
          });
        }

        // Non-successful status code
        if (response.status >= 500 && attempt < maxRetries) {
          await delay(attempt);
          continue;
        }

        const onFailDecision = this.definition.outputConfig.on_fail ?? 'deny';
        return this.buildResult(
          request,
          onFailDecision,
          `HTTP ${response.status}: Request failed.`,
          {
            required_actions: ['inspect-http-response'],
            audit_ref: `audit://http/${this.gate_id}/${request.request_id}`,
          },
        );
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries && isRetryableError(lastError)) {
          await delay(attempt);
          continue;
        }
      }
    }

    // All attempts exhausted
    const onFailDecision = this.definition.outputConfig.on_fail ?? 'deny';
    const errorMessage =
      lastError?.name === 'AbortError'
        ? `HttpRunner timed out after ${timeout}ms`
        : (lastError?.message ?? 'Unknown error');

    return this.buildResult(
      request,
      onFailDecision,
      `HttpRunner failed after ${maxRetries + 1} attempt(s): ${errorMessage}`,
      {
        required_actions: ['inspect-http-logs'],
        audit_ref: `audit://http/${this.gate_id}/${request.request_id}`,
      },
    );
  }

  /**
   * Extract a GateDecision from a JSON response body.
   * Validates that the `decision` field holds a known value;
   * otherwise falls back to status-code mapping.
   */
  private parseDecision(body: Record<string, unknown>, status: number): GateDecision {
    const raw = body.decision;
    if (typeof raw === 'string' && isGateDecision(raw)) {
      return raw;
    }
    // No valid decision in body — derive from HTTP status
    if (status >= 200 && status < 300) return 'allow';
    if (status >= 400 && status < 500) return 'deny';
    return 'defer';
  }
}

function isGateDecision(value: string): value is GateDecision {
  return VALID_DECISIONS.has(value);
}

/** Exponential backoff capped at 30 s. */
function delay(attempt: number): Promise<void> {
  const ms = Math.min(1000 * 2 ** attempt, 30_000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Determine whether an error is worth retrying (transient). */
function isRetryableError(error: Error): boolean {
  if (error.name === 'AbortError') return true;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('socket')
  );
}
