// ══════════════════════════════════════════════════════════
// HIFIGUARD — Renderer
// ══════════════════════════════════════════════════════════
Chart.defaults.color = '#64748b'
Chart.defaults.borderColor = '#2e3350'
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
Chart.register(ChartZoom)

// ── État ─────────────────────────────────────────────────
let currentPage = 'today'
let calView = 'year', calYear = new Date().getFullYear()
let calMonth = new Date().getMonth(), calDay = null
let config = null, suivi = {}
let chartToday = null, chartDay = null
let isPaused = false

// Données session courante (points live)
let sessionData = { labels: [], dba: [], niosh: [], omsj: [], lastTs: null }
const SESSION_MAX = 1200  // ~20 min à 1 pt/s

// Résolution calendrier : transmise directement au main pour le downsampling
// 0 = auto (max 600 pts), sinon valeur fixe en secondes
let dayResolution = 0

const COLORS = { dba:'#6366f1', niosh:'#f97316', omsj:'#22c55e', dbz:'#475569' }
const MONTHS  = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const DAYS    = ['L','M','M','J','V','S','D']

// ── Boucle RAF séparée du live ────────────────────────────
// Le chart ne redessine que si des données ont changé,
// indépendamment des polls réseau/IPC
let chartTodayDirty = false
let chartDayDirty   = false
// "Follow mode" : si le zoom est ancré à l'extrémité droite,
// on décale automatiquement la fenêtre quand un nouveau point arrive.
// Activé dès qu'on zoome ET qu'on se positionne sur le dernier point.
// Désactivé dès qu'on pan vers la gauche ou qu'on reset le zoom.
let followMode = false

function rafLoop() {
  if (chartTodayDirty && chartToday) {
    if (followMode) {
      // Décaler la fenêtre pour garder le dernier point visible à droite
      const xScale    = chartToday.scales.x
      const total     = chartToday.data.labels.length - 1
      if (xScale && total > 0) {
        const winSize = xScale.max - xScale.min   // taille de la fenêtre en pts
        const newMin  = Math.max(0, total - winSize)
        const newMax  = total
        chartToday.zoomScale('x', { min: newMin, max: newMax }, 'none')
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

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
async function init() {
  config = await window.hifi.getConfig()
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

  // Le live arrive par push (state-update) depuis le main process
  // pollState n'est qu'un fallback si l'event n'arrive pas
  startLivePoll()

  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden && currentPage === 'today' && !isPaused) {
      await reloadTodayFromCSV()
    }
  })

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && currentPage === 'today') {
      e.preventDefault(); togglePause()
    }
  })
}

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
  // Fallback poll 1s — très léger car get-state renvoie lastState en mémoire
  livePollInterval = setInterval(async () => {
    if (document.hidden || isPaused) return
    const state = await window.hifi.getState()
    if (state) handleLiveState(state)
  }, 1000)
}

// Push depuis le main (prioritaire, ~250ms en mode focus)
window.hifi.onStateUpdate(state => {
  if (!isPaused) handleLiveState(state)
})

function handleLiveState(state) {
  updateLive(state)
  updateTitlebar(state)
  if (currentPage === 'today' && !isPaused) {
    appendTodayPoint(state)   // marque chartTodayDirty, ne fait pas update()
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
  if (!chart || !chart.data.labels.length) return
  const xScale  = chart.scales.x
  if (!xScale)  return
  const total   = chart.data.labels.length - 1
  const visible = xScale.max
  // "Ancré à droite" = le dernier point visible est dans les 3 derniers points
  followMode = (total - visible) <= 3
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
  document.getElementById('chart-today').addEventListener('dblclick', () => { followMode = false; zoomToLast10Min(chartToday) })
  buildLegend('legend-today', chartToday, datasets)
}

async function reloadTodayFromCSV() {
  const today  = new Date().toISOString().slice(0, 10)
  const result = await window.hifi.readCsvRange(today + 'T00:00:00', today + 'T23:59:59', 0)
  const rows   = result.rows || result   // compat si le main renvoie directement un tableau
  document.getElementById('loading-today')?.classList.add('hidden')
  if (!rows.length) return

  const withGaps = insertGaps(rows)
  sessionData.labels = withGaps.map(r => r.ts ? r.ts.slice(11, 19) : null)
  sessionData.dba    = withGaps.map(r => r.db_a !== null ? r.db_a : null)
  sessionData.niosh  = withGaps.map(() => null)
  sessionData.omsj   = withGaps.map(() => null)
  // Réinitialiser le dernier timestamp connu pour éviter les faux gaps
  sessionData.lastTs = rows.length ? rows[rows.length - 1].ts : null

  if (chartToday) {
    chartToday.data.labels           = sessionData.labels
    chartToday.data.datasets[0].data = sessionData.dba
    chartToday.data.datasets[1].data = sessionData.niosh
    chartToday.data.datasets[2].data = sessionData.omsj
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
  const lastTs = sessionData.lastTs
  if (lastTs) {
    const gapMs = localIsoToMs(nowTs) - localIsoToMs(lastTs)
    if (gapMs > 3000 || gapMs < 0) {   // gapMs < 0 = données hors ordre (redémarrage daemon)
      sessionData.labels.push(null); sessionData.dba.push(null)
      sessionData.niosh.push(null);  sessionData.omsj.push(null)
    }
  }
  sessionData.lastTs = nowTs

  sessionData.labels.push(label)
  sessionData.dba.push(state.db_a > 0 ? state.db_a : 0)   // 0 = silence tracé
  sessionData.niosh.push(d.dose_niosh_pct  || null)
  sessionData.omsj.push(d.dose_who_day_pct || null)

  if (sessionData.labels.length > SESSION_MAX) {
    const trim = sessionData.labels.length - SESSION_MAX
    sessionData.labels.splice(0, trim); sessionData.dba.splice(0, trim)
    sessionData.niosh.splice(0, trim);  sessionData.omsj.splice(0, trim)
  }

  if (chartToday) {
    chartToday.data.labels           = sessionData.labels
    chartToday.data.datasets[0].data = sessionData.dba
    chartToday.data.datasets[1].data = sessionData.niosh
    chartToday.data.datasets[2].data = sessionData.omsj
    chartTodayDirty = true   // RAF loop redessine au prochain frame
  }
}

function zoomToLast10Min(chart) {
  const labels = chart.data.labels.filter(Boolean)
  if (labels.length < 2) { chart.resetZoom(); return }
  const toSec = s => { const [h,m,ss] = s.split(':').map(Number); return h*3600 + m*60 + ss }
  const lastSec   = toSec(labels[labels.length - 1])
  const tenMinAgo = lastSec - 600
  const all = chart.data.labels
  let startIdx = 0
  for (let i = 0; i < all.length; i++) {
    if (!all[i]) continue
    if (toSec(all[i]) >= tenMinAgo) { startIdx = i; break }
  }
  chart.zoomScale('x', { min: startIdx, max: all.length - 1 }, 'none')
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
    { label:'dB(A)',    data:[], borderColor:COLORS.dba,                  borderWidth:1.5, pointRadius:0, tension:0.2, spanGaps:false, yAxisID:'y' },
    { label:'dB(Z)',    data:[], borderColor:COLORS.dbz,                  borderWidth:1,   pointRadius:0, tension:0.2, borderDash:[3,3], spanGaps:false, yAxisID:'y' },
    { label:'Moyenne',  data:[], borderColor:'rgba(99,102,241,0.55)',      borderWidth:1.5, pointRadius:0, tension:0,   borderDash:[6,3], spanGaps:true,  yAxisID:'y' },
    { label:'Médiane',  data:[], borderColor:'rgba(249,115,22,0.55)',      borderWidth:1.5, pointRadius:0, tension:0,   borderDash:[2,4], spanGaps:true,  yAxisID:'y' },
  ]
  chartDay = new Chart(ctx, {
    type:'line', data:{ labels:[], datasets },
    options:{
      animation:false, responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false, axis:'x' },
      plugins:{ legend:{ display:false }, zoom:ZOOM_OPTIONS, tooltip:TOOLTIP_OPTIONS },
      scales:{
        x:{ ticks:{ maxTicksLimit:10, maxRotation:0 } },
        y:{ title:{ display:true, text:'dB' }, min:0, max:120 }
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

  // Datasets 2 et 3 = moyenne et médiane (toujours présents, créés dans createChartDay)
  const len = withGaps.length
  if (stats) {
    chartDay.data.datasets[2].data = Array(len).fill(stats.mean)
    chartDay.data.datasets[3].data = Array(len).fill(stats.median)
  } else {
    chartDay.data.datasets[2].data = []
    chartDay.data.datasets[3].data = []
  }

  // Mettre à jour les stats texte sous le graphe
  renderDayStats(stats)

  chartDayDirty = true   // RAF loop redessine
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
    <span>Moyenne : <strong style="color:#6366f1">${stats.mean} dB(A)</strong></span>
    <span>Médiane : <strong style="color:#f97316">${stats.median} dB(A)</strong></span>
    <span style="opacity:0.6">${stats.count} mesures avec son</span>
  `
}

// ══════════════════════════════════════════════════════════
// SÉLECTEUR DE RÉSOLUTION
// La résolution est transmise au main process via readCsvRange
// → le downsampling se fait là-bas, pas ici
// ══════════════════════════════════════════════════════════
function setDayResolution(spb) {
  dayResolution = spb
  document.querySelectorAll('.res-btn').forEach(el => {
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
  })
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
  })
}

function getMonthStats(year, month) {
  let total = 0, days = 0
  const dim = new Date(year, month + 1, 0).getDate()
  for (let d = 1; d <= dim; d++) {
    const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    if (suivi[key]) { total += suivi[key].dose_who_day_pct || 0; days++ }
  }
  const avg   = days > 0 ? total / days : 0
  const color = avg > 80 ? 'var(--danger)' : avg > 50 ? 'var(--warn)' : avg > 20 ? '#84cc16' : 'var(--safe)'
  return { avgDose: avg, days, color }
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
    grid.innerHTML += `<div class="cal-day ${cls}${isToday?' today':''}" data-key="${key}" title="${key} — OMS/j: ${dose.toFixed(1)}%">
      <div>${d}</div>${data ? `<div class="day-dot" style="background:${dot}"></div>` : ''}
    </div>`
  }
  grid.querySelectorAll('.cal-day:not(.empty):not(.nodata)').forEach(el => {
    el.addEventListener('click', () => { calDay = el.dataset.key; animTransition(() => renderViewDay(calDay)) })
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
  document.getElementById('btn-export').onclick          = () => window.hifi.exportData()
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
      ${isActive ? '<span class="profile-badge">Actif</span>' : `<button class="btn btn-secondary" style="font-size:11px" data-activate="${name}">Activer</button>`}
      <button class="btn btn-secondary" style="font-size:11px" data-edit="${name}">Modifier</button>
    </div>`
    const ab = item.querySelector('[data-activate]')
    if (ab) ab.addEventListener('click', async () => { config.active_profile = name; await window.hifi.saveConfig(config); renderProfileList() })
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
  else if (unit==='mV/Pa') sensMw = 20*Math.log10(raw/1000)+10*Math.log10(1000/imp)+120
  else if (unit==='dB/V')  sensMw = raw-10*Math.log10(imp/1000)
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
  const sens = parseFloat(document.getElementById('f-sens').value)
  const unit = document.getElementById('f-sens-unit').value
  const imp  = parseFloat(document.getElementById('f-imp').value)
  const vout = parseFloat(document.getElementById('f-vout').value)
  const desc = document.getElementById('f-desc').value.trim()
  if (!name || !sens || !imp || !vout) return alert('Remplis tous les champs obligatoires.')
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

init()
