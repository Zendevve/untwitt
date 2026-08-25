# untwitt

Bulk-unfollow utility for x.com. A Manifest V3 Chromium extension that walks the accounts you follow on x.com and unfollows them in configurable batches from a popup UI.

## Manual smoke test

1. Open chrome://extensions, enable Developer mode, click "Load unpacked", select the untwitt/ directory.
2. Navigate to https://x.com/<your-username>/following in any tab.
3. Click the untwitt extension icon. The popup should open at 360–400px wide with a dark theme.
4. Confirm "Mode = All accounts", "Speed = Normal", "Batch size = 50" are the defaults. Click UNFOLLOW ALL.
5. Observe: the unfollowed counter increments roughly once per second; the status card reads RUNNING.
6. Click PAUSE. The counter freezes. Click RESUME. The counter advances again.
7. Click STOP. The status reads STOPPED. Open DevTools → Application → Storage → Extension storage → Session and confirm the counters persisted.
8. Click UNFOLLOW ALL again with Batch mode at size 5. Confirm it stops after exactly 5 unfollows.

## Privacy

No backend, no analytics, no telemetry, no X API credentials, no remote scripts, all processing local.

## Architecture

- **popup** — the extension action UI; mode/speed/batch controls, RUN/PAUSE/STOP, live counters, status card.
- **content scripts** — injected into x.com pages; scroll the Following timeline, locate Unfollow buttons, dispatch clicks, observe DOM state.
- **background service worker** — orchestrates the loop, schedules cadence by Speed setting, holds the authoritative state machine, and writes to chrome.storage.session.
- **chrome.storage.session** — in-memory + service-worker lifetime persistence; counters, mode, speed, batch size, and pause/stop state.
- **assets** — popup HTML, CSS, and icon set.

## License

Proprietary. See [LICENSE](./LICENSE) for the full copyright notice and limited personal use terms. In short: you may download, view, study, fork, and install for personal non-commercial use. Modification, redistribution, derivative works, and commercial use require prior written permission from the copyright holder.
