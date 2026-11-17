export interface SpeechToTextOptions {
  /** Base URL of an OpenAI-compatible transcription server, e.g. http://stt:8000 */
  url: string;
  model: string;
  /** Optional language hint ("en", "ur", ...). Empty = auto-detect. */
  language: string;
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

/**
 * Transcribes voice notes with a self-hosted Whisper server (POST /v1/audio/transcriptions, the
 * OpenAI-compatible API that servers like speaches and faster-whisper-server expose). Runs on the VPS, free.
 */
export class SpeechToText {
  constructor(private opts: SpeechToTextOptions) {}

  get enabled(): boolean {
    return !!this.opts.url;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    if (!this.opts.url) throw new Error("Voice notes need STT_URL (a Whisper server)");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${EXTENSIONS[mimeType] ?? "ogg"}`);
    form.append("model", this.opts.model);
    form.append("response_format", "json");
    if (this.opts.language) form.append("language", this.opts.language);
    const res = await fetch(`${this.opts.url}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) throw new Error(`Transcription failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { text?: string };
    return (body.text ?? "").trim();
  }
}
