import type { MessageRecipient } from '../core';
import type {
  MailboxReplyInput,
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
} from '../persistence';

export interface MailboxToolPort {
  readInbox(recipient: MessageRecipient, limit?: number): Promise<PersistedMailboxEnvelope[]>;

  acknowledgeMessage(deliveryId: string, recipient: MessageRecipient): Promise<void>;

  replyMessage(input: MailboxReplyInput): Promise<PersistedMailboxDelivery>;
}
