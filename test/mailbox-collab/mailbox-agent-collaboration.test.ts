import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PersistentMailboxService } from '../../app/persistent-mailbox-service';
import type { MailboxStateStore } from '../../persistence/mailbox-state-store';
import type { AgentMailboxWakePort } from '../../protocol/agent-mailbox-wake';
import type { MessageRecipient } from '../../core';
import {
  MailboxServiceEnhanced,
  InMemoryMailboxEventEmitter,
  MailboxEventHandler,
  SqliteMailboxTimeoutStore,
  CoordinatorMailboxIntegration,
} from '../index';
import type { EventStore } from '../../coordinator/event-store';
import { InMemoryEventStore } from '../../coordinator/event-store';

describe('Mailbox Agent Collaboration', () => {
  let mailboxService: PersistentMailboxService;
  let enhancedService: MailboxServiceEnhanced;
  let eventEmitter: InMemoryMailboxEventEmitter;
  let eventStore: EventStore;
  let eventHandler: MailboxEventHandler;
  let mockWakePort: AgentMailboxWakePort;
  let mockStore: MailboxStateStore;

  beforeEach(() => {
    // Mock setup
    const wakeCalls: Array<{ agentId?: string; deliveryId: string }> = [];
    mockWakePort = {
      wakeAgent: async (request) => {
        wakeCalls.push({
          agentId: request.recipient_agent_id,
          deliveryId: request.delivery_id,
        });
      },
    };

    // Create event emitter and stores
    eventEmitter = new InMemoryMailboxEventEmitter();
    eventStore = new InMemoryEventStore();
    eventHandler = new MailboxEventHandler(eventStore);

    // Wire event emitter to event handler
    eventEmitter.subscribe((event) => {
      if ('action' in event) {
        // timeout event
        eventHandler.onMailboxTimeout(event as any);
      } else if ('acked_by_agent_id' in event) {
        // acked event
        eventHandler.onMailboxAcked(event as any);
      } else if ('replied_by_agent_id' in event) {
        // replied event
        eventHandler.onMailboxReplied(event as any);
      } else if ('error_code' in event) {
        // failed event
        eventHandler.onMailboxFailed(event as any);
      } else if ('requires_ack' in event) {
        // sent event
        eventHandler.onMailboxSent(event as any);
      }
    });

    enhancedService = new MailboxServiceEnhanced(mailboxService, mockStore as any, {
      maxRetries: 3,
      eventEmitter,
    });
  });

  afterEach(() => {
    eventEmitter.clear();
  });

  it('should emit sent event when message is sent', () => {
    const event = enhancedService.emitSentEvent('msg-1', {
      delivery_id: 'del-1',
      message_id: 'msg-1',
      recipient_agent_id: 'agent-1',
      status: 'pending',
      retry_count: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      schema_version: 1,
      requires_ack: true,
    });

    expect(event).toBeDefined();
    expect(event.message_id).toBe('msg-1');
    expect(event.delivery_id).toBe('del-1');
    expect(event.recipient_agent_id).toBe('agent-1');

    const events = eventEmitter.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty('delivery_id', 'del-1');
  });

  it('should emit acked event when message is acknowledged', () => {
    const event = enhancedService.emitAckedEvent('del-1', 'msg-1', 'agent-1');

    expect(event).toBeDefined();
    expect(event.delivery_id).toBe('del-1');
    expect(event.acked_by_agent_id).toBe('agent-1');

    const events = eventEmitter.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty('acked_by_agent_id', 'agent-1');
  });

  it('should emit replied event when message is replied', () => {
    const event = enhancedService.emitRepliedEvent(
      'reply-msg-1',
      'reply-del-1',
      'del-1',
      'msg-1',
      'agent-1',
    );

    expect(event).toBeDefined();
    expect(event.reply_message_id).toBe('reply-msg-1');
    expect(event.source_delivery_id).toBe('del-1');

    const events = eventEmitter.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty('replied_by_agent_id', 'agent-1');
  });

  it('should handle coordinator integration lifecycle', () => {
    const integration = new CoordinatorMailboxIntegration(
      mailboxService,
      enhancedService,
      eventStore,
      { checkIntervalMs: 100 },
    );

    expect(integration.isActive()).toBe(false);

    integration.start();
    expect(integration.isActive()).toBe(true);

    integration.stop();
    expect(integration.isActive()).toBe(false);
  });

  it('should track multiple events in event store', () => {
    eventHandler.onMailboxSent({
      message_id: 'msg-1',
      delivery_id: 'del-1',
      recipient_agent_id: 'agent-1',
      requires_ack: true,
    });

    eventHandler.onMailboxAcked({
      delivery_id: 'del-1',
      message_id: 'msg-1',
      acked_by_agent_id: 'agent-1',
      acked_at: '2024-01-01T00:00:01Z',
    });

    const events = eventStore.list();
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('mailbox.sent');
    expect(events[1].event_type).toBe('mailbox.delivery_acked');
  });

  it('should emit failure event on delivery failure', () => {
    const event = enhancedService.recordFailure(
      'del-1',
      'AGENT_CRASHED',
      'Agent process exited unexpectedly',
    );

    expect(event).toBeDefined();
    expect(event.error_code).toBe('AGENT_CRASHED');
    expect(event.delivery_id).toBe('del-1');

    const events = eventEmitter.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty('error_code', 'AGENT_CRASHED');
  });

  it('event emitter should support subscription', () => {
    const receivedEvents: any[] = [];
    const unsubscribe = eventEmitter.subscribe((event) => {
      receivedEvents.push(event);
    });

    eventEmitter.emitSentEvent({
      message_id: 'msg-1',
      delivery_id: 'del-1',
      requires_ack: true,
    });

    expect(receivedEvents).toHaveLength(1);

    unsubscribe();

    eventEmitter.emitSentEvent({
      message_id: 'msg-2',
      delivery_id: 'del-2',
      requires_ack: false,
    });

    // Should still be 1 because unsubscribed
    expect(receivedEvents).toHaveLength(1);
  });

  it('should handle timeout event with correct action based on retry count', () => {
    const timeoutEvent = {
      delivery_id: 'del-1',
      message_id: 'msg-1',
      recipient_agent_id: 'agent-1',
      action: 'retry' as const,
      timeout_at: '2024-01-01T00:00:10Z',
      retry_count: 1,
    };

    eventHandler.onMailboxTimeout(timeoutEvent);

    const events = eventStore.list();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('mailbox.delivery_timeout');
    expect(events[0].payload).toHaveProperty('action', 'retry');
  });
});
