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
// straight after installing, and is shown a recovery code once. That code is the way back in
// after losing every device; a SETUP_CODE opens the copy once, for a claim or a recovery (see
// "Setup codes open a copy once" below).

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

/**
 * A new session, written in the same batch as whatever authorises it: otherwise a sign-in whose
 * check passed a moment before a recovery could add its session after the recovery signed
 * everyone out. The cookie is set only once that batch has committed.
 */
async function newSession(db: D1Database, ownerId: string) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 86_400_000;
  return {
    token,
    insert: db.prepare("INSERT INTO sessions (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(tokenHash, ownerId, expiresAt, now),
    /** The same row, written only while this passkey still belongs to the owner. */
    insertIfPasskey: (credentialId: string) =>
      db.prepare("INSERT INTO sessions (token_hash, owner_id, expires_at, created_at) SELECT ?, owner_id, ?, ? FROM credentials WHERE id = ? AND owner_id = ?")
        .bind(tokenHash, expiresAt, now, credentialId, ownerId)
  };
}

function setSessionCookie(c: AppContext, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
    prefix: cookiePrefix(c)
  });
}

/**
 * Rows a statement changed, as D1 reports it. Callers test for zero rather than one: D1 derives this
 * from total_changes(), which also counts rows a trigger writes.
 */
function changed(result: D1Result | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

async function currentSessionHash(c: AppContext): Promise<string> {
  const token = getCookie(c, COOKIE, cookiePrefix(c));
  return token ? sha256Hex(token) : "";
}

async function ownerForSession(c: AppContext): Promise<OwnerRow | null> {
  const token = getCookie(c, COOKIE, cookiePrefix(c));
  if (!token) return null;
  return c.env.DB.prepare(
    "SELECT o.id, o.name, o.webauthn_user_id FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256Hex(token), Date.now()).first<OwnerRow>();
}

/**
 * The installer this copy asks about new releases, or "" to ask nobody. "off" is the owner's
 * opt-out, and the installer's updates keep it (installer/src/provision.ts upgradeInstall).
 */
export function updateChannel(env: Pick<Env, "UPDATE_CHANNEL">): string {
  const channel = (env.UPDATE_CHANNEL || "").trim();
  return channel.toLowerCase() === "off" ? "" : channel;
}

/** True only where the owner has connected their own desktop app; see Env.NEXTNOTE. */
export function nextNoteEnabled(env: { NEXTNOTE?: string }): boolean {
  const setting = (env.NEXTNOTE || "").trim().toLowerCase();
  return setting !== "" && setting !== "off" && setting !== "false" && setting !== "0";
}

async function ownerForIntegrationToken(c: AppContext): Promise<OwnerRow | null> {
  if (!nextNoteEnabled(c.env)) return null;
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
  /** SHA-256 of the setup code this registration spends, for setup or owner-recover. */
  setupCodeHash?: string;
  /** The owner's recovery_hash when the recovery code opened this owner-recover; spent with it. */
  recoveryCodeHash?: string;
}

// ── A code opens a copy once ─────────────────────────────────────────────────
// Every setup code and recovery code is spent, in spent_codes, by the claim or recovery it opens.
// The installer shows a new copy's SETUP_CODE as a claim link, and links end up in chats, so on a
// copy it made a setup code recovers nothing unless the installer granted it in the last day: a
// grant row it writes for the Cloudflare account owner who just signed in there. A copy deployed by
// hand has no installer, and its owner types a code they set themselves.

const GRANT_TTL_MS = 24 * 60 * 60_000;

/**
 * Only the installer's bundle runs src/standalone.ts, which sets INSTALLER_COPY. Not a variable the
 * owner configures: UPDATE_CHANNEL was used for this once, and deleting it (to stop the update
 * check) turned an old claim link back into a way in.
 */
function installerMade(env: Env): boolean {
  return env.INSTALLER_COPY === "1";
}

/** A copy whose schema update has not landed yet says so, instead of failing with a 500. */
function rethrowMissingTables(error: unknown): never {
  if (String(error).includes("no such table")) {
    fail(503, "update_pending", "This app is finishing an update. Try again in a minute.");
  }
  throw error;
}

async function codeTables<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    rethrowMissingTables(error);
  }
}

function codeSpent(db: D1Database, codeHash: string): Promise<boolean> {
  return codeTables(async () => Boolean(await db.prepare("SELECT 1 FROM spent_codes WHERE code_hash = ?").bind(codeHash).first()));
}

function setupCodeGranted(db: D1Database, codeHash: string): Promise<boolean> {
  return codeTables(async () => Boolean(
    await db.prepare("SELECT 1 FROM setup_code_grants WHERE code_hash = ? AND granted_at > ?")
      .bind(codeHash, Date.now() - GRANT_TTL_MS)
      .first()
  ));
}

/** Part of the batch that finishes the claim or recovery: a second use of the code fails on the key. */
function spendCode(db: D1Database, codeHash: string) {
  return db.prepare("INSERT INTO spent_codes (code_hash, used_at) VALUES (?, ?)").bind(codeHash, Date.now());
}

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first());
}

// Once there, the grants table stays: after the first yes this isolate stops asking, so a flood of
// unauthenticated /me requests does not read the schema every time. Keyed by the binding, which a
// Worker gets as the same object on every request.
const grantsTableSeen = new WeakSet<D1Database>();
async function grantsReady(db: D1Database): Promise<boolean> {
  if (!grantsTableSeen.has(db) && (await tableExists(db, "setup_code_grants"))) grantsTableSeen.add(db);
  return grantsTableSeen.has(db);
}

// ── Attempt limits ───────────────────────────────────────────────────────────
// The sign-in routes answer anyone. Counted per address, a flood cannot spend the free plan's
// database writes on challenges, and nobody gets more than a few guesses at a code. A refused
// request writes nothing. The count and the record are separate statements, so a burst of parallel
// requests can overshoot a limit once; codes are 80 bits, so the limit is a brake, not the lock.

const ATTEMPT_WINDOW_MS = 15 * 60_000;
const ATTEMPT_LIMITS = { challenge: 30, code: 10 } as const;
type AttemptKind = keyof typeof ATTEMPT_LIMITS;

/** An IPv4 address as it is; an IPv6 address by its /64, the block one host usually controls. */
export function addressBucket(address: string): string {
  const v4 = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!address.includes(":")) return address;
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

async function attemptKey(c: AppContext): Promise<string> {
  const address = c.req.header("cf-connecting-ip") || "local";
  return sha256Hex(`attempt:${addressBucket(address)}`);
}

// Both fail open: a copy whose schema update has not landed yet must still let its owner sign in.
async function checkAttempts(c: AppContext, key: string, kind: AttemptKind): Promise<void> {
  let count = 0;
  try {
    const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip_hash = ? AND kind = ? AND at > ?")
      .bind(key, kind, Date.now() - ATTEMPT_WINDOW_MS)
      .first<{ n: number }>();
    count = row?.n ?? 0;
  } catch (error) {
    console.error("Sign-in attempts could not be counted", error);
  }
  if (count >= ATTEMPT_LIMITS[kind]) {
    fail(429, "too_many_attempts", "Too many attempts from this network. Wait a few minutes and try again.");
  }
}

async function recordAttempt(db: D1Database, key: string, kind: AttemptKind): Promise<void> {
  const now = Date.now();
  try {
    await db.batch([
      db.prepare("DELETE FROM auth_attempts WHERE at < ?").bind(now - 60 * 60_000),
      db.prepare("INSERT INTO auth_attempts (ip_hash, kind, at) VALUES (?, ?, ?)").bind(key, kind, now)
    ]);
  } catch (error) {
    console.error("Sign-in attempt could not be recorded", error);
  }
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
    setupCodeRequired: Boolean(c.env.SETUP_CODE?.trim()),
    // Tells the installer this copy spends codes and honours recovery grants, so a code it hands
    // out opens the app once and never again. False until the schema update that brings the
    // tables has landed, so the installer does not write a grant nowhere.
    recoveryGrants: await grantsReady(c.env.DB),
    // Where a lost setup code can be replaced: the installer that provisioned this copy.
    installer: updateChannel(c.env),
    // The Connected apps row stays out of the Me tab everywhere this is off.
    nextNote: nextNoteEnabled(c.env)
  });
});

authRoutes.post("/register/options", async (c) => {
  const body = await readBody(c, registerBody);
  const db = c.env.DB;
  const key = await attemptKey(c);
  await checkAttempts(c, key, "challenge");
  let pending: PendingRegistration;
  let exclude: { id: string; transports: AuthenticatorTransport[] }[] = [];

  if (body.purpose === "setup") {
    if (await currentOwner(db)) fail(409, "already_set_up", "This Meeting Note already has an owner.");
    const setupCode = c.env.SETUP_CODE?.trim();
    let setupCodeHash: string | undefined;
    if (setupCode) {
      await checkAttempts(c, key, "code");
      if (!(await secretsMatch(body.setupCode.trim(), setupCode))) {
        await recordAttempt(db, key, "code");
        fail(403, "wrong_setup_code", "That setup code doesn't match.");
      }
      setupCodeHash = await sha256Hex(setupCode);
      if (await codeSpent(db, setupCodeHash)) fail(403, "setup_code_used", "This setup code has already been used.");
    }
    pending = { purpose: "setup", name: body.name, webauthnUserId: randomToken(), setupCodeHash };
  } else if (body.purpose === "owner-recover") {
    // The way back in after losing every device: the recovery code shown at setup, or an unused
    // SETUP_CODE — on an installer's copy, only one the installer granted, never the claim code.
    const owner = await currentOwner(db);
    if (!owner) fail(409, "not_set_up", "Nobody has set this app up yet.");
    await checkAttempts(c, key, "code");
    const setupCode = c.env.SETUP_CODE?.trim();
    const byRecoveryCode = Boolean(owner.recovery_hash) && (await secretsMatch(await recoveryHash(body.code), owner.recovery_hash!));
    const bySetupCode = !byRecoveryCode && Boolean(setupCode) && (await secretsMatch(body.code, setupCode!));
    if (!byRecoveryCode && !bySetupCode) {
      await recordAttempt(db, key, "code");
      fail(403, "wrong_recovery_code", "That recovery code doesn't match.");
    }
    const setupCodeHash = bySetupCode ? await sha256Hex(setupCode!) : undefined;
    if (setupCodeHash && (await codeSpent(db, setupCodeHash))) {
      await recordAttempt(db, key, "code");
      fail(403, "setup_code_used", installerMade(c.env)
        ? "That code has already been used. Make a new recovery link in the installer."
        : "That code has already been used. Set a new SETUP_CODE secret and try again.");
    }
    if (setupCodeHash && installerMade(c.env) && !(await setupCodeGranted(db, setupCodeHash))) {
      await recordAttempt(db, key, "code");
      fail(403, "setup_code_not_granted", "That code can't recover this app. Make a recovery link in the installer; each one works once, within a day.");
    }
    pending = {
      purpose: "owner-recover",
      ownerId: owner.id,
      name: owner.name,
      webauthnUserId: owner.webauthn_user_id,
      setupCodeHash,
      recoveryCodeHash: byRecoveryCode ? owner.recovery_hash! : undefined
    };
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
  await recordAttempt(db, key, "challenge");
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
  let sessionToken: string;
  if (pending.purpose === "setup") {
    ownerId = `own_${randomToken(12)}`;
    recoveryCode = newRecoveryCode();
    const session = await newSession(db, ownerId);
    try {
      // One transaction: the owner never exists without a passkey.
      await db.batch([
        db.prepare("INSERT INTO owners (id, name, webauthn_user_id, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(ownerId, pending.name, pending.webauthnUserId, await recoveryHash(recoveryCode), now),
        insertCredential(ownerId),
        // The claim link is spent with the claim: it never works again, not even for recovery.
        ...(pending.setupCodeHash ? [spendCode(db, pending.setupCodeHash)] : []),
        session.insert
      ]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) fail(409, "already_set_up", "Someone has just claimed this Meeting Note.");
      rethrowMissingTables(error);
    }
    sessionToken = session.token;
  } else if (pending.purpose === "owner-recover") {
    ownerId = pending.ownerId!;
    recoveryCode = newRecoveryCode();
    const session = await newSession(db, ownerId);
    // Recovery means the old passkeys are lost or can't be trusted: replace them, sign out
    // everywhere, and retire the code that was just used — one transaction, so of two recoveries
    // racing with the same code only one commits. Whatever authorised another recovery goes too:
    // the recovery code being replaced is spent, so a recovery someone began with it and kept
    // waiting fails at its own verify. A recovery through the installer also spends every other
    // grant; one through a recovery code leaves grants alone, so the Cloudflare account owner's
    // link still outranks a code someone else holds.
    const spends = [
      ...(pending.setupCodeHash ? [spendCode(db, pending.setupCodeHash)] : []),
      ...(pending.recoveryCodeHash ? [spendCode(db, pending.recoveryCodeHash)] : []),
      db.prepare("INSERT OR IGNORE INTO spent_codes (code_hash, used_at) SELECT recovery_hash, ? FROM owners WHERE id = ? AND recovery_hash IS NOT NULL")
        .bind(now, ownerId),
      ...(pending.setupCodeHash
        ? [db.prepare("INSERT OR IGNORE INTO spent_codes (code_hash, used_at) SELECT code_hash, ? FROM setup_code_grants").bind(now)]
        : [])
    ];
    const replace = [
      // Taking the copy back through the installer also retires the private calendar address: whoever
      // held the copy could have made one, and would keep reading new plans. The owner's own
      // recovery code leaves it alone, so a lost phone doesn't break a calendar subscription.
      ...(pending.setupCodeHash ? [db.prepare("DELETE FROM settings WHERE key = 'calendar_feed_token'")] : []),
      db.prepare("DELETE FROM credentials WHERE owner_id = ?").bind(ownerId),
      db.prepare("DELETE FROM sessions WHERE owner_id = ?").bind(ownerId),
      db.prepare("DELETE FROM device_links WHERE owner_id = ?").bind(ownerId),
      db.prepare("UPDATE integration_tokens SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL").bind(now, ownerId),
      db.prepare("UPDATE owners SET recovery_hash = ? WHERE id = ?").bind(await recoveryHash(recoveryCode), ownerId),
      insertCredential(ownerId),
      session.insert
    ];
    try {
      await db.batch([...spends, ...replace]);
    } catch (error) {
      if (String(error).includes("UNIQUE")) fail(409, "code_used", "That code has just been used.");
      // A copy whose schema update has not landed has nowhere to record spent codes. The recovery
      // code still works there, as it did before; a setup code never reaches this point without it.
      if (!String(error).includes("no such table") || pending.setupCodeHash) rethrowMissingTables(error);
      await db.batch(replace);
    }
    sessionToken = session.token;
  } else if (pending.purpose === "link-device") {
    // The link is used up by the batch that saves the passkey, and only a link that is still there
    // saves one: a recovery that removed it a moment ago wins.
    const session = await newSession(db, pending.ownerId!);
    const [saved] = await db.batch([
      db.prepare(
        `INSERT INTO credentials (id, owner_id, public_key, counter, transports, created_at)
         SELECT ?, owner_id, ?, ?, ?, ? FROM device_links WHERE token_hash = ? AND expires_at > ? AND owner_id = ?`
      ).bind(info.credential.id, toBase64Url(info.credential.publicKey), info.credential.counter, JSON.stringify(info.credential.transports ?? []), now, pending.linkHash!, now, pending.ownerId!),
      db.prepare("DELETE FROM device_links WHERE token_hash = ?").bind(pending.linkHash!),
      session.insertIfPasskey(info.credential.id)
    ]);
    if (changed(saved) === 0) {
      fail(400, "link_expired", "This link has expired or has already been used. Make a new one on your signed-in device.");
    }
    ownerId = pending.ownerId!;
    sessionToken = session.token;
  } else {
    // Add a device from one that is signed in: saved only while that session is still valid.
    const owner = await ownerForSession(c);
    if (!owner || owner.id !== pending.ownerId) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
    ownerId = owner.id;
    const session = await newSession(db, ownerId);
    const [saved] = await db.batch([
      db.prepare(
        `INSERT INTO credentials (id, owner_id, public_key, counter, transports, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND owner_id = ? AND expires_at > ?)`
      ).bind(info.credential.id, ownerId, toBase64Url(info.credential.publicKey), info.credential.counter, JSON.stringify(info.credential.transports ?? []), now, await currentSessionHash(c), ownerId, now),
      session.insertIfPasskey(info.credential.id)
    ]);
    if (changed(saved) === 0) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
    sessionToken = session.token;
  }

  setSessionCookie(c, sessionToken);
  return c.json({ ok: true, name: pending.name ?? null, recoveryCode });
});

/**
 * A one-time link, and its QR code, for adding a phone or computer. Only a signed-in device can make
 * one. Opening it on the new device lets that device create its own passkey; nothing else changes.
 */
authRoutes.post("/device-link", async (c) => {
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const key = await attemptKey(c);
  await checkAttempts(c, key, "challenge");
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + DEVICE_LINK_TTL_MS;
  // Written only while the session that asked still exists: a recovery that signed everyone out
  // a moment after the check above must not hand the old session a fresh way back in.
  const [, made] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM device_links WHERE expires_at < ?").bind(now),
    c.env.DB.prepare(
      "INSERT INTO device_links (token_hash, owner_id, expires_at, created_at) SELECT ?, owner_id, ?, ? FROM sessions WHERE token_hash = ? AND owner_id = ? AND expires_at > ?"
    ).bind(await sha256Hex(token), expiresAt, now, await currentSessionHash(c), owner.id, now)
  ]);
  await recordAttempt(c.env.DB, key, "challenge");
  if (changed(made) === 0) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
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
  // Counted like a challenge: a signed-in session cannot turn this into a stream of writes.
  const key = await attemptKey(c);
  await checkAttempts(c, key, "challenge");
  const recoveryCode = newRecoveryCode();
  const now = Date.now();
  const sessionHash = await currentSessionHash(c);
  // Both statements run only while the session that asked still exists, so a rotation whose check
  // passed just before a recovery cannot replace the recovered owner's new code afterwards. The
  // code being replaced is spent, so a recovery someone began with it fails at its verify.
  const signedIn = "EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND owner_id = ? AND expires_at > ?)";
  const replace = c.env.DB.prepare(`UPDATE owners SET recovery_hash = ? WHERE id = ? AND ${signedIn}`)
    .bind(await recoveryHash(recoveryCode), owner.id, sessionHash, owner.id, now);
  let replaced: D1Result | undefined;
  try {
    [, replaced] = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT OR IGNORE INTO spent_codes (code_hash, used_at) SELECT recovery_hash, ? FROM owners WHERE id = ? AND recovery_hash IS NOT NULL AND ${signedIn}`)
        .bind(now, owner.id, sessionHash, owner.id, now),
      replace
    ]);
  } catch (error) {
    if (!String(error).includes("no such table")) throw error;
    replaced = await replace.run();
  }
  await recordAttempt(c.env.DB, key, "challenge");
  if (changed(replaced) === 0) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  return c.json({ ok: true, recoveryCode });
});

const integrationTokenBody = z.object({
  label: z.string().trim().min(1).max(80).default("NextNote")
});

/** List revocable app connections. Secret values are never returned after creation. */
authRoutes.get("/integration-tokens", async (c) => {
  if (!nextNoteEnabled(c.env)) fail(404, "not_found", "This app has no connected apps.");
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
  if (!nextNoteEnabled(c.env)) fail(404, "not_found", "This app has no connected apps.");
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const body = await readBody(c, integrationTokenBody);
  const secret = `mn_${randomToken(32)}`;
  const id = `int_${randomToken(12)}`;
  const now = Date.now();
  // Created only while the asking session still exists (see /device-link).
  const made = await c.env.DB.prepare(
    "INSERT INTO integration_tokens (id, owner_id, label, token_hash, created_at) SELECT ?, owner_id, ?, ?, ? FROM sessions WHERE token_hash = ? AND owner_id = ? AND expires_at > ?"
  ).bind(id, body.label, await sha256Hex(secret), now, await currentSessionHash(c), owner.id, now).run();
  if (changed(made) === 0) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  return c.json({ ok: true, id, label: body.label, token: secret, createdAt: new Date(now).toISOString() }, 201);
});

authRoutes.delete("/integration-tokens/:id", async (c) => {
  if (!nextNoteEnabled(c.env)) fail(404, "not_found", "This app has no connected apps.");
  const owner = await ownerForSession(c);
  if (!owner) fail(401, "sign_in_required", "Sign in with your passkey to continue.");
  const result = await c.env.DB.prepare(
    "UPDATE integration_tokens SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL"
  ).bind(Date.now(), c.req.param("id"), owner.id).run();
  if ((result.meta.changes ?? 0) !== 1) fail(404, "not_found", "That app connection no longer exists.");
  return c.json({ ok: true });
});

authRoutes.post("/login/options", async (c) => {
  const key = await attemptKey(c);
  await checkAttempts(c, key, "challenge");
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(c).rpID,
    userVerification: "preferred",
    allowCredentials: [] // empty: the device offers whichever passkey it holds for this site
  });
  const challengeId = await storeChallenge(c.env.DB, "login", options.challenge, {});
  await recordAttempt(c.env.DB, key, "challenge");
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

  // The session is written only while this passkey is still the owner's: a recovery may have
  // removed it between the check above and now.
  const session = await newSession(db, credential.owner_id);
  const [, signedIn] = await db.batch([
    db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
      .bind(verification.authenticationInfo.newCounter, Date.now(), credential.id),
    session.insertIfPasskey(credential.id)
  ]);
  if (changed(signedIn) === 0) fail(400, "unknown_passkey", "This passkey isn't registered here.");
  setSessionCookie(c, session.token);
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE, cookiePrefix(c));
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, COOKIE, { path: "/", secure: isHttps(c), prefix: cookiePrefix(c) });
  return c.json({ ok: true });
});
