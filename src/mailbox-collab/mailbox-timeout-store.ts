import type { PersistedMailboxDelivery, PersistedMailboxEnvelope } from '../persistence';
import type { MessageTimeoutAction } from './mailbox-event-types';

export interface MailboxTimeoutStoreOptions {
  maxRetries?: number;
  now?: () => string;
}

export interface TimeoutCheckResult {
  timedOutEnvelopes: PersistedMailboxEnvelope[];
  toRetry: string[];
  toBlock: string[];
  toFail: string[];
}

export interface MailboxTimeoutStore {
  listTimedOutDeliveries(now: string): PersistedMailboxEnvelope[];

  recordMailboxTimeout(
    deliveryId: string,
    timeoutAt: string,
    action: MessageTimeoutAction,
  ): PersistedMailboxDelivery;

  recordMailboxFailure(
    deliveryId: string,
    errorCode: string,
    errorMessage: string,
  ): PersistedMailboxDelivery;

  recordMailboxRead(
    deliveryId: string,
    readAt: string,
  ): PersistedMailboxDelivery;
}
