export interface IncomingMedia {
  kind: "image" | "audio" | "document";
  mimeType: string;
  data: Buffer;
  filename?: string;
}

export interface IncomingMessage {
  /** Where to reply: a group id or the sender's own chat id. */
  chatId: string;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  /** Message text, or the caption of a photo or document. May be empty for media without a caption. */
  text: string;
  media?: IncomingMedia;
  /** Set when the user tapped a button the bot sent (e.g. Approve on a purchase order). */
  action?: string;
  /** True when the bot was @mentioned or the message replies to one of the bot's messages. */
  addressedToBot: boolean;
  /** Text of the message being replied to, if any. */
  quotedText?: string;
  timestamp: number;
}

/**
 * A message the bot sends on its own (not as a reply), such as a reminder. If the WhatsApp Cloud API's 24-hour
 * window is closed, the transport sends `text` through the approved template for `kind` instead.
 */
export interface Notice {
  kind: "reminder" | "update";
  /** Plain one-line text for the template variable. */
  text: string;
}

export interface OutgoingOptions {
  /** User ids to @mention (groups). */
  mentions?: string[];
  notice?: Notice;
}

export interface ActionButton {
  /** Returned as IncomingMessage.action when tapped. */
  id: string;
  /** Max 20 characters. */
  title: string;
}

/** A message that can never be delivered as things stand, so retrying is pointless. */
export class UndeliverableError extends Error {}

export interface Transport {
  readonly name: string;
  start(onMessage: (msg: IncomingMessage) => void): Promise<void>;
  send(chatId: string, text: string, opts?: OutgoingOptions): Promise<void>;
  sendDocument(chatId: string, data: Buffer, filename: string, caption?: string): Promise<void>;
  /**
   * Sends a message with tappable buttons. Transports without buttons send `fallbackText` instead.
   * `notice` is used when the 24-hour window is closed.
   */
  sendButtons(chatId: string, text: string, buttons: ActionButton[], fallbackText: string, notice?: Notice): Promise<void>;
  /** Text used to @mention a user inside a message body. */
  mentionTag(userId: string): string;
  /** The chat id for a phone number (digits only). */
  chatIdForNumber(digits: string): string;
  /** Phone number (digits only) of a sender id, or null if it can't be known. */
  numberOf(senderId: string): string | null;
  /**
   * For reminders due at `dueAt`: a warning to give the user if the transport may not be able to deliver it,
   * or null if it can.
   */
  reminderWarning?(chatId: string, dueAt: number): string | null;
}
