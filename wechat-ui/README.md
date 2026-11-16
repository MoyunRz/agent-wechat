# wechat-ui

Standalone Vue 3 chat UI for WeChat accounts served by the native hub. It is a
self-contained npm project (own lockfile, not part of the pnpm workspace) with
a single runtime dependency on `vue`.

## Run standalone with the daemon (no wrapper tooling needed)

```bash
# 1. build the UI bundle
npm ci && npm run build

# 2. place the bundle where the daemon finds it: either
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

Open that URL in a browser, scan the QR code to log in a WeChat account, and
the full chat UI runs against the hub directly — no vane-core, no vane-console.

## Run standalone (dev server against a running hub)

```bash
npm install
WECHAT_UI_HUB_BASE=http://127.0.0.1:6174 \
WECHAT_UI_HUB_TOKEN=<hub token> \
npm run dev
```

- `WECHAT_UI_HUB_BASE` — origin of the hub (default `http://127.0.0.1:6174`)
- `WECHAT_UI_HUB_TOKEN` — hub token used by the dev proxy; required unless the
  hub runs without authentication

The dev server proxies `/client/v1/*` to the hub as `/v1/*` with the token
attached, including the SSE event stream.

## Build for embedding

```bash
npm run build
```

The output lands in `dist/` with a relative base and content-hashed asset
names, so it can be served under any path prefix — for example vane-core's
`/api/wechat/sessions/{id}/client/ui/`, where the UI infers its API base
(`/client/v1`) from the page URL and the host injects authentication.

## Type check

```bash
npm run check
```
