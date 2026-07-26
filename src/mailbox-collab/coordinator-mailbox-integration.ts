import type { PersistentMailboxService } from '../app/persistent-mailbox-service';
import type { EventStore } from '../coordinator/event-store';
import { MailboxEventHandler } from './mailbox-event-handler';
import type { MailboxServiceEnhanced } from './mailbox-service-enhanced';

export interface CoordinatorMailboxIntegrationOptions {
  checkIntervalMs?: number;
}

export class CoordinatorMailboxIntegration {
  private readonly eventHandler: MailboxEventHandler;
  private checkInterval?: NodeJS.Timer;
  private readonly checkIntervalMs: number;
  private isRunning = false;

  constructor(
    private readonly mailboxService: PersistentMailboxService,
    private readonly mailboxServiceEnhanced: MailboxServiceEnhanced,
    private readonly eventStore: EventStore,
    options: CoordinatorMailboxIntegrationOptions = {},
  ) {
    this.checkIntervalMs = options.checkIntervalMs ?? 30_000;
    this.eventHandler = new MailboxEventHandler(eventStore);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.checkInterval = setInterval(async () => {
      try {
        await this.processTimeouts();
      } catch (error) {
        console.error('Error during mailbox timeout check:', error);
      }
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    this.isRunning = false;
  }

  private async processTimeouts(): Promise<void> {
    const now = new Date().toISOString();
    const results = await this.mailboxServiceEnhanced.processTimeouts(now);

    for (const { event } of results) {
      this.eventHandler.onMailboxTimeout(event);
    }
  }

  getEventHandler(): MailboxEventHandler {
    return this.eventHandler;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}
