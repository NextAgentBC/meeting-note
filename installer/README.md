# Meeting Note Personal Cloud Installer

The phone-first installer replaces GitHub and API-token instructions with Cloudflare OAuth:

1. Tap Install.
2. Sign in to Cloudflare and authorize the verified Meeting Note client.
3. Open the deployed app and create a passkey with Face ID.

The setup code travels only in the URL fragment. The browser removes it immediately, so it is not
sent to the Worker or written into access logs. The owner name and setup-code fields stay hidden for
installer-created apps.

## Build

From the repository root:

```sh
npm run build:personal-release
npx wrangler deploy --dry-run --config installer/wrangler.jsonc
```

Before a real deployment, create a public Cloudflare OAuth client, replace the placeholder OAuth
client ID/scopes and installer KV ID, then store both `OAUTH_CLIENT_SECRET` and a random
`SESSION_ENCRYPTION_KEY` with `wrangler secret put`. Required OAuth permissions are D1 Write,
Queues Write, Workers KV Storage Write, Workers Scripts Write, Workers AI Write, and User Details
Read.

The installer encrypts OAuth access tokens in its private KV, keeps them for no more than 30
minutes, revokes the token after a successful installation, and deletes the installer session. If
provisioning fails, newly created resources are rolled back so the user can retry cleanly — the
token is kept, so Try again re-runs the installation without a second Cloudflare sign-in.

## Updating a copy that is already installed

`POST /api/update` uploads the current release over an existing Worker of this account, keeping its
D1, KV, queue, R2 and secrets, and `GET /api/release` tells any copy which version that is. The
account screen marks an installation whose `/api/health` reports an older version and offers to
update it; the app itself shows the same offer as a banner and links here. Schema changes are not
this installer's business any more — the uploaded app applies its own (`src/schema.ts`).

An installation nobody claimed is shown as such, and `POST /api/reclaim` writes a fresh `SETUP_CODE`
secret and returns a one-time claim link. It refuses a copy that already has an owner.

## Shared into WeChat

Most people receive this link in a chat app and tap it there, which opens it in that app's own
browser. The claim step needs a passkey, which those webviews never show, so the page detects them
by user agent and asks the reader to reopen it in Safari or Chrome — with the steps for their
phone, the address to copy, and a way through if the guess was wrong. The install buttons lead to
that warning until it is dismissed. The app itself does the same on its sign-in screen.

## Installing twice

Nothing blocks a second run. A failed installation rolls its resources back and the next attempt
uses new names, so the same person, the same Cloudflare account and the same email can simply try
again. A finished installation does stay, so before installing the account screen lists the Worker
names it already has (`GET /api/installs`, filtered to `meeting-note-<id>`) with their addresses:
someone who lost the address gets it back, and someone who really wants a second, separate copy
has to say so.

## The workers.dev subdomain

An account that has never opened the Workers dashboard has no workers.dev subdomain, and Cloudflare
refuses the script upload with error 10063. The installer therefore registers one before it creates
anything (`PUT /accounts/:id/workers/subdomain`, name `meeting-note-<six random characters>`, another
name on 10031). If that registration is refused as well, the page says so in Chinese or English and
links to `https://dash.cloudflare.com/<account>/workers/onboarding`: opening that page once creates
the subdomain, and Try again then finishes the installation.
