// ══════════════════════════════════════════════════════════
// HIFIGUARD — Renderer
// ══════════════════════════════════════════════════════════
Chart.defaults.color = '#64748b'
Chart.defaults.borderColor = '#2e3350'
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
Chart.register(ChartZoom)

// ── État ─────────────────────────────────────────────────
let currentPage = 'today'
let L = {}  // locale strings
let calView = 'year', calYear = new Date().getFullYear()
let calMonth = new Date().getMonth(), calDay = null
let config = null, suivi = {}
let chartToday = null, chartDay = null
let isPaused = false

// Données session courante (points live)
let sessionData = { labels: [], dba: [], niosh: [], omsj: [], lastTs: null }
// Accumulateur pour le bucket en cours (respecte todayResolution)
// maxDb = pic du bucket, lastFlush = timestamp du dernier point écrit
let sessionBucket = { maxDba: 0, lastFlush: null }
const SESSION_MAX = 90000  // journée entière (~25h × 3600s/h, largement suffisant)

// Résolution pour le graphe calendrier (jour historique)
let dayResolution = 0
// Métrique affichée dans la vue mois du calendrier
// oms | niosh | mean | median | peak | mean_z
let calMetric = 'oms'
// Résolution pour le graphe aujourd'hui
// 0 = auto, sinon valeur fixe en secondes
let todayResolution = 0

// Buffer haute précision : 10 dernières minutes à ~1pt/s, gardé en RAM
// Utilisé pour le double-clic "10 dernières min" avec toute la précision
const HIRES_MAX = 2400  // 1 min × (1000ms/25ms) = 2400 pts à 25ms/pt
let hiresBuffer = { labels: [], dba: [], niosh: [], omsj: [], lastTs: null }

const COLORS = { dba:'#6366f1', niosh:'#f97316', omsj:'#22c55e', dbz:'#475569' }
// MONTHS et DAYS sont définis depuis la locale dans init()
let MONTHS = []
let DAYS   = []

// ── Boucle RAF séparée du live ────────────────────────────
// Le chart ne redessine que si des données ont changé,
// indépendamment des polls réseau/IPC
let chartTodayDirty = false
let chartDayDirty   = false
let followMode = false   // scroll auto quand ancré à droite
let hiresMode  = false   // affiche hiresBuffer (10min précis) au lieu de sessionData

function applyTranslations() {
  // Cherche tous les éléments HTML qui ont un attribut data-i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (L[key]) {
      // Si c'est un champ de saisie, on traduit le placeholder, sinon on traduit le texte
      if (el.tagName === 'INPUT') el.placeholder = L[key];
      else el.innerHTML = L[key];
    }
  });
}

function rafLoop() {
  if (chartTodayDirty && chartToday) {
    // En mode hires : copie fraîche du hiresBuffer à chaque frame dirty
    if (hiresMode) {
      chartToday.data.labels           = [...hiresBuffer.labels]
      chartToday.data.datasets[0].data = [...hiresBuffer.dba]
      chartToday.data.datasets[1].data = [...hiresBuffer.niosh]
      chartToday.data.datasets[2].data = [...hiresBuffer.omsj]
    }
    // Follow mode : décaler la fenêtre pour garder le dernier point visible
    if (followMode) {
      const xScale = chartToday.scales.x
      const total  = chartToday.data.labels.length - 1
      if (xScale && total > 0) {
        const winSize = Math.max(xScale.max - xScale.min, 1)
        chartToday.zoomScale('x', { min: Math.max(0, total - winSize), max: total }, 'none')
      }
    }
    chartToday.update('none')
    chartTodayDirty = false
  }
  if (chartDayDirty && chartDay) {
    chartDay.update('none')
    chartDayDirty = false
  }
  requestAnimationFrame(rafLoop)
}
requestAnimationFrame(rafLoop)

// ── Cache suivi côté renderer ─────────────────────────────
// On ne re-demande au main que toutes les SUIVI_TTL ms
// (le main a son propre cache de 10s côté fichier)
let suiviLastFetch = 0
const SUIVI_TTL = 30000   // 30s : le suivi ne change que quand il y a du son

async function getSuiviThrottled() {
  const now = Date.now()
  if (now - suiviLastFetch > SUIVI_TTL) {
    suivi = await window.hifi.getSuivi()
    suiviLastFetch = now
  }
  return suivi
}

// ── Contrôles fenêtre ────────────────────────────────────
document.getElementById('btn-minimize').onclick = () => window.hifi.winMinimize()
document.getElementById('btn-maximize').onclick = () => window.hifi.winMaximize()
document.getElementById('btn-close').onclick    = () => window.hifi.winClose()
document.getElementById('hamburger').onclick    = () => {
  document.getElementById('sidebar').classList.toggle('collapsed')
}

// ── Navigation ───────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(el => {
  el.addEventListener('click', () => navigateTo(el.dataset.page))
})
window.hifi.onNavigate(page => navigateTo(page))

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(e => e.classList.toggle('active', e.dataset.page === page))
  document.querySelectorAll('.page').forEach(e => e.classList.toggle('active', e.id === 'page-' + page))
  currentPage = page
  if (page === 'calendar') renderCalendar()
  if (page === 'settings') renderSettings()
}

// ── Couleur selon dB ─────────────────────────────────────
function getThresholds() {
  return (config && config.tray_thresholds) || { ok:75, warn:80, danger:85 }
}
function dbColor(db) {
  const t = getThresholds()
  if (!db || db <= 0) return 'var(--muted)'
  if (db < t.ok)     return 'var(--safe)'
  if (db < t.warn)   return '#84cc16'
  if (db < t.danger) return 'var(--warn)'
  return 'var(--danger)'
}

// ── Context menu ─────────────────────────────────────────────
let ctxTarget = null  // { type: 'day'|'month', key: '2026-04' | '2026-04-12' }

function showCtxMenu(e, type, key) {
  e.preventDefault()
  ctxTarget = { type, key }
  const menu  = document.getElementById('ctx-menu')
  const title = document.getElementById('ctx-title')
  const delDay   = document.getElementById('ctx-delete-day')
  const delMonth = document.getElementById('ctx-delete-month')

  if (type === 'day') {
    const [y,m,d] = key.split('-')
    title.textContent = `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y}`
    delDay.style.display   = 'flex'
    delMonth.style.display = 'none'
  } else {
    const [y,m] = key.split('-')
    title.textContent = `${MONTHS[parseInt(m)-1]} ${y}`
    delDay.style.display   = 'none'
    delMonth.style.display = 'flex'
  }

  // Positionner le menu
  const x = Math.min(e.clientX, window.innerWidth  - 200)
  const y2 = Math.min(e.clientY, window.innerHeight - 120)
  menu.style.left = x + 'px'
  menu.style.top  = y2 + 'px'
  menu.classList.add('visible')
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.remove('visible')
  ctxTarget = null
}

document.addEventListener('click',       hideCtxMenu)
document.addEventListener('contextmenu', e => { if (!e.target.closest('#ctx-menu')) hideCtxMenu() })

document.getElementById('ctx-delete-day').addEventListener('click', async () => {
  if (!ctxTarget) return
  const key = ctxTarget.key
  const [y,m,d] = key.split('-')
  hideCtxMenu()
  showConfirm(
    `Supprimer le ${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y} ?`,
    'Toutes les mesures de ce jour seront effacées définitivement.',
    async () => {
      const r = await window.hifi.deleteDayData(key)
      if (r.ok) {
        suivi = await window.hifi.getSuivi(); suiviLastFetch = Date.now()
        if (calView === 'month') renderViewMonth()
        else renderViewYear()
      }
    }
  )
})

document.getElementById('ctx-delete-month').addEventListener('click', async () => {
  if (!ctxTarget) return
  const [y, m] = ctxTarget.key.split('-')
  hideCtxMenu()
  showConfirm(
    `Supprimer ${MONTHS[parseInt(m)-1]} ${y} ?`,
    'Toutes les mesures de ce mois seront effacées définitivement.',
    async () => {
      const r = await window.hifi.deleteMonthData(parseInt(y), parseInt(m))
      if (r.ok) {
        suivi = await window.hifi.getSuivi(); suiviLastFetch = Date.now()
        renderViewYear()
      }
    }
  )
})


// ── Popups custom ────────────────────────────────────────
function showConfirm(title, message, onConfirm) {
  document.getElementById('modal-title').textContent   = title
  document.getElementById('modal-message').textContent = message
  document.getElementById('modal-overlay').classList.add('visible')
  const btnOk     = document.getElementById('modal-ok')
  const btnCancel = document.getElementById('modal-cancel')
  const close = () => document.getElementById('modal-overlay').classList.remove('visible')
  btnOk.onclick     = () => { close(); onConfirm() }
  btnCancel.onclick = close
}

function showToast(message) {
  let toast = document.getElementById('hifi-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'hifi-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.classList.add('visible')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => toast.classList.remove('visible'), 3000)
}

// Boutons métrique calendrier
document.querySelectorAll('.metric-btn').forEach(el => {
  el.addEventListener('click', () => {
    calMetric = el.dataset.metric
    document.querySelectorAll('.metric-btn').forEach(b => b.classList.toggle('active', b.dataset.metric === calMetric))
    if (calView === 'month') renderViewMonth()
  })
})

// ══════════════════════════════════════════════════════════
// LIVE — deux voies découplées
//
// Voie 1 : push via state-update (main → renderer, sans poll)
//          → met à jour l'UI live immédiatement
// Voie 2 : fallback poll à 1s si le push ne passe pas
//          (fenêtre en arrière-plan, etc.)
// Le chart TODAY est marqué dirty → redessiné par la RAF loop
// ══════════════════════════════════════════════════════════
let livePollInterval = null

function startLivePoll() {
  // Le push IPC state-update arrive maintenant même fenêtre cachée.
  // Fallback poll 1s en secours au cas où le push IPC rate (redémarrage daemon, etc.)
  livePollInterval = setInterval(async () => {
    if (isPaused || !document.hidden) return   // si visible, le push s'en charge
    const state = await window.hifi.getState()
    if (state) feedHiresBuffer(state)   // en tray : juste le buffer, pas le DOM
  }, 1000)
}

// Push depuis le main (prioritaire, ~250ms en mode focus)
window.hifi.onStateUpdate(state => {
  if (!isPaused) handleLiveState(state)
})

function handleLiveState(state) {
  // hiresBuffer : toujours, que la fenêtre soit visible ou non
  feedHiresBuffer(state)
  // DOM : seulement si la fenêtre est au premier plan
  if (!document.hidden) {
    updateLive(state)
    updateTitlebar(state)
    if (currentPage === 'today' && !isPaused) {
      appendTodayPoint(state)
    }
  }
}

// ══════════════════════════════════════════════════════════
// TITLEBAR
// ══════════════════════════════════════════════════════════
function updateTitlebar(state) {
  const db = state && state.db_a > 0 ? state.db_a.toFixed(1) + ' dB(A)' : '--'
  const el = document.getElementById('titlebar-db')
  el.textContent = db + ' '
  el.style.color = state ? dbColor(state.db_a) : 'var(--muted)'
  if (config) document.getElementById('titlebar-profile').textContent = '— ' + config.active_profile
}

// ══════════════════════════════════════════════════════════
// LIVE SIDEBAR
// ══════════════════════════════════════════════════════════
function updateLive(state) {
  const db  = state ? state.db_a : 0
  const col = dbColor(db)
  document.getElementById('live-db').textContent       = db > 0 ? db.toFixed(1) : '--'
  document.getElementById('live-db').style.color       = col
  document.getElementById('live-bar').style.width      = Math.min((db || 0) / 120 * 100, 100) + '%'
  document.getElementById('live-bar').style.background = col
  document.getElementById('live-niosh').textContent    = state ? state.dose_niosh.toFixed(1) + '%'  : '--%'
  document.getElementById('live-oms-j').textContent    = state ? state.dose_who_j.toFixed(1) + '%'  : '--%'
  document.getElementById('live-oms-7j').textContent   = state ? state.dose_who_7j.toFixed(1) + '%' : '--%'
}

// ══════════════════════════════════════════════════════════
// GAPS
// Insère un point null à chaque gap > 3s pour casser la ligne.
// null = vrai trou temporel. 0 = silence musique → reste tracé à 0.
// ══════════════════════════════════════════════════════════
// Parse un timestamp ISO local (sans Z, sans offset) en millisecondes locaux.
// Évite que JS interprète "2026-04-12T22:01:22" comme UTC au lieu d'heure locale.
function localIsoToMs(ts) {
  // "2026-04-12T22:01:22.123" ou "2026-04-12T22:01:22"
  const [datePart, timePart] = ts.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi, sPart = '0'] = timePart.split(':')
  const s = parseFloat(sPart)
  return new Date(y, mo - 1, d, +h, +mi, Math.floor(s), Math.round((s % 1) * 1000)).getTime()
}

function insertGaps(rows) {
  if (rows.length < 2) return rows

  // Calculer l'espacement médian entre les points pour adapter le seuil de gap.
  // Évite d'insérer des nulls entre chaque point quand les données sont downsamplées.
  const gaps = []
  for (let i = 1; i < Math.min(rows.length, 50); i++) {
    if (rows[i].ts && rows[i-1].ts) {
      const g = localIsoToMs(rows[i].ts) - localIsoToMs(rows[i-1].ts)
      if (g > 0) gaps.push(g)
    }
  }
  gaps.sort((a, b) => a - b)
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1000
  // Seuil = 3× l'espacement médian, minimum 3s, maximum 10 min
  const threshold = Math.max(3000, Math.min(medianGap * 3, 600000))

  const result = []
  for (let i = 0; i < rows.length; i++) {
    result.push(rows[i])
    if (i < rows.length - 1 && rows[i].ts && rows[i+1].ts) {
      const gap = localIsoToMs(rows[i+1].ts) - localIsoToMs(rows[i].ts)
      if (gap > threshold) result.push({ ts: null, db_z: null, db_a: null })
    }
  }
  return result
}

// ══════════════════════════════════════════════════════════
// OPTIONS CHART COMMUNES
// ══════════════════════════════════════════════════════════
const ZOOM_OPTIONS = {
  zoom: {
    wheel:  { enabled: true },
    pinch:  { enabled: true },
    mode:   'x',
    onZoom: ({ chart }) => { checkFollowMode(chart) }
  },
  pan: {
    enabled: true,
    mode:    'x',
    onPan:   ({ chart }) => { checkFollowMode(chart) }
  }
}

// Vérifie si la vue est ancrée à l'extrémité droite des données.
// Si oui, active le follow mode (la courbe avance en direct).
function checkFollowMode(chart) {
  if (chart !== chartToday) return
  const xScale = chart.scales.x
  if (!xScale)  return
  const total   = chart.data.labels.length - 1
  followMode    = (total - xScale.max) <= 3

  // Si on pan vers la gauche en mode hires → sortir du mode hires
  // et revenir aux sessionData (journée entière)
  if (!followMode && hiresMode) {
    hiresMode = false
    // Copie des sessionData pour éviter les mutations partagées
    chart.data.labels           = [...sessionData.labels]
    chart.data.datasets[0].data = [...sessionData.dba]
    chart.data.datasets[1].data = [...sessionData.niosh]
    chart.data.datasets[2].data = [...sessionData.omsj]
    chart.resetZoom()
    chartTodayDirty = true
  }
}

const TOOLTIP_OPTIONS = {
  mode: 'index',
  intersect: false,
  backgroundColor: 'rgba(15,17,23,0.92)',
  borderColor: '#2e3350',
  borderWidth: 1,
  titleColor: '#e2e8f0',
  bodyColor: '#94a3b8',
  padding: 10,
  callbacks: {
    label(ctx) {
      const v = ctx.parsed.y
      if (v === null || v === undefined) return null
      return ` ${ctx.dataset.label}: ${v.toFixed(1)}${ctx.dataset.yAxisID === 'y2' ? '%' : ' dB'}`
    }
  }
}

// ══════════════════════════════════════════════════════════
// CHART TODAY
// ══════════════════════════════════════════════════════════
function initChartToday() {
  const ctx = document.getElementById('chart-today').getContext('2d')
  const datasets = [
    { label:'dB(A)',   data:[], borderColor:COLORS.dba,   borderWidth:2,   pointRadius:0, tension:0.3, yAxisID:'y',  spanGaps:false },
    { label:'NIOSH %', data:[], borderColor:COLORS.niosh, borderWidth:1.5, pointRadius:0, tension:0.3, yAxisID:'y2', borderDash:[4,4], spanGaps:false },
    { label:'OMS/j %', data:[], borderColor:COLORS.omsj,  borderWidth:1.5, pointRadius:0, tension:0.3, yAxisID:'y2', borderDash:[4,4], spanGaps:false },
  ]
  chartToday = new Chart(ctx, {
    type:'line', data:{ labels:[], datasets },
    options:{
      animation:false, responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false, axis:'x' },
      plugins:{ legend:{ display:false }, zoom:ZOOM_OPTIONS, tooltip:TOOLTIP_OPTIONS },
      scales:{
        x:  { ticks:{ maxTicksLimit:8, maxRotation:0 } },
        y:  { position:'left',  title:{ display:true, text:'dB(A)' }, min:0, max:120 },
        y2: { position:'right', title:{ display:true, text:'Dose %' }, min:0, max:100, grid:{ drawOnChartArea:false } }
      }
    }
  })
  document.getElementById('chart-today').addEventListener('dblclick', () => {
  if (hiresMode) {
    // Deuxième double-clic : quitter le mode hires, revenir à la journée
    hiresMode  = false
    followMode = false
    chartToday.data.labels           = [...sessionData.labels]
    chartToday.data.datasets[0].data = [...sessionData.dba]
    chartToday.data.datasets[1].data = [...sessionData.niosh]
    chartToday.data.datasets[2].data = [...sessionData.omsj]
    chartToday.resetZoom()
    chartTodayDirty = true
  } else {
    zoomToLast10Min(chartToday)
  }
})
  buildLegend('legend-today', chartToday, datasets)
}

async function reloadTodayFromCSV() {
  const today  = new Date().toISOString().slice(0, 10)
  document.getElementById('loading-today')?.classList.remove('hidden')
  const result = await window.hifi.readCsvRange(today + 'T00:00:00', today + 'T23:59:59', todayResolution)
  const rows   = result.rows || result
  document.getElementById('loading-today')?.classList.add('hidden')
  if (!rows.length) return

  const withGaps = insertGaps(rows)
  sessionData.labels = withGaps.map(r => r.ts ? r.ts.slice(11, 19) : null)
  sessionData.dba    = withGaps.map(r => r.db_a !== null ? r.db_a : null)
  sessionData.niosh  = withGaps.map(r => r.db_a !== null ? null : null)  // rempli par suivi
  sessionData.omsj   = withGaps.map(() => null)
  sessionData.lastTs = rows.length ? rows[rows.length - 1].ts : null

  if (chartToday) {
    chartToday.data.labels           = sessionData.labels
    chartToday.data.datasets[0].data = sessionData.dba
    chartToday.data.datasets[1].data = sessionData.niosh
    chartToday.data.datasets[2].data = sessionData.omsj
    // Ne pas toucher au mode hires si l'utilisateur est dessus
    if (!hiresMode) {
      followMode = false
      chartToday.resetZoom()
    }
    chartTodayDirty = true
  }
}

function appendTodayPoint(state) {
  const today = new Date().toISOString().slice(0, 10)
  const d   = suivi[today] || {}
  const col = dbColor(state.db_a)

  document.getElementById('s-db').textContent    = state.db_a > 0 ? state.db_a.toFixed(1) + ' dB' : '--'
  document.getElementById('s-db').style.color    = col
  document.getElementById('s-niosh').textContent = (d.dose_niosh_pct    || 0).toFixed(1) + '%'
  document.getElementById('s-omsj').textContent  = (d.dose_who_day_pct  || 0).toFixed(1) + '%'
  document.getElementById('s-oms7j').textContent = state.dose_who_7j.toFixed(1) + '%'
  document.getElementById('s-max').textContent   = (d.max_db_a           || 0).toFixed(1) + ' dB'
  document.getElementById('s-t80').textContent   = (d.minutes_above_80   || 0).toFixed(1) + ' min'
  renderDoseBars({ niosh: d.dose_niosh_pct || 0, omsj: d.dose_who_day_pct || 0, oms7j: state.dose_who_7j })

  // Recharger suivi throttlé (30s) pour avoir les stats à jour
  getSuiviThrottled()

  // Le daemon écrit datetime.now().isoformat() = heure locale sans timezone.
  // new Date("2026-04-12T22:01:22") est interprété UTC par JS → décalage en FR.
  // On parse manuellement pour forcer l'interprétation en heure locale.
  const nowTs  = state.ts || new Date().toISOString()
  const label  = nowTs.slice(11, 19)
  const nowMs  = localIsoToMs(nowTs)

  // Accumuler le max dans le bucket en cours
  if (state.db_a > 0) sessionBucket.maxDba = Math.max(sessionBucket.maxDba, state.db_a)

  // Intervalle d'écriture selon todayResolution
  // todayResolution=0 → 1s (même résolution que le CSV)
  const flushIntervalMs = (todayResolution > 0 ? todayResolution : 1) * 1000

  const lastFlush = sessionBucket.lastFlush
  const elapsedMs = lastFlush ? (nowMs - localIsoToMs(lastFlush)) : flushIntervalMs

  // Flush seulement si l'intervalle est écoulé
  if (elapsedMs < flushIntervalMs) return

  // Détecter un gap (pause, redémarrage)
  const lastTs = sessionData.lastTs
  if (lastTs) {
    const gapMs = localIsoToMs(nowTs) - localIsoToMs(lastTs)
    if (gapMs > flushIntervalMs * 2 || gapMs < 0) {
      sessionData.labels.push(null); sessionData.dba.push(null)
      sessionData.niosh.push(null);  sessionData.omsj.push(null)
    }
  }
  sessionData.lastTs     = nowTs
  sessionBucket.lastFlush = nowTs

  sessionData.labels.push(label)
  sessionData.dba.push(sessionBucket.maxDba > 0 ? sessionBucket.maxDba : 0)
  sessionData.niosh.push(d.dose_niosh_pct  || null)
  sessionData.omsj.push(d.dose_who_day_pct || null)

  // Reset bucket
  sessionBucket.maxDba = 0

  if (sessionData.labels.length > SESSION_MAX) {
    const trim = sessionData.labels.length - SESSION_MAX
    sessionData.labels.splice(0, trim); sessionData.dba.splice(0, trim)
    sessionData.niosh.splice(0, trim);  sessionData.omsj.splice(0, trim)
  }

  if (chartToday) {
    // En mode hires, ne pas écraser les données du chart avec sessionData —
    // la RAF loop s'en charge avec une copie fraîche du hiresBuffer
    if (!hiresMode) {
      chartToday.data.labels           = sessionData.labels
      chartToday.data.datasets[0].data = sessionData.dba
      chartToday.data.datasets[1].data = sessionData.niosh
      chartToday.data.datasets[2].data = sessionData.omsj
    }
    chartTodayDirty = true
  }

}

// Alimente le hiresBuffer en permanence — appelé pour chaque state reçu
// indépendamment de la page visible ou du mode tray
function feedHiresBuffer(state) {
  const today  = new Date().toISOString().slice(0, 10)
  const d      = suivi[today] || {}
  const nowTs  = state.ts || new Date().toISOString()
  const label  = nowTs.slice(11, 19)

  const lastHiTs = hiresBuffer.lastTs
  if (lastHiTs) {
    const gapHi = localIsoToMs(nowTs) - localIsoToMs(lastHiTs)
    if (gapHi > 3000 || gapHi < 0) {
      hiresBuffer.labels.push(null); hiresBuffer.dba.push(null)
      hiresBuffer.niosh.push(null);  hiresBuffer.omsj.push(null)
    }
  }
  hiresBuffer.lastTs = nowTs
  hiresBuffer.labels.push(label)
  hiresBuffer.dba.push(state.db_a > 0 ? state.db_a : 0)
  hiresBuffer.niosh.push(d.dose_niosh_pct  || null)
  hiresBuffer.omsj.push(d.dose_who_day_pct || null)
  if (hiresBuffer.labels.length > HIRES_MAX) {
    const t = hiresBuffer.labels.length - HIRES_MAX
    hiresBuffer.labels.splice(0,t); hiresBuffer.dba.splice(0,t)
    hiresBuffer.niosh.splice(0,t);  hiresBuffer.omsj.splice(0,t)
  }
  // Si on est en hiresMode, marquer le chart dirty pour la RAF loop
  if (hiresMode && chartToday) chartTodayDirty = true
}

function zoomToLast10Min(chart) {
  if (chart !== chartToday || hiresBuffer.labels.length < 2) return
  hiresMode  = true
  followMode = true
  // Copier (pas pointer) les données hires dans le chart
  // pour éviter que appendTodayPoint modifie le tableau pendant le rendu
  chart.data.labels           = [...hiresBuffer.labels]
  chart.data.datasets[0].data = [...hiresBuffer.dba]
  chart.data.datasets[1].data = [...hiresBuffer.niosh]
  chart.data.datasets[2].data = [...hiresBuffer.omsj]
  chart.resetZoom()
  chartTodayDirty = true
}

// ══════════════════════════════════════════════════════════
// DOSE BARS
// ══════════════════════════════════════════════════════════
function renderDoseBars(doses) {
  document.getElementById('dose-bars').innerHTML = [
    { name:'NIOSH',    val: doses ? doses.niosh  : 0, color:COLORS.niosh, sub:'85 dB(A)/8h'     },
    { name:'OMS/jour', val: doses ? doses.omsj   : 0, color:COLORS.omsj,  sub:'80 dB(A)/342min' },
    { name:'OMS/7j',   val: doses ? doses.oms7j  : 0, color:'#a855f7',    sub:'80 dB(A)/40h'   },
  ].map(it => {
    const pct = Math.min(it.val || 0, 100)
    const col = it.val > 80 ? 'var(--danger)' : it.val > 50 ? 'var(--warn)' : it.color
    return `<div class="dose-row">
      <div class="dose-name" title="Seuil : ${it.sub}">${it.name}</div>
      <div class="dose-track"><div class="dose-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="dose-pct" style="color:${col}">${(it.val || 0).toFixed(1)}%</div>
    </div>`
  }).join('')
}

// ══════════════════════════════════════════════════════════
// PAUSE
// ══════════════════════════════════════════════════════════
function togglePause() {
  isPaused = !isPaused
  const pauseItem = document.getElementById('legend-pause-item')
  if (pauseItem) {
    pauseItem.classList.toggle('paused', isPaused)
    pauseItem.querySelector('.legend-label').textContent = isPaused ? '⏸ En pause' : '⏵ Espace = Pause'
    pauseItem.style.color = isPaused ? 'var(--warn)' : ''
  }
}

// ══════════════════════════════════════════════════════════
// LÉGENDE
// ══════════════════════════════════════════════════════════
function buildLegend(containerId, chart, datasets) {
  const c = document.getElementById(containerId)
  c.innerHTML = ''
  datasets.forEach((ds, i) => {
    const el = document.createElement('div')
    el.className = 'legend-item'
    el.innerHTML = `<div class="legend-dot" style="background:${ds.borderColor}"></div><span class="legend-label">${ds.label}</span>`
    el.addEventListener('click', () => {
      const meta = chart.getDatasetMeta(i)
      meta.hidden = !meta.hidden
      el.classList.toggle('hidden', meta.hidden)
      chart.update()
    })
    c.appendChild(el)
  })
  if (containerId === 'legend-today') {
    const pauseEl = document.createElement('div')
    pauseEl.className = 'legend-item'
    pauseEl.id = 'legend-pause-item'
    pauseEl.style.marginLeft = 'auto'
    pauseEl.innerHTML = `<span class="legend-label" style="color:var(--muted)">⏵ Espace = Pause</span>`
    pauseEl.addEventListener('click', togglePause)
    c.appendChild(pauseEl)
  }
}

// ══════════════════════════════════════════════════════════
// CHART DAY — recréé à chaque ouverture de jour
// (destroy + recreate garantit les bonnes dimensions du canvas)
// ══════════════════════════════════════════════════════════
function initChartDay() {
  // Ne rien créer au boot — le canvas est dans une page cachée (0x0)
  // createChartDay() est appelé dans renderViewDay() après que le DOM est visible
}

function createChartDay() {
  if (chartDay) { chartDay.destroy(); chartDay = null }
  const canvas   = document.getElementById('chart-day')
  const ctx      = canvas.getContext('2d')
  // Les 4 datasets sont déclarés dès la création — fillDayChart ne fait que remplir.
  // Ça évite les push() dynamiques qui cassent le rendu Chart.js.
  const datasets = [
    { label:'dB(A)',    data:[], borderColor:COLORS.dba,             borderWidth:1.5, pointRadius:0, tension:0.2, spanGaps:false, yAxisID:'y'  },
    { label:'dB(Z)',    data:[], borderColor:COLORS.dbz,             borderWidth:1,   pointRadius:0, tension:0.2, borderDash:[3,3], spanGaps:false, yAxisID:'y'  },
    { label:'Moyenne',  data:[], borderColor:'rgba(99,102,241,0.55)',borderWidth:1.5, pointRadius:0, tension:0,   borderDash:[6,3], spanGaps:true,  yAxisID:'y'  },
    { label:'Médiane',  data:[], borderColor:'rgba(249,115,22,0.55)',borderWidth:1.5, pointRadius:0, tension:0,   borderDash:[2,4], spanGaps:true,  yAxisID:'y'  },
    { label:'NIOSH %',  data:[], borderColor:COLORS.niosh,           borderWidth:1.5, pointRadius:0, tension:0.3, borderDash:[4,4], spanGaps:true,  yAxisID:'y2' },
    { label:'OMS/j %',  data:[], borderColor:COLORS.omsj,            borderWidth:1.5, pointRadius:0, tension:0.3, borderDash:[4,4], spanGaps:true,  yAxisID:'y2' },
  ]
  chartDay = new Chart(ctx, {
    type:'line', data:{ labels:[], datasets },
    options:{
      animation:false, responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false, axis:'x' },
      plugins:{ legend:{ display:false }, zoom:ZOOM_OPTIONS, tooltip:TOOLTIP_OPTIONS },
      scales:{
        x:  { ticks:{ maxTicksLimit:10, maxRotation:0 } },
        y:  { position:'left',  title:{ display:true, text:'dB' }, min:0, max:120 },
        y2: { position:'right', title:{ display:true, text:'Dose %' }, min:0, max:100, grid:{ drawOnChartArea:false } }
      }
    }
  })
  canvas.addEventListener('dblclick', () => { chartDay.resetZoom(); chartDayDirty = true })
  buildLegend('legend-day', chartDay, datasets)
  renderDayStats(null)
}

// Remplit le chart day avec des données déjà downsamplées par le main process
// Aucun traitement lourd ici — juste insertion des labels/data + insertGaps
function fillDayChart(rows, stats) {
  const withGaps = insertGaps(rows)
  chartDay.data.labels           = withGaps.map(r => r.ts ? r.ts.slice(11, 19) : null)
  chartDay.data.datasets[0].data = withGaps.map(r => r.db_a !== null ? r.db_a : null)
  chartDay.data.datasets[1].data = withGaps.map(r => r.db_z !== null ? r.db_z : null)

  const len = withGaps.length
  if (stats) {
    chartDay.data.datasets[2].data = Array(len).fill(stats.mean)
    chartDay.data.datasets[3].data = Array(len).fill(stats.median)
  } else {
    chartDay.data.datasets[2].data = []
    chartDay.data.datasets[3].data = []
  }

  // NIOSH % et OMS/j % : valeurs cumulées réelles calculées dans main.js
  // Chaque row contient niosh et whoDay à cet instant précis
  chartDay.data.datasets[4].data = withGaps.map(r => r.ts ? (r.niosh  || 0) : null)
  chartDay.data.datasets[5].data = withGaps.map(r => r.ts ? (r.whoDay || 0) : null)

  renderDayStats(stats)
  chartDayDirty = true
}

function renderDayStats(stats) {
  let el = document.getElementById('day-chart-stats')
  if (!el) {
    el = document.createElement('div')
    el.id = 'day-chart-stats'
    el.style.cssText = 'display:flex;gap:18px;margin-top:8px;font-size:12px;color:var(--muted);flex-wrap:wrap;'
    const legendEl = document.getElementById('legend-day')
    if (legendEl) legendEl.after(el)
  }
  if (!stats) { el.innerHTML = ''; return }
  el.innerHTML = `
    <span>${L.mean_label||'Average'} : <strong style="color:#6366f1">${stats.mean} dB(A)</strong></span>
    <span>${L.median_label||'Median'} : <strong style="color:#f97316">${stats.median} dB(A)</strong></span>
    <span style="opacity:0.6">${stats.count} ${L.measures_with_sound||'measurements with sound'}</span>
  `
}

// ══════════════════════════════════════════════════════════
// SÉLECTEUR DE RÉSOLUTION
// La résolution est transmise au main process via readCsvRange
// → le downsampling se fait là-bas, pas ici
// ══════════════════════════════════════════════════════════
function setDayResolution(spb) {
  dayResolution = spb
  document.querySelectorAll('#page-calendar .res-btn').forEach(el => {
    el.classList.toggle('active', +el.dataset.spb === spb)
  })
  if (!calDay || calView !== 'day') return
  const loadingEl = document.getElementById('loading-day')
  if (loadingEl) loadingEl.classList.remove('hidden')
  window.hifi.readCsvRange(calDay + 'T00:00:00', calDay + 'T23:59:59', dayResolution).then(result => {
    if (loadingEl) loadingEl.classList.add('hidden')
    const rows  = result.rows || result
    const stats = result.stats || null
    fillDayChart(rows, stats)
    // Reset zoom pour montrer la journée entière après changement de résolution
    if (chartDay) { chartDay.resetZoom(); chartDayDirty = true }
  })
}

function setTodayResolution(spb) {
  todayResolution = spb
  sessionBucket = { maxDba: 0, lastFlush: null }   // reset bucket au changement de résolution
  document.querySelectorAll('#page-today .res-btn').forEach(el => {
    el.classList.toggle('active', +el.dataset.spb === spb)
  })
  reloadTodayFromCSV()
}

// ══════════════════════════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════════════════════════
document.getElementById('cal-prev').addEventListener('click', calPrev)
document.getElementById('cal-next').addEventListener('click', calNext)

function calPrev() {
  if (calView==='year')  { calYear--;  renderViewYear(); return }
  if (calView==='month') { calMonth--; if(calMonth<0){calMonth=11;calYear--} renderViewMonth(); return }
  if (calView==='day' && calDay) {
    const d = new Date(calDay); d.setDate(d.getDate() - 1)
    calDay = d.toISOString().slice(0,10)
    // Mettre à jour calMonth/calYear si on change de mois
    calYear = d.getFullYear(); calMonth = d.getMonth()
    renderViewDay(calDay)
  }
}
function calNext() {
  if (calView==='year')  { calYear++;  renderViewYear(); return }
  if (calView==='month') { calMonth++; if(calMonth>11){calMonth=0;calYear++} renderViewMonth(); return }
  if (calView==='day' && calDay) {
    const d = new Date(calDay); d.setDate(d.getDate() + 1)
    // Ne pas aller dans le futur
    if (d > new Date()) return
    calDay = d.toISOString().slice(0,10)
    calYear = d.getFullYear(); calMonth = d.getMonth()
    renderViewDay(calDay)
  }
}

async function renderCalendar() {
  suivi = await window.hifi.getSuivi()
  suiviLastFetch = Date.now()
  calView = 'year'; renderViewYear()
}

function renderViewYear() {
  calView = 'year'
  document.getElementById('cal-title').textContent = calYear
  showCalView('view-year'); updateBreadcrumb()
  document.getElementById('view-year').innerHTML = MONTHS.map((name, mi) => {
    const { avgDose, days, color } = getMonthStats(calYear, mi)
    return `<div class="month-cell" data-month="${mi}">
      <div class="month-name">${name}</div>
      <div class="month-stats">${days}j · ${avgDose.toFixed(0)}% OMS moy.</div>
      <div class="month-bar"><div class="month-bar-fill" style="width:${Math.min(avgDose,100)}%;background:${color}"></div></div>
    </div>`
  }).join('')
  document.querySelectorAll('.month-cell').forEach(el => {
    el.addEventListener('click', () => { calMonth = +el.dataset.month; animTransition(renderViewMonth) })
    el.addEventListener('contextmenu', e => {
      e.preventDefault()
      e.stopPropagation()
      showCtxMenu(e, 'month', `${calYear}-${String(+el.dataset.month+1).padStart(2,'0')}`)
    })
  })
}

function getMonthStats(year, month) {
  let totalOms = 0, totalNiosh = 0, days = 0
  const dim = new Date(year, month + 1, 0).getDate()
  for (let d = 1; d <= dim; d++) {
    const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    if (suivi[key]) {
      totalOms   += suivi[key].dose_who_day_pct || 0
      totalNiosh += suivi[key].dose_niosh_pct   || 0
      days++
    }
  }
  const avg   = days > 0 ? totalOms / days : 0
  const color = avg > 80 ? 'var(--danger)' : avg > 50 ? 'var(--warn)' : avg > 20 ? '#84cc16' : 'var(--safe)'
  return { avgDose: avg, days, color }
}

// Retourne la valeur de la métrique choisie pour un jour donné
function getDayMetricValue(key) {
  const d = suivi[key]
  if (!d) return null
  switch (calMetric) {
    case 'oms':    return d.dose_who_day_pct || 0
    case 'niosh':  return d.dose_niosh_pct   || 0
    case 'mean':   return d.mean_db_a        || null
    case 'median': return d.median_db_a      || null
    case 'peak':   return d.max_db_a         || null
    case 'mean_z': return d.mean_db_z        || null
    default:       return d.dose_who_day_pct || 0
  }
}

function formatMetricValue(v) {
  if (v === null || v === undefined) return ''
  switch (calMetric) {
    case 'oms': case 'niosh': return v.toFixed(0) + '%'
    default: return v.toFixed(1) + ' dB'
  }
}

function renderViewMonth() {
  calView = 'month'
  document.getElementById('cal-title').textContent = MONTHS[calMonth] + ' ' + calYear
  showCalView('view-month'); updateBreadcrumb()
  const today    = new Date().toISOString().slice(0, 10)
  const firstMon = (new Date(calYear, calMonth, 1).getDay() + 6) % 7
  const dim      = new Date(calYear, calMonth + 1, 0).getDate()
  const grid     = document.getElementById('cal-month-grid')
  grid.innerHTML = DAYS.map(d => `<div class="cal-day-header">${d}</div>`).join('')
  for (let i = 0; i < firstMon; i++) grid.innerHTML += `<div class="cal-day empty"></div>`
  for (let d = 1; d <= dim; d++) {
    const key  = `${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const data = suivi[key]; const isToday = key === today
    let cls = 'nodata', dot = '#333', dose = 0
    if (data) {
      dose = data.dose_who_day_pct || 0
      if (dose > 80)      { cls = 'danger'; dot = 'var(--danger)' }
      else if (dose > 50) { cls = 'warn';   dot = 'var(--warn)'   }
      else if (dose > 20) { cls = 'ok';     dot = '#84cc16'       }
      else                { cls = 'safe';   dot = 'var(--safe)'   }
    }
    const metricVal   = getDayMetricValue(key)
    const metricStr   = metricVal !== null ? formatMetricValue(metricVal) : ''
    grid.innerHTML += `<div class="cal-day ${cls}${isToday?' today':''}" data-key="${key}" title="${key} — OMS/j: ${dose.toFixed(1)}%">
      <div>${d}</div>
      ${data ? `<div class="day-dot" style="background:${dot}"></div>` : ''}
      ${metricStr ? `<div class="day-metric">${metricStr}</div>` : ''}
    </div>`
  }
  grid.querySelectorAll('.cal-day:not(.empty):not(.nodata)').forEach(el => {
    el.addEventListener('click', () => { calDay = el.dataset.key; animTransition(() => renderViewDay(calDay)) })
    el.addEventListener('contextmenu', e => {
      e.preventDefault()
      e.stopPropagation()
      showCtxMenu(e, 'day', el.dataset.key)
    })
  })
}

async function renderViewDay(dateKey) {
  calView = 'day'
  document.getElementById('cal-title').textContent = formatDateFR(dateKey)
  showCalView('view-day')
  updateBreadcrumb()

  const data = suivi[dateKey] || {}
  document.getElementById('day-stats-grid').innerHTML = [
    { v:(data.dose_niosh_pct    || 0).toFixed(1)+'%',    l:'NIOSH',        sub:'85 dB(A)/8h'       },
    { v:(data.dose_who_day_pct  || 0).toFixed(1)+'%',    l:'OMS/jour',     sub:'80 dB(A)/342min'   },
    { v:(data.dose_who_week_pct || 0).toFixed(1)+'%',    l:'OMS contrib.', sub:'Contribution hebdo' },
    { v:(data.max_db_a          || 0).toFixed(1)+' dB',  l:'Pic',          sub:'dB(A) max'          },
    { v:(data.minutes_above_80  || 0).toFixed(1)+' min', l:'>80 dB(A)',    sub:''                   },
    { v:(data.minutes_above_85  || 0).toFixed(1)+' min', l:'>85 dB(A)',    sub:''                   },
  ].map(s => `<div class="stat-card"><div class="stat-val">${s.v}</div><div class="stat-label">${s.l}</div>${s.sub ? `<div class="stat-sub">${s.sub}</div>` : ''}</div>`).join('')

  document.getElementById('day-chart-title').textContent = 'Courbes du ' + formatDateFR(dateKey)

  const loadingEl = document.getElementById('loading-day')
  if (loadingEl) loadingEl.classList.remove('hidden')

  // Double rAF : garantit que view-day est dans le DOM et peint
  // avant de créer le chart (dimensions correctes)
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
  createChartDay()   // destroy + recreate avec les bonnes dimensions

  // Lecture CSV async — le main streame et downsamle, aucun freeze ici
  const result = await window.hifi.readCsvRange(
    dateKey + 'T00:00:00',
    dateKey + 'T23:59:59',
    dayResolution
  )
  if (loadingEl) loadingEl.classList.add('hidden')
  const rows  = result.rows || result
  const stats = result.stats || null
  fillDayChart(rows, stats)
}

// ══════════════════════════════════════════════════════════
// BREADCRUMB
// ══════════════════════════════════════════════════════════
function updateBreadcrumb() {
  const bc    = document.getElementById('breadcrumb')
  const parts = [{ label: String(calYear), action: () => animTransition(renderViewYear) }]
  if (calView==='month' || calView==='day') parts.push({ label: MONTHS[calMonth], action: () => animTransition(renderViewMonth) })
  if (calView==='day' && calDay) parts.push({ label: formatDateFR(calDay), action: null })
  bc.innerHTML = parts.map((p, i) => {
    const isLast = i === parts.length - 1
    return `<span class="${isLast ? 'bc-current' : 'bc-item'}" data-i="${i}">${p.label}</span>` + (isLast ? '' : `<span class="bc-sep">›</span>`)
  }).join('')
  bc.querySelectorAll('.bc-item').forEach((el, i) => { if (parts[i].action) el.addEventListener('click', parts[i].action) })
}

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
async function renderSettings() {
  config = await window.hifi.getConfig()
  if (!config) return
  renderProfileList()
  renderRefreshModes()
  renderThresholds()
  document.getElementById('btn-export').onclick = () => window.hifi.openDataFolder()
  document.getElementById('btn-purge-old').onclick       = async () => {
    showConfirm('Supprimer les données > 90 jours ?', 'Cette action est irréversible.', async () => {
    const r = await window.hifi.deleteOldData(90)
    if (r.ok) { suivi = await window.hifi.getSuivi(); suiviLastFetch = Date.now(); showToast('Données de plus de 90 jours supprimées.') }
    })
  }
  document.getElementById('btn-restart').onclick         = () => window.hifi.restartDaemon()
  document.getElementById('btn-clear-form').onclick      = clearForm
  document.getElementById('btn-save-profile').onclick    = saveProfile
  document.getElementById('btn-save-refresh').onclick    = saveRefresh
  document.getElementById('btn-save-thresholds').onclick = saveThresholds
  ;['f-sens','f-imp','f-vout','f-sens-unit'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateMaxSplPreview)
  })
}

function renderProfileList() {
  const list = document.getElementById('profile-list')
  list.innerHTML = ''
  Object.entries(config.profiles).forEach(([name, p]) => {
    const unit     = p.sensitivity_unit || 'dB/mW'
    const maxSpl   = computeMaxSpl(p.sensitivity, unit, p.impedance, p.dac_vout)
    const isActive = name === config.active_profile
    const item     = document.createElement('div')
    item.className = 'profile-item' + (isActive ? ' active' : '')
    item.innerHTML = `<div>
      <div class="profile-name">${name}</div>
      <div class="profile-desc">${p.description || ''}</div>
      <div class="profile-specs">${p.sensitivity} ${unit} · ${p.impedance}Ω · ${p.dac_vout}Vrms → MAX SPL: ${maxSpl.toFixed(1)} dB</div>
    </div>
    <div style="display:flex;gap:7px;align-items:center;flex-shrink:0;">
      ${isActive ? `<span class="profile-badge">${L.profile_active||'Active'}</span>` : `<button class="btn btn-secondary" style="font-size:11px" data-activate="${name}">${L.profile_activate||'Activate'}</button>`}
      <button class="btn btn-secondary" style="font-size:11px" data-edit="${name}">${L.profile_edit||'Edit'}</button>
      ${!isActive ? `<button class="btn btn-danger" style="font-size:11px" data-delete="${name}">${L.profile_delete||'Delete'}</button>` : ''}
    </div>`
    const ab = item.querySelector('[data-activate]')
    if (ab) ab.addEventListener('click', async () => { config.active_profile = name; await window.hifi.saveConfig(config); renderProfileList() })
    const db = item.querySelector('[data-delete]')
    if (db) db.addEventListener('click', () => {
      const pname = db.dataset.delete
      showConfirm(
        `${L.profile_delete||'Delete'} "${pname}"?`,
        '',
        async () => {
          config = await window.hifi.getConfig()
          delete config.profiles[pname]
          await window.hifi.saveConfig(config)
          renderProfileList()
        }
      )
    })
    item.querySelector('[data-edit]').addEventListener('click', () => {
      document.getElementById('f-name').value      = name
      document.getElementById('f-sens').value      = p.sensitivity
      document.getElementById('f-sens-unit').value = p.sensitivity_unit || 'dB/mW'
      document.getElementById('f-imp').value       = p.impedance
      document.getElementById('f-vout').value      = p.dac_vout
      document.getElementById('f-desc').value      = p.description || ''
      updateMaxSplPreview()
    })
    list.appendChild(item)
  })
}

function computeMaxSpl(raw, unit, imp, vout) {
  let sensMw
  if (unit==='dB/mW')      sensMw = raw
  else if (unit==='mV/Pa') sensMw = 124 - 20*Math.log10(raw) + 10*Math.log10(imp)
  else if (unit==='dB/V')  sensMw = raw - 10*Math.log10(1000/imp)
  else sensMw = raw
  return sensMw + 10*Math.log10(((vout**2)/imp)*1000)
}

function updateMaxSplPreview() {
  const sens = parseFloat(document.getElementById('f-sens').value)
  const unit = document.getElementById('f-sens-unit').value
  const imp  = parseFloat(document.getElementById('f-imp').value)
  const vout = parseFloat(document.getElementById('f-vout').value)
  const el   = document.getElementById('f-maxspl')
  if (sens && imp && vout) el.textContent = `→ MAX SPL calculé : ${computeMaxSpl(sens, unit, imp, vout).toFixed(1)} dB`
  else el.textContent = ''
}

async function saveProfile() {
  const name = document.getElementById('f-name').value.trim()
  const sens = document.getElementById('f-sens').value
  const unit = document.getElementById('f-sens-unit').value
  const imp  = document.getElementById('f-imp').value
  const vout = document.getElementById('f-vout').value
  const desc = document.getElementById('f-desc').value.trim()
  
  // On vérifie juste que les champs de base ne sont pas vides
  if (!name || !sens || !imp || !vout) { 
    showToast(L.fill_required || 'Veuillez remplir tous les champs avec des nombres valides.'); 
    return 
  }
  
  config = await window.hifi.getConfig()
  config.profiles[name] = { 
    sensitivity: parseFloat(sens), 
    sensitivity_unit: unit, 
    impedance: parseFloat(imp), 
    dac_vout: parseFloat(vout), 
    description: desc 
  }
  await window.hifi.saveConfig(config)
  clearForm(); renderProfileList()
}
  
  config = await window.hifi.getConfig()
  config.profiles[name] = { sensitivity:sens, sensitivity_unit:unit, impedance:imp, dac_vout:vout, description:desc }
  await window.hifi.saveConfig(config)
  clearForm(); renderProfileList()
}

function clearForm() {
  ['f-name','f-sens','f-imp','f-vout','f-desc'].forEach(id => document.getElementById(id).value = '')
  document.getElementById('f-sens-unit').value = 'dB/mW'
  document.getElementById('f-maxspl').textContent = ''
}

function renderRefreshModes() {
  const mode = config.refresh_mode || 'focus'
  document.querySelectorAll('.refresh-card').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode)
    el.addEventListener('click', () => {
      document.querySelectorAll('.refresh-card').forEach(e => e.classList.remove('active'))
      el.classList.add('active')
      document.getElementById('custom-refresh-fields').classList.toggle('visible', el.dataset.mode === 'custom')
    })
  })
  document.getElementById('custom-refresh-fields').classList.toggle('visible', mode === 'custom')
  const custom = config.refresh_custom || {}
  document.getElementById('rc-python').value = custom.python_ms || 25
  document.getElementById('rc-ui').value     = custom.ui_ms    || 250
  document.getElementById('rc-tray').value   = custom.tray_ms  || 1000
}

async function saveRefresh() {
  const mode = document.querySelector('.refresh-card.active')?.dataset.mode || 'focus'
  config = await window.hifi.getConfig()
  config.refresh_mode = mode
  if (mode === 'custom') {
    config.refresh_custom = {
      python_ms: parseInt(document.getElementById('rc-python').value) || 25,
      ui_ms:     parseInt(document.getElementById('rc-ui').value)     || 250,
      tray_ms:   parseInt(document.getElementById('rc-tray').value)   || 1000,
    }
  }
  await window.hifi.saveConfig(config)
}

const THRESHOLD_DEFS = [
  { key:'ok',     label:'Vert (sûr)',      color:'#22c55e' },
  { key:'warn',   label:'Orange (modéré)', color:'#f97316' },
  { key:'danger', label:'Rouge (danger)',  color:'#ef4444' },
]

function renderThresholds() {
  const t = getThresholds()
  document.getElementById('threshold-grid').innerHTML = THRESHOLD_DEFS.map(def => `
    <div class="threshold-row">
      <div class="threshold-color" style="background:${def.color}"></div>
      <div class="threshold-label">${def.label}</div>
      <input class="threshold-input" type="number" data-key="${def.key}" value="${t[def.key]}" min="50" max="130" step="1"> dB
    </div>`).join('')
}

async function saveThresholds() {
  const thresholds = { safe:0, ok:75, warn:80, danger:85 }
  document.querySelectorAll('.threshold-input').forEach(input => {
    thresholds[input.dataset.key] = parseFloat(input.value)
  })
  config = await window.hifi.getConfig()
  config.tray_thresholds = thresholds
  await window.hifi.saveConfig(config)
}

// ══════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════
function showCalView(id) {
  ['view-year','view-month','view-day'].forEach(v => {
    document.getElementById(v).style.display = 'none'
  })
  const el = document.getElementById(id)
  el.style.display = id === 'view-year' ? 'grid' : 'block'
}

function animTransition(fn) {
  const view = document.getElementById('calendar-view')
  view.classList.add('anim-out')
  setTimeout(() => {
    view.classList.remove('anim-out'); fn()
    view.classList.add('anim-in'); setTimeout(() => view.classList.remove('anim-in'), 280)
  }, 180)
}

function formatDateFR(key) {
  const [y, m, d] = key.split('-')
  return `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y}`
}



// ── Popups custom ────────────────────────────────────────
function showConfirm(title, message, onConfirm) {
  document.getElementById('modal-title').textContent   = title
  document.getElementById('modal-message').textContent = message
  document.getElementById('modal-overlay').classList.add('visible')
  const btnOk     = document.getElementById('modal-ok')
  const btnCancel = document.getElementById('modal-cancel')
  const close = () => document.getElementById('modal-overlay').classList.remove('visible')
  btnOk.onclick     = () => { close(); onConfirm() }
  btnCancel.onclick = close
}

function showToast(message) {
  let toast = document.getElementById('hifi-toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'hifi-toast'
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.classList.add('visible')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => toast.classList.remove('visible'), 3000)
}

// Boutons métrique calendrier
document.querySelectorAll('.metric-btn').forEach(el => {
  el.addEventListener('click', () => {
    calMetric = el.dataset.metric
    document.querySelectorAll('.metric-btn').forEach(b => b.classList.toggle('active', b.dataset.metric === calMetric))
    if (calView === 'month') renderViewMonth()
  })
})

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════

async function init() {
  L      = await window.hifi.getLocale()
  MONTHS = L.months || []
  DAYS   = L.days   || []
  config = await window.hifi.getConfig()
  
  // ── TRADUCTION DE L'INTERFACE ──
  if (typeof applyTranslations === 'function') {
    applyTranslations()
  }
  // ───────────────────────────────

  // Si une langue est déjà configurée, masquer immédiatement le setup overlay
  if (config && config.language) {
    const setupEl = document.getElementById('lang-setup')
    if (setupEl) { setupEl.classList.add('done'); setTimeout(() => setupEl.remove(), 10) }
  }
  
  suivi  = await window.hifi.getSuivi()
  suiviLastFetch = Date.now()

  // Pré-créer les deux charts dès le boot
  initChartToday()
  initChartDay()

  renderDoseBars(null)
  await reloadTodayFromCSV()

  // App prête — masquer le loader
  const appLoader = document.getElementById('app-loader')
  if (appLoader) { appLoader.classList.add('done'); setTimeout(() => appLoader.remove(), 350) }

  startLivePoll()

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && currentPage === 'today') {
      e.preventDefault(); togglePause()
    }
  })
}

init()
