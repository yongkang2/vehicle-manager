import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { fontFamily, installThemeTokens } from './theme'

installThemeTokens()
document.documentElement.style.fontFamily = fontFamily

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
