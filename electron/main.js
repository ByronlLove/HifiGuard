const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron')
const path   = require('path')
const fs     = require('fs')
const { spawn, execSync } = require('child_process')

// ── Chemins ────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, '..', 'data')
const STATE_PATH  = path.join(DATA_DIR, 'state.json')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const JSON_PATH   = path.join(DATA_DIR, 'suivi_audio.json')
const CSV_PATH    = path.join(DATA_DIR, 'historique.csv')
const DAEMON_PATH = path.join(__dirname, '..', 'daemon', 'hifiguard.py')
const PYTHON_CMD  = 'python'

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ── Variables globales ─────────────────────────────────────
let tray          = null
let mainWindow    = null
let daemonProcess = null
let pollInterval  = null
let lastState     = null
let lastTrayZone  = null   // pour ne recréer l'icône que si la zone change
let windowVisible = false

// ── Timers adaptatifs ─────────────────────────────────────
let uiPollMs   = 250
let trayPollMs = 1000

// ══════════════════════════════════════════════════════════
// DAEMON
// ══════════════════════════════════════════════════════════
function startDaemon() {
  if (daemonProcess) return
  console.log('[Daemon] Démarrage...')
  daemonProcess = spawn(PYTHON_CMD, ['-X', 'utf8', DAEMON_PATH], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  daemonProcess.stdout.on('data', d => process.stdout.write('[D] ' + d.toString()))
  daemonProcess.stderr.on('data', d => process.stderr.write('[D ERR] ' + d.toString()))
  daemonProcess.on('exit', code => {
    console.log(`[Daemon] Arrêté (code ${code})`)
    daemonProcess = null
  })
}

function stopDaemon()    { if (daemonProcess) { daemonProcess.kill(); daemonProcess = null } }
function restartDaemon() { stopDaemon(); setTimeout(startDaemon, 800) }

// ══════════════════════════════════════════════════════════
// LECTURE FICHIERS
// ══════════════════════════════════════════════════════════
function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}
const readState  = () => readJSON(STATE_PATH)
const readConfig = () => readJSON(CONFIG_PATH)
const readSuivi  = () => readJSON(JSON_PATH) || {}

// ══════════════════════════════════════════════════════════
// ICÔNE TRAY — ne se recrée que si la zone change
// ══════════════════════════════════════════════════════════
function getTrayZone(db_a, thresholds) {
  if (db_a === null || db_a === undefined) return 'offline'
  const t = thresholds || { ok: 75, warn: 80, danger: 85 }
  if (db_a < t.ok)     return 'safe'
  if (db_a < t.warn)   return 'ok'
  if (db_a < t.danger) return 'warn'
  return 'danger'
}

const ZONE_COLORS = {
  offline: { r: 100, g: 100, b: 100 },
  safe:    { r: 34,  g: 197, b: 94  },
  ok:      { r: 132, g: 204, b: 22  },
  warn:    { r: 249, g: 115, b: 22  },
  danger:  { r: 239, g: 68,  b: 68  },
}

function buildTrayIcon(zone) {
  const { r, g, b } = ZONE_COLORS[zone] || ZONE_COLORS.offline
  const size = 16
  const buf  = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    // Cercle plein centré
    const x = (i % size) - size/2 + 0.5
    const y = Math.floor(i / size) - size/2 + 0.5
    const inside = Math.sqrt(x*x + y*y) < size/2 - 1
    buf[i*4+0] = inside ? r : 0
    buf[i*4+1] = inside ? g : 0
    buf[i*4+2] = inside ? b : 0
    buf[i*4+3] = inside ? 255 : 0
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function updateTray(state) {
  if (!tray) return
  const cfg  = readConfig()
  const t    = cfg && cfg.tray_thresholds
  const db_a = state ? state.db_a : null
  const zone = getTrayZone(db_a, t)

  // Ne recrée l'icône que si la zone change — évite le CPU gaspillé
  if (zone !== lastTrayZone) {
    tray.setImage(buildTrayIcon(zone))
    lastTrayZone = zone
  }

  // Tooltip : toujours mis à jour (pas de re-rendu natif lourd)
  if (state && db_a > 0) {
    tray.setToolTip(
      `HifiGuard\n` +
      `${db_a} dB(A)\n` +
      `NIOSH: ${state.dose_niosh}% | OMS/j: ${state.dose_who_j}%\n` +
      `OMS/7j: ${state.dose_who_7j}%`
    )
  } else {
    tray.setToolTip('HifiGuard — silence / inactif')
  }
}

// ══════════════════════════════════════════════════════════
// MENU TRAY
// ══════════════════════════════════════════════════════════
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'HifiGuard', enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir', click: () => showWindow() },
    { type: 'separator' },
    { label: '🔄 Relancer le daemon Python', click: () => restartDaemon() },
    { type: 'separator' },
    { label: '📤 Exporter les données', click: () => exportData() },
    { label: '⚙️ Paramètres', click: () => { showWindow(); mainWindow && mainWindow.webContents.send('navigate', 'settings') } },
    { type: 'separator' },
    { label: 'Quitter', click: () => { stopDaemon(); app.quit() } }
  ])
}

// ══════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════
async function exportData() {
  const result = await dialog.showSaveDialog({
    title: 'Exporter — HifiGuard',
    defaultPath: `hifiguard_${new Date().toISOString().slice(0,10)}`,
    filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'CSV', extensions: ['csv'] }]
  })
  if (result.canceled) return
  const ext = path.extname(result.filePath)
  if (ext === '.json') {
    const out = { exported_at: new Date().toISOString(), config: readConfig(), suivi: readSuivi() }
    fs.writeFileSync(result.filePath, JSON.stringify(out, null, 2))
  } else if (ext === '.csv' && fs.existsSync(CSV_PATH)) {
    fs.copyFileSync(CSV_PATH, result.filePath)
  }
}

// ══════════════════════════════════════════════════════════
// FENÊTRE — frameless avec titlebar custom
// ══════════════════════════════════════════════════════════
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1120,
    height: 760,
    minWidth:  800,
    minHeight: 560,
    frame: false,          // ← supprime la barre Windows native
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
  mainWindow.once('ready-to-show', () => { mainWindow.show(); windowVisible = true; adaptPolling(true) })

  mainWindow.on('focus',  () => { windowVisible = true;  adaptPolling(true)  })
  mainWindow.on('blur',   () => { windowVisible = false; adaptPolling(false) })
  mainWindow.on('close',  e  => { e.preventDefault(); mainWindow.hide(); windowVisible = false; adaptPolling(false) })
  mainWindow.on('closed', () => { mainWindow = null })
}

function showWindow() {
  if (!mainWindow) createWindow()
  else { mainWindow.show(); mainWindow.focus() }
}

// ══════════════════════════════════════════════════════════
// POLLING ADAPTATIF
// ══════════════════════════════════════════════════════════
function adaptPolling(focused) {
  const state  = lastState
  const cfg    = readConfig()
  const mode   = cfg && cfg.refresh_mode || 'focus'
  const custom = cfg && cfg.refresh_custom

  if (mode === 'eco') {
    uiPollMs   = 1000
    trayPollMs = 2000
  } else if (mode === 'custom' && custom) {
    uiPollMs   = custom.ui_ms   || 1000
    trayPollMs = custom.tray_ms || 1000
  } else if (mode === 'focus') {
    uiPollMs   = focused ? 250 : 1000
    trayPollMs = 1000
  } else if (mode === 'tray') {
    uiPollMs   = 1000
    trayPollMs = 1000
  }

  restartPolling()
}

function restartPolling() {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = setInterval(doPoll, uiPollMs)
}

function doPoll() {
  const state = readState()
  if (!state) return

  // Tray : seulement si le délai tray est écoulé (approx)
  updateTray(state)

  if (JSON.stringify(state) !== JSON.stringify(lastState)) {
    lastState = state
    if (mainWindow && !mainWindow.isDestroyed() && windowVisible) {
      mainWindow.webContents.send('state-update', state)
    }
  }
}

// ══════════════════════════════════════════════════════════
// IPC
// ══════════════════════════════════════════════════════════
ipcMain.handle('get-state',  () => readState())
ipcMain.handle('get-config', () => readConfig())
ipcMain.handle('get-suivi',  () => readSuivi())

ipcMain.handle('save-config', (_, config) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  restartDaemon()
  adaptPolling(windowVisible)
  return true
})

ipcMain.handle('read-csv-range', (_, dateFrom, dateTo) => {
  if (!fs.existsSync(CSV_PATH)) return []
  const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n')
  const rows  = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const [ts, db_z, db_a, vol_db, profile] = line.split(',')
    if (ts >= dateFrom && ts <= dateTo)
      rows.push({ ts, db_z: +db_z, db_a: +db_a, vol_db: +vol_db, profile })
  }
  return rows
})

ipcMain.handle('export-data',    () => exportData())
ipcMain.handle('restart-daemon', () => restartDaemon())

// Contrôles fenêtre depuis le titlebar custom
ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize())
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
})
ipcMain.on('win-close', () => mainWindow && mainWindow.hide())

// ══════════════════════════════════════════════════════════
// AUTO LAUNCH WINDOWS
// ══════════════════════════════════════════════════════════
function setAutoLaunch(enable) {
  if (process.platform !== 'win32') return
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  try {
    if (enable) execSync(`reg add "${key}" /v HifiGuard /t REG_SZ /d "${process.execPath}" /f`)
    else        execSync(`reg delete "${key}" /v HifiGuard /f`)
  } catch(e) { console.error('AutoLaunch:', e.message) }
}

// ══════════════════════════════════════════════════════════
// APP LIFECYCLE
// ══════════════════════════════════════════════════════════
app.whenReady().then(() => {
  const icon = buildTrayIcon('offline')
  tray = new Tray(icon)
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip('HifiGuard — Démarrage...')
  tray.on('click', () => showWindow())

  createWindow()
  startDaemon()
  adaptPolling(true)
  setAutoLaunch(true)
})

app.on('window-all-closed', e => e.preventDefault())
app.on('before-quit', () => {
  if (pollInterval) clearInterval(pollInterval)
  stopDaemon()
})
