# client-support

Test-only snapshot of the framework-free client modules the smoke harness
exercises. It exists so `scripts/client-ui-smoke.mjs` keeps testing the same
session, history-search, login-attempt, media-outbox, group-creation and
connection behavior after the desktop UI package is removed.

- The `.ts` files here were copied from that package before its removal. This
  directory is now their source of truth: keep changes here and in the harness,
  not in application code.
- The only import rewrite points the shared SDK at the built workspace package
  (`packages/shared/dist/index.js`); locale JSON now lives in `locales/`.
- `i18n.ts` replaces the i18next/React module with the same English catalogue
  lookup so plain Node can load it.
- `preview-launcher.mjs` is the synthetic preview server the launcher check
  runs; it serves `wechat-ui` and its Vite configuration.

The harness runs with Node 24 type stripping; do not add TypeScript syntax it
cannot erase. Its launcher check serves `wechat-ui` through Vite, so run
`npm --prefix wechat-ui ci` once before `pnpm client:smoke`.
