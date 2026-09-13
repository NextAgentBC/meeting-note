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
src/recall/      hybrid-recall merge, time words, splitting (ported from nextclaw-cloud)
src/ai.ts        runModel, modelText (every response shape), usage     src/settings.ts owner settings
public/          the app, with no build step: app.js (recording, uploads), auth.js (sign-in), plans.js, ask.js
migrations/      0001–0003 meetings, segments, AI usage; 0004 passkeys; 0005 recovery code; 0006 plans; 0007 memory;
                 0008 device links (Add device); 0009 memory embedding tracking (embedded_at/embedded_hash)
e2e/             the sign-in flows in a real browser (own package.json)
```

## Memory API

For the Memory page. Every route is under the owner's session like the rest of `/api` (see
`sameOriginWrites`/`requireOwner`); kinds are `fact | plan | summary | section | transcript | dictation`.

- **`GET /api/memory?kind=&q=&cursor=&limit=`** — newest-first (a cursor over `(occurred_at, id)`
  DESC) when `q` is absent; the existing hybrid search (`searchMemory`), ranked by relevance and
  with no cursor, when it's given. `kind` filters either way.
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
