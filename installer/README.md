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
provisioning fails, newly created resources are rolled back so the user can retry cleanly.
