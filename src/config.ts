function numbers(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
}

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
  // Language the bot always replies in, e.g. "Roman Urdu" or "English". Empty = the person's own language,
  // with Roman Urdu for anyone writing or speaking Urdu.
  replyLanguage: process.env.REPLY_LANGUAGE ?? "",
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
  allowedNumbers: numbers("ALLOWED_NUMBERS"),
  purchaseOrders: {
    // Who may create purchase orders. Empty = anyone allowed to use the bot.
    staffNumbers: numbers("STAFF_NUMBERS"),
    // Who approves them. Purchase orders are disabled until at least one is set.
    managerNumbers: numbers("MANAGER_NUMBERS"),
    companyName: env("COMPANY_NAME", "Purchase Order"),
    currency: env("CURRENCY", ""),
    numberPrefix: env("PO_PREFIX", "PO-"),
  },
  odoo: {
    url: (process.env.ODOO_URL ?? "").replace(/\/$/, ""),
    database: process.env.ODOO_DB ?? "",
    // "json2" for Odoo 19 and later, "jsonrpc" for Odoo 18 and earlier.
    api: env("ODOO_API", "json2") as "json2" | "jsonrpc",
    // Login (email) of the API user; only needed for jsonrpc.
    login: process.env.ODOO_LOGIN ?? "",
    apiKey: process.env.ODOO_API_KEY ?? "",
    // Confirm the purchase order in Odoo once a manager approves it on WhatsApp.
    confirm: env("ODOO_CONFIRM", "true") === "true",
  },
  customErp: {
    // Approved purchase orders are POSTed here as JSON, signed with HMAC-SHA256.
    url: process.env.CUSTOM_ERP_URL ?? "",
    secret: process.env.CUSTOM_ERP_SECRET ?? "",
  },
  speechToText: {
    // OpenAI-compatible transcription server (e.g. the speaches container in docker-compose.yml).
    url: (process.env.STT_URL ?? "").replace(/\/$/, ""),
    // large-v3-turbo handles Urdu and Farsi far better than the small models. Needs ~2-3 GB RAM.
    model: env("STT_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2"),
    // Force one language, e.g. "ur". Empty = detect automatically.
    language: process.env.STT_LANGUAGE ?? "",
    // Re-transcribe in another language when this one is detected. "hi:ur" = Hindi heard -> write Urdu.
    remap: env("STT_LANGUAGE_REMAP", "hi:ur"),
  },
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
    // Language code of the approved templates.
    templateLang: env("WA_TEMPLATE_LANG", env("WA_REMINDER_TEMPLATE_LANG", "en")),
    // Approved utility template "{{1}}"-style, for purchase-order updates outside the 24h window.
    updateTemplate: process.env.WA_UPDATE_TEMPLATE ?? "",
    // Approved template with Approve / Reject quick-reply buttons, for approval requests outside the window.
    approvalTemplate: process.env.WA_APPROVAL_TEMPLATE ?? "",
  },
};
