// Deploys the installer with this account's own values filled in, so the committed config never
// names anyone's KV namespace, OAuth client or hostname.
//
// The values come from installer/deploy.json (untracked; copy deploy.example.json) or, if that is
// missing, from INSTALLER_HOSTNAME / INSTALLER_SESSIONS_KV_ID / INSTALLER_OAUTH_CLIENT_ID in the
// environment. Anything passed after `--` goes to wrangler, so `--dry-run` works.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = `${root}installer/wrangler.jsonc`;
const generatedPath = `${root}installer/wrangler.deploy.jsonc`;
const settingsPath = `${root}installer/deploy.json`;

const file = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const settings = {
  INSTALLER_HOSTNAME: process.env.INSTALLER_HOSTNAME || file.hostname,
  INSTALLER_SESSIONS_KV_ID: process.env.INSTALLER_SESSIONS_KV_ID || file.sessionsKvId,
  INSTALLER_OAUTH_CLIENT_ID: process.env.INSTALLER_OAUTH_CLIENT_ID || file.oauthClientId
};

const missing = Object.entries(settings).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Cannot deploy the installer without ${missing.join(", ")}.`);
  console.error(`Put them in installer/deploy.json (see installer/deploy.example.json) or in the environment.`);
  process.exit(1);
}

let config = readFileSync(configPath, "utf8");
for (const [placeholder, value] of Object.entries(settings)) config = config.replaceAll(placeholder, value);
writeFileSync(generatedPath, config);

try {
  execFileSync("npx", ["wrangler", "deploy", "--config", generatedPath, ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit"
  });
} finally {
  // The filled-in config never outlives the deploy that needed it.
  rmSync(generatedPath, { force: true });
}
