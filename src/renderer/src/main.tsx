import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Overlay } from './views/Overlay'
import './index.css'

// The overlay window (Phase 12) loads this same bundle behind a #overlay hash
// and renders the compact read-only panel instead of the full app.
const isOverlay = window.location.hash === '#overlay'
if (isOverlay) document.body.classList.add('overlay-body')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isOverlay ? <Overlay /> : <App />}</React.StrictMode>
)
