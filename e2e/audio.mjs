// End-to-end check of the vocabulary and the permanent recording: saving the vocabulary from Me, a real
// recorded chunk transcribed with it, the Recording sheet (kept, downloaded byte for byte, keep off and on
// again, deleted). It claims a fresh copy, so start from an empty database, with a RECORDINGS binding:
//
//   rm -rf .wrangler/state && npx wrangler d1 migrations apply DB --local -c <config with RECORDINGS>
//   npx wrangler dev -c <config with RECORDINGS> --port 8791   (not --local: transcription needs Workers AI)
//
//   cd e2e && BASE=http://localhost:8791 AUDIO_FILE=/path/to/a-3-minute-chunk.webm node audio.mjs
//
// AUDIO_FILE should be a real browser recording (WebM/Opus), ideally speech with product names in it.
// SHOTS=<folder> saves screenshots of the two sheets at phone size.

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:8791";
const AUDIO_FILE = process.env.AUDIO_FILE;
const SHOTS = process.env.SHOTS;
const VOCABULARY = ["水光", "灌注", "6cc", "菲洛嘉", "NCTF 135HA", "NAD+", "三文鱼水光", "外泌体", "Redensity 1", "丽珠兰", "Rejuran", "tone-up booster", "PDRN", "skin booster", "Promoitalia", "Advanced Collagen Matrix", "Restylane Skinbooster Vital", "瑞蓝唯瑅", "PLLA", "童颜水光", "肉毒素"];

const step = (name) => console.log(`• ${name}`);
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function shot(page, name) {
  if (!SHOTS) return;
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 15_000, animations: "disabled" });
  } catch (error) {
    console.warn(`  (screenshot ${name} skipped: ${error.message.split("\n")[0]})`);
  }
}

if (!AUDIO_FILE) throw new Error("Set AUDIO_FILE to a recorded WebM chunk.");
const audioBytes = await readFile(AUDIO_FILE);
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

try {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Vancouver", viewport: { width: 430, height: 932 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("  page error:", error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
  });

  step("claim the fresh copy");
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Set up your Meeting Note" }).waitFor();
  await page.locator("#ownerName").fill("Audio Tester");
  await page.getByRole("button", { name: /Create my passkey/ }).click();
  await page.getByRole("button", { name: /I've saved it/ }).click();
  await page.locator("#tabbar").waitFor();
  const tab = async (name) => {
    await page.locator(`#tabbar a[data-tab="${name.toLowerCase()}"]`).click();
    await page.waitForFunction((title) => document.querySelector("#viewTitle")?.textContent === title, name);
  };

  step("the vocabulary is saved from Me, and the footnote says recordings are kept");
  await tab("Me");
  await page.locator("#vocabularyRow").click();
  await page.locator("#vocabularyInput").fill(`${VOCABULARY.join("\n")}\n丽珠兰`);
  await page.locator("#saveVocabulary").click();
  await page.locator("#vocabularyStatus", { hasText: `Saved ${VOCABULARY.length} terms` }).waitFor();
  expect((await page.locator("#vocabularyInput").inputValue()).split("\n").length === VOCABULARY.length, "the duplicate term wasn't dropped");
  await shot(page, "01-vocabulary");
  await page.locator("#closeVocabularyDialog").click();
  expect((await page.locator("#vocabularySummary").innerText()).startsWith(`${VOCABULARY.length} terms`), "Me doesn't show the vocabulary count");
  expect((await page.locator("#privacyFootnote").innerText()).includes("kept until you delete"), "the footnote still says audio deletes itself");

  step("a real recorded chunk is uploaded and transcribed with the vocabulary");
  const meetingId = await page.evaluate(async ({ base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const created = await fetch("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Audio archive test", template: "meeting", language: "auto" })
    }).then((r) => r.json());
    const id = created.meeting.id;
    const upload = await fetch(`/api/meetings/${id}/chunks/0`, { method: "PUT", headers: { "content-type": "audio/webm", "x-duration-ms": "180000" }, body: bytes });
    if (!upload.ok) throw new Error(`upload failed: ${upload.status}`);
    await fetch(`/api/meetings/${id}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedChunks: 1 }) });
    return id;
  }, { base64: audioBytes.toString("base64") });

  const deadline = Date.now() + 6 * 60_000;
  let data = {};
  while (Date.now() < deadline) {
    await page.waitForTimeout(4000);
    data = await page.evaluate(async (id) => (await fetch(`/api/meetings/${id}`)).json(), meetingId);
    if (data.meeting?.status === "ready" || data.meeting?.summaryStatus === "failed") break;
  }
  expect(data.meeting?.status === "ready", `the meeting didn't finish: ${data.meeting?.status} / ${data.meeting?.summaryStatus} ${data.meeting?.lastError ?? ""}`);
  const transcript = data.chunks[0].transcript ?? "";
  console.log(`  transcript (${transcript.length} chars): ${transcript.slice(0, 400)}…`);
  console.log(`  vocabulary found: ${VOCABULARY.filter((term) => transcript.toLowerCase().includes(term.toLowerCase())).join(", ") || "(none)"}`);
  expect(transcript.length > 100, "the transcript is nearly empty");
  expect(!/([^\s\d]{1,4}?)(?:[\s。，,.、?？!！]*\1){5,}/u.test(transcript), "a decoding loop survived into the transcript");
  expect(!/[Ѐ-ӿ]/.test(transcript), "Cyrillic text in a Mandarin/English transcript");

  step("the Recording sheet shows the part as kept, and it downloads byte for byte");
  await page.goto(`${BASE}/#/meetings/${meetingId}`);
  await page.locator("#audioButton").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#audioButton").click();
  await page.locator("#audioStatus", { hasText: "Kept permanently" }).waitFor();
  await page.locator("#audioParts .audio-part audio").first().waitFor();
  const download = await page.evaluate(async (id) => {
    const response = await fetch(`/api/meetings/${id}/audio/0`);
    return { status: response.status, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), size: (await response.arrayBuffer()).byteLength };
  }, meetingId);
  console.log(`  download: ${JSON.stringify(download)}`);
  expect(download.status === 200 && download.size === audioBytes.length, `the part didn't download intact: ${JSON.stringify(download)}`);
  expect(download.disposition?.startsWith("attachment;") && download.disposition.includes("filename*=UTF-8''"), "no attachment filename");
  await shot(page, "02-recording-sheet");

  const reopenUntil = async (text) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await page.locator("#audioStatus").innerText()).includes(text)) return;
      await page.locator("#closeAudioDialog").click();
      await page.waitForTimeout(3000);
      await page.locator("#audioButton").click();
      await page.waitForFunction(() => document.querySelector("#audioStatus")?.textContent !== "Loading…");
    }
    throw new Error(`the Recording sheet never said "${text}"; it says "${await page.locator("#audioStatus").innerText()}"`);
  };

  step("Keep off deletes the permanent copy; Keep on copies it back from KV");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#keepAudioToggle").uncheck();
  await page.locator("#audioStatus", { hasText: "Temporary" }).waitFor();
  await page.locator("#keepAudioToggle").check();
  await reopenUntil("all 1 part saved");

  step("deleting the audio keeps the transcript, and the part can't be fetched any more");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#deleteAudioButton").click();
  await page.locator("#audioStatus", { hasText: "was deleted" }).waitFor();
  const after = await page.evaluate(async (id) => ({
    part: (await fetch(`/api/meetings/${id}/audio/0`)).status,
    transcript: ((await (await fetch(`/api/meetings/${id}`)).json()).chunks[0].transcript ?? "").length
  }), meetingId);
  expect(after.part === 410, `a deleted part still answers ${after.part}`);
  expect(after.transcript > 100, "deleting the audio lost the transcript");
  await shot(page, "03-deleted");

  console.log("✓ vocabulary and permanent recording work end to end");
} finally {
  await browser.close();
}
