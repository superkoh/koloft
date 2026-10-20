import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTitleTips } from './titleTips'

installTitleTips()

void Promise.allSettled([...document.fonts].map((face) => face.load())).then(() =>
  createRoot(document.getElementById('root')!).render(<App />)
)
