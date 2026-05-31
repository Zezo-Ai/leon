import '@fontsource/source-sans-pro/latin-400.css'
import '@fontsource/source-sans-pro/latin-600.css'
import '@fontsource/source-sans-pro/latin-700.css'
import 'remixicon/fonts/remixicon.css'
import './styles/main.sass'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { router } from './router'
import { applyStoredTheme } from './theme'

applyStoredTheme()

const rootElement = document.querySelector('#root')

if (rootElement === null) {
  throw new Error('Root element not found.')
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
