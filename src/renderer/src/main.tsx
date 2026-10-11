import { createRoot } from 'react-dom/client'
import App from './App'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

const BUNDLED_TERMINAL_FACES = [
  '400 1em "JetBrainsMono Nerd Font"',
  '700 1em "JetBrainsMono Nerd Font"',
  'italic 400 1em "JetBrainsMono Nerd Font"',
  'italic 700 1em "JetBrainsMono Nerd Font"'
]

void Promise.allSettled(BUNDLED_TERMINAL_FACES.map((face) => document.fonts.load(face))).then(() =>
  createRoot(document.getElementById('root')!).render(<App />)
)
