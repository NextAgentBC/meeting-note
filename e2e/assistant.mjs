// End-to-end check of plans: typing and dictating them, checking suggestions, editing, the .ics
// file and the private calendar feed. It claims a fresh copy first, so start from an empty database:
//
//   rm -rf .wrangler/state && npm run db:local && npx wrangler dev --port 8789
//   (not --local: dictation needs Workers AI, which only runs in Cloudflare; everything else stays local)
//
//   cd e2e && BASE=http://localhost:8789 DICTATION_WAV=/path/to/spoken-plan.wav node assistant.mjs
//
// DICTATION_WAV plays as the microphone (16-bit PCM WAV). Without it, the dictation step is skipped.
// MEETING_WAV is uploaded as a one-chunk meeting that then gets asked about; it should say the talk
// is at the Richmond Public Library (列治文公共图书馆) and that Sam makes the poster.
// PW_CHANNEL=chrome uses the installed Google Chrome; SHOTS=<folder> saves screenshots.

import { chromium, request } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8789";
const WAV = process.env.DICTATION_WAV;
const SHOTS = process.env.SHOTS;

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

const browser = await chromium.launch({
  ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  args: WAV ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`] : []
});

try {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "America/Vancouver",
    viewport: { width: 1280, height: 900 },
    permissions: ["microphone", "clipboard-read", "clipboard-write"]
  });
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
  await page.locator("#ownerName").fill("Plans Tester");
  await page.getByRole("button", { name: /Create my passkey/ }).click();
  await page.getByRole("button", { name: /I've saved it/ }).click();
  await page.getByRole("heading", { name: "Say it, and it goes on your calendar" }).waitFor();

  step("a typed plan with a date and time lands in Coming up, with calendar links");
  await page.locator("#quickAddTitle").fill("Workshop at OCCA");
  await page.locator("#quickAddDate").fill("2026-09-22");
  await page.locator("#quickAddTime").fill("18:30");
  await page.locator("#quickAddForm").getByRole("button", { name: "Add" }).click();
  const workshop = page.locator("#taskList .plan-row", { hasText: "Workshop at OCCA" });
  await workshop.waitFor();
  const google = await workshop.getByRole("link", { name: "Google" }).getAttribute("href");
  expect(google.includes("dates=20260923T013000Z%2F20260923T023000Z"), `unexpected Google link: ${google}`);
  expect((await workshop.locator("small").innerText()).includes("6:30"), "the row doesn't show 6:30 PM");

  step("its .ics file is a real calendar event");
  const icsHref = await workshop.getByRole("link", { name: "Apple · Outlook" }).getAttribute("href");
  const ics = await page.evaluate(async (href) => {
    const response = await fetch(href);
    return { type: response.headers.get("content-type"), text: await response.text() };
  }, icsHref);
  expect(ics.type.startsWith("text/calendar"), `.ics served as ${ics.type}`);
  expect(ics.text.includes("DTSTART:20260923T013000Z") && ics.text.includes("SUMMARY:Workshop at OCCA"), `unexpected .ics:\n${ics.text}`);

  step("editing moves it to 7 PM");
  await workshop.getByRole("button", { name: "Edit" }).click();
  const editor = page.locator(".plan-edit-row");
  await editor.locator('input[name="time"]').fill("19:00");
  await editor.getByRole("button", { name: "Save" }).click();
  await page.locator("#taskList .plan-row", { hasText: "Workshop at OCCA" }).locator("small", { hasText: "7:00" }).waitFor();

  step("a to-do without a date waits under No date yet");
  await page.locator("#quickAddTitle").fill("Buy printer ink");
  await page.locator("#quickAddForm").getByRole("button", { name: "Add" }).click();
  await page.locator(".plan-group", { hasText: "No date yet" }).waitFor();
  await shot(page, "01-plans-typed");

  step("the private calendar feed works without signing in, and can be replaced");
  await page.getByRole("button", { name: "Calendar sync" }).click();
  await page.getByRole("button", { name: /Make my private calendar address/ }).click();
  await page.locator("#feedReady").waitFor();
  const feedUrl = await page.locator("#feedUrl").inputValue();
  expect(/\/cal\/[A-Za-z0-9_-]{40,}\.ics$/.test(feedUrl), `unexpected feed address: ${feedUrl}`);
  expect((await page.locator("#webcalLink").getAttribute("href")).startsWith("webcal://"), "no webcal link");
  await shot(page, "02-calendar-sync");
  const outsider = await request.newContext();
  const feed = await outsider.get(feedUrl);
  const feedText = await feed.text();
  expect(feed.ok() && feedText.includes("SUMMARY:Workshop at OCCA") && !feedText.includes("printer ink"), `unexpected feed (${feed.status()}):\n${feedText}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "replace it" }).click();
  await page.waitForFunction((old) => document.querySelector("#feedUrl").value !== old, feedUrl);
  expect((await outsider.get(feedUrl)).status() === 404, "the replaced feed address still works");
  const newFeedUrl = await page.locator("#feedUrl").inputValue();
  await page.getByRole("button", { name: "Close" }).click();

  step("done, then undone");
  await page.locator("#taskList .plan-row", { hasText: "Workshop at OCCA" }).getByRole("button", { name: "Mark as done" }).click();
  await page.locator(".plan-group", { hasText: "Done" }).waitFor();
  await page.locator("#taskList .plan-row", { hasText: "Workshop at OCCA" }).getByRole("button", { name: "Mark as not done" }).click();
  await page.locator("#taskList .plan-row.confirmed", { hasText: "Workshop at OCCA" }).waitFor();

  step("a suggestion can be dismissed, and never reaches the feed");
  await page.evaluate(async () => {
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Maybe repaint the office", date: "2026-10-03", status: "suggested" })
    });
  });
  await page.reload();
  const suggestion = page.locator("#suggestedList .plan-row", { hasText: "Maybe repaint the office" });
  await suggestion.waitFor();
  expect(!(await outsider.get(newFeedUrl).then((r) => r.text())).includes("repaint"), "a suggestion leaked into the feed");
  await suggestion.getByRole("button", { name: "Dismiss" }).click();
  await suggestion.waitFor({ state: "detached" });

  if (WAV) {
    step("dictation: speak, check the suggestions, add them all");
    await page.getByRole("button", { name: /Tap and say your plans/ }).click();
    await page.getByText("Listening… tap when you're done").waitFor();
    await page.waitForTimeout(Number(process.env.DICTATION_SECONDS ?? 9) * 1000);
    await shot(page, "03-dictating");
    await page.locator("#dictateButton").click();
    await page.locator("#dictateResult").waitFor({ timeout: 90_000 });
    await page.locator("#dictateButton:not([disabled])").waitFor({ timeout: 90_000 });
    console.log(`  heard: ${await page.locator("#dictateTranscript").innerText()}`);
    console.log(`  said: ${await page.locator("#dictateMessage").innerText()}`);
    const suggested = page.locator("#suggestedList .plan-row");
    const count = await suggested.count();
    const lines = [];
    for (let index = 0; index < count; index += 1) {
      const row = suggested.nth(index);
      lines.push(`${await row.locator("strong").innerText()} — ${await row.locator("small").innerText()}`);
    }
    for (const line of lines) console.log(`  suggestion: ${line}`);
    // e.g. DICTATION_EXPECT="Tomorrow · 3:00 PM" for a recording that says 明天下午三点
    if (process.env.DICTATION_EXPECT) expect(lines.some((line) => line.includes(process.env.DICTATION_EXPECT)), `no suggestion shows "${process.env.DICTATION_EXPECT}"`);
    await shot(page, "04-suggestions");
    expect(count > 0, "dictation found no plans");
    if (count > 1) await page.getByRole("button", { name: "Add all" }).click();
    else await suggested.first().getByRole("button", { name: "Add" }).click();
    await page.locator("#suggestedBlock").waitFor({ state: "hidden" });
  }

  step("removing a confirmed plan tells subscribed calendars to drop it");
  await page.locator("#taskList .plan-row", { hasText: "Workshop at OCCA" }).getByRole("button", { name: "Remove" }).click();
  await page.locator("#taskList .plan-row", { hasText: "Workshop at OCCA" }).waitFor({ state: "detached" });
  const cancelledFeed = await outsider.get(newFeedUrl).then((r) => r.text());
  expect(/SUMMARY:Workshop at OCCA[\s\S]*?STATUS:CANCELLED/.test(cancelledFeed), `the feed doesn't mark it cancelled:\n${cancelledFeed}`);
  await shot(page, "05-plans-final");

  if (process.env.MEETING_WAV) {
    step("a recorded meeting is remembered, and Ask answers from it with its sources");
    const { readFile } = await import("node:fs/promises");
    const wav = await readFile(process.env.MEETING_WAV);
    const seconds = Math.round((wav.length - 44) / (wav.readUInt32LE(28) || 32000));
    const meetingId = await page.evaluate(async ({ base64, durationMs }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const created = await fetch("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Weekly planning", template: "meeting", language: "auto" })
      }).then((r) => r.json());
      const id = created.meeting.id;
      await fetch(`/api/meetings/${id}/chunks/0`, { method: "PUT", headers: { "content-type": "audio/wav", "x-duration-ms": String(durationMs) }, body: bytes });
      await fetch(`/api/meetings/${id}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedChunks: 1 }) });
      return id;
    }, { base64: wav.toString("base64"), durationMs: seconds * 1000 });

    const deadline = Date.now() + 5 * 60_000;
    let meeting = {};
    while (Date.now() < deadline) {
      await page.waitForTimeout(4000);
      meeting = (await page.evaluate(async (id) => (await fetch(`/api/meetings/${id}`)).json(), meetingId)).meeting ?? {};
      if (meeting.status === "ready" || meeting.summaryStatus === "failed") break;
    }
    expect(meeting.status === "ready", `the meeting didn't finish: ${meeting.status} / ${meeting.summaryStatus} ${meeting.lastError ?? ""}`);

    const ask = async (question) => {
      await page.locator("#askInput").fill(question);
      await page.locator("#askForm").getByRole("button", { name: "Ask" }).click();
      await page.locator("#askAnswer:not(.thinking)").waitFor({ timeout: 90_000 });
      const answer = await page.locator("#askText").innerText();
      const sources = await page.locator(".ask-source strong").allInnerTexts();
      console.log(`  Q: ${question}\n  A: ${answer.replace(/\n+/g, " ")}\n  sources: ${sources.join(" | ") || "(none)"}`);
      return { answer, sources };
    };

    await page.reload();
    const venue = await ask("讲座的场地定在哪里？");
    expect(/图书馆|library/i.test(venue.answer) && venue.sources.some((s) => s.includes("Weekly planning")), "Ask didn't find the venue in the meeting");
    await shot(page, "07-ask");
    const poster = await ask("Who is doing the poster, and by when?");
    expect(/Sam/i.test(poster.answer), "Ask didn't find who makes the poster");
    await page.locator(".ask-source", { hasText: "Weekly planning" }).first().click();
    await page.locator("#activeMeetingTitle", { hasText: "Weekly planning" }).waitFor();
    await page.getByRole("button", { name: "← All meetings" }).click();
    await page.locator("#askSection").waitFor();

    if (WAV) {
      const tomorrow = await ask("明天有什么安排？");
      expect(/Sindy|Cindy/i.test(tomorrow.answer), "Ask didn't find tomorrow's dictated plan");
    }
  }

  step("the same screen on a phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#plansSection").scrollIntoViewIfNeeded();
  await shot(page, "06-phone");

  await outsider.dispose();
  console.log("All plan flows passed.");
} catch (error) {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
