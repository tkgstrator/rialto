import '@/i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import 'remixicon/fonts/remixicon.css'
import { ThemeProvider } from 'next-themes'
import { RouterProvider } from 'react-router-dom'
import { ConfigProvider } from '@/components/ConfigProvider'
import { registerServiceWorker } from './pwa'
import { router } from './routes'

// Before the first render: the worker only serves the installed app, and
// waiting for React to mount would put it a navigation behind.
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute='class' defaultTheme='system' storageKey='theme'>
      <ConfigProvider>
        <RouterProvider router={router} />
      </ConfigProvider>
    </ThemeProvider>
  </StrictMode>
)
