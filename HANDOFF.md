# Meeting Note — handoff, 2026-09-19

Everything another developer (or coding agent) needs to pick this up. `AGENTS.md` is the living
reference for how the code works; this file is the state of the project on the day it was written,
and it is meant to be readable on its own.

---

## 1. What this is

A meeting recorder that runs **in its owner's own Cloudflare account**. The browser records, Workers
AI transcribes and writes the notes, and only the owner can sign in. There is no shared backend and
no account system: every user has their own Worker, their own D1 database, their own KV namespace
and their own queue.

Three things are deployed from this one repository:

| Deployment | What it is | Config | Who it is for |
|---|---|---|---|
| `install.meeting.nextagent.ca` | The installer: Cloudflare OAuth, then it provisions a private copy in the visitor's own account | `installer/wrangler.jsonc` (+ `installer/deploy.json`, untracked) | anyone installing |
| `meeting.nextagent.ca` | The author's own copy of the app | `wrangler.production.jsonc` (untracked, `.git/info/exclude`) | one person |
| the repo itself | The template the Deploy-to-Cloudflare button uses | `wrangler.jsonc` (placeholder ids) | anyone cloning |

---

## 2. Rules that must stay true

1. **$0, no card on file.** No R2 and no Cloudflare Access in the template — both ask for a payment
   method even on the free plan. Audio lives in KV with an expiry (`AUDIO_RETENTION_DAYS`).
2. **One-click deploy.** The button provisions D1, KV and the queue from `wrangler.jsonc`, so the
   placeholder ids stay. No dead-letter queue: the button will not create one.
3. **One owner, passkeys only.** `owners.singleton` is UNIQUE, so the first person to claim a fresh
   copy owns it. No passwords: the free plan's 10ms of CPU per request cannot hash one.
4. **Audio is temporary** unless the owner binds R2 (`RECORDINGS`, never in the template).
5. **Nothing in the public repo names one account.** The installer's hostname, OAuth client id and
   KV namespace id are placeholders, filled in at deploy time (see §6).

---

## 3. Layout

```
src/index.ts          API routes, queue consumer, advance(): the only code that moves a meeting on
src/auth.ts           passkeys, sessions, device links, recovery, integration tokens (NextNote)
src/schema.ts         the app's own migration runner — an updated copy brings its database with it
src/segment.ts        five-minute section notes        src/summary.ts   final merge + JSON repair
src/transcript.ts     Whisper options, loop collapsing, the owner's vocabulary
src/assistant.ts      plans: tasks API, dictation, .ics feed      src/plans.ts  plan prompt + dates
src/memory.ts         what gets remembered and how it is searched (FTS5 + LIKE + time + vector)
src/facts.ts          durable facts, with supersession              src/ask.ts   questions → answers
src/captures.ts       quick notes, WebP photos, photo AI, voice notes (POST /api/captures/voice)
src/audio.ts          permanent audio copies in R2, play/download/keep/delete
src/embed.ts          optional Vectorize embeddings                 src/chinese.ts  Traditional → Simplified
public/               the app, no build step (see §5 for the visual modules)
installer/            the installer Worker + its own page
migrations/           0001–0012, applied by src/schema.ts at runtime as well as by wrangler
scripts/              build-standalone-release.mjs, deploy-installer.mjs, check-theme-contrast.mjs
test/                 259 vitest tests               e2e/   sign-in flows in a real browser
```

---

## 4. How an installed copy is born, and how it is updated

**Install.** `install.meeting.nextagent.ca` → Cloudflare OAuth → `installer/src/provision.ts`:

1. `ensureWorkersSubdomain` **first**, before anything is created. A brand-new account has no
   workers.dev subdomain and Cloudflare refuses the script upload with error **10063**; registering
   one first means a refusal costs nothing to roll back. A taken name answers 10031 → try another.
2. D1, KV, queue, migrations, the Worker (one self-contained module with the static files embedded),
   the queue consumer, then the public address.
3. A one-time `SETUP_CODE` secret travels to the owner in the URL fragment (`#claim=…`).
4. The OAuth token is revoked immediately and the installer session deleted.
5. Any failure rolls back what it made, and reaches the page as a code the page can say in Chinese.

**Update.** Nobody can push code into someone else's Worker, so updates are pulled:

- The copy knows its own release (`RELEASE_VERSION` in `src/migrations.generated.ts`, reported by
  `GET /api/health` along with `UPDATE_CHANNEL`).
- `checkForUpdate()` in `public/app.js` asks `<UPDATE_CHANNEL>/api/release` at most once every six
  hours and shows a banner when the versions differ.
- An app left open (a home-screen app is resumed, not reloaded) notices when its own Worker has
  moved on: `public/version-watch.js` compares `/api/health`'s version with the one it started on and
  `offerRefresh()` shows a Refresh banner, held back while recording or dictating.
- The owner authorizes Cloudflare once more and `POST /api/update` uploads the new module over the
  same Worker: same database, same audio, same queue, same passkey. Bindings are read back from the
  Worker and carried over; `keep_bindings: ["secret_text"]` keeps the setup code.
- **The schema travels with the code.** `src/schema.ts` applies whatever `migrations/` has that the
  database does not, once per isolate, one transaction per migration. A copy installed before the
  tracking table existed is *adopted*, not rebuilt: each migration carries a sentinel (the table it
  creates, or the column it adds) extracted at build time.

**Recovery.** The installer's account screen lists the `meeting-note-*` Workers the account already
holds, marks the ones behind the current release, and marks the ones nobody ever claimed —
`POST /api/reclaim` writes a fresh `SETUP_CODE` and returns a one-time claim link.

⚠️ Copies installed **before** `UPDATE_CHANNEL` existed do not know where to ask, so they never show
the banner. Their owners have to open the installer once; after that first update they self-announce.

---

## 5. The look

**Glass.** Four ingredients, all theme tokens defined per mode in `public/preferences.css`:
`--glass-face` (a lit gradient), `--glass-body` (a colour lighter than what it sits on),
`--glass-edge` (bright hairline on top and sides, shaded underneath) and `--glass-drop` (a shadow in
the theme's own colour), plus `--glass-grain`, one tiled SVG noise — the thing that separates frosted
glass from a blur.

**Backdrop blur is expensive** — one full blur pass per element per frame while anything moves. It
belongs to the two bars and whichever sheet is open, and nothing else. Cards, rows, orbs and filter
circles get the same look from tint + grain + edges + shadow, which costs nothing.

**Themes.** Seven, each with its own canvas *and* surface in both modes. `npm run test:themes`
checks 84 contrast pairs and must pass: body/secondary/muted on canvas, body on card, brand text on
canvas, button text on brand.

**Motion** (`public/motion.js`, `glass.js`, `memory-orbs.js`, `metaball.js`):

| Effect | Where | Notes |
|---|---|---|
| Liquid glass bars | `.appbar`, `.tabbar` | highlight rides the edge, pushed by scroll; re-tints itself every 500ms from what is behind (`data-glass="light"/"dark"`) |
| Damping + flow | whole page | scroll-velocity spring, ±14px, staggered per block, settles in ~0.25s; damping is per millisecond, not per frame |
| Section breathing | `[data-cylinder] > *` | scale 0.9→1, opacity 0.55→1 across the screen. **No rotation** — a tilted block's corners overlap the next one |
| Depth of field | `body::before/::after` | two washes, translate only (animating blur or opacity repaints them) |
| Ambient glow | note photos, lightbox | dominant colour weighted towards saturated pixels, `@property --glow-color` so changes interpolate |
| Metaball drag | pending photos, filter circles | SVG goo filter; the neck thins with distance and breaks at 96px |
| Memory orbs | remembered facts | soft collisions, wandering headings, no walls (they drift out and return), tap opens in place |

**Performance budget.** `motion.js` watches frame times: two consecutive windows of 60 frames with
more than half of them over 32ms ⇒ `data-motion="light"` (no section movement, no bar blur, orbs
line up). The verdict is **never persisted** — it is about this build, and the next one may be
lighter. Everything is also off under `prefers-reduced-motion`.

**Hard-coded colours are a bug.** The app began dark-only; a sweep replaced nine greys and a
`color-scheme: dark` on the date inputs that made them white-on-white in light mode. Use theme
tokens (`--ink`, `--ink-2`, `--ink-3`, `--brand-fg`, `--danger`…), never hex.

---

## 6. Commands

```sh
npm run dev                 # http://localhost:8787, fully local (no Workers AI)
npm test                    # 259 tests
npm run typecheck
npm run test:themes         # 84 contrast checks

npm run deploy:installer                      # build the release, then deploy the installer
node scripts/deploy-installer.mjs --dry-run   # same, without deploying
npx wrangler deploy --config wrangler.production.jsonc   # the author's own copy
```

**Values that never enter the repo:**

- `installer/deploy.json` (untracked; `deploy.example.json` beside it) — `hostname`,
  `sessionsKvId`, `oauthClientId`. `scripts/deploy-installer.mjs` writes a filled-in config, deploys
  with it and deletes it in a `finally`. The same values can come from `INSTALLER_HOSTNAME`,
  `INSTALLER_SESSIONS_KV_ID`, `INSTALLER_OAUTH_CLIENT_ID`.
- Installer secrets: `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY` (`wrangler secret put`).
- `wrangler.production.jsonc` — untracked via `.git/info/exclude`; it holds the author's D1/KV/R2/
  Vectorize ids and `NEXTNOTE: "on"`.

---

## 7. Gotchas worth knowing before changing anything

- **GLM thinks before answering** and it counts against `max_tokens`: pass
  `chat_template_kwargs: { enable_thinking: false }`.
- **No colon in a Whisper `initial_prompt`**, and **VAD stays off** for meetings: the current
  settings were measured on a real bilingual meeting and cut character error by 15–25%.
- **`memory_fts` is FTS5 kept in step by triggers.** Write `memory_items` with
  `INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE` (it skips the delete trigger).
- **Remembering never fails the work it follows**: wrap memory writes in `safely()`.
- **An app's built-in browser** (WeChat, QQ, Weibo, DingTalk, Feishu, Alipay, Douyin, Xiaohongshu,
  Facebook, Instagram, LINE) has `PublicKeyCredential` but never shows the passkey prompt.
  `public/in-app-browser.js` recognises them and both pages say how to reopen in Safari; the address
  they offer to copy is captured **before** `#claim=` is stripped.
- **A transformed ancestor drags the native date picker off screen.** Section transforms pause while
  anything is focused. Empty iOS date inputs also draw nothing, so each one is labelled.
- **NextNote** (the desktop vault) is one deployment's feature: `NEXTNOTE` in
  `wrangler.production.jsonc` is the only place it is on. Everywhere else the Connected apps row is
  hidden, the token routes 404 and bearer tokens are refused.
- **One meeting leaves many memory pieces** (a passage per chunk, a note per five minutes), all
  carrying the meeting title. The list folds consecutive pieces of one meeting and kind into one
  card — they are not duplicates.
- **`public/` has no bundler.** Plain ES modules, hand-written base64url in `auth.js`.
- **Workers AI does not run locally.** `npm run dev` is `--local`, where queue jobs fail with
  "Binding AI needs to be run remotely"; that is expected.

---

## 8. What changed on 2026-09-19

In order, with why:

1. **The installer could not install.** `ensureWorkersSubdomain` ran *after* the script upload, so
   every brand-new account hit Cloudflare error 10063 and rolled back. It runs first now, and every
   failure carries a code the page says in the reader's language.
2. **Home screen and address.** The address was hidden behind a button; it is shown, copyable, with
   how to keep it. The app teaches Add to Home Screen per platform (Safari never fires
   `beforeinstallprompt`), and asks once after sign-in.
3. **Installing twice, and unclaimed copies.** The account screen lists what the account already has,
   and offers a fresh claim link for a copy nobody claimed.
4. **WeChat.** Both pages detect an in-app browser and refuse to lead someone into an app they will
   not be able to claim.
5. **The update channel** and **the app's own migration runner** (§4).
6. **Voice quick notes** (`POST /api/captures/voice`; the audio is thrown away, the words are kept).
7. **The visual system** (§5), in several passes: liquid glass, ambient glow, depth, section
   breathing, metaball drag, memory orbs, circular note filters.
8. **NextNote became one deployment's feature.**
9. **Bolder themes** — every light theme's surface used to be `#ffffff`, so every card was white.
10. **Performance.** Backdrop blur removed from everything but the bars and sheets, per-frame layout
    reads cached, auto-degrade added (§5).
11. **Bug fixes:** the date/time fields, a shadowed `start` that froze the orb field on first tap,
    the degrade verdict that outlived the build that caused it, overlapping sections (perspective
    rotation), and the wall of near-identical memory rows.
12. **The public repo stopped naming one account**, and the installer's KV namespace was rotated
    (the old one, empty, was deleted).

---

## 9. Known gaps

- **Plans have one date and one time** (the start). There is no end time: adding one means a column,
  a migration, the edit form and `DTEND` in `src/calendar/`.
- **Ambient glow only has photos to work with.** Meeting cards have no image; a colour could be
  derived from the template or the duration instead.
- **最近记录 is cards, not orbs.** Orbs need a short title; those rows are whole passages. If they
  should be orbs, the orb has to open to read anything.
- **Copies installed before the update channel** never announce updates (§4).
- **e2e has not been run** this cycle (it needs a browser with a virtual authenticator); the 259
  unit tests, typecheck and the contrast checks all pass.
- **Everything visual was verified in a desktop browser at phone width**, not on a real iPhone,
  except what the owner checked by hand.
