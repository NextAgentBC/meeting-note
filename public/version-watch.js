// Notices when the server has moved on to a newer version than the one this page started on.
//
// Meeting Note on a phone's home screen is resumed, not reloaded, so it can run the same code for
// days after its Worker was updated. The service worker cannot be relied on to notice: not every
// release changes it. So the app asks /api/health, which needs no sign-in, which version the server
// runs: when it starts, when it comes back to the foreground, and every half hour while it is on
// screen. The first answer is the version this page runs (the page itself came over the network).

export const VERSION_CHECK_INTERVAL = 30 * 60 * 1000;
const MIN_GAP = 60 * 1000;

/**
 * fetchVersion() resolves to the server's version string; onNewer(version) is called on every
 * check that finds the server on a different version than the first answer, so an offer the app
 * could not show yet (mid-recording) is made again on the next check.
 */
export function createVersionWatch({ fetchVersion, onNewer, now = () => Date.now() }) {
  let loaded = "";
  let lastCheck = -Infinity;
  let pending = null;

  function check({ force = false } = {}) {
    if (pending) return pending;
    if (!force && now() - lastCheck < MIN_GAP) return Promise.resolve();
    lastCheck = now();
    pending = (async () => {
      let version;
      try {
        version = await fetchVersion();
      } catch {
        return; // Offline, or the Worker is mid-deploy: the next check asks again.
      }
      if (typeof version !== "string" || !version) return;
      // A page that started offline takes its first answer as its own version, so an update made
      // while it was offline goes unnoticed until the next launch, which loads the new code anyway.
      if (!loaded) loaded = version;
      else if (version !== loaded) onNewer(version);
    })().finally(() => { pending = null; });
    return pending;
  }

  return {
    check,
    get loadedVersion() { return loaded; }
  };
}
