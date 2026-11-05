import { z } from "zod";
import { config } from "../config.js";
import type { ToolSpec } from "../tools.js";
import { TransientLlmError, type ChatTurn, type LlmBackend } from "./types.js";

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

/** Self-hosted open model through Ollama's native /api/chat endpoint. No API key, no per-message cost. */
export class OllamaBackend implements LlmBackend {
  readonly name = "ollama";

  async run(system: string, history: ChatTurn[], userText: string, tools: ToolSpec[]): Promise<string> {
    const messages: OllamaMessage[] = [
      { role: "system", content: system },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userText },
    ];
    const toolDefs = tools.map((t) => {
      const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
      return { type: "function", function: { name: t.name, description: t.description, parameters } };
    });
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (let step = 0; step < 6; step++) {
      const reply = await this.chat(messages, toolDefs);
      messages.push(reply);
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) return stripThinking(reply.content);

      for (const call of calls) {
        const t = byName.get(call.function.name);
        let result: string;
        if (!t) {
          result = JSON.stringify({ error: `Unknown tool ${call.function.name}` });
        } else {
          const raw = typeof call.function.arguments === "string" ? safeJson(call.function.arguments) : call.function.arguments;
          const parsed = t.schema.safeParse(dropNulls(raw ?? {}));
          result = parsed.success
            ? await t.run(parsed.data).catch((err: Error) => JSON.stringify({ error: err.message }))
            : JSON.stringify({ error: "Invalid arguments", details: z.prettifyError(parsed.error) });
        }
        messages.push({ role: "tool", tool_name: call.function.name, content: result });
      }
    }
    return "Sorry, I got stuck on that one. Could you rephrase it?";
  }

  private async chat(messages: OllamaMessage[], tools: unknown[]): Promise<OllamaMessage> {
    let res: Response;
    try {
      res = await fetch(`${config.ollama.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.ollama.model,
          messages,
          tools,
          stream: false,
          think: config.ollama.think,
          keep_alive: "24h",
          options: { num_ctx: config.ollama.numCtx, temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(config.ollama.timeoutMs),
      });
    } catch (err) {
      // Ollama not running, or the model took too long.
      throw new TransientLlmError(`Ollama unreachable at ${config.ollama.url}: ${(err as Error).message}`);
    }
    if (res.status >= 500) throw new TransientLlmError(`Ollama ${res.status}: ${await res.text()}`);
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message: OllamaMessage };
    return { role: "assistant", content: body.message.content ?? "", tool_calls: body.message.tool_calls };
  }
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Small models often send null for optional fields; treat that as "not given". */
function dropNulls(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ""));
}

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
