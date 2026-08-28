import { z } from 'zod';
import type { RunArtifactContent } from '../app/run-artifact-content-reader';
import {
  RunArtifactContentUnavailableError,
  RunArtifactNotFoundError,
} from '../app/run-artifact-content-reader';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';

export interface ArtifactMethodsService {
  getArtifactContent(runId: string, artifactId: string): Promise<RunArtifactContent>;
}

const getContentParamsSchema = z
  .object({
    run_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    artifact_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export class ArtifactRpcMethods {
  constructor(private readonly service: ArtifactMethodsService) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('artifact.getContent', async (params) => {
      const parsed = getContentParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
      }
      try {
        return await this.service.getArtifactContent(
          parsed.data.run_id,
          parsed.data.artifact_id,
        );
      } catch (error) {
        if (error instanceof RunArtifactNotFoundError) {
          throw new JsonRpcMethodError(
            JSON_RPC_ERROR_CODES.ARTIFACT_NOT_FOUND,
            'Artifact not found',
            { run_id: error.runId, artifact_id: error.artifactId },
          );
        }
        if (error instanceof RunArtifactContentUnavailableError) {
          throw new JsonRpcMethodError(
            JSON_RPC_ERROR_CODES.ARTIFACT_CONTENT_UNAVAILABLE,
            'Artifact content unavailable',
            {
              run_id: error.runId,
              artifact_id: error.artifactId,
              reason: error.reason,
            },
          );
        }
        throw error;
      }
    });
  }
}
