# wechat-ui

Standalone Vue 3 chat UI for WeChat accounts served by the native hub. It is a
self-contained npm project (own lockfile, not part of the pnpm workspace) with
a single runtime dependency on `vue`.

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
