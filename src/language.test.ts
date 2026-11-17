import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import PDFDocument from "pdfkit";
import { write } from "./po/pdf.js";
import { parseRemap, SpeechToText } from "./stt.js";

/** Fake Whisper server. `detect` is the language it "hears" when none is forced. */
async function fakeWhisper(opts: { detect: string; needsDownload?: boolean }) {
  const calls: { path: string; language: string | null }[] = [];
  let downloaded = !opts.needsDownload;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const language = body.match(/name="language"\r\n\r\n([a-z]+)/)?.[1] ?? null;
      calls.push({ path: req.url!, language });
      if (req.url!.startsWith("/v1/models/")) {
        downloaded = true;
        return res.end("{}");
      }
      if (!downloaded) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ detail: "Model not found" }));
      }
      res.setHeader("content-type", "application/json");
      const lang = language ?? opts.detect;
      const text = lang === "hindi" || lang === "hi" ? "दस डिब्बे कागज़" : lang === "ur" ? "دس ڈبے کاغذ" : "ten boxes";
      res.end(JSON.stringify({ text, language: language ? language : opts.detect }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("stt: Hindi detected -> transcribed again as Urdu", async () => {
  const w = await fakeWhisper({ detect: "hindi" });
  const stt = new SpeechToText({ url: w.url, model: "m", language: "", remap: parseRemap("hi:ur") });
  const t = await stt.transcribe(Buffer.from("x"), "audio/ogg");
  w.close();
  assert.deepEqual(t, { text: "دس ڈبے کاغذ", language: "ur" });
  assert.deepEqual(
    w.calls.map((c) => c.language),
    [null, "ur"],
  );
});

test("stt: other languages and a forced language are left alone", async () => {
  const w = await fakeWhisper({ detect: "fa" });
  const auto = await new SpeechToText({ url: w.url, model: "m", language: "", remap: { hi: "ur" } }).transcribe(Buffer.from("x"), "audio/ogg");
  assert.equal(auto.language, "fa");
  assert.equal(w.calls.length, 1);
  const forced = await new SpeechToText({ url: w.url, model: "m", language: "ur", remap: { hi: "ur" } }).transcribe(Buffer.from("x"), "audio/ogg");
  assert.equal(forced.text, "دس ڈبے کاغذ");
  assert.equal(w.calls.length, 2);
  w.close();
});

test("stt: asks the server to download the model once if it's missing", async () => {
  const w = await fakeWhisper({ detect: "en", needsDownload: true });
  const t = await new SpeechToText({ url: w.url, model: "org/whisper-x", language: "", remap: {} }).transcribe(Buffer.from("x"), "audio/ogg");
  w.close();
  assert.equal(t.text, "ten boxes");
  assert.deepEqual(
    w.calls.map((c) => c.path),
    ["/v1/audio/transcriptions", "/v1/models/org/whisper-x", "/v1/audio/transcriptions"],
  );
});

test("stt: parseRemap", () => {
  assert.deepEqual(parseRemap("hi:ur, pa : ur"), { hi: "ur", pa: "ur" });
  assert.deepEqual(parseRemap("none"), {});
});

/** Records what write() draws, and where. */
function recordingDoc() {
  const doc = new PDFDocument({ size: "A4" });
  doc.registerFont("naskh", new URL("../assets/fonts/NotoNaskhArabic-Regular.ttf", import.meta.url).pathname);
  doc.registerFont("naskh-bold", new URL("../assets/fonts/NotoNaskhArabic-Bold.ttf", import.meta.url).pathname);
  const drawn: { text: string; x: number }[] = [];
  const original = doc.text.bind(doc);
  doc.text = ((text: string, x?: number, y?: number, o?: object) => {
    drawn.push({ text, x: x ?? 0 });
    return original(text, x, y, o);
  }) as typeof doc.text;
  return { doc, drawn };
}

test("pdf: Urdu words go right to left, brackets mirror, numbers and English keep their order", () => {
  const { doc, drawn } = recordingDoc();
  write(doc, "نیلے قلم (۵۰ کا پیک) A4 80gsm", 50, 50, { width: 400 });
  doc.end();
  // Reading order of the words, from the rightmost drawn word to the leftmost.
  const rightToLeft = [...drawn].sort((a, b) => b.x - a.x).map((d) => d.text);
  // "(" opens on the right in right-to-left text, so it is drawn with the ")" glyph; the digits are pre-reversed
  // for the font engine, and "A4 80gsm" is one left-to-right block, so 80gsm sits to the right of A4.
  assert.deepEqual(rightToLeft, ["نیلے", "قلم", ")", "۰۵", "کا", "پیک", "(", "80gsm", "A4"]);
  assert.ok(drawn.every((d) => d.x >= 50 && d.x <= 450));
});

test("pdf: Latin-only text uses the normal path", () => {
  const { doc, drawn } = recordingDoc();
  write(doc, "Stapler heavy duty", 50, 50, { width: 400 });
  doc.end();
  assert.deepEqual(drawn.map((d) => d.text), ["Stapler heavy duty"]);
});
