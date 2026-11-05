import type { ToolSpec } from "../tools.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmBackend {
  readonly name: string;
  /** Runs one user turn (including any tool calls) and returns the final reply text. */
  run(system: string, history: ChatTurn[], userText: string, tools: ToolSpec[]): Promise<string>;
}

/** Errors worth telling the user to retry later (overload, rate limit, model server down). */
export class TransientLlmError extends Error {}
