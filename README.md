# Meeting Note

Record a meeting or a workshop in your browser. Your own free Cloudflare account transcribes it, in
English and Chinese, and writes a structured note every five minutes while you are still talking.

**New to Cloudflare?** Start with the [plain-language Chinese setup guide](QUICKSTART.zh-CN.md).
You do not need to learn Cloudflare or write code. It is simply the free account that runs your
private copy of Meeting Note.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NextAgentBC/meeting-note)

- Record the microphone, or the microphone plus a Zoom tab's audio (desktop Chrome).
- Whisper transcribes and Llama writes the notes, both on Workers AI.
- A short note for every five minutes, merged into one note when you stop, exportable as Markdown.
- The whole recording also stays on your computer as a download, in case anything in the cloud fails.
- **Only you can sign in**, with a passkey: Face ID, a fingerprint or your screen lock. No password.
- **Audio deletes itself after seven days.**

## What it costs

**$0, and no credit card.** It avoids the two Cloudflare products that ask for a card even on the
free plan: R2 (audio goes into KV instead) and Cloudflare Access (it has its own passkey sign-in).

| Part | What it does here | Free allowance |
|---|---|---|
| Workers AI | Transcription and notes | 10,000 "neurons" a day: **about two hours of recording**, notes included. It stops at the limit and never bills. Resets at 00:00 UTC. |
| KV | Audio, about 1 MB per three minutes, expiring after 7 days | 1,000 writes a day, far more than the AI allowance can use |
| D1 | Meetings, transcripts, notes, your passkey | 100,000 rows written a day |
| Queues | Background transcription | 10,000 operations a day |
| Workers | The app | 100,000 requests a day |

The app shows how much recording today's allowance still affords, before you start.

## Put it online

1. Make two free accounts, if you don't have them: [Cloudflare](https://dash.cloudflare.com/sign-up) and [GitHub](https://github.com/signup).
2. Press **Deploy to Cloudflare** above and keep the suggested settings. It takes a few minutes.
3. Straight away, open `https://meeting-note.<your-name>.workers.dev`, type your name and create your
   passkey. The app then shows a **recovery code** once: take a screenshot of it. From then on, only
   your devices can sign in.

Install it like an app: in Chrome, the install icon in the address bar; on an iPhone, Safari → Share →
Add to Home Screen.

## Recording well

**In a room:** choose **Microphone only** and put the laptop or phone near whoever speaks most.
Speak for half a minute and watch the input level: around −20 to −35 dB is right; below −50 dB the app
warns you. Repeat audience questions before answering them: they are the quietest thing in the room.
Keep the tab in front; the app keeps the screen awake while recording. At the end, press **Stop &
create note**, then **Download the full local recording** as your backup.

**A Zoom call:** choose **Zoom + microphone** and, in Chrome's share dialog, pick the Zoom window and
tick **Share tab audio** or **Share system audio**. Without that tick only your own voice is recorded.
Phones can't record another app's audio, so record calls from a computer.

**Tell people you're recording**, and follow the consent rules where you are.

## If something goes wrong

- **The note never appears:** press **Create the note from what we have**. It builds the note from every
  section that did transcribe.
- **Your sign-in ran out mid-meeting:** a banner says so. Recording carries on, the audio waits on your
  device, and it uploads once you press **Sign in again**.
- **You lost your passkey:** on the sign-in screen, choose **Lost your passkey? Use your recovery code**.
  It puts a new passkey on the device you're holding, signs you out everywhere else, and shows a new
  recovery code; the old one stops working.
- **It asks you to sign in the very first time you open it:** someone set it up before you did. In the
  Cloudflare dashboard, open the `meeting-note` Worker → **Settings** → **Variables and Secrets** and add a
  secret named `SETUP_CODE` with any code. Then choose **Lost your passkey? Use your recovery code** and
  type that code: their passkeys and sessions are removed and the app is yours.
- **Today's AI allowance is used up:** transcription pauses until 00:00 UTC. Open the meeting afterwards
  and press **Retry**.

## How it works

```text
Browser (MediaRecorder)
   ├─ the whole session → a local backup you can download
   └─ 3-minute chunks → IndexedDB → Worker API → KV (expires after 7 days)
                                          └→ Queue: transcribe → Whisper → D1 transcript
                                                └→ ~5 minutes of transcript? → Queue: section note → Llama → D1
Stop → close out the last section → Queue: final → merge the section notes → D1 note + Markdown
```

Nothing ever summarises a whole meeting in one pass: the final merge reads a handful of short section
notes, so it stays small however long the meeting ran. A silent chunk is a normal, empty result; a
chunk that can never transcribe is skipped after its retries rather than holding the meeting up.

**Chinese:** Whisper writes Mandarin in Traditional characters by default. The transcription prompt
is in Simplified Chinese, and every transcript and note is then converted character by character, so
regional words are left as the speaker said them. Set `CHINESE_SCRIPT` to `off` to keep the model's output.

**Sign-in:** a passkey signature check takes well under a millisecond, which fits the free plan's
10 ms of CPU per request. The database stores only hashes of session tokens and of the recovery code.
Requests that change data must come from the app's own address. Nothing is asked at deploy time: a fresh
copy belongs to whoever sets it up first, so open yours right after deploying. To require a code at setup
instead, add a `SETUP_CODE` secret to the Worker.

## Privacy

- Everything stays in **your** Cloudflare account. Audio lives in KV and expires after seven days.
  Transcripts and notes stay in D1 until you remove them; there is no delete button yet, so use
  Cloudflare's dashboard (D1 → `meeting-note-db` → Console) if you need to.
- AI notes are drafts. Check names, numbers and decisions against the transcript.

## Settings

Change these in `wrangler.jsonc` (or in the Cloudflare dashboard, under the Worker's settings).

| Setting | Default | Meaning |
|---|---|---|
| `SEGMENT_TARGET_MINUTES` | `5` | How much talk one section note covers |
| `AUDIO_RETENTION_DAYS` | `7` | When audio deletes itself |
| `CHINESE_SCRIPT` | `simplified` | `off` keeps Traditional characters |
| `ASR_MODEL` | Whisper Large v3 Turbo | Transcription |
| `SUMMARY_MODEL` / `FINAL_MODEL` | Llama 3.3 70B | Section notes / the final merge |
| `FREE_DAILY_NEURONS` | `10000` | The allowance the usage card measures against |

## Run it on your computer

```sh
npm install
npm run dev      # http://localhost:8787
npm test
```

Locally everything runs on your machine except Workers AI, so recording and uploads work but
transcription only happens in the deployed app. `e2e/passkeys.mjs` walks through setup, the recovery
code, sign-in, an expired session and recovery on a new device in a real browser; the steps are at the top of the file.

## License

MIT.
