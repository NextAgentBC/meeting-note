// Sign-in for the one owner of this Meeting Note. Passkeys only: the phone or computer
// confirms it's you with Face ID, a fingerprint or the screen lock, and the server checks
// a signature. There is no password anywhere.

const $ = (selector) => document.querySelector(selector);

// ── WebAuthn: turn the server's JSON into browser calls and back ─────────────

function toBuffer(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)).buffer;
}

function toBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function post(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function describe(credential, extra) {
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: extra
  };
}

async function createPasskey(request) {
  const { challengeId, options } = await post("/api/auth/register/options", request);
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      user: { ...options.user, id: toBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) }))
    }
  });
  const response = credential.response;
  return post("/api/auth/register/verify", {
    challengeId,
    response: describe(credential, {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : []
    })
  });
}

async function signInWithPasskey() {
  const { challengeId, options } = await post("/api/auth/login/options");
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuffer(c.id) }))
    }
  });
  const response = credential.response;
  return post("/api/auth/login/verify", {
    challengeId,
    response: describe(credential, {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : undefined
    })
  });
}

function messageFor(error) {
  if (error && (error.name === "NotAllowedError" || error.name === "AbortError")) return "Cancelled. Nothing was changed.";
  return error instanceof Error ? error.message : String(error);
}

// ── The sign-in screen ───────────────────────────────────────────────────────

let whenSignedIn = null;

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function showPanel(name) {
  show($("#setupForm"), name === "setup");
  show($("#signInPanel"), name === "signin");
  show($("#recoverForm"), name === "recover");
  show($("#recoveryPanel"), name === "recovery");
  show($("#authError"), false);
}

function showError(error) {
  $("#authError").textContent = messageFor(error);
  show($("#authError"), true);
}

function enterApp() {
  show($("#authView"), false);
  show($("#dashboardView"), true);
  show($("#signOutButton"), true);
  document.body.classList.remove("auth-pending");
  window.dispatchEvent(new CustomEvent("meetingnote:signed-in"));
  whenSignedIn?.();
  whenSignedIn = null;
}

/** Shown once after setup, and again after a recovery replaces the old code. */
function showRecoveryCode(code, replaced) {
  $("#authTitle").textContent = "Save your recovery code";
  $("#authLede").textContent = replaced
    ? "Your old recovery code no longer works. This is the new one. Take a screenshot or write it down now: it won't be shown again."
    : "If you ever lose the phone or computer you just used, this code gets you back in. Take a screenshot or write it down now: it won't be shown again.";
  $("#recoveryCode").textContent = code;
  $("#copyRecoveryCode").textContent = "Copy the code";
  showPanel("recovery");
}

async function run(button, action, { replacesCode = false } = {}) {
  button.disabled = true;
  try {
    const result = await action();
    if (result?.recoveryCode) showRecoveryCode(result.recoveryCode, replacesCode);
    else enterApp();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

/** Resolves once the owner is signed in, showing the sign-in or setup screen until then. */
export async function ensureSignedIn() {
  const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.json());
  if (me.signedIn) {
    show($("#signOutButton"), true);
    document.body.classList.remove("auth-pending");
    return;
  }

  show($("#dashboardView"), false);
  show($("#meetingView"), false);
  show($("#authView"), true);
  document.body.classList.remove("auth-pending");

  if (!window.PublicKeyCredential) {
    $("#authTitle").textContent = "This browser can't use passkeys";
    $("#authLede").textContent = "Open this page in a recent Safari, Chrome or Edge.";
    showPanel("none");
    return new Promise(() => {});
  }

  if (me.hasOwner) {
    $("#authTitle").textContent = "Sign in";
    $("#authLede").textContent = "Your phone or computer confirms it's you with Face ID, a fingerprint or your screen lock. No password.";
    showPanel("signin");
  } else {
    $("#authTitle").textContent = "Set up your Meeting Note";
    $("#authLede").textContent = "This copy is brand new. Create your passkey now, and it's yours alone.";
    show($("#setupCodeField"), me.setupCodeRequired);
    show($("#noSetupCodeWarning"), !me.setupCodeRequired);
    $("#setupCode").required = me.setupCodeRequired;
    showPanel("setup");
  }
  return new Promise((resolve) => {
    whenSignedIn = resolve;
  });
}

$("#setupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(event.submitter ?? $("#setupForm button"), () =>
    createPasskey({ purpose: "setup", setupCode: $("#setupCode").value, name: $("#ownerName").value })
  );
});

$("#signInButton").addEventListener("click", (event) => void run(event.currentTarget, signInWithPasskey));

$("#showRecover").addEventListener("click", () => showPanel("recover"));
$("#hideRecover").addEventListener("click", () => showPanel("signin"));

$("#recoverForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(
    event.submitter ?? $("#recoverForm button"),
    () => createPasskey({ purpose: "owner-recover", code: $("#recoverCode").value }),
    { replacesCode: true }
  );
});

$("#copyRecoveryCode").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText($("#recoveryCode").textContent);
    event.currentTarget.textContent = "Copied";
  } catch {
    // Clipboard blocked: the code is on screen and selectable.
  }
});

$("#recoverySaved").addEventListener("click", () => enterApp());

$("#signOutButton").addEventListener("click", async () => {
  await post("/api/auth/logout").catch(() => undefined);
  location.reload();
});

// If a request comes back 401 mid-session (the 30-day session ran out), offer to sign in
// again right here: a recording in progress keeps going, and its audio waits on this device.
window.addEventListener("meetingnote:signin-required", () => {
  if ($("#authView").classList.contains("hidden")) show($("#reauthBanner"), true);
});

$("#reauthButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await signInWithPasskey();
    show($("#reauthBanner"), false);
    window.dispatchEvent(new CustomEvent("meetingnote:signed-in"));
  } catch (error) {
    $("#reauthMessage").textContent = messageFor(error);
  } finally {
    button.disabled = false;
  }
});

/** Adds a passkey on this device for the signed-in owner (after signing in with a phone's QR code). */
export function addThisDevice() {
  return createPasskey({ purpose: "add-device" });
}
