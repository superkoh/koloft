import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

void Promise.allSettled([...document.fonts].map((face) => face.load())).then(() =>
  createRoot(document.getElementById('root')!).render(<App />)
)
