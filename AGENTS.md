# Meeting Note — notes for AI coding tools

> Picking this up cold? `HANDOFF.md` is the whole project in one file: what is deployed where,
> how an installed copy is updated, the visual system and its budget, and what is still missing.

A meeting recorder that runs on its owner's own free Cloudflare account: the browser records, Workers AI
transcribes and writes notes, and only the owner can sign in. Read this before changing it.

## Keep these true

1. **$0 with no card on file.** No Cloudflare R2 in the template (audio lives in KV with an expiry; see 4) and no Cloudflare
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
4. **Audio is temporary, unless the owner binds somewhere to keep it.** Chunks expire from KV after
   `AUDIO_RETENTION_DAYS`, and KV is what transcription reads. Only the optional `RECORDINGS` R2 binding
   (never in `wrangler.jsonc`, like `MEMORY_VECTORS`) keeps a permanent copy, per meeting (`keep_audio`),
   and the owner can turn that off or delete the audio from the meeting's Recording sheet. Never move
   audio into D1.

## Where things are

```
src/index.ts     API routes, the queue consumer, and advance(): the only code that moves a meeting on
src/auth.ts      passkey setup / sign-in / owner recovery / device links (Add device), sessions, same-origin check
src/segment.ts   five-minute section notes     src/summary.ts   the final merge and its JSON repair
src/chinese.ts   Traditional → Simplified, character by character
src/assistant.ts plans: tasks API, dictation, .ics and the /cal/<token>.ics feed, meeting to-dos
src/plans.ts     the plan-reading prompt and its reference calendar   src/dates.ts   date words → dates
src/tasks.ts     task rows, scheduling in the owner's time zone        src/calendar/  RFC 5545 + Google links
src/memory.ts    what gets remembered, and search (FTS5 + LIKE + time + vector) src/ask.ts  questions → answers
src/embed.ts     semantic search: Workers AI embeddings + Vectorize, all of it optional
src/facts.ts     durable facts ("长期事实记忆"): one model call per finished meeting, with supersession
src/memory-routes.ts  the Memory page's API: GET /api/memory, GET /api/memory/facts, DELETE /api/memory/:id
src/captures.ts  quick notes, private WebP uploads, photo-AI setting and queued photo understanding
src/recall/      hybrid-recall merge, time words, splitting (ported from nextclaw-cloud)
src/ai.ts        runModel, modelText (every response shape), usage     src/settings.ts owner settings
src/schema.ts   the app's own migration runner: an updated copy brings its database with it
src/transcript.ts Whisper's decoding options and prompt, loop collapsing, the owner's vocabulary and its correction pass
src/audio.ts     a meeting's audio: optional permanent copies in RECORDINGS (R2), play/download/keep/delete routes
public/          the app, with no build step: app.js (recording, uploads), auth.js (sign-in), plans.js, ask.js,
                 captures.js (WebP quick notes), preferences.js/css (themes, appearance and bilingual UI),
                 transcription.js (Vocabulary/Recording sheets), zip.js
migrations/      0001–0003 meetings, segments, AI usage; 0004 passkeys; 0005 recovery code; 0006 plans; 0007 memory;
                 0008 device links; 0009 memory embedding tracking; 0010 integration tokens;
                 0011 permanent audio/tuned ASR; 0012 quick notes/photos
e2e/             the sign-in flows in a real browser (own package.json)
installer/       install.meeting.nextagent.ca: Cloudflare OAuth, then one account's private copy.
                 src/provision.ts creates D1/KV/the queue and uploads the release bundle built by
                 scripts/build-standalone-release.mjs into public/release/ (src/standalone.ts + the
                 embedded public/ files). public/app.js is the page, in both languages.
```

## The look, and what it costs

Everything here is decoration: it never touches data, it is all skipped under
`prefers-reduced-motion`, and it removes itself on a device that cannot keep up. Read this before
adding any of it anywhere, because most of it is cheap only where it already is.

**Glass is four things, and all four are tokens.** A tint alone reads as grey haze — it disappears
on a light theme and looks like a hole on a dark one. What makes it glass: `--glass-face` (a lit
gradient down the surface), `--glass-body` (a colour *lighter* than whatever it sits on),
`--glass-edge` (a bright hairline along the top and sides, a shaded one underneath — this is the
only source of thickness) and `--glass-grain` (one tiled SVG noise, inline, which is what separates
frosted glass from a blur), plus `--glass-drop`, a shadow **in the theme's colour, never black**.
They are defined per mode in `preferences.css` and used by `shell.css`, so a theme swap carries the
material with it. Never write `rgba(255,255,255,…)` into a component.

**Surfaces carry the theme.** Every light theme's `--surface` used to be `#ffffff`, which made all
seven themes look the same — the colour has to be in the page, not only in the buttons. Keep
`--canvas` and `--surface` in the same hue, a few percent apart. `npm run test:themes` checks 84
contrast pairs and has to pass: body/secondary/muted on canvas, body on card, brand text on canvas,
button text on brand.

**`backdrop-filter` is the one expensive line of CSS.** It is a full blur pass *per element per
frame* while anything moves; a screen of blurred cards is what made this app stutter on a phone.
The whole app is allowed four, and that is the budget:

| Where | Blur | Why it is allowed |
|---|---|---|
| `.appbar`, `.tabbar` | 34px | two, always on screen, always over moving content |
| `.sheet` | 44px | one open at a time |
| `.calendar-dialog::backdrop` | 4px | only while that dialog is open |
| `.recording-active .stop-button` | 18px | one bar, only while recording |

Cards, rows, orbs and filter circles get the same look from face + grain + edge + drop, which costs
nothing. **Never animate a blur** — binding `saturate()` to the scroll spring invalidated every
blurred element every frame, which was the worst version of this bug. Keep the
`@supports not (backdrop-filter…)` fallback: an old WebView must get an opaque bar, not a see-through
one.

**The motion, module by module.**

- **`public/glass.js`** — the highlight that rides the edge of each bar, pushed by scroll velocity
  and drifting back (`--glass-shift`, `--glass-lean`). Every 500ms it reads the colour just outside
  each bar with `elementFromPoint`, walks up to the first element with a colour of its own, and sets
  `data-glass="light" | "dark"`: over bright content the glass goes bright and its labels go dark.
- **`public/motion.js`** — `depthScroll` moves two background washes (`body::before/::after`) at
  different speeds; their blur and opacity are **static**, because animating either repaints the
  whole screen. `cylinderScroll` runs one spring off scroll velocity: blocks inside `[data-cylinder]`
  lag up to 14px, staggered, and scale 0.9→1 and fade 0.55→1 as they cross the middle of the screen,
  on phone widths only. Boxes are measured once and re-measured on resize, mutation or route change
  — never per frame. Damping is per millisecond (`0.86 ** (dt / 16.7)`), so it settles in the same
  quarter second at 120Hz and at 10. `ambientGlow` averages a photo to one colour, weighted towards
  the saturated pixels, into `--glow-color`, registered with `@property` so a new photo interpolates.
- **`public/memory-orbs.js`** — remembered facts as circles: soft collisions (a push proportional to
  overlap, not an exchange of speed), a slowly turning heading each, no walls (they drift out, fade,
  and return from the other side), 24 of them, 14 on a phone. Tapping one grows it in place over
  half a second into a round card.
- **`public/metaball.js`** — one SVG goo filter over two circles and the bar between them; the neck
  thins with distance and breaks at 96px. Used for pulling a photo out of a note and for the note
  filters. The × button still does the same job for anyone who would rather tap.

**It removes itself.** `motion.js` watches frame times: two consecutive windows of 60 frames with
more than half of them over 32ms set `data-motion="light"` — no section movement, no bar blur, orbs
line up — and fire `meetingnote:motion-light`. The verdict is **never persisted**: it is about this
build, and the next one may be lighter. An older build stored it, and devices stayed frozen after
the cause was fixed; `cylinderScroll` clears that key on load.

**Seven things that cost a day each.**

1. **No `rotateX` on stacked blocks.** A tilted block's corners reach past its own box and sit on
   the one below. Use `scale` and `opacity`, and keep a gap the shrink cannot cross.
2. **A transformed ancestor drags native pickers off screen.** `<input type="date">` opens its
   popover in the transformed coordinate space and paints it wrong, so all shaping pauses on
   `focusin` and resumes on `focusout`.
3. **Never read layout per frame.** `getBoundingClientRect()` in a rAF loop forces a reflow every
   frame for every element.
4. **Never animate `filter`, blur radius or the opacity of a full-screen layer.** Only `transform`.
5. **Never persist a degrade verdict.**
6. **A hard-coded grey disappears on a light theme.** This app began dark-only; nine of them, plus a
   `color-scheme: dark` pinned to the date inputs, made text white on white. Use `--ink`, `--ink-2`,
   `--ink-3`, `--brand-fg`, `--danger` — never a hex outside a token block.
7. **An empty iOS date input draws nothing at all.** Every date and time field carries a visible
   label of its own.

**On a phone**: `100svh` not `100vh`, `env(safe-area-inset-*)` on anything fixed, 16px minimum on
inputs (smaller and iOS zooms the page on focus), tap targets ≥44px, and `touch-action: none` on
anything dragged so the gesture is not fighting the scroller.

## Updating an installed copy

Every copy is one Worker in **its owner's** Cloudflare account. Nobody can push code into it: the
OAuth token is revoked the moment the installation finishes, on purpose. So updates are pulled, and
three pieces make that work.

1. **The copy knows what it is running.** `RELEASE_VERSION` comes from `src/migrations.generated.ts`
   (written by `scripts/build-standalone-release.mjs` from the git sha) and `GET /api/health`
   reports it, publicly, together with `UPDATE_CHANNEL` — the installer that made it.
2. **The copy asks.** `checkForUpdate()` in `public/app.js` reads `/api/health`, then
   `<UPDATE_CHANNEL>/api/release` (CORS `*`, cached five minutes), at most once every six hours, and
   shows a banner when the versions differ. "Not now" remembers that version, not the question.
3. **The owner authorizes once, and the installer replaces the script.** `POST /api/update` reads the
   Worker's current bindings, carries every data binding over untouched, keeps the owner's own
   variables, adds the ones this release introduces, and uploads the new module with
   `keep_bindings: ["secret_text"]` so the setup code survives. It refuses any Worker without a d1,
   kv, queue and ai binding.

**The schema comes with the code.** `src/schema.ts` runs at the start of every fetch and queue batch
(once per isolate) and applies what `MIGRATIONS` has and `schema_migrations` does not. A copy from
before that table existed is adopted rather than rebuilt: each migration carries a sentinel (a table,
or a column in a table) extracted at build time, and a migration whose sentinel is already there is
recorded without running. Each migration runs as one `db.batch`, so a failure leaves nothing half
done. `migrations/*.sql` stays the source; never write a migration that only makes sense once.

## Memory API

For the Memory page. Every route is under the owner's session like the rest of `/api` (see
`sameOriginWrites`/`requireOwner`); kinds are `fact | plan | summary | section | transcript | dictation`.

- **`GET /api/memory?kind=&q=&cursor=&limit=`** — newest-first (a cursor over `(occurred_at, id)`
  DESC) when `q` is absent; the existing hybrid search (`searchMemory`), ranked by relevance and
  with no cursor, when it's given. `kind` filters either way; quick notes use kind `capture`.
  Returns `{ ok, items: [{ id, kind, title, snippet, meetingId, chunkSequence, occurredAt, superseded }], nextCursor }`.
- **`GET /api/memory/facts`** — current (non-superseded) facts only.
  Returns `{ ok, facts: [{ id, topic, statement, meetingId, meetingTitle, occurredAt, priorVersions }] }`.
- **`DELETE /api/memory/:id`** — forgets one row (fires the FTS delete trigger) and its vector, if
  any. For a `fact`, forgets every version of that topic, not just the current one.
  Returns `{ ok, removed }` (a count; `0` if the id was already gone).

Semantic search (the `vector` route `mergeHits` already has a slot for) needs `MEMORY_VECTORS`, a
Vectorize binding that does **not** exist in this template — the one-click Deploy button can't
provision an index the way it provisions D1/KV/the queue, and this is a hand-run copy anyway. Every
call site checks for the binding first; absent, everything above still works on full-text and LIKE
search alone. To turn it on for a real deployment (not this repo's `wrangler.jsonc`):

```sh
npx wrangler vectorize create <index-name> --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index <index-name> --property-name=kind --type=string
npx wrangler vectorize create-metadata-index <index-name> --property-name=occurredAt --type=number
```

and add `{ "vectorize": [{ "binding": "MEMORY_VECTORS", "index_name": "<index-name>" }] }` to that
deployment's wrangler config. Embedding (`@cf/baai/bge-m3`, overridable with `EMBED_MODEL`) always
runs in its own `{ type: "embed", ids }` queue job, never inside the request or job that wrote the
memory; a text change or a fresh row is picked up next time something searches or asks (the
once-only backlog scan in `embedBacklog`, hung off the same marker pattern as the meeting-note
catch-up in `ask.ts`).

## Commands

```sh
npm run dev         # http://localhost:8787, fully local (wrangler dev --local)
npm test
npm run typecheck
```

## Gotchas

- **GLM thinks before answering**, and that counts against max_tokens: pass
  `chat_template_kwargs: { enable_thinking: false }` (see `modelOptions`). It answers in
  `choices[0].message.content`. Llama 3.3 with a JSON schema garbles Chinese; don't make it a default.
- **No colon in a Whisper `initial_prompt`**: with "：" in it, whisper-large-v3-turbo wrote "Ｂ" for commas.
- **Whisper's settings are measured, not guessed** (`WHISPER_OPTIONS` in `src/transcript.ts`). On a real
  Mandarin meeting with English product names, the old settings (VAD on, a prompt saying "请用简体中文转写")
  left a line of Russian, 150 "嗯?" over real speech and a lost price. `condition_on_previous_text: false`,
  the compression/no-speech/log-prob thresholds, `hallucination_silence_threshold` and VAD **off** fixed
  those and cut the character error rate by 15–25%. Don't turn VAD back on or tell Whisper to write Chinese.
- **The vocabulary pass may only fix words.** `correctTranscript` asks the summary model to correct
  near-misses of the owner's vocabulary; `acceptCorrection` throws the answer away unless it keeps the
  length within 15% and 80% of the character pairs (real fixes kept 94–100%, two different decodings of
  the same audio 62%). A failed pass keeps Whisper's words; `transcript_json` always holds the raw result.
  Deepgram nova-3 on Workers AI has no Chinese, and no Workers AI model hears audio better than Whisper.
- **Permanent audio is an upload-time copy, with a queue fallback.** The chunk upload writes KV, then
  `archiveChunk` writes the same key to `RECORDINGS`; if that fails, an `{ type: "archive" }` job copies it
  from KV later. Audio recorded before the binding existed is copied once by `archiveBacklog` (the
  catch-up call in `ask.ts`). Transcription falls back to the permanent copy when KV has expired it.
- **The installer's config names no account.** The hostname, the OAuth client id and the KV
  namespace for installation sessions are placeholders in `installer/wrangler.jsonc`;
  `scripts/deploy-installer.mjs` writes a filled-in copy, deploys with it and deletes it again,
  reading the values from the untracked `installer/deploy.json` or from the environment. The repo is
  public, so nothing in it should identify one person's Cloudflare account.
- **An app's built-in browser cannot finish any of this.** A link shared in WeChat (or QQ, Weibo,
  DingTalk, Feishu, Alipay, Douyin, Xiaohongshu, Facebook, Instagram, LINE) opens in that app's
  webview, where `window.PublicKeyCredential` exists but the passkey prompt never appears, and
  nothing can be added to the home screen. `public/in-app-browser.js` recognises them by user agent;
  the sign-in screen then shows how to reopen the page in Safari or the system browser instead of a
  passkey button, and the installer page (its own copy of the same list, in `installer/public/app.js`
  — keep the two in step) shows the same thing and sends its install links to that warning. Both
  leave a way through for a wrong guess. The address the sign-in screen offers to copy is
  `arrivalUrl`, captured **before** `#claim=` / `#add-device=` is stripped, or the owner would arrive
  in Safari without the code.
- **Installing twice is allowed, and a failed install leaves nothing behind.** The rollback removes
  the Worker, queue, KV namespace and database it made, and the next attempt draws new names from a
  new install id, so the same account can retry as often as it likes. What does survive is a
  *finished* install, so `listInstalls` shows the account's existing `meeting-note-<id>` Workers on
  the account screen before installing another — that is also how someone who lost their address
  finds it again. It never throws: an account it cannot read simply has nothing to show.
- **NextNote is one deployment's feature, not the product's.** The desktop vault that pulls
  recordings out of this app belongs to the owner of `meeting.nextagent.ca`, so `NEXTNOTE` in
  `wrangler.production.jsonc` is the only place it is on. Everywhere else `nextNoteEnabled` is false:
  `/api/auth/me` reports `nextNote: false` and the Me tab's Connected apps group stays hidden, the
  three `/api/auth/integration-tokens` routes answer 404, and a `Bearer mn_…` token is not accepted
  at all. The `integration_tokens` table still ships in migration 0010 — a migration is never
  un-run — it is simply never written to.
- **A brand-new Cloudflare account has no workers.dev subdomain**, and uploading a Worker to it fails
  with error **10063** ("You need a workers.dev subdomain in order to proceed"). `ensureWorkersSubdomain`
  registers one (`PUT /accounts/:id/workers/subdomain`, a random `meeting-note-xxxxxx`) **before** the
  installer creates anything, so a refusal costs nothing to roll back; a name someone else holds answers
  10031 and it tries another. The account subdomain cannot reuse the install id — it is one name per
  account, not per install. Every provisioning failure reaches the browser as an `InstallError` code
  (`workers_subdomain`, `database`, `storage`, `queue`, `worker`, `address`), because `app.js` says the
  problem in the reader's language and keeps Cloudflare's English line as the detail underneath.
- **Dates in plans are worked out by `resolveDatePhrase`** from the words the model copies out; the model's
  own date is the fallback. Weeks start on Monday: 下周二 / next Tuesday is Tuesday of next week.
- **memory_fts is an FTS5 table kept in step by triggers.** Write memory_items with
  `INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE` (it skips the delete trigger). The trigram
  tokenizer can't match fewer than three characters, so shorter words, and the two-character pieces of
  longer Chinese words, go through LIKE. `wrangler d1 export` can't export virtual tables.
- **Remembering never fails the work it follows**: wrap memory writes in `safely()`. `rememberSource` and
  `rememberMeeting` take the whole `Env`, not just `DB`, because they also queue embedding and delete
  vectors — pass `env`, not `env.DB`.
- A fact's `text` is `"<statement>\nFrom: <meeting title>, <local date>"`, always in that shape; `factStatement`
  strips the appended line back off. Its `title` is the topic, which is how supersession and "forget this
  fact" find every version — see `normalizeTopic` before comparing two topics for equality.
- `/cal/*` runs the Worker without a session (calendar apps can't sign in); the service worker never caches it.
- Camera originals never leave the browser: `captures.js` draws them to canvas and uploads bounded WebP
  full/thumbnail copies. Photo AI is off by default and only queues when the full image upload completes.

- Workers AI doesn't run locally, so transcription and notes can only be tested on a deployed copy, or with
  `npx wrangler dev` (no `--local`): that proxies AI calls to the real service under your `wrangler login`,
  while D1/KV/the queue still run locally. `npm run dev` uses `--local`, where queue jobs fail with "Binding
  AI needs to be run remotely"; that's expected there.
- `public/` has no bundler, so `auth.js` calls WebAuthn directly and converts base64url by hand.
- KV has no `head`: `list({ prefix, limit: 1 })` stands in for it. The column is still called `r2_key`.
- Every `/api` route except `/api/auth/*` and `/api/health` needs the owner's session. A 401 mid-session
  makes `auth.js` show a "sign in again" banner; recording carries on and audio waits in IndexedDB.
- Full-page screenshots of this theme time out in headless Chrome (large blurred backgrounds); the
  e2e takes viewport screenshots.
