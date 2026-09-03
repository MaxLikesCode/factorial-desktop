import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { UpdateApp } from './UpdateApp'
import '../styles.css'
import './update.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element missing')
createRoot(root).render(
  <StrictMode>
    <UpdateApp />
  </StrictMode>,
)
