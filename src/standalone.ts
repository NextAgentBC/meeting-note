import appWorker from "./index";
import { serveEmbeddedAsset } from "./standalone-assets.generated";
import type { Env, JobMessage } from "./types";

// The personal-cloud installer uploads one self-contained Worker module. Static files are embedded
// at release-build time so a new account needs only D1, KV, Queue and Workers AI bindings.
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/cal/")) {
      return serveEmbeddedAsset(request);
    }
    return appWorker.fetch(request, env);
  },
  queue(batch: MessageBatch<JobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    return appWorker.queue(batch, env);
  }
};
