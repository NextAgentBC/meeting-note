// End-to-end check of the owner's passkey sign-in, in a real browser with a virtual
// authenticator standing in for Face ID / fingerprint. Run it against a fresh local database:
//
//   rm -rf .wrangler/state && npm run dev              (in the project folder, one terminal)
//   cd e2e && npm install && npx playwright install chromium
//   npm test                                           (in e2e/, another terminal)
//
// Environment: BASE (default http://localhost:8787), SETUP_CODE (default local-dev-code,
// matching .dev.vars), PW_CHANNEL=chrome to use the installed Google Chrome, SHOTS=<folder>
// to save screenshots.

import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:8787";
const SETUP_CODE = process.env.SETUP_CODE ?? "local-dev-code";
const SHOTS = process.env.SHOTS;

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

const step = (name) => console.log(`• ${name}`);
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

try {
  step("before setup, the API gives nothing away");
  const stranger = await deviceWithPasskeys(browser);
  await stranger.goto(BASE);
  const refused = await stranger.evaluate(async () => (await fetch("/api/meetings")).status);
  if (refused !== 401) throw new Error(`expected 401 from /api/meetings, got ${refused}`);

  step("the owner sets it up with the setup code and a passkey");
  const owner = await deviceWithPasskeys(browser);
  await owner.goto(BASE);
  await owner.getByRole("heading", { name: "Set up your Meeting Note" }).waitFor();
  await shot(owner, "01-setup");
  await owner.locator("#setupCode").fill(SETUP_CODE);
  await owner.locator("#ownerName").fill("Test Owner");
  await owner.getByRole("button", { name: /Create my passkey/ }).click();
  await owner.getByText("No recordings yet").waitFor();
  await shot(owner, "02-dashboard");

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

  step("the session runs out mid-use: a banner offers to sign in again, in place");
  await owner.context().clearCookies();
  await owner.getByRole("button", { name: "Refresh" }).click();
  await owner.getByRole("button", { name: "Sign in again" }).waitFor();
  await shot(owner, "03-reauth-banner");
  await owner.getByRole("button", { name: "Sign in again" }).click();
  await owner.locator("#reauthBanner").waitFor({ state: "hidden" });
  await owner.getByRole("button", { name: "Refresh" }).click();
  await owner.getByText("E2E check").waitFor();

  step("sign out, then back in with nothing but the passkey");
  await owner.getByRole("button", { name: "Sign out" }).click();
  await owner.getByRole("heading", { name: "Sign in" }).waitFor();
  await shot(owner, "04-sign-in");
  await owner.getByRole("button", { name: /Sign in with your passkey/ }).click();
  await owner.getByText("E2E check").waitFor();

  step("a lost device: the setup code puts a new passkey on a new device");
  const ownerNewDevice = await deviceWithPasskeys(browser);
  await ownerNewDevice.goto(BASE);
  await ownerNewDevice.getByRole("button", { name: "Lost your passkey? Use your setup code" }).click();
  await ownerNewDevice.locator("#recoverCode").fill(SETUP_CODE);
  await ownerNewDevice.getByRole("button", { name: /Replace my passkey/ }).click();
  await ownerNewDevice.getByText("E2E check").waitFor();

  step("the old device is signed out, and its passkey no longer works");
  await owner.reload();
  await owner.getByRole("button", { name: /Sign in with your passkey/ }).click();
  await owner.getByText("isn't registered here").waitFor();

  console.log("All Meeting Note sign-in flows passed.");
} catch (error) {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
