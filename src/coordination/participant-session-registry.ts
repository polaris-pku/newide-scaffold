/**
 * Explicit Task/workspace/role -> ACP Session binding.
 *
 * Mailbox delivery may consume this registry, but it never creates a Session.
 * The durable adapter is added by the checkpoint slice; this small port keeps
 * PR1 independent of the checkpoint schema while making the boundary explicit.
 */
export interface ParticipantSessionRegistry {
  register(input: ParticipantSessionBinding): void;
  get(taskId: string, workspacePath: string, roleId: string): string | undefined;
  clear(taskId: string, workspacePath: string, roleId: string): void;
  list?(taskId: string, workspacePath: string): ParticipantSessionBinding[];
  listForTask?(taskId: string): ParticipantSessionBinding[];
}

export interface ParticipantSessionPersistence {
  saveParticipantSession(input: ParticipantSessionBinding): void;
  findParticipantSession(taskId: string, workspacePath: string, roleId: string): string | undefined;
  deleteParticipantSession(taskId: string, workspacePath: string, roleId: string): void;
  listParticipantSessions?(taskId: string, workspacePath: string): ParticipantSessionBinding[];
  listParticipantSessionsForTask?(taskId: string): ParticipantSessionBinding[];
}

export interface ParticipantSessionBinding {
  task_id: string;
  workspace_path: string;
  role_id: string;
  session_id: string;
}

export interface ParticipantSessionProvisionRequest {
  task_id: string;
  workspace_path: string;
  role_id: string;
  /** 执行身份；council 席位是 `${任务run_id}_${phaseId}`。 */
  run_id: string;
  /** 本次执行归属的**任务 run**（冻结 routing 快照按它存）；缺省时等于 `run_id`。 */
  activity_run_id?: string;
}

export type ParticipantSessionProvisioner = (
  input: ParticipantSessionProvisionRequest,
) => Promise<string>;

export class InMemoryParticipantSessionRegistry implements ParticipantSessionRegistry {
  private readonly sessions = new Map<string, string>();

  register(input: ParticipantSessionBinding): void {
    requireText(input.task_id, 'task_id');
    requireText(input.workspace_path, 'workspace_path');
    requireText(input.role_id, 'role_id');
    requireText(input.session_id, 'session_id');
    const key = bindingKey(input.task_id, input.workspace_path, input.role_id);
    const existing = this.sessions.get(key);
    if (existing && existing !== input.session_id) {
      throw new Error(
        `Session binding conflict for ${input.task_id}/${input.role_id}: ${existing} != ${input.session_id}`,
      );
    }
    this.sessions.set(key, input.session_id);
  }

  get(taskId: string, workspacePath: string, roleId: string): string | undefined {
    return this.sessions.get(bindingKey(taskId, workspacePath, roleId));
  }

  clear(taskId: string, workspacePath: string, roleId: string): void {
    this.sessions.delete(bindingKey(taskId, workspacePath, roleId));
  }

  list(taskId: string, workspacePath: string): ParticipantSessionBinding[] {
    const prefix = `${taskId}\u0000${workspacePath}\u0000`;
    return [...this.sessions.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, session_id]) => ({
        task_id: taskId,
        workspace_path: workspacePath,
        role_id: key.slice(prefix.length),
        session_id,
      }));
  }

  listForTask(taskId: string): ParticipantSessionBinding[] {
    return [...this.sessions.entries()].flatMap(([key, session_id]) => {
      const [task_id, workspace_path, role_id] = key.split('\u0000');
      return task_id === taskId && workspace_path && role_id
        ? [{ task_id, workspace_path, role_id, session_id }] : [];
    });
  }
}

/** Durable registry adapter used by the production SQLite composition. */
export class PersistentParticipantSessionRegistry implements ParticipantSessionRegistry {
  constructor(private readonly persistence: ParticipantSessionPersistence) {}

  register(input: ParticipantSessionBinding): void {
    requireText(input.task_id, 'task_id');
    requireText(input.workspace_path, 'workspace_path');
    requireText(input.role_id, 'role_id');
    requireText(input.session_id, 'session_id');
    const existing = this.persistence.findParticipantSession(
      input.task_id,
      input.workspace_path,
      input.role_id,
    );
    if (existing && existing !== input.session_id) {
      throw new Error(
        `Session binding conflict for ${input.task_id}/${input.role_id}: ${existing} != ${input.session_id}`,
      );
    }
    this.persistence.saveParticipantSession(input);
  }

  get(taskId: string, workspacePath: string, roleId: string): string | undefined {
    return this.persistence.findParticipantSession(taskId, workspacePath, roleId);
  }

  clear(taskId: string, workspacePath: string, roleId: string): void {
    this.persistence.deleteParticipantSession(taskId, workspacePath, roleId);
  }

  list(taskId: string, workspacePath: string): ParticipantSessionBinding[] {
    const persistence = this.persistence as ParticipantSessionPersistence & {
      listParticipantSessions?: (
        taskId: string,
        workspacePath: string,
      ) => ParticipantSessionBinding[];
    };
    return persistence.listParticipantSessions?.(taskId, workspacePath) ?? [];
  }

  listForTask(taskId: string): ParticipantSessionBinding[] {
    return this.persistence.listParticipantSessionsForTask?.(taskId) ?? [];
  }
}

export function bindingKey(taskId: string, workspacePath: string, roleId: string): string {
  return `${taskId}\u0000${workspacePath}\u0000${roleId}`;
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} is required`);
}
