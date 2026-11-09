import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MainWindow } from './main-window/MainWindow'
import { Popover } from './popover/Popover'
import './styles.css'

// The main process loads this page with ?view=main or ?view=popover.
const view = new URLSearchParams(window.location.search).get('view')
const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(<StrictMode>{view === 'popover' ? <Popover /> : <MainWindow />}</StrictMode>)
