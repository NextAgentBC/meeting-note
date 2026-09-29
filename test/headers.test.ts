import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS, secureResponse } from "../src/headers";
import { serveEmbeddedAsset } from "../src/standalone-assets.generated";

const headersFile = fileURLToPath(new URL("../public/_headers", import.meta.url));

describe("security headers", () => {
  it("are the same in public/_headers as in the Worker", () => {
    const lines = readFileSync(headersFile, "utf8").split("\n");
    expect(lines[0]).toBe("/*");
    const declared = Object.fromEntries(lines.slice(1).filter((line) => line.trim()).map((line) => {
      const [name, ...value] = line.trim().split(":");
      return [name, value.join(":").trim()];
    }));
    expect(declared).toEqual(SECURITY_HEADERS);
  });

  it("forbid framing on every response, and keep what the response already said", () => {
    const secured = secureResponse(new Response("{}", { status: 401, headers: { "content-type": "application/json", "referrer-policy": "no-referrer" } }));
    expect(secured.status).toBe(401);
    expect(secured.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(secured.headers.get("x-frame-options")).toBe("DENY");
    expect(secured.headers.get("referrer-policy")).toBe("no-referrer");
    expect(secured.headers.get("content-type")).toBe("application/json");
  });

  it("reach the pages an installed copy serves from inside its Worker", () => {
    const page = secureResponse(serveEmbeddedAsset(new Request("https://notes.example.test/")));
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    // The instruction file for Cloudflare's asset server is not one of the app's pages.
    expect(serveEmbeddedAsset(new Request("https://notes.example.test/_headers")).headers.get("content-type")).toContain("text/html");
  });
});
