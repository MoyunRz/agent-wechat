import { createApp } from 'vue'
import App from './App.vue'
import { initHubAuth } from './api'
import './styles.css'

// 独立托管模式（hub /ui/）下把 ?auth= 令牌移入 sessionStorage 并清理地址栏。
initHubAuth()

const UI_SETTINGS_KEY = 'vane.wechat.ui-settings'
try {
  const raw = localStorage.getItem(UI_SETTINGS_KEY)
  if (raw && JSON.parse(raw).themeMode === 'light')
    document.documentElement.classList.add('theme-light')
}
catch {
  // 读取失败时保持默认深色主题。
}

createApp(App).mount('#app')
