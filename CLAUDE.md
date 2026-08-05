# Project instructions

## Structure

- `src/background/` contains the extension service worker and browser event handlers.
- `src/content/` bridges the isolated extension context to Twitch page and worker scripts.
- `src/page/` intercepts Twitch fetches and workers, detects ad playlists, and selects direct or proxied requests.
- `src/store/` wraps browser local storage.
- `src/common/` contains shared proxy, stream, parsing, and UI helpers.
- `src/manifest.chromium.json` and `src/manifest.firefox.json` define browser-specific permissions and entry points.

## Build and validation

- Install locked dependencies with `npm ci`.
- Run focused regression tests with `npm test`.
- Run formatting checks with `npm run lint`.
- Run TypeScript checks with `npm run type-check`.
- Build Chromium with `npm run build:chromium`.
- Build Firefox with `npm run build:firefox`.
- Exercise playback changes in an isolated browser profile with and without the extension. Compare time to first video progress and inspect extension logs for proxy activation and cleanup.

## Code style

- Follow the existing TypeScript and Prettier configuration.
- Keep browser-specific behavior behind the existing `isChromium` checks.
- Correlate every request-response message exchange with a unique request ID.
- Confirm proxy settings have applied before allowing a flagged fetch to continue.
- Keep request and URL logs free of authentication tokens and complete query strings.

## Fork Changes

- `src/page/getFetch.ts`: use direct initial Usher and assigned Video Weaver requests in `blockAds` mode, then proxy replacement requests only after an ad is detected.
- `src/page/adReplacementCoordinator.ts`, `src/page/getFetch.ts`, and `src/background/background.ts`: share one replacement workflow per channel, retry transient failures once, back off repeated failures, return clean replacement playlists directly, cancel failed replacements, and report sanitized HTTP and Chromium proxy errors.
- `src/page/sendMessage.ts`, `src/content/content.ts`, and `src/page/getFetch.ts`: correlate asynchronous responses by unique request ID and clear response timers immediately.
- `src/common/ts/proxySettings.ts` and `src/background/handlers/onContentScriptMessage.ts`: await PAC application, serialize proxy updates, track concurrent full-mode requests independently, and always clean up proxy state after failed fetches.
- `src/background/handlers/disableSubscriptionAutoWhitelist.ts`, `src/page/getFetch.ts`, and the options UI: remove automatic subscription whitelisting, migrate its recorded channels out of the manual whitelist, and leave only explicit user-selected channel exceptions.
- `src/manifest.chromium.json`: point the extension homepage at the `clearcmos` fork and retain the existing Chromium extension ID for local builds.
