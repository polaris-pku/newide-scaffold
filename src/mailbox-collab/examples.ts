import Database from 'better-sqlite3';
import type { PersistentMailboxService } from '../../app/persistent-mailbox-service';
import type { EventStore } from '../../coordinator/event-store';
import type { JsonRpcDispatcher } from '../../rpc/json-rpc-dispatcher';
import {
  SqliteMailboxTimeoutStore,
  MailboxServiceEnhanced,
  InMemoryMailboxEventEmitter,
  CoordinatorMailboxIntegration,
  MailboxToolRpcMethods,
  MailboxEventHandler,
} from '../index';

/**
 * Example: How to integrate Mailbox Agent Collaboration into your Coordinator
 */

export interface MailboxCollaborationSetup {
  db: Database.Database;
  mailboxService: PersistentMailboxService;
  eventStore: EventStore;
  dispatcher: JsonRpcDispatcher;
}

export function setupMailboxCollaboration(setup: MailboxCollaborationSetup): {
  enhancedService: MailboxServiceEnhanced;
  integration: CoordinatorMailboxIntegration;
  eventHandler: MailboxEventHandler;
} {
  const { db, mailboxService, eventStore, dispatcher } = setup;

  // 1. Create timeout store
  const timeoutStore = new SqliteMailboxTimeoutStore(db);

  // 2. Create event emitter
  const eventEmitter = new InMemoryMailboxEventEmitter();

  // 3. Create enhanced service
  const enhancedService = new MailboxServiceEnhanced(mailboxService, timeoutStore, {
    maxRetries: 3,
    eventEmitter,
  });

  // 4. Create event handler
  const eventHandler = new MailboxEventHandler(eventStore);

  // 5. Wire events to event store
  eventEmitter.subscribe((event) => {
    if ('action' in event) {
      // timeout
      eventHandler.onMailboxTimeout(event as any);
    } else if ('acked_by_agent_id' in event) {
      // acked
      eventHandler.onMailboxAcked(event as any);
    } else if ('replied_by_agent_id' in event) {
      // replied
      eventHandler.onMailboxReplied(event as any);
    } else if ('error_code' in event) {
      // failed
      eventHandler.onMailboxFailed(event as any);
    } else if ('requires_ack' in event) {
      // sent
      eventHandler.onMailboxSent(event as any);
    }
  });

  // 6. Create coordinator integration
  const integration = new CoordinatorMailboxIntegration(
    mailboxService,
    enhancedService,
    eventStore,
    { checkIntervalMs: 30_000 }, // Every 30 seconds
  );

  // 7. Register RPC methods for Agent tools
  const toolMethods = new MailboxToolRpcMethods(mailboxService);
  toolMethods.register(dispatcher);

  return { enhancedService, integration, eventHandler };
}

/**
 * Example: Coordinator startup sequence
 */

export async function startCoordinator(setup: MailboxCollaborationSetup): Promise<void> {
  const { enhancedService, integration } = setupMailboxCollaboration(setup);

  // Start timeout checking
  integration.start();
  console.log('✅ Mailbox collaboration started');

  // On shutdown, stop timeout checking
  process.on('SIGTERM', () => {
    integration.stop();
    console.log('⏹ Mailbox collaboration stopped');
  });
}

/**
 * Example: How agents use the mailbox
 */

export const agentExamples = {
  /**
   * Agent reads inbox and processes messages
   */
  async readAndProcess(agentId: string, rpc: any): Promise<void> {
    // 1. Read inbox
    const result = await rpc.call('mailbox.read', {
      agent_id: agentId,
      limit: 10,
    });

    // 2. Process each message
    for (const envelope of result.envelopes) {
      const { message, delivery } = envelope;

      switch (message.type) {
        case 'review_request':
          {
            // Do the work
            const reviewResult = await performReview(message.payload);

            // Reply
            await rpc.call('mailbox.reply', {
              source_delivery_id: delivery.delivery_id,
              source_recipient: { agent_id: agentId },
              from_agent_id: agentId,
              to: [{ agent_id: message.from_agent_id }],
              type: 'review_request',
              payload: reviewResult,
              requires_ack: false,
            });
          }
          break;

        case 'task.assigned':
          {
            // Do the task
            await executeTask(message.payload);

            // Just acknowledge (no reply needed)
            await rpc.call('mailbox.acknowledge', {
              delivery_id: delivery.delivery_id,
              agent_id: agentId,
            });
          }
          break;
      }
    }
  },
};

async function performReview(payload: any): Promise<any> {
  // Simulated review logic
  return { approved: true, comment: 'Looks good' };
}

async function executeTask(payload: any): Promise<void> {
  // Simulated task execution
  console.log('Executing task:', payload);
}
