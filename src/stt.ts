export interface SpeechToTextOptions {
  /** Base URL of an OpenAI-compatible transcription server, e.g. http://stt:8000 */
  url: string;
  model: string;
  /** Force one language ("ur", "fa", ...). Empty = detect automatically. */
  language: string;
  /**
   * When the detected language is a key here, transcribe again in the mapped language. Default {hi: "ur"}:
   * spoken Urdu and Hindi sound almost the same, and Whisper often picks Hindi and writes Devanagari script.
   */
  remap?: Record<string, string>;
  timeoutMs?: number;
}

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

/** Whisper reports languages as codes or English names depending on the server. */
const LANGUAGE_CODES: Record<string, string> = {
  hindi: "hi",
  urdu: "ur",
  persian: "fa",
  farsi: "fa",
  sindhi: "sd",
  punjabi: "pa",
  arabic: "ar",
  english: "en",
  pashto: "ps",
};

export interface Transcript {
  text: string;
  /** Language code, if the server reported one. */
  language: string | null;
}

/** Parses "hi:ur,pa:ur" into {hi: "ur", pa: "ur"}. */
export function parseRemap(s: string): Record<string, string> {
  return Object.fromEntries(
    s
      .split(",")
      .map((p) => p.split(":").map((x) => x.trim().toLowerCase()))
      .filter((p) => p.length === 2 && p[0] && p[1]),
  );
}

/**
 * Transcribes voice notes with a self-hosted Whisper server (POST /v1/audio/transcriptions, the
 * OpenAI-compatible API that servers like speaches and faster-whisper-server expose). Runs on the VPS, free.
 */
export class SpeechToText {
  private modelRequested = false;

  constructor(private opts: SpeechToTextOptions) {}

  get enabled(): boolean {
    return !!this.opts.url;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<Transcript> {
    if (!this.opts.url) throw new Error("Voice notes need STT_URL (a Whisper server)");
    const first = await this.request(audio, mimeType, this.opts.language || null);
    const remapTo = !this.opts.language && first.language ? (this.opts.remap ?? { hi: "ur" })[first.language] : undefined;
    if (!remapTo) return first;
    const again = await this.request(audio, mimeType, remapTo);
    return { text: again.text || first.text, language: remapTo };
  }

  private async request(audio: Buffer, mimeType: string, language: string | null): Promise<Transcript> {
    const send = () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${EXTENSIONS[mimeType] ?? "ogg"}`);
      form.append("model", this.opts.model);
      form.append("response_format", "verbose_json");
      if (language) form.append("language", language);
      return fetch(`${this.opts.url}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 180_000),
      });
    };
    let res = await send();
    if (res.status === 404 && !this.modelRequested) {
      // Some servers (e.g. recent speaches) only serve models that were downloaded first. Ask once, then retry.
      this.modelRequested = true;
      await fetch(`${this.opts.url}/v1/models/${this.opts.model}`, { method: "POST", signal: AbortSignal.timeout(30 * 60_000) }).catch(
        () => undefined,
      );
      res = await send();
    }
    if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { text?: string; language?: string };
    const lang = body.language?.toLowerCase() ?? null;
    return { text: (body.text ?? "").trim(), language: lang ? (LANGUAGE_CODES[lang] ?? lang) : null };
  }
}
