# wechat-ui

Chat interface for WeChat accounts served by the native hub. It is one React
application used in two places: the browser page the daemon hosts at `/ui/`,
and the Tauri desktop app.

The project is self-contained: it has its own lockfile, is not part of the pnpm
workspace, and builds with `npm`.

## Run it

### Standalone with the daemon

```bash
# 1. build the bundle
npm ci && npm run build

# 2. put the bundle where the daemon finds it: either
#    - a `wechat-ui/` directory next to the wx binary, or
#    - `<data_dir>/ui`, or
#    - anywhere, exported as WX_UI_DIR
# 3. start the daemon
wx serve
```

The daemon hosts the bundle at `/ui/` and logs a one-click URL with the API
token attached:

```
Chat UI: http://127.0.0.1:6174/ui/?auth=<token> (bundle: ...)
```

Open that URL, scan the QR code to sign a WeChat account in, and the interface
runs against the hub directly.

### Dev server against a running hub

```bash
npm install
WECHAT_UI_HUB_BASE=http://127.0.0.1:6174 \
WECHAT_UI_HUB_TOKEN=<hub token> \
npm run dev
```

- `WECHAT_UI_HUB_BASE` — origin of the hub (default `http://127.0.0.1:6174`)
- `WECHAT_UI_HUB_TOKEN` — hub token used by the dev proxy; required unless the
  hub runs without authentication

Open the printed URL with any `?auth=` value, for example
`http://localhost:5173/?auth=dev`. The page needs that marker to treat itself as
signed in; the proxy replaces it with the real token before the request reaches
the hub. The dev server proxies both `/client/v1/*` and `/v1/*` to the hub,
including the event stream.

### Desktop

The Tauri app in `packages/desktop` builds this project through
`npm --prefix ../../wechat-ui run build` and bundles `wechat-ui/dist`. In the
desktop shell the hub token stays in the system keychain: every request goes
through a Tauri command instead of `fetch`, and the page never sees it.

## Build for embedding

```bash
npm run build
```

The output lands in `dist/` with a relative base and content-hashed asset
names, so it can be served under any path prefix — for example vane-core's
`/api/wechat/sessions/{id}/client/ui/`, where the interface infers its API base
(`/client/v1`) from the page URL and the host injects authentication.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Shell: boot, login, rail, conversation pane, banners, dialogs |
| `src/store/` | Application state: one external store (`useSyncExternalStore`), split into session, conversations, messages and interface slices, plus the engine that opens the event stream |
| `src/platform/` | Runtime differences: browser or desktop detection, the request transport, file saving, and the Tauri bridge |
| `src/components/` | Views, one file per screen area |
| `src/styles/` | `base.css` theme variables, `app.css` shell, per-component files under `styles/components/` |
| `src/i18n/` | Source-string translation: `t('中文原文')` returns the English entry, or the source text when none exists |
| `src/api.ts`, `src/types.ts` | HTTP client and contract types shared by every view |

## Checks

```bash
npm run check   # tsc --noEmit
npm run test    # vitest
npm run build   # type check + production bundle
```
