import { createRoot } from 'react-dom/client'
import App from './App'
import { installTitleTips } from './titleTips'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

installTitleTips()

void Promise.allSettled([...document.fonts].map((face) => face.load())).then(() =>
  createRoot(document.getElementById('root')!).render(<App />)
)
