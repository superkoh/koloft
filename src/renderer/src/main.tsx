import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTitleTips } from './titleTips'
import { landAfterClosingAWatchedSession } from './store'
import { butlerLanding } from '@plugins/butler/renderer/landing'

installTitleTips()
landAfterClosingAWatchedSession(butlerLanding)

createRoot(document.getElementById('root')!).render(<App />)
