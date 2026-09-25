/**
 * The open app's "a new version is ready" check (public/version-watch.js), and the offline shell
 * that has to carry it: app.js imports it, so an app started offline without it would not start.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser modules are shipped as plain JavaScript without declaration files.
import { createVersionWatch } from "../public/version-watch.js";

function watch(answers: Array<string | Error>) {
  let clock = 0;
  const onNewer = vi.fn();
  const fetchVersion = vi.fn(async () => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const watcher = createVersionWatch({ fetchVersion, onNewer, now: () => clock });
  return { watcher, onNewer, fetchVersion, advance: (ms: number) => { clock += ms; } };
}

describe("the version check an open app runs", () => {
  it("takes its own version from the first answer and says nothing about it", async () => {
    const { watcher, onNewer } = watch(["ee9df89"]);
    await watcher.check();
    expect(watcher.loadedVersion).toBe("ee9df89");
    expect(onNewer).not.toHaveBeenCalled();
  });

  it("keeps quiet while the server still runs the version the page loaded", async () => {
    const { watcher, onNewer, advance } = watch(["ee9df89", "ee9df89"]);
    await watcher.check();
    advance(61_000);
    await watcher.check();
    expect(onNewer).not.toHaveBeenCalled();
  });

  it("reports the server's version on every check that finds it moved on", async () => {
    const { watcher, onNewer, advance } = watch(["ee9df89", "a1b2c3d", "a1b2c3d"]);
    await watcher.check();
    advance(61_000);
    await watcher.check();
    advance(61_000);
    await watcher.check();
    expect(onNewer.mock.calls).toEqual([["a1b2c3d"], ["a1b2c3d"]]);
    expect(watcher.loadedVersion).toBe("ee9df89");
  });

  it("asks at most once a minute, unless told to", async () => {
    const { watcher, fetchVersion, advance } = watch(["ee9df89", "ee9df89", "ee9df89"]);
    await watcher.check();
    advance(30_000);
    await watcher.check();
    expect(fetchVersion).toHaveBeenCalledTimes(1);
    await watcher.check({ force: true });
    expect(fetchVersion).toHaveBeenCalledTimes(2);
  });

  it("shares one request between checks that overlap", async () => {
    const { watcher, fetchVersion } = watch(["ee9df89"]);
    await Promise.all([watcher.check({ force: true }), watcher.check({ force: true })]);
    expect(fetchVersion).toHaveBeenCalledTimes(1);
  });

  it("shrugs off a failed request and an empty answer, and starts from the first real one", async () => {
    const { watcher, onNewer, advance } = watch([new Error("offline"), "", "ee9df89", "ee9df89"]);
    await watcher.check();
    advance(61_000);
    await watcher.check();
    advance(61_000);
    await watcher.check();
    expect(watcher.loadedVersion).toBe("ee9df89");
    advance(61_000);
    await watcher.check();
    expect(onNewer).not.toHaveBeenCalled();
  });
});

describe("the offline shell", () => {
  it("precaches every script the app is made of", () => {
    const publicDir = fileURLToPath(new URL("../public", import.meta.url));
    const worker = readFileSync(`${publicDir}/service-worker.js`, "utf8");
    const scripts = readdirSync(publicDir).filter((name) => name.endsWith(".js") && name !== "service-worker.js");
    const missing = scripts.filter((name) => !worker.includes(`"/${name}"`));
    expect(missing).toEqual([]);
  });
});
