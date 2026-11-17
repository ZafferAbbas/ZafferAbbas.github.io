import type { ToolSpec } from "../tools.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** A photo or PDF the user sent, for models that can read them. */
export interface Attachment {
  kind: "image" | "pdf";
  mediaType: string;
  /** Base64 data. */
  data: string;
}

export interface UserTurn {
  text: string;
  attachments: Attachment[];
}

export interface LlmBackend {
  readonly name: string;
  /** Whether it can read photos and PDFs. */
  readonly readsAttachments: boolean;
  /** Runs one user turn (including any tool calls) and returns the final reply text. */
  run(system: string, history: ChatTurn[], user: UserTurn, tools: ToolSpec[]): Promise<string>;
}

/** Errors worth telling the user to retry later (overload, rate limit, model server down). */
export class TransientLlmError extends Error {}
