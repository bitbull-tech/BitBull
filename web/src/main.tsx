import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { loadBrand } from './brand.ts'

// The operator's name, logo and colours are applied before the first paint, so a
// white-labelled install never flashes the stock brand. A failure keeps the defaults.
await loadBrand()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
