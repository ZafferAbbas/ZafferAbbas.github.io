import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { config } from "../config.js";
import type { ToolSpec } from "../tools.js";
import { TransientLlmError, type ChatTurn, type LlmBackend } from "./types.js";

/** Optional hosted backend (paid, per message). Used when LLM_PROVIDER=claude. */
export class ClaudeBackend implements LlmBackend {
  readonly name = "claude";
  private client = new Anthropic();

  async run(system: string, history: ChatTurn[], userText: string, tools: ToolSpec[]): Promise<string> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userText },
    ];
    let final: Anthropic.Beta.BetaMessage;
    try {
      final = await this.client.beta.messages.toolRunner({
        model: config.claude.model,
        max_tokens: 16000,
        output_config: { effort: config.claude.effort },
        // Refusal fallback: if a safety classifier declines, the API retries on a suitable model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system,
        tools: tools.map((t) =>
          betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: (input) => t.run(input) }),
        ),
        messages,
        max_iterations: 10,
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)) {
        throw new TransientLlmError(err.message);
      }
      throw err;
    }
    if (final.stop_reason === "refusal") return "Sorry, I can't help with that one.";
    return final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
}
