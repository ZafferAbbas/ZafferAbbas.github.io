function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const transport = env("WA_TRANSPORT", "cloud");
if (transport !== "baileys" && transport !== "cloud") {
  throw new Error(`WA_TRANSPORT must be "baileys" or "cloud", got "${transport}"`);
}

const provider = env("LLM_PROVIDER", "ollama");
if (provider !== "ollama" && provider !== "claude") {
  throw new Error(`LLM_PROVIDER must be "ollama" or "claude", got "${provider}"`);
}

const effort = env("CLAUDE_EFFORT", "medium");
if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
  throw new Error(`CLAUDE_EFFORT must be low|medium|high|xhigh|max, got "${effort}"`);
}

export const config = {
  botName: env("BOT_NAME", "Assistant"),
  timezone: env("TIMEZONE", Intl.DateTimeFormat().resolvedOptions().timeZone),
  dataDir: env("DATA_DIR", "./data"),
  provider: provider as "ollama" | "claude",
  ollama: {
    url: env("OLLAMA_URL", "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: env("OLLAMA_MODEL", "qwen3:4b"),
    // Reasoning mode for models that support it. Off keeps replies fast on a CPU-only VPS.
    think: env("OLLAMA_THINK", "false") === "true",
    numCtx: Number(env("OLLAMA_NUM_CTX", "8192")),
    timeoutMs: Number(env("OLLAMA_TIMEOUT_MS", "180000")),
  },
  claude: {
    model: env("CLAUDE_MODEL", "claude-opus-5-5"),
    effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
  },
  // Small local models do better with a shorter context.
  historyTurns: Number(env("HISTORY_TURNS", provider === "ollama" ? "8" : "20")),
  schedulerIntervalMs: Number(env("SCHEDULER_INTERVAL_MS", "20000")),
  // Extra words that address the bot in a group, besides @mentioning it or replying to it.
  groupTriggers: env("GROUP_TRIGGERS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Comma-separated phone numbers (digits only) allowed to DM the bot. Empty = everyone.
  allowedNumbers: env("ALLOWED_NUMBERS", "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean),
  transport: transport as "baileys" | "cloud",
  baileys: {
    authDir: env("BAILEYS_AUTH_DIR", "./data/baileys-auth"),
    pairingNumber: env("WA_PAIRING_NUMBER", "").replace(/\D/g, ""),
  },
  cloud: {
    port: Number(env("PORT", "3000")),
    verifyToken: process.env.WA_VERIFY_TOKEN ?? "",
    accessToken: process.env.WA_ACCESS_TOKEN ?? "",
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID ?? "",
    appSecret: process.env.WA_APP_SECRET ?? "",
    graphVersion: env("WA_GRAPH_VERSION", "v23.0"),
    // Approved template used for reminders when the 24h customer-service window has closed.
    reminderTemplate: process.env.WA_REMINDER_TEMPLATE ?? "",
    reminderTemplateLang: env("WA_REMINDER_TEMPLATE_LANG", "en"),
  },
};
