import { secureResponse } from "./headers";
import appWorker from "./index";
import { serveEmbeddedAsset } from "./standalone-assets.generated";
import type { Env, JobMessage } from "./types";

// The personal-cloud installer uploads one self-contained Worker module. Static files are embedded
// at release-build time so a new account needs only D1, KV, Queue and Workers AI bindings.
// Only the installer's bundle enters here, so this is where a copy learns that the installer made
// it (Env.INSTALLER_COPY): an owner cannot switch that off by editing a variable.
function installerEnv(env: Env): Env {
  return { ...env, INSTALLER_COPY: "1" };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/cal/")) {
      // What public/_headers does for the template's static files; the app's own routes add it too.
      return secureResponse(serveEmbeddedAsset(request));
    }
    return appWorker.fetch(request, installerEnv(env), ctx);
  },
  queue(batch: MessageBatch<JobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    return appWorker.queue(batch, installerEnv(env));
  }
};
