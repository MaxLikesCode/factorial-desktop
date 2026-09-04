import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './AppShell'
import '../styles.css'
import './app.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')
createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
