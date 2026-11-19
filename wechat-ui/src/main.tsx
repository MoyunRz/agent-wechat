// Side-effect import: applies the stored light/dark theme before the first paint.
import './theme-boot'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initHubAuth } from './api'
import { initPlatform } from './platform'
import './styles/base.css'
import './styles/app.css'
import './styles/layout.css'

// Standalone hosting (the hub's /ui/) moves the ?auth= token into session
// storage and strips it from the address bar.
initHubAuth()

const rootElement = document.getElementById('root')
if (!rootElement)
  throw new Error('missing #root element')

const root = createRoot(rootElement)

// The platform layer installs the desktop transport before the first request,
// so the shell must not mount earlier.
void initPlatform().then(() => {
  root.render(<App />)
})
