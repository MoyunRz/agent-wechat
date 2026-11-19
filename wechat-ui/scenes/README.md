# Visual review scenes

Playwright scenes for the chat interface. Each scene opens a route against a
fresh synthetic hub, waits for the screen to settle, and uploads a screenshot to
Argos in CI. Names are `<scene>@<viewport>` and `<scene>@<viewport>@<language>`;
Argos compares them with the latest main build.

The scenes need a browser and the Rust simulator. They do not run in a normal
test pass.

## Install once

From the repository root:

```bash
pnpm install --frozen-lockfile          # shared SDK build
npm --prefix wechat-ui ci               # app, Playwright and Argos
(cd wechat-ui && npx playwright install chromium)   # add --with-deps on Linux CI hosts
```

The scenes capture Simplified Chinese as well. Install Noto CJK and Noto Color
Emoji fonts for the same text rendering as CI.

## Run

```bash
npm --prefix wechat-ui run scenes                         # every scene
npm --prefix wechat-ui run scenes -- --grep chat-list     # one scene
npm --prefix wechat-ui run scenes:list                    # rewrite interfaces/ui/scenes.txt
```

The runner builds `@agent-wechat/shared` and the simulator when needed. Set
`WX_DEV_BINARY` to use an existing `wx-dev` build. Screenshots stay under
`scenes/.scenes/screenshots` for debugging; nothing uploads to Argos outside CI.

## Files

| Path | Responsibility |
| --- | --- |
| `scenes.mjs` | Scene table: data setup, route, checks and masks |
| `capture.spec.mjs` | Playwright test that runs and captures each scene |
| `server.mjs` | Vite server for `wechat-ui`, swapping the hub per scene |
| `stack.mjs` | Disposable simulator and hub for one scene |
| `seed.mjs`, `accounts.mjs` | Synthetic data shared by the scenes |
| `desktop.mjs` | Desktop bridge stand-in for desktop-only screens |
| `routes.ts` | Re-exports the app route table in `src/platform/routes.ts`; the scenes open those patterns |
| `listing.mjs` | Writes `interfaces/ui/scenes.txt` |
| `run.mjs` | Builds prerequisites and runs Playwright |

Add or update a scene when a screen changes. Argos shows the visual diff, and
the owner approves it; never approve your own change.
