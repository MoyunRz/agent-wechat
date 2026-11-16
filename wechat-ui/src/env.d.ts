/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WECHAT_CLIENT_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
