# Meeting Note — notes for AI coding tools

A meeting recorder that runs on its owner's own free Cloudflare account: the browser records, Workers AI
transcribes and writes notes, and only the owner can sign in. Read this before changing it.

## Keep these true

1. **$0 with no card on file.** No Cloudflare R2 (audio lives in KV with an expiry) and no Cloudflare
   Access / Zero Trust (sign-in is the app's own passkeys). Both ask for a payment method even on the
   free plan.
2. **One-click deploy.** The Deploy to Cloudflare button provisions D1, KV and the queue from
   `wrangler.jsonc`, so keep placeholder IDs there. There is deliberately no dead-letter queue, because
   the button wouldn't create one. Schema changes are new files in `migrations/`, applied in `predeploy`.
3. **One owner, passkeys only, nothing asked at deploy time.** The first person to open a fresh copy claims
   it; `owners.singleton` is UNIQUE, so a second claim fails in the database. The owner is shown a recovery
   code once (stored as SHA-256, replaced every time it's used); a `SETUP_CODE` secret is optional. No
   passwords: the free plan's 10 ms of CPU per request can't afford password hashing. Don't add a
   `.dev.vars.example`: the Deploy button turns every line in it into a form field.
4. **Audio is temporary.** Chunks expire from KV after `AUDIO_RETENTION_DAYS`. Never move audio into D1
   or anywhere it would outlive that.

## Where things are

```
src/index.ts     API routes, the queue consumer, and advance(): the only code that moves a meeting on
src/auth.ts      passkey setup / sign-in / owner recovery / add-a-device, sessions, same-origin check
src/segment.ts   five-minute section notes     src/summary.ts   the final merge and its JSON repair
src/chinese.ts   Traditional → Simplified, character by character
public/          the app, with no build step: app.js (recording, uploads), auth.js (sign-in), styles
migrations/      0001–0003 meetings, segments, AI usage; 0004 the owner's passkeys; 0005 the recovery code
e2e/             the sign-in flows in a real browser (own package.json)
```

## Commands

```sh
npm run dev         # http://localhost:8787, fully local (wrangler dev --local)
npm test
npm run typecheck
```

## Gotchas

- Workers AI doesn't run locally, so transcription and notes can only be tested on a deployed copy.
  Locally, queue jobs fail with "Binding AI needs to be run remotely"; that's expected.
- `public/` has no bundler, so `auth.js` calls WebAuthn directly and converts base64url by hand.
- KV has no `head`: `list({ prefix, limit: 1 })` stands in for it. The column is still called `r2_key`.
- Every `/api` route except `/api/auth/*` and `/api/health` needs the owner's session. A 401 mid-session
  makes `auth.js` show a "sign in again" banner; recording carries on and audio waits in IndexedDB.
- Full-page screenshots of this theme time out in headless Chrome (large blurred backgrounds); the
  e2e takes viewport screenshots.
