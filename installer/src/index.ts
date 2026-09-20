import { InstallError, provisionMeetingNote } from "./provision";

type Env = {
  ASSETS: Fetcher;
  INSTALL_SESSIONS: KVNamespace;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET: string;
  OAUTH_SCOPES: string;
  INSTALLER_ORIGIN: string;
  SESSION_ENCRYPTION_KEY: string;
};

type Session = { accessToken: string; accounts: Array<{ id: string; name: string }> };
const API = "https://api.cloudflare.com/client/v4";
const SESSION_COOKIE = "mn_install";
const STATE_COOKIE = "mn_oauth_state";
const SESSION_TTL = 30 * 60;

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function id(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function cookie(request: Request, name: string): string {
  const found = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(value, { status, headers: responseHeaders });
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(value: Session, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(value))
  );
  const output = new Uint8Array(iv.byteLength + encrypted.byteLength);
  output.set(iv);
  output.set(new Uint8Array(encrypted), iv.byteLength);
  return base64url(output);
}

async function unseal(value: string, secret: string): Promise<Session | null> {
  try {
    const bytes = fromBase64url(value);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await encryptionKey(secret),
      bytes.slice(12)
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as Session;
  } catch {
    return null;
  }
}

async function accounts(accessToken: string): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch(`${API}/accounts?per_page=50`, { headers: { authorization: `Bearer ${accessToken}` } });
  const data = await response.json<{ success: boolean; result: Array<{ id: string; name: string }>; errors?: Array<{ message: string }> }>();
  if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message || "Could not read Cloudflare accounts");
  return data.result.map(({ id, name }) => ({ id, name }));
}

async function oauthStart(_request: Request, env: Env): Promise<Response> {
  const state = id();
  await env.INSTALL_SESSIONS.put(`state:${state}`, "1", { expirationTtl: 600 });
  const callback = `${env.INSTALLER_ORIGIN}/oauth/callback`;
  const target = new URL("https://dash.cloudflare.com/oauth2/auth");
  target.search = new URLSearchParams({
    response_type: "code",
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: callback,
    scope: env.OAUTH_SCOPES,
    state
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "set-cookie": setCookie(STATE_COOKIE, state, 600), "cache-control": "no-store" }
  });
}

async function oauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const expectedState = cookie(request, STATE_COOKIE);
  if (!state || !code || state !== expectedState || !(await env.INSTALL_SESSIONS.get(`state:${state}`))) {
    return new Response(null, {
      status: 302,
      headers: { location: `${env.INSTALLER_ORIGIN}/?error=authorization`, "set-cookie": setCookie(STATE_COOKIE, "", 0) }
    });
  }
  await env.INSTALL_SESSIONS.delete(`state:${state}`);
  const credentials = btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`);
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { authorization: `Basic ${credentials}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${env.INSTALLER_ORIGIN}/oauth/callback` })
  });
  const token = await response.json<{ access_token?: string }>();
  if (!response.ok || !token.access_token) return Response.redirect(`${env.INSTALLER_ORIGIN}/?error=token`, 302);
  const sessionId = id();
  const visibleAccounts = await accounts(token.access_token);
  const encryptedSession = await seal({ accessToken: token.access_token, accounts: visibleAccounts }, env.SESSION_ENCRYPTION_KEY);
  await env.INSTALL_SESSIONS.put(`session:${sessionId}`, encryptedSession, { expirationTtl: SESSION_TTL });
  const headers = new Headers({ location: env.INSTALLER_ORIGIN, "cache-control": "no-store" });
  headers.append("set-cookie", setCookie(SESSION_COOKIE, sessionId, SESSION_TTL));
  headers.append("set-cookie", setCookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function getSession(request: Request, env: Env): Promise<{ id: string; value: Session } | null> {
  const sessionId = cookie(request, SESSION_COOKIE);
  if (!sessionId) return null;
  const encrypted = await env.INSTALL_SESSIONS.get(`session:${sessionId}`);
  if (!encrypted) return null;
  const value = await unseal(encrypted, env.SESSION_ENCRYPTION_KEY);
  return value ? { id: sessionId, value } : null;
}

async function revoke(accessToken: string, env: Env): Promise<void> {
  const credentials = btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`);
  const response = await fetch("https://dash.cloudflare.com/oauth2/revoke", {
    method: "POST",
    headers: { authorization: `Basic ${credentials}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken })
  });
  if (!response.ok) throw new Error(`OAuth revoke failed (${response.status})`);
}

function sameOrigin(request: Request, env: Env): boolean {
  return request.headers.get("origin") === env.INSTALLER_ORIGIN;
}

async function install(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, env)) return json({ error: "Invalid request origin" }, 403);
  const body = await request.json<{ accountId?: string }>().catch(() => ({}) as { accountId?: string });
  if (!body.accountId) return json({ error: "Missing Cloudflare account" }, 400);
  const session = await getSession(request, env);
  if (!session || !session.value.accounts.some((account) => account.id === body.accountId)) {
    return json({ error: "Installation session expired" }, 401, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
  }
  try {
    const origin = new URL(request.url).origin;
    const [scriptResponse, migrationsResponse] = await Promise.all([
      env.ASSETS.fetch(`${origin}/release/standalone.js`),
      env.ASSETS.fetch(`${origin}/release/migrations.json`)
    ]);
    if (!scriptResponse.ok || !migrationsResponse.ok) throw new InstallError("unknown", "Installation release is unavailable");
    const result = await provisionMeetingNote({
      accountId: body.accountId,
      accessToken: session.value.accessToken,
      releaseScript: await scriptResponse.text(),
      release: await migrationsResponse.json(),
      installId: session.id
    });
    await revoke(session.value.accessToken, env).catch((error) => console.error("OAuth revoke failed", error));
    await env.INSTALL_SESSIONS.delete(`session:${session.id}`);
    return json({ ok: true, ...result }, 200, { "set-cookie": setCookie(SESSION_COOKIE, "", 0) });
  } catch (error) {
    console.error("Personal installation failed", error);
    const code = error instanceof InstallError ? error.code : "unknown";
    // The page turns the code into the reader's own language; the message is the detail behind it.
    return json({ error: error instanceof Error ? error.message : "Installation failed", code }, 502);
  }
}

function secureAsset(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "meeting-note-installer" });
    }
    if (url.pathname === "/oauth/start") return oauthStart(request, env);
    if (url.pathname === "/oauth/callback") return oauthCallback(request, env);
    if (url.pathname === "/api/session" && request.method === "GET") {
      const session = await getSession(request, env);
      return session ? json({ authorized: true, accounts: session.value.accounts }) : json({ authorized: false, accounts: [] });
    }
    if (url.pathname === "/api/install" && request.method === "POST") return install(request, env);
    return secureAsset(await env.ASSETS.fetch(request));
  }
};
