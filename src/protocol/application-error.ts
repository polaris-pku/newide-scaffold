import { z } from 'zod';

export const APPLICATION_ERROR_CONTRACT_VERSION = 'newide.application-error.v1' as const;

export const applicationErrorCodeSchema = z.enum(['CAPABILITY_UNAVAILABLE']);

export const applicationErrorDataV1Schema = z
  .object({
    contract_version: z.literal(APPLICATION_ERROR_CONTRACT_VERSION),
    error_code: applicationErrorCodeSchema,
    category: z.literal('capability'),
    retryable: z.boolean(),
    request_id: z.string().min(1),
    capability_id: z.string().min(1),
    allowed_actions: z.array(z.string().min(1)),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ApplicationErrorDataV1 = z.infer<typeof applicationErrorDataV1Schema>;

export class ApplicationError extends Error {
  constructor(readonly data: ApplicationErrorDataV1) {
    super(humanMessage(data));
    this.name = 'ApplicationError';
  }
}

function humanMessage(data: ApplicationErrorDataV1): string {
  switch (data.error_code) {
    case 'CAPABILITY_UNAVAILABLE':
      return `Capability unavailable: ${data.capability_id}`;
  }
}
