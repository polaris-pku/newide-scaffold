import type {
  MailboxDeliveryAckedEvent,
  MailboxDeliveryFailedEvent,
  MailboxDeliveryReadEvent,
  MailboxDeliveryRepliedEvent,
  MailboxDeliveryTimeoutEvent,
  MailboxEvent,
  MailboxEventEmitter,
  MailboxSentEvent,
} from './mailbox-event-types';

export type MailboxEventListener = (event: MailboxEvent) => void;

export class InMemoryMailboxEventEmitter implements MailboxEventEmitter {
  private listeners: MailboxEventListener[] = [];
  private events: MailboxEvent[] = [];

  emitSentEvent(event: MailboxSentEvent): void {
    this.emit(event);
  }

  emitReadEvent(event: MailboxDeliveryReadEvent): void {
    this.emit(event);
  }

  emitAckedEvent(event: MailboxDeliveryAckedEvent): void {
    this.emit(event);
  }

  emitRepliedEvent(event: MailboxDeliveryRepliedEvent): void {
    this.emit(event);
  }

  emitTimeoutEvent(event: MailboxDeliveryTimeoutEvent): void {
    this.emit(event);
  }

  emitFailureEvent(event: MailboxDeliveryFailedEvent): void {
    this.emit(event);
  }

  subscribe(listener: MailboxEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  listEvents(): MailboxEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
    this.listeners = [];
  }

  private emit(event: MailboxEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in mailbox event listener:', error);
      }
    }
  }
}
