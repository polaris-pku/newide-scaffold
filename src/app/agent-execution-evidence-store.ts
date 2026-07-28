import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AgentContextPackEvidence {
  context_pack_id: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  role_id: string;
  context_policy: string;
  input_artifact_refs: string[];
  memory_buffer_ref: string;
  retrieval: {
    experiences: unknown[];
    skills: unknown[];
  };
  driver_context: unknown;
  /** Exact merged context serialized into A's DriverPrompt. */
  driver_invocation_context?: unknown;
  created_at: string;
  schema_version: string;
}

export interface AgentExecutionEvidenceStore {
  saveContextPack(evidence: AgentContextPackEvidence): Promise<{ uri: string }>;
}

export interface FileAgentExecutionEvidenceStoreOptions {
  root: string;
}

export class FileAgentExecutionEvidenceStore implements AgentExecutionEvidenceStore {
  private readonly root: string;

  constructor(options: FileAgentExecutionEvidenceStoreOptions) {
    this.root = path.resolve(options.root);
  }

  async saveContextPack(evidence: AgentContextPackEvidence): Promise<{ uri: string }> {
    if (!/^context_pack_[a-f0-9]{24}$/.test(evidence.context_pack_id)) {
      throw new Error(`Invalid context pack id: ${evidence.context_pack_id}`);
    }
    await fs.mkdir(this.root, { recursive: true });
    const target = path.join(this.root, `${evidence.context_pack_id}.json`);
    await fs.writeFile(target, JSON.stringify(evidence, null, 2), 'utf-8');
    return { uri: pathToFileURL(target).href };
  }
}
