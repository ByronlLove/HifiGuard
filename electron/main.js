const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron')
const path     = require('path')
const fs       = require('fs')
const readline = require('readline')
const LOCALES_DIR = app.isPackaged
  ? path.join(process.resourcesPath, '..', 'locales')
  : path.join(__dirname, '..', 'locales')
const { spawn, execSync } = require('child_process')

// ── Chemins ────────────────────────────────────────────────
app.setPath('userData', path.join(app.getPath('appData'), 'HifiGuard'))
const userDataPath = app.getPath('userData')
const DATA_DIR     = path.join(userDataPath, 'data')

const STATE_PATH   = path.join(DATA_DIR, 'state.json')
const CONFIG_PATH  = path.join(DATA_DIR, 'config.json')
const JSON_PATH    = path.join(DATA_DIR, 'suivi_audio.json')
const CSV_PATH     = path.join(DATA_DIR, 'historique.csv')

// En production (electron-builder), le daemon est compilé en .exe via PyInstaller
// et placé dans resources/daemon/hifiguard.exe
// En développement, on lance le .py directement avec python
const IS_PROD      = app.isPackaged
const DAEMON_PATH  = IS_PROD
  ? path.join(process.resourcesPath, 'daemon', 'hifiguard.exe')
  : path.join(__dirname, '..', 'daemon', 'hifiguard.py')
const PYTHON_CMD   = IS_PROD ? null : 'python'

// Création du dossier de données s'il n'existe pas
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ── Constantes normes (miroir de hifiguard.py) ───────────────
const NIOSH_CL    = 85.0    // Criterion Level dB(A)
const NIOSH_CT    = 480.0   // Criterion Time minutes
const WHO_DAY     = 2400.0 / 7   // minutes/jour OMS
const WHO_WEEK    = 2400.0  // minutes/semaine OMS
const WHO_SAFE    = 80.0

function permNiosh(db) {
  if (db < 70) return Infinity
  return NIOSH_CT / Math.pow(2, (db - NIOSH_CL) / 3)
}
function permWhoDay(db) {
  if (db < 70) return Infinity
  return WHO_DAY / Math.pow(2, (db - WHO_SAFE) / 3)
}

// ── Variables globales ─────────────────────────────────────
let tray          = null
let mainWindow    = null
let daemonProcess = null
let pollInterval  = null
let lastState     = null
let lastStateSent = null   // fingerprint pour éviter les IPC inutiles
let lastTrayZone  = null
let windowVisible = false
let isQuitting = false

// ── Timers adaptatifs ─────────────────────────────────────
let uiPollMs   = 250
let trayPollMs = 1000

// ── Cache suivi : relit le JSON max toutes les 10s ────────
let suiviCache     = null
let suiviCacheTime = 0
const SUIVI_TTL_MS = 10000

function readSuiviCached() {
  const now = Date.now()
  if (suiviCache && (now - suiviCacheTime) < SUIVI_TTL_MS) return suiviCache
  try {
    suiviCache     = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))
    suiviCacheTime = now
  } catch { suiviCache = {} }
  return suiviCache
}

// ══════════════════════════════════════════════════════════
// DAEMON
// ══════════════════════════════════════════════════════════
function startDaemon() {
  if (daemonProcess) return
  console.log('[Daemon] Démarrage...')
  const spawnArgs = IS_PROD
    ? [DAEMON_PATH, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }]
    : [PYTHON_CMD, ['-X', 'utf8', DAEMON_PATH], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }]
  daemonProcess = spawn(...spawnArgs)
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

// ══════════════════════════════════════════════════════════
// LECTURE CSV — streaming readline + downsampling dans le main process
//
// Principe :
//   - On ne fait JAMAIS de readFileSync sur historique.csv (peut faire 50+ Mo)
//   - On lit ligne par ligne via un stream readline non-bloquant
//   - Le downsampling se fait ici → le renderer reçoit max MAX_POINTS points
//   - secondsPerBucket > 0 : résolution fixe (1 pt par N secondes)
//   - secondsPerBucket = 0 : auto (découpe en MAX_POINTS buckets égaux)
// ══════════════════════════════════════════════════════════
const MAX_POINTS = 600

async function readCsvRangeStreamed(dateFrom, dateTo, secondsPerBucket) {
  if (!fs.existsSync(CSV_PATH)) return { rows: [], stats: null }

  const useFixed = secondsPerBucket > 0
  const buckets  = new Map()
  const rawRows  = []
  const allDbA   = []   // uniquement points avec son, pour moyenne/médiane
  let cumNiosh  = 0    // dose NIOSH cumulée (%) — calculée en streaming
  let cumWhoDay = 0    // dose OMS/jour cumulée (%)

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(CSV_PATH, { encoding: 'utf8' })
    const rl     = readline.createInterface({ input: stream, crlfDelay: Infinity })
    let header   = true

    rl.on('line', line => {
      if (header) { header = false; return }
      const s = line.trim()
      if (!s) return

      const c1 = s.indexOf(',')
      const c2 = s.indexOf(',', c1 + 1)
      const c3 = s.indexOf(',', c2 + 1)
      if (c1 < 0 || c2 < 0 || c3 < 0) return

      const ts = s.slice(0, c1)
      if (ts < dateFrom || ts > dateTo) return

      const db_z = parseFloat(s.slice(c1 + 1, c2))
      const db_a = parseFloat(s.slice(c2 + 1, c3))

      if (db_a > 0) allDbA.push(db_a)

      // Dose cumulée — recalculée fidèlement depuis le CSV (1 ligne = 1 seconde)
      // Même formule que hifiguard.py : dose += (1min/60) / T_permis * 100
      if (db_a >= 70) {
        const minFrac = 1 / 60
        const tn = permNiosh(db_a)
        const td = permWhoDay(db_a)
        if (isFinite(tn) && tn > 0) cumNiosh  += (minFrac / tn) * 100
        if (isFinite(td) && td > 0) cumWhoDay += (minFrac / td) * 100
      }

      if (useFixed) {
        const tSec = Math.floor(new Date(ts).getTime() / 1000 / secondsPerBucket)
        if (!buckets.has(tSec)) buckets.set(tSec, { sumA: 0, sumZ: 0, countA: 0, countZ: 0, maxA: 0, maxZ: 0, niosh: 0, whoDay: 0, ts })
        const b = buckets.get(tSec)
        if (db_a > 0) { b.sumA += db_a; b.countA++; if (db_a > b.maxA) b.maxA = db_a }
        if (db_z > 0) { b.sumZ += db_z; b.countZ++; if (db_z > b.maxZ) b.maxZ = db_z }
        b.niosh  = cumNiosh
        b.whoDay = cumWhoDay
      } else {
        rawRows.push({ ts, db_a, db_z, niosh: cumNiosh, whoDay: cumWhoDay })
      }
    })

    rl.on('close', resolve)
    rl.on('error', reject)
    stream.on('error', reject)
  })

  // Moyenne et médiane (sur les points avec son uniquement)
  let stats = null
  if (allDbA.length > 0) {
    const mean   = allDbA.reduce((s, v) => s + v, 0) / allDbA.length
    const sorted = [...allDbA].sort((a, b) => a - b)
    const mid    = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]
    stats = { mean: +mean.toFixed(1), median: +median.toFixed(1), count: allDbA.length }
  }

  let rows
  if (useFixed) {
    rows = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => ({
        ts:    b.ts,
        db_a:  b.maxA  || 0,
        db_z:  b.maxZ  || 0,
        niosh: b.niosh  || 0,
        whoDay:b.whoDay || 0,
      }))
  } else if (rawRows.length <= MAX_POINTS) {
    rows = rawRows
  } else {
    const step = Math.ceil(rawRows.length / MAX_POINTS)
    rows = []
    for (let i = 0; i < rawRows.length; i += step) {
      const seg    = rawRows.slice(i, i + step)
      const midRow = seg[Math.floor(seg.length / 2)]
      // db_a et db_z : MAX pour préserver les pics
      // niosh/whoDay : valeur du dernier point du bucket (dose cumulée à cet instant)
      const vA   = seg.map(r => r.db_a)
      const vZ   = seg.map(r => r.db_z).filter(v => v > 0)
      const last = seg[seg.length - 1]
      rows.push({
        ts:    midRow.ts,
        db_a:  Math.max(...vA),
        db_z:  vZ.length ? Math.max(...vZ) : 0,
        niosh: last.niosh  || 0,
        whoDay:last.whoDay || 0,
      })
    }
  }

  return { rows, stats }
}

// ══════════════════════════════════════════════════════════
// ICÔNE TRAY
// ══════════════════════════════════════════════════════════
function getTrayZone(db_a, thresholds) {
  // Si aucune donnée ou si le volume est à 0 (pas de son capté), on affiche l'icône grise
  if (db_a === null || db_a === undefined || db_a <= 0) return 'offline'
  
  const t = thresholds || { ok: 75, warn: 80, danger: 85 }
  if (db_a < t.ok)     return 'safe'
  if (db_a < t.warn)   return 'ok'
  if (db_a < t.danger) return 'warn'
  return 'danger'
}

function buildTrayIcon(zone) {
  // On pointe directement vers le dossier contenant tes icônes 64x64
  // Les zones possibles : 'safe', 'ok', 'warn', 'danger', 'offline'
  const iconPath = path.join(__dirname, '..', 'assets', 'tray', `${zone}.ico`);
  
  // Petite sécurité : si tu as oublié de mettre un fichier .ico, on évite le crash
  if (!fs.existsSync(iconPath)) {
    console.warn(`[Tray] Icône introuvable : ${iconPath}`);
    return nativeImage.createEmpty();
  }

  // On dit à Electron de charger ton icône Windows
  return nativeImage.createFromPath(iconPath);
}

let trayLastPoll = 0
function updateTray(state, now) {
  if (!tray) return
  if (now - trayLastPoll < trayPollMs) return
  trayLastPoll = now

  const cfg  = readConfig()
  const t    = cfg && cfg.tray_thresholds
  const db_a = state ? state.db_a : null
  const zone = getTrayZone(db_a, t)

  if (zone !== lastTrayZone) {
    tray.setImage(buildTrayIcon(zone))
    lastTrayZone = zone
  }

  if (state && db_a > 0) {
    tray.setToolTip(
      `HifiGuard\n${db_a} dB(A)\n` +
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
    { label: 'Relancer le daemon Python', click: () => restartDaemon() },
    { type: 'separator' },
    { label: 'Ouvrir le dossier des données', click: () => shell.showItemInFolder(DATA_DIR) },
    { label: 'Paramètres', click: () => { showWindow(); mainWindow && mainWindow.webContents.send('navigate', 'settings') } },
    { type: 'separator' },
    { label: 'Quitter', click: () => { 
        isQuitting = true;
        stopDaemon(); 
        app.quit(); 
      } 
    }
  ])
}

// ══════════════════════════════════════════════════════════
// FENÊTRE
// ══════════════════════════════════════════════════════════
function createWindow() {
  const winIcon = path.join(__dirname, '..', 'assets', 'icon256.ico')
  mainWindow = new BrowserWindow({
    width:  1120,
    height: 760,
    minWidth:  800,
    minHeight: 560,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1117',
    icon: winIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
  
  mainWindow.once('ready-to-show', () => { 
    mainWindow.show()
    windowVisible = true
    adaptPolling(true) 
  })
  
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools()
      else mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })
  
  mainWindow.on('focus',  () => { windowVisible = true;  adaptPolling(true)  })
  mainWindow.on('blur',   () => { windowVisible = false; adaptPolling(false) })
  
  // ── MODIFICATION ICI : On vérifie si on doit vraiment quitter ──
  mainWindow.on('close',  e  => { 
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      windowVisible = false
      adaptPolling(false)
    }
  })
  
  mainWindow.on('closed', () => { mainWindow = null })
}

function showWindow() {
  if (!mainWindow) createWindow()
  else { mainWindow.show(); mainWindow.focus() }
}

// ══════════════════════════════════════════════════════════
// POLLING — un seul setInterval, gère live + tray séparément
// ══════════════════════════════════════════════════════════
function adaptPolling(focused) {
  const cfg    = readConfig()
  const mode   = cfg && cfg.refresh_mode || 'focus'
  const custom = cfg && cfg.refresh_custom

  if (mode === 'eco') {
    uiPollMs = 1000; trayPollMs = 2000
  } else if (mode === 'custom' && custom) {
    uiPollMs = custom.ui_ms || 1000; trayPollMs = custom.tray_ms || 1000
  } else if (mode === 'focus') {
    uiPollMs = focused ? 250 : 1000; trayPollMs = 1000
  } else if (mode === 'tray') {
    uiPollMs = 1000; trayPollMs = 1000
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
  lastState = state

  const now = Date.now()

  // Tray géré avec son propre throttle dans updateTray()
  updateTray(state, now)

  // state-update : toujours envoyé si la fenêtre existe (visible ou non)
  // Le renderer gère lui-même ce qu'il affiche selon la page active
  if (mainWindow && !mainWindow.isDestroyed()) {
    const fingerprint = `${state.ts}|${state.db_a}`
    if (fingerprint !== lastStateSent) {
      lastStateSent = fingerprint
      mainWindow.webContents.send('state-update', state)
    }
  }
}

// ══════════════════════════════════════════════════════════
// IPC HANDLERS
// ══════════════════════════════════════════════════════════

// ── Live (thread renderer dédié au live) ──────────────────
// Renvoie le state déjà en mémoire — zéro I/O
ipcMain.handle('get-state', () => lastState || readState())

// ── Config ────────────────────────────────────────────────
ipcMain.handle('get-config', () => readConfig())

// ── Suivi : avec cache 10s ────────────────────────────────
// Le renderer demande ponctuellement, pas en boucle serrée
ipcMain.handle('get-suivi', () => readSuiviCached())

ipcMain.handle('save-config', (_, config) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  restartDaemon()
  adaptPolling(windowVisible)
  return true
})

// ── CSV : stream async + downsampling ici ─────────────────
// secondsPerBucket transmis par le renderer (0 = auto)
// Le renderer reçoit MAX_POINTS points max — jamais les rows brutes
ipcMain.handle('read-csv-range', async (_, dateFrom, dateTo, secondsPerBucket = 0) => {
  try {
    return await readCsvRangeStreamed(dateFrom, dateTo, secondsPerBucket)
  } catch (err) {
    console.error('[CSV] Erreur lecture:', err.message)
    return { rows: [], stats: null }
  }
})

ipcMain.handle('get-locale', () => {
  const cfg  = readConfig()
  const lang = (cfg && cfg.language) || 'en'
  try {
    const p = path.join(LOCALES_DIR, lang + '.json')
    return JSON.parse(require('fs').readFileSync(p, 'utf8'))
  } catch {
    const p = path.join(LOCALES_DIR, 'en.json')
    return JSON.parse(require('fs').readFileSync(p, 'utf8'))
  }
})

ipcMain.handle('set-language', async (_, lang) => {
  const cfg = readConfig() || {}
  cfg.language = lang
  require('fs').writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
  return true
})

ipcMain.handle('open-data-folder', () => { shell.showItemInFolder(DATA_DIR); return true })
ipcMain.handle('restart-daemon', () => restartDaemon())

// ── Suppression de données ────────────────────────────────
ipcMain.handle('delete-day-data', async (_, dateKey) => {
  // dateKey = "2026-04-12"
  try {
    // 1. Supprimer du suivi JSON
    const suivi = readSuiviCached()
    if (suivi[dateKey]) {
      delete suivi[dateKey]
      fs.writeFileSync(JSON_PATH, JSON.stringify(suivi, null, 2))
      suiviCache = suivi
      suiviCacheTime = Date.now()
    }
    // 2. Filtrer le CSV — réécrire sans les lignes du jour
    if (fs.existsSync(CSV_PATH)) {
      const prefix = dateKey + 'T'
      const lines  = fs.readFileSync(CSV_PATH, 'utf8').split('\n')
      const kept   = lines.filter((l, i) => i === 0 || !l.startsWith(prefix))
      fs.writeFileSync(CSV_PATH, kept.join('\n'))
    }
    restartDaemon()
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('delete-month-data', async (_, year, month) => {
  // year = 2026, month = 4 (1-based)
  try {
    const prefix = `${year}-${String(month).padStart(2,'0')}`
    // 1. Supprimer du suivi JSON
    const suivi = readSuiviCached()
    Object.keys(suivi).forEach(k => { if (k.startsWith(prefix)) delete suivi[k] })
    fs.writeFileSync(JSON_PATH, JSON.stringify(suivi, null, 2))
    suiviCache = suivi; suiviCacheTime = Date.now()
    // 2. Filtrer le CSV
    if (fs.existsSync(CSV_PATH)) {
      const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n')
      const kept  = lines.filter((l, i) => i === 0 || !l.startsWith(prefix))
      fs.writeFileSync(CSV_PATH, kept.join('\n'))
    }
    restartDaemon()
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('delete-old-data', async (_, keepDays) => {
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - keepDays)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    // 1. Suivi JSON
    const suivi = readSuiviCached()
    Object.keys(suivi).forEach(k => { if (k < cutoffStr) delete suivi[k] })
    fs.writeFileSync(JSON_PATH, JSON.stringify(suivi, null, 2))
    suiviCache = suivi; suiviCacheTime = Date.now()
    // 2. CSV
    if (fs.existsSync(CSV_PATH)) {
      const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n')
      const kept  = lines.filter((l, i) => i === 0 || l.slice(0, 10) >= cutoffStr)
      fs.writeFileSync(CSV_PATH, kept.join('\n'))
    }
    restartDaemon()
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ── Contrôles fenêtre ─────────────────────────────────────
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
  } catch (e) { console.error('AutoLaunch:', e.message) }
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
  isQuitting = true // Sécurité supplémentaire
  if (pollInterval) clearInterval(pollInterval)
  stopDaemon()
  // ── MODIFICATION ICI : Destruction du "fantôme" ──
  if (tray) tray.destroy() 
})
