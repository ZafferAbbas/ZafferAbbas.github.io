export interface IncomingMessage {
  /** Where to reply: a group id or the sender's own chat id. */
  chatId: string;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  text: string;
  /** True when the bot was @mentioned or the message replies to one of the bot's messages. */
  addressedToBot: boolean;
  /** Text of the message being replied to, if any. */
  quotedText?: string;
  timestamp: number;
}

export interface OutgoingOptions {
  /** User ids to @mention (groups). */
  mentions?: string[];
  /** Set for scheduled reminders. Plain reminder text, used as the template variable when a template is needed. */
  reminderText?: string;
}

/** A message that can never be delivered as things stand, so retrying is pointless. */
export class UndeliverableError extends Error {}

export interface Transport {
  readonly name: string;
  start(onMessage: (msg: IncomingMessage) => void): Promise<void>;
  send(chatId: string, text: string, opts?: OutgoingOptions): Promise<void>;
  /** Text used to @mention a user inside a message body. */
  mentionTag(userId: string): string;
  /**
   * For reminders due at `dueAt`: a warning to give the user if the transport may not be able to deliver it,
   * or null if it can.
   */
  reminderWarning?(chatId: string, dueAt: number): string | null;
}
