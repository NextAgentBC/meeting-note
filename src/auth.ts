import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { Hono, type Context, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { renderSVG } from "uqr";
import { z } from "zod";
import type { Env } from "./types";

// Meeting Note has exactly one user: whoever deployed it. They sign in with a passkey
// (Face ID, a fingerprint or the screen lock). There are no passwords to leak, and no
// Cloudflare Access, which would need a card on file. Checking a passkey signature takes
// well under a millisecond, so it fits the free plan's 10 ms of CPU per request.
//
// Nothing needs choosing at deploy time. The first person to open a fresh copy claims it,
// straight after installing, and is shown a recovery code once. That code (or a SETUP_CODE
// secret, for anyone who configures one) is the way back in after losing every device.

type AppContext = Context<{ Bindings: Env }>;

const SESSION_DAYS = 30;
const CHALLENGE_TTL_MS = 5 * 60_000;
/** How long a link for adding a phone or computer works. */
const DEVICE_LINK_TTL_MS = 10 * 60_000;
const COOKIE = "session";
const encoder = new TextEncoder();

class AuthError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string) {
    super(message);
  }
}

function fail(status: ContentfulStatusCode, code: string, message: string): never {
  throw new AuthError(status, code, message);
}

// ── Small crypto helpers ─────────────────────────────────────────────────────

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two secrets without leaking, through timing, how much of them matched. */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

// Crockford base32: no I, L, O or U, so a code copied by hand or read aloud survives.
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 characters, 80 random bits, shown as XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(16);
  let code = "";
  for (let i = 0; i < bytes.length; i += 1) {
    code += RECOVERY_ALPHABET[bytes[i] % 32]; // 256 is a multiple of 32, so there is no bias
    if (i % 4 === 3 && i < bytes.length - 1) code += "-";
  }
  return code;
}

/** Forgives how a person types it back: case, spaces, dashes, and O/I/L for 0/1. */
export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

async function recoveryHash(code: string): Promise<string> {
  return sha256Hex(normalizeRecoveryCode(code));
}

// ── Sessions ─────────────────────────────────────────────────────────────────

interface OwnerRow {
  id: string;
  name: string;
  webauthn_user_id: string;
  recovery_hash?: string | null;
}

function isHttps(c: AppContext): boolean {
  return new URL(c.req.url).protocol === "https:";
}

// Over https the cookie is named __Host-session, so browsers insist it is Secure,
// Path=/ and tied to this exact host. Plain http only happens on your own machine.
function cookiePrefix(c: AppContext): "host" | undefined {
  return isHttps(c) ? "host" : undefined;
}

async function startSession(c: AppContext, ownerId: string): Promise<void> {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), ownerId, now + SESSION_DAYS * 86_400_000, now)
    .run();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
    prefix: cookiePrefix(c)
  });
}

async function ownerForSession(c: AppContext): Promise<OwnerRow | null> {
  const token = getCookie(c, COOKIE, cookiePrefix(c));
  if (!token) return null;
  return c.env.DB.prepare(
    "SELECT o.id, o.name, o.webauthn_user_id FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256Hex(token), Date.now()).first<OwnerRow>();
}

async function ownerForIntegrationToken(c: AppContext): Promise<OwnerRow | null> {
  const authorization = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(mn_[A-Za-z0-9_-]{20,})$/i.exec(authorization);
  if (!match) return null;

  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.webauthn_user_id, t.id AS token_id, t.last_used_at
       FROM integration_tokens t
       JOIN owners o ON o.id = t.owner_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL`
  ).bind(await sha256Hex(match[1])).first<OwnerRow & { token_id: string; last_used_at: number | null }>();
  if (!row) return null;

  // Keep the timestamp useful without spending a D1 write on every polling request.
  if (row.last_used_at === null || row.last_used_at < now - 60 * 60_000) {
    await c.env.DB.prepare("UPDATE integration_tokens SET last_used_at = ? WHERE id = ?")
      .bind(now, row.token_id).run();
  }
  return { id: row.id, name: row.name, webauthn_user_id: row.webauthn_user_id };
}

async function currentOwner(db: D1Database): Promise<OwnerRow | null> {
  return db.prepare("SELECT id, name, webauthn_user_id, recovery_hash FROM owners LIMIT 1").first<OwnerRow>();
}

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * Anything that changes data must come from a page on this site. Browsers always send the
 * Origin header on such requests and another site can't fake it, which stops a malicious
 * page from acting in the signed-in owner's name.
 */
export async function sameOriginWrites(c: AppContext, next: Next) {
  const bearer = /^Bearer\s+mn_/i.test(c.req.header("authorization") ?? "");
  if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("origin") !== new URL(c.req.url).origin) {
    return c.json({ ok: false, error: "Requests that change data must come from this site.", code: "cross_origin" }, 403);
  }
  return next();
}

/** Every /api route except sign-in and the health check needs the owner's session. */
export async function requireOwner(c: AppContext, next: Next) {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/auth/") || path === "/api/health") return next();
  if (!(await ownerForSession(c)) && !(await ownerForIntegrationToken(c))) {
    return c.json({ ok: false, error: "Sign in with your passkey to continue.", code: "sign_in_required" }, 401);
  }
  return next();
}

// ── Passkey routes ───────────────────────────────────────────────────────────

function relyingParty(c: AppContext) {
  const url = new URL(c.req.url);
  return { rpID: url.hostname, origin: url.origin };
}

async function storeChallenge(db: D1Database, purpose: "register" | "login", challenge: string, payload: object) {
  const id = `chl_${randomToken(12)}`;
  await db.prepare("INSERT INTO challenges (id, purpose, challenge, payload, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, purpose, challenge, JSON.stringify(payload), Date.now() + CHALLENGE_TTL_MS)
    .run();
  return id;
}

/** Challenges are single use: reading one deletes it. */
async function takeChallenge(db: D1Database, id: string, purpose: "register" | "login") {
  const now = Date.now();
  const row = await db.prepare("DELETE FROM challenges WHERE id = ? AND purpose = ? RETURNING challenge, payload, expires_at")
    .bind(id, purpose)
    .first<{ challenge: string; payload: string; expires_at: number }>();
  await db.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(now).run();
  if (!row || row.expires_at < now) fail(400, "challenge_expired", "That took too long. Please try again.");
  return row;
}

async function readBody<T extends z.ZodTypeAny>(c: AppContext, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, "invalid_input", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

const registerBody = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("setup"), setupCode: z.string().max(200).default(""), name: z.string().trim().min(1).max(80) }),
  z.object({ purpose: z.literal("owner-recover"), code: z.string().trim().min(1).max(200) }),
  z.object({ purpose: z.literal("add-device") }),
  z.object({ purpose: z.literal("link-device"), token: z.string().min(20).max(120) })
]);

const verifyBody = z.object({ challengeId: z.string().min(1).max(100), response: z.record(z.string(), z.unknown()) });

interface PendingRegistration {
  purpose: "setup" | "owner-recover" | "add-device" | "link-device";
  webauthnUserId: string;
  ownerId?: string;
  name?: string;
  /** SHA-256 of the device link being used, for link-device. */
  linkHash?: string;
}

async function credentialsToExclude(db: D1Database, ownerId: string) {
  const { results } = await db.prepare("SELECT id, transports FROM credentials WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ id: string; transports: string }>();
  return results.map((row) => ({ id: row.id, transports: JSON.parse(row.transports) as AuthenticatorTransport[] }));
}

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.onError((error, c) => {
  if (error instanceof AuthError) return c.json({ ok: false, error: error.message, code: error.code }, error.status);
  console.error(error);
  return c.json({ ok: false, error: "Something went wrong on our side." }, 500);
});

authRoutes.get("/me", async (c) => {
  const owner = await ownerForSession(c);
  return c.json({
    ok: true,
    signedIn: Boolean(owner),
    name: owner?.name ?? null,
    hasOwner: Boolean(await currentOwner(c.env.DB)),
    setupCodeRequired: Boolean(c.env.SETUP_CODE?.trim())
  });
});

authRoutes.post("/register/options", async (c) => {
  const body = await readBody(c, registerBody);
  const db = c.env.DB;
  let pending: PendingRegistration;
  let exclude: { id: string; transports: AuthenticatorTransport[] }[] = [];

  if (body.purpose === "setup") {
    if (await currentOwner(db)) fail(409, "already_set_up", "This Meeting Note already has an owner.");
    const setupCode = c.env.SETUP_CODE?.trim();
    if (setupCode && !(await secretsMatch(body.setupCode.trim(), setupCode))) {
      fail(403, "wrong_setup_code", "That setup code doesn't match.");
    }
    pending = { purpose: "setup", name: body.name, webauthnUserId: randomToken() };
  } else if (body.purpose === "owner-recover") {
    // The way back in after losing every device: the recovery code shown at setup, or the
    // SETUP_CODE secret if this deployment has one.
    const owner = await currentOwner(db);
    if (!owner) fail(409, "not_set_up", "Nobody has set this app up yet.");
    const setupCode = c.env.SETUP_CODE?.trim();
    const byRecoveryCode = Boolean(owner.recovery_hash) && (await secretsMatch(await recoveryHash(body.code), owner.recovery_hash!));
    const bySetupCode = Boolean(setupCode) && (await secretsMatch(body.code, setupCode!));
    if (!byRecoveryCode && !bySetupCode) fail(403, "wrong_recovery_code", "That recovery code doesn't match.");
    pending = { purpose: "owner-recover", ownerId: owner.id, name: owner.name, webauthnUserId: owner.webauthn_user_id };
  } else if (body.purpose === "link-device") {
    // A new phone or computer, invited by a link from a device that is signed in. The link is
    // checked here and used up when the passkey is saved, so cancelling Face ID doesn't waste it.
    const linkHash = await sha256Hex(body.token);
    const link = await db.prepare(
      "SELECT o.id, o.name, o.webauthn_user_id FROM device_links l JOIN owners o ON o.id = l.owner_id WHERE l.token_hash = ? AND l.expires_at > ?"
    ).bind(linkHash, Date.now()).first<OwnerRow>();
    if (!link) fail(400, "link_expired", "This link has expired or has already been used. Make a new one on your signed-in device.");
    exclude = await credentialsToExclude(db, link.id);
    pending = { purpose: "link-device", ownerId: link.id, name: link.name, webauthnUserId: link.webauthn_user_id, linkHash };
  } else {
    const owner = await ownerForSession(c);
    if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
    exclude = await credentialsToExclude(db, owner.id);
    pending = { purpose: "add-device", ownerId: owner.id, name: owner.name, webauthnUserId: owner.webauthn_user_id };
  }

  const options = await generateRegistrationOptions({
    rpName: "Meeting Note",
    rpID: relyingParty(c).rpID,
    userName: pending.name ?? "owner",
    userDisplayName: pending.name ?? "Owner",
    userID: fromBase64Url(pending.webauthnUserId),
    attestationType: "none",
    excludeCredentials: exclude,
    // "required": the passkey lives on the device, so signing in needs no username at all.
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" }
  });
  const challengeId = await storeChallenge(db, "register", options.challenge, pending);
  return c.json({ ok: true, challengeId, options });
});

authRoutes.post("/register/verify", async (c) => {
  const body = await readBody(c, verifyBody);
  const db = c.env.DB;
  const stored = await takeChallenge(db, body.challengeId, "register");
  const pending = JSON.parse(stored.payload) as PendingRegistration;
  const { rpID, origin } = relyingParty(c);

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false
    });
  } catch (error) {
    fail(400, "passkey_rejected", error instanceof Error ? error.message : "The passkey could not be checked.");
  }
  const info = verification.registrationInfo;
  if (!verification.verified || !info) fail(400, "passkey_rejected", "The passkey could not be checked.");

  const now = Date.now();
  const insertCredential = (ownerId: string) =>
    db.prepare("INSERT INTO credentials (id, owner_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(info.credential.id, ownerId, toBase64Url(info.credential.publicKey), info.credential.counter, JSON.stringify(info.credential.transports ?? []), now);

  let ownerId: string;
  let recoveryCode: string | null = null;
  if (pending.purpose === "setup") {
    ownerId = `own_${randomToken(12)}`;
    recoveryCode = newRecoveryCode();
    try {
      // One transaction: the owner never exists without a passkey.
      await db.batch([
        db.prepare("INSERT INTO owners (id, name, webauthn_user_id, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(ownerId, pending.name, pending.webauthnUserId, await recoveryHash(recoveryCode), now),
        insertCredential(ownerId)
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) fail(409, "already_set_up", "Someone has just claimed this Meeting Note.");
      throw error;
    }
  } else if (pending.purpose === "owner-recover") {
    ownerId = pending.ownerId!;
    recoveryCode = newRecoveryCode();
    // Recovery means the old passkeys are lost or can't be trusted: replace them, sign out
    // everywhere, and retire the code that was just used.
    await db.batch([
      db.prepare("DELETE FROM credentials WHERE owner_id = ?").bind(ownerId),
      db.prepare("DELETE FROM sessions WHERE owner_id = ?").bind(ownerId),
      db.prepare("DELETE FROM device_links WHERE owner_id = ?").bind(ownerId),
      db.prepare("UPDATE owners SET recovery_hash = ? WHERE id = ?").bind(await recoveryHash(recoveryCode), ownerId),
      insertCredential(ownerId)
    ]);
  } else if (pending.purpose === "link-device") {
    // Used up now, whether or not anything below fails: a link works once.
    const link = await db.prepare("DELETE FROM device_links WHERE token_hash = ? AND expires_at > ? RETURNING owner_id")
      .bind(pending.linkHash!, Date.now())
      .first<{ owner_id: string }>();
    if (!link || link.owner_id !== pending.ownerId) {
      fail(400, "link_expired", "This link has expired or has already been used. Make a new one on your signed-in device.");
    }
    ownerId = link.owner_id;
    await insertCredential(ownerId).run();
  } else {
    const owner = await ownerForSession(c);
    if (!owner || owner.id !== pending.ownerId) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
    ownerId = owner.id;
    await insertCredential(ownerId).run();
  }

  await startSession(c, ownerId);
  return c.json({ ok: true, name: pending.name ?? null, recoveryCode });
});

/**
 * A one-time link, and its QR code, for adding a phone or computer. Only a signed-in device can make
 * one. Opening it on the new device lets that device create its own passkey; nothing else changes.
 */
authRoutes.post("/device-link", async (c) => {
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + DEVICE_LINK_TTL_MS;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM device_links WHERE expires_at < ?").bind(now),
    c.env.DB.prepare("INSERT INTO device_links (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), owner.id, expiresAt, now)
  ]);
  const url = `${new URL(c.req.url).origin}/#add-device=${token}`;
  return c.json({ ok: true, url, qrSvg: renderSVG(url, { ecc: "M", border: 2 }), expiresAt: new Date(expiresAt).toISOString() });
});

/**
 * A new recovery code for the signed-in owner, for when the one shown at setup was never saved or has
 * been lost. The old code stops working at once.
 */
authRoutes.post("/recovery-code", async (c) => {
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const recoveryCode = newRecoveryCode();
  await c.env.DB.prepare("UPDATE owners SET recovery_hash = ? WHERE id = ?").bind(await recoveryHash(recoveryCode), owner.id).run();
  return c.json({ ok: true, recoveryCode });
});

const integrationTokenBody = z.object({
  label: z.string().trim().min(1).max(80).default("NextNote")
});

/** List revocable app connections. Secret values are never returned after creation. */
authRoutes.get("/integration-tokens", async (c) => {
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const { results } = await c.env.DB.prepare(
    `SELECT id, label, created_at, last_used_at
       FROM integration_tokens
      WHERE owner_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`
  ).bind(owner.id).all<{ id: string; label: string; created_at: number; last_used_at: number | null }>();
  return c.json({
    ok: true,
    tokens: results.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null
    }))
  });
});

/** Make a token for a native app. The plaintext is shown exactly once. */
authRoutes.post("/integration-tokens", async (c) => {
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const body = await readBody(c, integrationTokenBody);
  const secret = `mn_${randomToken(32)}`;
  const id = `int_${randomToken(12)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO integration_tokens (id, owner_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, owner.id, body.label, await sha256Hex(secret), now).run();
  return c.json({ ok: true, id, label: body.label, token: secret, createdAt: new Date(now).toISOString() }, 201);
});

authRoutes.delete("/integration-tokens/:id", async (c) => {
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const result = await c.env.DB.prepare(
    "UPDATE integration_tokens SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL"
  ).bind(Date.now(), c.req.param("id"), owner.id).run();
  if ((result.meta.changes ?? 0) !== 1) fail(404, "not_found", "That app connection no longer exists.");
  return c.json({ ok: true });
});

authRoutes.post("/login/options", async (c) => {
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(c).rpID,
    userVerification: "preferred",
    allowCredentials: [] // empty: the device offers whichever passkey it holds for this site
  });
  const challengeId = await storeChallenge(c.env.DB, "login", options.challenge, {});
  return c.json({ ok: true, challengeId, options });
});

authRoutes.post("/login/verify", async (c) => {
  const body = await readBody(c, verifyBody);
  const db = c.env.DB;
  const stored = await takeChallenge(db, body.challengeId, "login");
  const response = body.response as unknown as AuthenticationResponseJSON;
  if (typeof response.id !== "string") fail(400, "passkey_rejected", "The passkey could not be checked.");

  const credential = await db.prepare(
    `SELECT c.id, c.public_key, c.counter, c.transports, c.owner_id, o.webauthn_user_id
     FROM credentials c JOIN owners o ON o.id = c.owner_id WHERE c.id = ?`
  ).bind(response.id).first<{ id: string; public_key: string; counter: number; transports: string; owner_id: string; webauthn_user_id: string }>();
  if (!credential) fail(400, "unknown_passkey", "This passkey isn't registered here.");
  if (response.response?.userHandle && response.response.userHandle !== credential.webauthn_user_id) {
    fail(400, "passkey_rejected", "The passkey could not be checked.");
  }

  const { rpID, origin } = relyingParty(c);
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: credential.id,
        publicKey: fromBase64Url(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports) as AuthenticatorTransport[]
      }
    });
  } catch (error) {
    fail(400, "passkey_rejected", error instanceof Error ? error.message : "The passkey could not be checked.");
  }
  if (!verification.verified) fail(400, "passkey_rejected", "The passkey could not be checked.");

  await db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, Date.now(), credential.id)
    .run();
  await startSession(c, credential.owner_id);
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE, cookiePrefix(c));
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, COOKIE, { path: "/", secure: isHttps(c), prefix: cookiePrefix(c) });
  return c.json({ ok: true });
});
