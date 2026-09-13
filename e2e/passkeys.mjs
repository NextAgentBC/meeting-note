// End-to-end check of the owner's passkey sign-in, in a real browser with a virtual
// authenticator standing in for Face ID / fingerprint. Run it against a fresh local database:
//
//   rm -rf .wrangler/state && npm run dev              (in the project folder, one terminal)
//   cd e2e && npm install && npx playwright install chromium
//   npm test                                           (in e2e/, another terminal)
//
// Environment: BASE (default http://localhost:8787); SETUP_CODE, only if the deployment has that
// secret; PW_CHANNEL=chrome to use the installed Google Chrome; SHOTS=<folder> to save screenshots;
// AUDIO_FILE=<speech.mp3> to send real speech through a deployed copy (Workers AI isn't local).

import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8787";
const SETUP_CODE = process.env.SETUP_CODE ?? "";
const SHOTS = process.env.SHOTS;
const CODE_SHAPE = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/;

async function deviceWithPasskeys(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1200, height: 860 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });
  page.on("pageerror", (error) => console.error("  page error:", error.message));
  return page;
}

// Viewport-sized, and never fatal: the app's large blurred backgrounds make full-page
// captures crawl in headless Chrome, and a screenshot is a convenience, not the test.
async function shot(page, name) {
  if (!SHOTS) return;
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 15_000, animations: "disabled" });
  } catch (error) {
    console.warn(`  (screenshot ${name} skipped: ${error.message.split("\n")[0]})`);
  }
}

/** Reads the recovery code off the screen, checks its shape, and continues into the app. */
async function saveRecoveryCode(page, shotName) {
  await page.getByRole("heading", { name: "Save your recovery code" }).waitFor();
  const code = (await page.locator("#recoveryCode").innerText()).trim();
  if (!CODE_SHAPE.test(code)) throw new Error(`unexpected recovery code: ${code}`);
  await shot(page, shotName);
  await page.getByRole("button", { name: /I've saved it/ }).click();
  return code;
}

const step = (name) => console.log(`• ${name}`);
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

try {
  step("before setup, the API gives nothing away");
  const stranger = await deviceWithPasskeys(browser);
  await stranger.goto(BASE);
  const refused = await stranger.evaluate(async () => (await fetch("/api/meetings")).status);
  if (refused !== 401) throw new Error(`expected 401 from /api/meetings, got ${refused}`);

  step("the owner claims the fresh copy with a passkey and is shown a recovery code");
  const owner = await deviceWithPasskeys(browser);
  await owner.goto(BASE);
  await owner.getByRole("heading", { name: "Set up your Meeting Note" }).waitFor();
  await shot(owner, "01-setup");
  if (await owner.locator("#setupCode").isVisible()) {
    if (!SETUP_CODE) throw new Error("this deployment asks for a setup code: pass SETUP_CODE");
    await owner.locator("#setupCode").fill(SETUP_CODE);
  }
  await owner.locator("#ownerName").fill("Test Owner");
  await owner.getByRole("button", { name: /Create my passkey/ }).click();
  let recoveryCode = await saveRecoveryCode(owner, "02-recovery-code");
  await owner.getByRole("heading", { name: "Your meetings" }).waitFor();
  await shot(owner, "03-dashboard");

  step("nobody else can claim it now");
  await stranger.reload();
  await stranger.getByRole("heading", { name: "Sign in" }).waitFor();

  step("a recorded chunk is accepted and stored");
  const upload = await owner.evaluate(async () => {
    const created = await fetch("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "E2E check", template: "meeting", language: "en" })
    }).then((r) => r.json());
    const id = created.meeting?.id ?? created.id;
    const put = await fetch(`/api/meetings/${id}/chunks/0`, {
      method: "PUT",
      headers: { "content-type": "audio/webm", "x-duration-ms": "1000" },
      body: new Uint8Array(2048)
    });
    return { id, status: put.status, body: await put.text() };
  });
  if (upload.status !== 201) throw new Error(`chunk upload returned ${upload.status}: ${upload.body}`);
  console.log(`  meeting ${upload.id}: chunk stored`);

  if (process.env.AUDIO_FILE) {
    step("real speech comes back as a transcript and a note");
    const { readFile } = await import("node:fs/promises");
    const base64 = (await readFile(process.env.AUDIO_FILE)).toString("base64");
    const type = process.env.AUDIO_FILE.endsWith(".mp3") ? "audio/mpeg" : process.env.AUDIO_FILE.endsWith(".wav") ? "audio/wav" : "audio/webm";
    const meetingId = await owner.evaluate(async ({ base64, type }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const created = await fetch("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Real audio check", template: "meeting", language: "auto" })
      }).then((r) => r.json());
      const id = created.meeting.id;
      await fetch(`/api/meetings/${id}/chunks/0`, { method: "PUT", headers: { "content-type": type, "x-duration-ms": "20000" }, body: bytes });
      await fetch(`/api/meetings/${id}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedChunks: 1 })
      });
      return id;
    }, { base64, type });

    const deadline = Date.now() + 5 * 60_000;
    let detail = {};
    do {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      detail = await owner.evaluate(async (id) => (await fetch(`/api/meetings/${id}`)).json(), meetingId);
    } while (Date.now() < deadline && !detail.meeting?.summaryMarkdown && detail.meeting?.status !== "failed");

    const chunk = detail.chunks?.[0] ?? {};
    const transcript = Object.entries(chunk)
      .filter(([key, value]) => /transcript/i.test(key) && typeof value === "string")
      .map(([, value]) => value)
      .join(" ")
      .trim();
    console.log(`  transcript: ${transcript.slice(0, 240)}`);
    console.log(`  note: ${(detail.meeting?.summaryMarkdown ?? "(none yet)").slice(0, 400).replace(/\n+/g, " ⏎ ")}`);
    if (!transcript) throw new Error(`no transcript: status ${detail.meeting?.status}, note ${detail.meeting?.summaryStatus}`);

    step("the note can be written again from the saved transcript");
    const rebuilt = await owner.evaluate(async (id) => (await fetch(`/api/meetings/${id}/rebuild-note`, { method: "POST" })).status, meetingId);
    if (rebuilt !== 200) throw new Error(`rebuild-note returned ${rebuilt}`);
    const again = Date.now() + 5 * 60_000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      detail = await owner.evaluate(async (id) => (await fetch(`/api/meetings/${id}`)).json(), meetingId);
    } while (Date.now() < again && detail.meeting?.status !== "ready");
    if (!detail.meeting?.summaryMarkdown) throw new Error(`the rewritten note never arrived: ${detail.meeting?.status}`);
    console.log(`  rewritten note: ${detail.meeting.summaryMarkdown.slice(0, 160).replace(/\n+/g, " ⏎ ")}`);
  }

  step("the session runs out mid-use: a banner offers to sign in again, in place");
  await owner.context().clearCookies();
  await owner.getByRole("button", { name: "Refresh" }).click();
  await owner.getByRole("button", { name: "Sign in again" }).waitFor();
  await shot(owner, "04-reauth-banner");
  await owner.getByRole("button", { name: "Sign in again" }).click();
  await owner.locator("#reauthBanner").waitFor({ state: "hidden" });
  await owner.getByRole("button", { name: "Refresh" }).click();
  await owner.getByText("E2E check").waitFor();

  step("sign out, then back in with nothing but the passkey");
  await owner.getByRole("link", { name: "Me", exact: true }).click();
  await owner.getByRole("button", { name: "Sign out" }).click();
  await owner.getByRole("heading", { name: "Sign in" }).waitFor();
  await shot(owner, "05-sign-in");
  await owner.getByRole("button", { name: /Sign in with your passkey/ }).click();
  await owner.getByText("E2E check").waitFor();

  step("a phone joins through Add device, and the first device keeps working");
  await owner.getByRole("link", { name: "Me", exact: true }).click();
  await owner.getByRole("button", { name: /Add a phone or computer/ }).click();
  await owner.waitForFunction(() => document.querySelector("#deviceLink")?.value.includes("#add-device="));
  const deviceLink = await owner.locator("#deviceLink").inputValue();
  if (!(await owner.locator("#deviceQr svg").count())) throw new Error("no QR code for the device link");
  await shot(owner, "06-add-device");
  const phone = await deviceWithPasskeys(browser);
  await phone.goto(deviceLink);
  await phone.getByRole("heading", { name: "Add this device" }).waitFor();
  if (phone.url().includes("add-device")) throw new Error("the link's token was left in the address bar");
  await phone.getByRole("button", { name: /Add this device/ }).click();
  await phone.getByText("E2E check").waitFor();
  await owner.getByRole("button", { name: "Close" }).click();

  step("the link works only once");
  const latecomer = await deviceWithPasskeys(browser);
  await latecomer.goto(deviceLink);
  await latecomer.getByRole("button", { name: /Add this device/ }).click();
  await latecomer.getByText("expired or has already been used").waitFor();

  step("a signed-in device makes a new recovery code, and the old one stops working");
  await owner.getByRole("button", { name: /Recovery code/ }).click();
  owner.once("dialog", (dialog) => dialog.accept());
  await owner.getByRole("button", { name: "Make a new recovery code" }).click();
  await owner.locator("#newRecoveryCodeValue:not(.hidden)").waitFor();
  const replacedCode = recoveryCode;
  recoveryCode = (await owner.locator("#newRecoveryCodeValue").innerText()).trim();
  if (!CODE_SHAPE.test(recoveryCode) || recoveryCode === replacedCode) throw new Error(`unexpected new recovery code: ${recoveryCode}`);
  await owner.getByRole("button", { name: "Close" }).click();
  const staleCode = await owner.evaluate(async (code) => (await fetch("/api/auth/register/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purpose: "owner-recover", code })
  })).status, replacedCode);
  if (staleCode !== 403) throw new Error(`the replaced recovery code still worked (${staleCode})`);

  step("both devices sign in with their own passkeys");
  await phone.getByRole("link", { name: "Me", exact: true }).click();
  await phone.getByRole("button", { name: "Sign out" }).click();
  await phone.getByRole("button", { name: /Sign in with your passkey/ }).click();
  await phone.getByText("E2E check").waitFor();
  await owner.goto(BASE);
  await owner.getByText("E2E check").waitFor();

  step("a lost device: the recovery code, typed loosely, puts a new passkey on a new device");
  const ownerNewDevice = await deviceWithPasskeys(browser);
  await ownerNewDevice.goto(BASE);
  await ownerNewDevice.getByRole("button", { name: /Lost every device/ }).click();
  await ownerNewDevice.locator("#recoverCode").fill(recoveryCode.toLowerCase().replace(/-/g, " "));
  await ownerNewDevice.getByRole("button", { name: /Replace my passkey/ }).click();
  const newRecoveryCode = await saveRecoveryCode(ownerNewDevice, "06-new-recovery-code");
  if (newRecoveryCode === recoveryCode) throw new Error("the recovery code was not replaced");
  await ownerNewDevice.getByText("E2E check").waitFor();

  step("the old devices are signed out, and their passkeys no longer work");
  await owner.reload();
  await owner.getByRole("button", { name: /Sign in with your passkey/ }).click();
  await owner.getByText("isn't registered here").waitFor();
  await phone.reload();
  await phone.getByRole("button", { name: /Sign in with your passkey/ }).click();
  await phone.getByText("isn't registered here").waitFor();

  step("a used recovery code doesn't work twice");
  const intruder = await deviceWithPasskeys(browser);
  await intruder.goto(BASE);
  await intruder.getByRole("button", { name: /Lost every device/ }).click();
  await intruder.locator("#recoverCode").fill(recoveryCode);
  await intruder.getByRole("button", { name: /Replace my passkey/ }).click();
  await intruder.getByText("doesn't match").waitFor();

  console.log("All Meeting Note sign-in flows passed.");
} catch (error) {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
