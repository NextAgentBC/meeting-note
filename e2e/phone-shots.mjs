// Screenshots of every tab at phone size, on a fresh local copy. BASE, SHOTS, PW_CHANNEL as in the other e2e files.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8789";
const SHOTS = process.env.SHOTS ?? ".";
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "America/Vancouver" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("console:", message.text()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(BASE);
  await page.getByRole("heading", { name: "Set up your Meeting Note" }).waitFor();
  await page.locator("#ownerName").fill("Yao");
  await page.getByRole("button", { name: /Create my passkey/ }).click();
  await page.getByRole("button", { name: /I've saved it/ }).click();
  await page.locator("#tabbar").waitFor();
  await page.evaluate(async () => {
    await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Call Cindy about the venue", date: "2026-09-15", time: "15:00" }) });
    await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Pay rent", date: "2026-09-30", status: "suggested" }) });
    await fetch("/api/meetings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Weekly planning", template: "meeting", language: "auto" }) });
  });
  for (const [tab, name] of [["#/meetings", "1-meetings"], ["#/plans", "2-plans"], ["#/memory", "3-memory"], ["#/me", "4-me"]]) {
    await page.evaluate((hash) => { location.hash = hash; }, tab);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
    console.log("shot", name, await page.locator("#viewTitle").innerText());
  }
  await page.evaluate(() => { location.hash = "#/meetings"; });
  await page.waitForTimeout(700);
  await page.locator(".meeting-row").first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/5-meeting.png` });
  console.log("meeting title:", await page.locator("#viewTitle").innerText(), "back visible:", await page.locator("#backButton").isVisible());
  await page.locator("#backButton").click();
  await page.waitForTimeout(500);
  console.log("after back:", await page.locator("#viewTitle").innerText());
  await page.evaluate(() => { location.hash = "#/me"; });
  await page.getByRole("button", { name: /Add a phone or computer/ }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/6-add-device-sheet.png` });
} finally {
  await browser.close();
}
