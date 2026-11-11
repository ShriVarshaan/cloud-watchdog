import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MainWindow } from './main-window/MainWindow'
import { Popover } from './popover/Popover'
import '@fontsource-variable/inter/opsz.css'
import './styles.css'

// The main process loads this page with ?view=main or ?view=popover, and
// with &focus=<resource key> when a notification was clicked.
const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>{view === 'popover' ? <Popover /> : <MainWindow focusKey={params.get('focus')} />}</StrictMode>
)
