// ══════════════════════════════════════════════════════════
// HIFIGUARD - Renderer
// ══════════════════════════════════════════════════════════
Chart.defaults.color = '#64748b'
Chart.defaults.borderColor = '#2e3350'
Chart.defaults.font.family = "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
Chart.register(ChartZoom)

// ── État ─────────────────────────────────────────────────
let currentPage = 'today'
let L = {}  
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
let hiresMode  = false   


// Fonction officielle : Courbe de pondération A (IEC 61672-1)
// Calcule l'atténuation exacte en dB(A) pour une fréquence donnée
function getAWeightingOffset(f) {
  const f2 = f * f;
  const c1 = Math.pow(12194, 2);
  const c2 = Math.pow(20.6, 2);
  const c3 = Math.pow(107.7, 2);
  const c4 = Math.pow(737.9, 2);
  
  const num = c1 * f2 * f2;
  const den = (f2 + c2) * Math.sqrt((f2 + c3) * (f2 + c4)) * (f2 + c1);
  const rA = num / den;
  
  // Le +2.000 est la normalisation pour que 1000 Hz donne exactement 0 dB d'atténuation
  return 20 * Math.log10(rA) + 2.000; 
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (L[key]) {
      if (el.tagName === 'INPUT') el.placeholder = L[key];
      else el.innerHTML = L[key];
    }
  });

  // Traduit les bulles au survol (attribut title)
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (L[key]) el.title = L[key];
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
  if (page === 'system') renderSystem()

  // --- AUTO-KILL & DÉMARRAGES LOURDS (SANS FREEZE !) ---
  if (window.hifi && config) {
    let configChanged = false;

    if (page !== 'system' && config.compare_eq) {
      config.compare_eq = false;
      const toggle = document.getElementById('toggle-compare');
      if (toggle) toggle.checked = false;
      const box = document.getElementById('compare-box');
      if (box) box.style.display = 'none';
      configChanged = true;
    }

    if (page !== 'spectrum' && config.spectrum_enabled) {
      config.spectrum_enabled = false;
      configChanged = true;
    }

    if (page === 'spectrum') {
      const bands = parseInt(document.getElementById('spec-bands').value) || 80;
      updateSpectrumLabels(bands);
      
      if (!config.spectrum_enabled) {
        config.spectrum_enabled = true;
        config.spectrum_bands = bands;
        const loader = document.getElementById('loading-spectrum');
        loader.classList.remove('hidden');
        // Sécurité : si les données n'arrivent pas dans 4s, on cache quand même
        clearTimeout(window._spectrumLoaderTimeout);
        window._spectrumLoaderTimeout = setTimeout(() => {
          loader.classList.add('hidden');
        }, 4000);
        configChanged = true;
      }
    }

    // On SAUVEGARDE le fichier, MAIS ON NE REDÉMARRE PLUS LE DAEMON !
    // Le loader va tourner, et Python allumera le flux tout seul dans les secondes qui suivent.
    if (configChanged) {
      window.hifi.saveConfig(config).then(() => {
        window.hifi.triggerPythonReload();
      });      
    }
  }
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
    `${L.profile_delete || 'Supprimer'} : ${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y} ?`,
    L.delete_day_msg || 'Toutes les mesures de ce jour seront effacées définitivement.',
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
    `${L.profile_delete || 'Supprimer'} ${MONTHS[parseInt(m)-1]} ${y} ?`,
    L.delete_month_msg || 'Toutes les mesures de ce mois seront effacées définitivement.',
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
// LIVE - deux voies découplées
//
// Voie 1 : push via state-update (main -> renderer, sans poll)
//          -> met à jour l'UI live immédiatement
// Voie 2 : fallback poll à 1s si le push ne passe pas
//          (fenêtre en arrière-plan, etc.)
// Le chart TODAY est marqué dirty -> redessiné par la RAF loop
// ══════════════════════════════════════════════════════════
let livePollInterval = null

// --- RÉCEPTION DIRECTE DU SPECTRE DEPUIS LA RAM (Zéro Lag Disque) ---
let latestSpectrumData = null;
let isSpectrumDrawing = false;

if (window.hifi.onSpectrumFast) {
  window.hifi.onSpectrumFast((jsonStr) => {
    if (currentPage === 'spectrum' && config && config.spectrum_enabled) {
      try {
        // 1. On stocke juste la dernière frame en RAM (si le PC rame, on écrase l'ancienne = Drop Frame)
        latestSpectrumData = JSON.parse(jsonStr);
        
        const loader = document.getElementById('loading-spectrum');
        if (loader && !loader.classList.contains('hidden')) {
          loader.classList.add('hidden');
        }

        // 2. Bouclier Anti-Freeze : On ne dessine QUE quand le moniteur rafraîchit l'écran
        if (!isSpectrumDrawing) {
          isSpectrumDrawing = true;
          requestAnimationFrame(() => {
            try {
              if (latestSpectrumData) {
                drawNativeSpectrum(latestSpectrumData);
              }
            } catch (err) {
            } finally {
              isSpectrumDrawing = false;
            }
          });
        }
      } catch (err) {}
    }
  });
}

function startLivePoll() {
  // Le push IPC state-update arrive maintenant même fenêtre cachée.
  // Fallback poll 1s en secours au cas où le push IPC rate (redémarrage daemon, etc.)
  livePollInterval = setInterval(async () => {
    if (isPaused || !document.hidden) return   // si visible, le push s'en charge
    const state = await window.hifi.getState()
    if (state) feedHiresBuffer(state)   // en tray : juste le buffer, pas le DOM
  }, 1000)
}

// Push depuis le main 
window.hifi.onStateUpdate(state => {
  if (!isPaused) handleLiveState(state)
})

function handleLiveState(state) {
  feedHiresBuffer(state);
  
  if (!document.hidden) {
    updateLive(state);
    updateTitlebar(state);
    
    if (currentPage === 'today' && !isPaused) {
      appendTodayPoint(state);
    }

    // --- MISE À JOUR DU MODE COMPARAISON ---
    if (currentPage === 'system' && config && config.compare_eq) {
      const cmpRaw = document.getElementById('cmp-raw');
      const cmpEq  = document.getElementById('cmp-eq');
      if (cmpRaw && cmpEq) {
        const rawVal = state.db_a_raw !== undefined ? state.db_a_raw : state.db_a;
        cmpRaw.textContent = rawVal > 0 ? rawVal.toFixed(1) + ' dB(A)' : '-- dB(A)';
        cmpEq.textContent  = state.db_a > 0 ? state.db_a.toFixed(1) + ' dB(A)' : '-- dB(A)';
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// TITLEBAR
// ══════════════════════════════════════════════════════════
function updateTitlebar(state) {
  const elTitle = document.getElementById('titlebar-app-title');
  const elDoses = document.getElementById('titlebar-doses');
  if (!elTitle || !elDoses) return;

  // On cache le deuxième texte pour forcer l'affichage sur une seule ligne
  elDoses.style.display = 'none';

  if (state && state.db_a > 0) {
    const profileName = state.profile || "Aucun profil";
    
    // On récupère la couleur dynamique (Vert, Jaune, Orange, Rouge) selon le volume
    const col = dbColor(state.db_a); 
    
    // Tout sur une seule ligne (Côte à côte)
    elTitle.innerHTML = `<span style="font-size:14px; font-weight:bold; color:${col};">${state.db_a.toFixed(1)} dB(A)</span> <span style="font-size:13px; color:var(--muted); margin-left:6px; font-weight:normal;">— ${profileName}</span>`;
  } else {
    // Mode attente
    elTitle.innerHTML = `<span style="font-size:14px; font-weight:bold; color:var(--muted);">-- dB(A)</span> <span style="font-size:13px; color:var(--muted); margin-left:6px; font-weight:normal;">— En attente...</span>`;
  }
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
function localIsoToMs(ts) {
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

  if (!followMode && hiresMode) {
    hiresMode = false
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
    { label: L.metric_oms || 'OMS/j %', data:[], borderColor:COLORS.omsj,  borderWidth:1.5, pointRadius:0, tension:0.3, yAxisID:'y2', borderDash:[4,4], spanGaps:false },
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
        y2: { position:'right', title:{ display:true, text: L.label_dose_axis || 'Dose %' }, min:0, max:100, grid:{ drawOnChartArea:false } }
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
  sessionData.niosh = withGaps.map(r => r.niosh !== undefined ? r.niosh : null)
  sessionData.omsj  = withGaps.map(r => r.whoDay !== undefined ? r.whoDay : null)
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

  // ── ICI ON UTILISE LE STATE EN TEMPS RÉEL (state.) AU LIEU DE (d.) ──
  document.getElementById('s-db').textContent    = state.db_a > 0 ? state.db_a.toFixed(1) + ' dB' : '--'
  document.getElementById('s-db').style.color    = col
  document.getElementById('s-niosh').textContent = (state.dose_niosh || 0).toFixed(1) + '%'
  document.getElementById('s-omsj').textContent  = (state.dose_who_j || 0).toFixed(1) + '%'
  document.getElementById('s-oms7j').textContent = (state.dose_who_7j || 0).toFixed(1) + '%'
  document.getElementById('s-max').textContent   = (state.max_db_a || 0).toFixed(1) + ' dB'
  document.getElementById('s-t80').textContent   = (d.minutes_above_80 || 0).toFixed(1) + ' min'
  renderDoseBars({ niosh: state.dose_niosh || 0, omsj: state.dose_who_j || 0, oms7j: state.dose_who_7j || 0 })

  // Recharger suivi throttlé (30s) pour garder le temps > 80dB à jour
  getSuiviThrottled()

  const nowTs  = state.ts || new Date().toISOString()
  const label  = nowTs.slice(11, 19)
  const nowMs  = localIsoToMs(nowTs)

  if (state.db_a > 0) sessionBucket.maxDba = Math.max(sessionBucket.maxDba, state.db_a)

  const flushIntervalMs = (todayResolution > 0 ? todayResolution : 1) * 1000
  const lastFlush = sessionBucket.lastFlush
  const elapsedMs = lastFlush ? (nowMs - localIsoToMs(lastFlush)) : flushIntervalMs

  if (elapsedMs < flushIntervalMs) return

  const lastTs = sessionData.lastTs
  if (lastTs) {
    const gapMs = localIsoToMs(nowTs) - localIsoToMs(lastTs)
    if (gapMs > flushIntervalMs * 2 || gapMs < 0) {
      sessionData.labels.push(null); sessionData.dba.push(null)
      sessionData.niosh.push(null);  sessionData.omsj.push(null)
    }
  }
  sessionData.lastTs      = nowTs
  sessionBucket.lastFlush = nowTs

  sessionData.labels.push(label)
  sessionData.dba.push(sessionBucket.maxDba > 0 ? sessionBucket.maxDba : 0)
  sessionData.niosh.push(state.dose_niosh || null)
  sessionData.omsj.push(state.dose_who_j  || null)

  sessionBucket.maxDba = 0

  if (sessionData.labels.length > SESSION_MAX) {
    const trim = sessionData.labels.length - SESSION_MAX
    sessionData.labels.splice(0, trim); sessionData.dba.splice(0, trim)
    sessionData.niosh.splice(0, trim);  sessionData.omsj.splice(0, trim)
  }

  if (chartToday) {
    if (!hiresMode) {
      chartToday.data.labels           = sessionData.labels
      chartToday.data.datasets[0].data = sessionData.dba
      chartToday.data.datasets[1].data = sessionData.niosh
      chartToday.data.datasets[2].data = sessionData.omsj
    }
    chartTodayDirty = true
  }
}

// Alimente le hiresBuffer en permanence - appelé pour chaque state reçu
// indépendamment de la page visible ou du mode tray
function feedHiresBuffer(state) {
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
  // ── COURBES HAUTE PRÉCISION EN TEMPS RÉEL ──
  hiresBuffer.niosh.push(state.dose_niosh || null)
  hiresBuffer.omsj.push(state.dose_who_j  || null)
  
  if (hiresBuffer.labels.length > HIRES_MAX) {
    const t = hiresBuffer.labels.length - HIRES_MAX
    hiresBuffer.labels.splice(0,t); hiresBuffer.dba.splice(0,t)
    hiresBuffer.niosh.splice(0,t);  hiresBuffer.omsj.splice(0,t)
  }
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
    { name: L.dose_niosh || 'NIOSH',    val: doses ? doses.niosh  : 0, color:COLORS.niosh, sub: L.desc_niosh || '85 dB(A)/8h'      },
    { name: L.dose_oms_day || 'OMS/jour', val: doses ? doses.omsj   : 0, color:COLORS.omsj,  sub: L.desc_oms_day || '80 dB(A)/342min' },
    { name: L.dose_oms_week || 'OMS/7j',   val: doses ? doses.oms7j  : 0, color:'#a855f7',    sub: L.desc_oms_week || '80 dB(A)/40h'   },
  ].map(it => {
    const pct = Math.min(it.val || 0, 100)
    const col = it.val > 80 ? 'var(--danger)' : it.val > 50 ? 'var(--warn)' : it.color
    return `<div class="dose-row">
      <div class="dose-name" title="${L.threshold_label || 'Seuil'} : ${it.sub}">${it.name}</div>
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
    pauseItem.querySelector('.legend-label').textContent = isPaused ? (L.paused || '⏸ En pause') : (L.pause_hint || '⏵ Espace = Pause')
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
    pauseEl.innerHTML = `<span class="legend-label" data-i18n="pause_hint" style="color:var(--muted)">${L.pause_hint || '⏵ Space = Pause'}</span>`
    pauseEl.addEventListener('click', togglePause)
    c.appendChild(pauseEl)
  }
}

// ══════════════════════════════════════════════════════════
// CHART DAY - recréé à chaque ouverture de jour
// (destroy + recreate garantit les bonnes dimensions du canvas)
// ══════════════════════════════════════════════════════════
function initChartDay() {
  // Ne rien créer au boot - le canvas est dans une page cachée (0x0)
  // createChartDay() est appelé dans renderViewDay() après que le DOM est visible
}

function createChartDay() {
  if (chartDay) { chartDay.destroy(); chartDay = null }
  const canvas   = document.getElementById('chart-day')
  const ctx      = canvas.getContext('2d')
  // Les 4 datasets sont déclarés dès la création - fillDayChart ne fait que remplir.
  // Ça évite les push() dynamiques qui cassent le rendu Chart.js.
  const datasets = [
    { label:'dB(A)',    data:[], borderColor:COLORS.dba,             borderWidth:1.5, pointRadius:0, tension:0.2, spanGaps:false, yAxisID:'y'  },
    { label:'dB(Z)',    data:[], borderColor:COLORS.dbz,             borderWidth:1,   pointRadius:0, tension:0.2, borderDash:[3,3], spanGaps:false, yAxisID:'y'  },
    { label: L.mean_label || 'Moyenne',  data:[], borderColor:'rgba(99,102,241,0.55)',borderWidth:1.5, pointRadius:0, tension:0,   borderDash:[6,3], spanGaps:true,  yAxisID:'y'  },
    { label: L.median_label || 'Médiane',  data:[], borderColor:'rgba(249,115,22,0.55)',borderWidth:1.5, pointRadius:0, tension:0,   borderDash:[2,4], spanGaps:true,  yAxisID:'y'  },
    { label:'NIOSH %',  data:[], borderColor:COLORS.niosh,           borderWidth:1.5, pointRadius:0, tension:0.3, borderDash:[4,4], spanGaps:true,  yAxisID:'y2' },
    { label: L.metric_oms || 'OMS/j %',  data:[], borderColor:COLORS.omsj,            borderWidth:1.5, pointRadius:0, tension:0.3, borderDash:[4,4], spanGaps:true,  yAxisID:'y2' },
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
        y2: { position:'right', title:{ display:true, text: L.label_dose_axis || 'Dose %' }, min:0, max:100, grid:{ drawOnChartArea:false } }
      }
    }
  })
  canvas.addEventListener('dblclick', () => { chartDay.resetZoom(); chartDayDirty = true })
  buildLegend('legend-day', chartDay, datasets)
  renderDayStats(null)
}

// Remplit le chart day avec des données déjà downsamplées par le main process
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
    <span>${L.mean_label || 'Moyenne'} : <strong style="color:#6366f1">${stats.mean} dB(A)</strong></span>
    <span>${L.median_label || 'Médiane'} : <strong style="color:#f97316">${stats.median} dB(A)</strong></span>
    <span style="opacity:0.6">${stats.count} ${L.measures_with_sound || 'mesures avec son'}</span>
  `
}

// ══════════════════════════════════════════════════════════
// SÉLECTEUR DE RÉSOLUTION
// La résolution est transmise au main process via readCsvRange
// -> le downsampling se fait là-bas, pas ici
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
    let statsTemplate = L.cal_stats_suffix || "{days}j · {avg}% OMS moy.";
    let statsText = statsTemplate.replace('{days}', days).replace('{avg}', avgDose.toFixed(0));
    return `<div class="month-cell" data-month="${mi}">
      <div class="month-name">${name}</div>
      <div class="month-stats">${statsText}</div>
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
    grid.innerHTML += `<div class="cal-day ${cls}${isToday?' today':''}" data-key="${key}" title="${key} — ${L.dose_oms_day || 'OMS/j'}: ${dose.toFixed(1)}%">
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
    { v:(data.dose_niosh_pct    || 0).toFixed(1)+'%',    l: L.dose_niosh || 'NIOSH',       sub: L.desc_niosh || '85 dB(A)/8h'        },
    { v:(data.dose_who_day_pct  || 0).toFixed(1)+'%',    l: L.dose_oms_day || 'OMS/jour',  sub: L.desc_oms_day || '80 dB(A)/342min'    },
    { v:(data.dose_who_week_pct || 0).toFixed(1)+'%',    l: L.label_oms_contrib || 'OMS contrib.', sub: L.desc_oms_week || 'Contribution hebdo' },
    { v:(data.max_db_a          || 0).toFixed(1)+' dB',  l: L.today_peak || 'Pic',          sub: L.desc_peak || 'dB(A) max'          },
    { v:(data.minutes_above_80  || 0).toFixed(1)+' min', l:'>80 dB(A)',    sub:'' },
    { v:(data.minutes_above_85  || 0).toFixed(1)+' min', l:'>85 dB(A)',    sub:'' },
  ].map(s => `<div class="stat-card"><div class="stat-val">${s.v}</div><div class="stat-label">${s.l}</div>${s.sub ? `<div class="stat-sub">${s.sub}</div>` : ''}</div>`).join('')
  
  document.getElementById('day-chart-title').textContent = (L.cal_curves || 'Curves') + ' — ' + formatDateFR(dateKey)
  
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
  document.getElementById('btn-purge-old').onclick = async () => {
    showConfirm(
      L.purge_confirm_title || 'Supprimer les données > 90 jours ?', 
      L.purge_confirm_msg || 'Cette action est irréversible.', 
      async () => {
        const r = await window.hifi.deleteOldData(90)
        if (r.ok) { 
          suivi = await window.hifi.getSuivi(); 
          suiviLastFetch = Date.now(); 
          showToast(L.purge_success || 'Données de plus de 90 jours supprimées.') 
        }
      }
    )
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
    if (ab) ab.addEventListener('click', async () => { 
      config.active_profile = name; 
      await window.hifi.saveConfig(config); 
      renderProfileList(); 
      showToast(L.profile_activated || "Profil activé"); 
    })
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
  
  const prefix = L.max_spl_calc || 'MAX SPL calculé'

  if (sens && imp && vout) {
    el.textContent = `→ ${prefix} : ${computeMaxSpl(sens, unit, imp, vout).toFixed(1)} dB`
  } else {
    el.textContent = ''
  }
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
  
  showToast("Rafraîchissement appliqué. Relance du daemon...");
  window.hifi.restartDaemon(); 
}

function renderThresholds() {
  const t = getThresholds()
  const defs = [
    { key:'ok',     label: L.color_ok     || 'Jaune (correct)', color:'#84cc16' },
    { key:'warn',   label: L.color_warn   || 'Orange (modéré)', color:'#f97316' },
    { key:'danger', label: L.color_danger || 'Rouge (danger)',  color:'#ef4444' },
  ]
  
  document.getElementById('threshold-grid').innerHTML = defs.map(def => `
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

// ══════════════════════════════════════════════════════════
// SYSTEME & AVANCÉ
// ══════════════════════════════════════════════════════════
// --- GESTION DE LA PAUSE CONSOLE ---
let isConsolePaused = false;
let consoleBuffer = [];

function toggleConsolePause() {
  isConsolePaused = !isConsolePaused;
  const statusEl = document.getElementById('daemon-status');
  
  if (isConsolePaused) {
    if (statusEl) {
      statusEl.textContent = '⏸ En pause (Espace pour reprendre)';
      statusEl.style.color = 'var(--warn)';
    }
  } else {
    if (statusEl) {
      statusEl.textContent = 'En ligne';
      statusEl.style.color = 'var(--safe)';
    }
    
    // À la reprise, on injecte tout le texte mis en attente d'un coup
    const consoleEl = document.getElementById('sys-console');
    if (consoleEl && consoleBuffer.length > 0) {
      consoleEl.value += consoleBuffer.join('\n') + '\n';
      consoleBuffer = []; // On vide la mémoire
      
      // On coupe à 100 lignes max pour préserver la RAM
      const lines = consoleEl.value.split('\n');
      if (lines.length > 100) {
        consoleEl.value = lines.slice(-100).join('\n');
      }
      
      // On téléporte la molette tout en bas !
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  }
}

window.hifi.onDaemonLog((msg) => {
  let cleanMsg = msg.replace(/\x1b\[K/g, '').replace(/\r/g, '');
  if (cleanMsg.trim() === '') return;

  // Si en pause, on stocke secrètement les lignes en arrière-plan
  if (isConsolePaused) {
    consoleBuffer.push(cleanMsg);
    // On limite aussi le buffer à 100 lignes pour éviter 
    // de saturer la RAM si on laisse en pause trop longtemps
    if (consoleBuffer.length > 100) {
      consoleBuffer = consoleBuffer.slice(-100);
    }
    return;
  }

  // Comportement normal (Non-pausé)
  const consoleEl = document.getElementById('sys-console');
  if (consoleEl) {
    const isAtBottom = consoleEl.scrollHeight - consoleEl.scrollTop <= consoleEl.clientHeight + 50;
    const oldScrollTop = consoleEl.scrollTop;
    const oldScrollHeight = consoleEl.scrollHeight;

    consoleEl.value += cleanMsg + '\n';
    
    // On garde toujours 100 lignes max en direct
    const lines = consoleEl.value.split('\n');
    if (lines.length > 100) {
      consoleEl.value = lines.slice(-100).join('\n');
    }
    
    if (isAtBottom) {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    } else {
      const newScrollHeight = consoleEl.scrollHeight;
      consoleEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
    }
  }
});

// --- ANALYSEUR DE SPECTRE ---
let chartSpectrum = null;

function updateSpectrumLabels(numBands) {
  if (!chartSpectrum) return;
  const labels = [];
  const logMin = Math.log10(20), logMax = Math.log10(20000);
  const step = (logMax - logMin) / numBands;
  for (let i=0; i<numBands; i++) {
    const f = Math.pow(10, logMin + step * (i + 0.5));
    labels.push(f < 1000 ? Math.round(f) + 'Hz' : (f/1000).toFixed(1) + 'k');
  }
  chartSpectrum.data.labels = labels;
  chartSpectrum.data.datasets[0].data = new Array(numBands).fill(0);
  chartSpectrum.update('none');
}

// --- ANALYSEUR DE SPECTRE NATIF (ULTRA-RAPIDE) ---
let spectrumCanvasCtx = null;
let spectrumCanvasEl = null;

function initChartSpectrum() {
  spectrumCanvasEl = document.getElementById('chart-spectrum');
  spectrumCanvasCtx = spectrumCanvasEl.getContext('2d');

  const bandsSelect = document.getElementById('spec-bands');
  const bandsCustom = document.getElementById('spec-bands-custom');
  const customWrap  = document.getElementById('spec-bands-custom-wrap');
  const weightSelect = document.getElementById('spec-weight');

  if (config) {
    const b = config.spectrum_bands || 80;
    // Si la valeur n'est pas dans la liste 20,40,80,160, c'est du personnalisé
    if ([20, 40, 80, 160].includes(b)) {
      bandsSelect.value = b;
      customWrap.style.display = 'none';
    } else {
      bandsSelect.value = 'custom';
      customWrap.style.display = 'flex';
      bandsCustom.value = b;
    }
    weightSelect.value = config.spectrum_weight || 'Z';
  }

  // --- CE QUI CHANGE EST JUSTE EN DESSOUS ---
  // Fonction de sauvegarde optimisée (Anti-Lag + Feedback Visuel)
  const triggerUpdate = async () => {
    if (!config) return;
    
    // 1. On allume le petit spinner à côté du bouton (au lieu du gros écran noir)
    const miniLoader = document.getElementById('mini-loader-spectrum');
    if (miniLoader) miniLoader.style.display = 'flex';

    let finalBands = parseInt(bandsSelect.value);
    if (bandsSelect.value === 'custom') {
      finalBands = parseInt(bandsCustom.value) || 80;
    }

    config.spectrum_bands  = finalBands;
    config.spectrum_weight = weightSelect.value;

    await window.hifi.saveConfig(config);
    
    // 2. On laisse le spinner tourner un petit peu (ex: 600ms) pour que l'œil le voie, puis on l'éteint
    setTimeout(() => {
      if (miniLoader) miniLoader.style.display = 'none';
    }, 600);
  };
  // --- FIN DU CHANGEMENT ---

  bandsSelect.onchange = () => {
    if (bandsSelect.value === 'custom') {
      customWrap.style.display = 'flex';
      bandsCustom.focus();
    } else {
      customWrap.style.display = 'none';
      triggerUpdate();
    }
  };

  bandsCustom.onchange = triggerUpdate;
  weightSelect.onchange = triggerUpdate;
  const canvas = document.getElementById('chart-spectrum');

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    // On sauvegarde la position brute de la souris en temps réel
    canvas._mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
  });

  canvas.addEventListener('mouseleave', () => {
    canvas._mouseX = -1;
  });
}

// --- MOTEUR WEBGL HAUTE PERFORMANCE ---
let gl = null;
let glProgram = null;
let posBuffer = null;
let posLoc, resLoc, colLoc;

function initWebGL(canvas) {
  // Fallback de sécurité pour les PC qui n'ont pas le flag WebGL standard
  gl = canvas.getContext('webgl', { alpha: true, antialias: false }) || 
       canvas.getContext('experimental-webgl', { alpha: true, antialias: false });
       
  if (!gl) {
    console.error("[WebGL] ❌ Contexte non supporté par la carte graphique.");
    return false;
  }

  // Fonction de compilation avec logs d'erreurs
  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[WebGL] ❌ Erreur Shader:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vsSource = `
    attribute vec2 a_position;
    uniform vec2 u_resolution;
    void main() {
      vec2 zeroToOne = a_position / u_resolution;
      vec2 clipSpace = (zeroToOne * 2.0) - 1.0;
      gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);
    }
  `;
  
  const fsSource = `
    precision mediump float;
    uniform vec4 u_color;
    void main() {
      gl_FragColor = u_color;
    }
  `;

  const vs = createShader(gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
  
  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vs);
  gl.attachShader(glProgram, fs);
  gl.linkProgram(glProgram);
  
  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
    console.error("[WebGL] ❌ Erreur Programme:", gl.getProgramInfoLog(glProgram));
    return false;
  }

  posLoc = gl.getAttribLocation(glProgram, "a_position");
  resLoc = gl.getUniformLocation(glProgram, "u_resolution");
  colLoc = gl.getUniformLocation(glProgram, "u_color");
  posBuffer = gl.createBuffer();
  
  console.log("[WebGL] ✅ Moteur graphique initialisé avec succès !");
  return true;
}

let previousBars = []; 

function drawNativeSpectrum(data) {
  const glCanvas = document.getElementById('chart-spectrum-gl');
  if (!spectrumCanvasCtx || !spectrumCanvasEl || !glCanvas || !data || data.length === 0) return;

  const rect = spectrumCanvasEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return; 
  
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.floor(rect.width * dpr);
  const targetHeight = Math.floor(rect.height * dpr);
  
  if (spectrumCanvasEl.width !== targetWidth) spectrumCanvasEl.width = targetWidth;
  if (spectrumCanvasEl.height !== targetHeight) spectrumCanvasEl.height = targetHeight;
  if (glCanvas.width !== targetWidth) glCanvas.width = targetWidth;
  if (glCanvas.height !== targetHeight) glCanvas.height = targetHeight;
  
  if (!gl) { if (!initWebGL(glCanvas)) return; }

  const ctx = spectrumCanvasCtx;
  const width = spectrumCanvasEl.width;
  const height = spectrumCanvasEl.height;

  const marginLeft = 35 * dpr;   
  const marginBottom = 20 * dpr; 
  const drawWidth = width - marginLeft;
  const drawHeight = height - marginBottom;
  const numBands = data.length;

  // 1. DESSIN DE LA GRILLE
  ctx.clearRect(0, 0, width, height); 
  ctx.strokeStyle = 'rgba(46, 51, 80, 0.6)';
  ctx.lineWidth = 1 * dpr;
  ctx.fillStyle = '#94a3b8';
  ctx.font = `${10 * dpr}px sans-serif`;

  const gridLevels = [20, 40, 60, 80]; 
  ctx.textAlign = 'right'; 
  gridLevels.forEach(db => {
    const yDb = drawHeight - (db / 100) * drawHeight; 
    ctx.beginPath(); 
    ctx.moveTo(marginLeft, yDb); 
    ctx.lineTo(width, yDb); 
    ctx.stroke();
    ctx.fillText(`${db}`, marginLeft - (6 * dpr), yDb + (3 * dpr));
  });
  ctx.fillText(`100`, marginLeft - (6 * dpr), 10 * dpr); 

  // 2. CALCUL DES LIMITES DE FRÉQUENCE (Le moteur Python)
  const FB_FREQS_JS = [
    50, 54, 59, 63, 74, 80, 87, 94, 102, 110, 119, 129, 139, 150, 163, 176, 191, 206, 223, 241,
    261, 282, 306, 331, 358, 387, 419, 453, 490, 530, 574, 620, 671, 726, 786, 850, 920, 1000,
    1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2200, 2400, 2600, 2800, 3000,
    3200, 3500, 3800, 4100, 4400, 4800, 5200, 5600, 6100, 6600, 7100, 7700, 8300, 9000, 10000,
    11000, 12000, 13000, 14000, 16000, 17000, 18000, 20000, 21000, 23000, 25000
  ];
  let bounds = [];
  if (numBands <= 80) {
    const step = Math.max(1, Math.floor(FB_FREQS_JS.length / Math.max(1, numBands)));
    for (let i = 0; i < FB_FREQS_JS.length; i += step) bounds.push(FB_FREQS_JS[i]);
    if (bounds.length < numBands + 1) bounds.push(FB_FREQS_JS[FB_FREQS_JS.length - 1]);
  } else {
    for (let i = 0; i <= numBands; i++) {
      const exactIdx = (i / numBands) * (FB_FREQS_JS.length - 1);
      const idx1 = Math.floor(exactIdx);
      const idx2 = Math.ceil(exactIdx);
      if (idx1 === idx2) bounds.push(FB_FREQS_JS[idx1]);
      else {
        const f1 = Math.log10(FB_FREQS_JS[idx1]);
        const f2 = Math.log10(FB_FREQS_JS[idx2]);
        bounds.push(Math.pow(10, f1 + (exactIdx - idx1) * (f2 - f1)));
      }
    }
  }

  // 3. PRÉPARATION DES BARRES (Toutes de la même largeur visuelle !)
  if (previousBars.length !== numBands) previousBars = new Array(numBands).fill(0);
  const attackLerp = 0.5; 
  const decayRateDB = 2.0; 
  const padding = 1 * dpr;
  const vertices = new Float32Array(numBands * 12);
  let v = 0;

  // On lit l'état de la nouvelle case à cocher
  const compensateUI = document.getElementById('spec-compensate');
  const doCompensate = compensateUI ? compensateUI.checked : false;

  for (let i = 0; i < numBands; i++) {
    // Si la case est cochée, on ajoute les 13 dB de compensation visuelle. Sinon, on garde la valeur brute.
    const rawVal = data[i] > 0 ? data[i] : 0;
    const finalVal = (doCompensate && rawVal > 0) ? rawVal + 13 : rawVal;

    let targetDb = Math.max(0, Math.min(finalVal, 100)); 

    if (targetDb > previousBars[i]) { previousBars[i] += (targetDb - previousBars[i]) * attackLerp; }
    else { previousBars[i] -= decayRateDB; if (previousBars[i] < targetDb) previousBars[i] = targetDb; }
    if (previousBars[i] < 0) previousBars[i] = 0;

    const barHeight = (previousBars[i] / 100) * drawHeight;

    // Répartition de la largeur d'écran en parts ÉGALES
    const startX = marginLeft + Math.floor((i / numBands) * drawWidth);
    const endX = marginLeft + Math.floor(((i + 1) / numBands) * drawWidth);
    const actualBarWidth = Math.max(1, (endX - startX) - padding);

    const x = startX;
    const y = drawHeight - barHeight; 
    const w = actualBarWidth;
    const h = barHeight;

    vertices[v++] = x;     vertices[v++] = y + h; 
    vertices[v++] = x + w; vertices[v++] = y + h; 
    vertices[v++] = x;     vertices[v++] = y;     
    vertices[v++] = x;     vertices[v++] = y;     
    vertices[v++] = x + w; vertices[v++] = y + h; 
    vertices[v++] = x + w; vertices[v++] = y;     
  }

  // 4. INJECTION WEBGL
  if (glProgram) {
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(glProgram);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(resLoc, targetWidth, targetHeight);
    gl.uniform4f(colLoc, 99/255, 102/255, 241/255, 0.9); 
    gl.drawArrays(gl.TRIANGLES, 0, numBands * 6);
  }

  // 5. ÉTIQUETTES (Placées au bon endroit sous la bonne barre)
  const labelFreqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 25000];
  ctx.fillStyle = '#64748b';
  ctx.font = `${9 * dpr}px sans-serif`;

  labelFreqs.forEach((f, idx) => {
    let fIdx = 0;
    for (let i = 0; i < bounds.length; i++) { if (bounds[i] >= f) { fIdx = i; break; } }
    
    const xPos = marginLeft + (fIdx / numBands) * drawWidth;
    const text = f < 1000 ? f + 'Hz' : (f / 1000).toFixed(0) + 'k';

    if (idx === 0) ctx.textAlign = 'left';
    else if (idx === labelFreqs.length - 1) ctx.textAlign = 'right';
    else ctx.textAlign = 'center';

    ctx.fillText(text, xPos, height - (4 * dpr));

    ctx.strokeStyle = 'rgba(46, 51, 80, 0.3)';
    ctx.lineWidth = 0.5 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(xPos, 0);
    ctx.lineTo(xPos, height - 14 * dpr);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // 6. TOOLTIP EXACTEMENT COMME TU AS DEMANDÉ (Colonne illuminée + 2 Lignes)
  const mouseX = spectrumCanvasEl._mouseX;
  if (mouseX && mouseX >= marginLeft && mouseX <= width) {
    const hoverIdx = Math.floor(((mouseX - marginLeft) / drawWidth) * numBands);

    if (hoverIdx >= 0 && hoverIdx < numBands) {
      const dbVal = previousBars[hoverIdx] || 0;
      const unit = (config && config.spectrum_weight === 'A') ? 'dB(A)' : 'dB(Z)';
      
      const f1 = Math.round(bounds[hoverIdx] || 0);
      const f2 = Math.round(bounds[hoverIdx+1] || 0);

      const startX = marginLeft + Math.floor((hoverIdx / numBands) * drawWidth);
      const endX = marginLeft + Math.floor(((hoverIdx + 1) / numBands) * drawWidth);
      const barW = Math.max(1, (endX - startX) - padding);

      // A) Surlignage de la bande jusqu'à 100dB (Bleu transparent)
      ctx.fillStyle = 'rgba(99, 102, 241, 0.15)'; 
      ctx.fillRect(startX, 0, barW, drawHeight);

      // B) Le petit "toit" lumineux sur la barre actuelle
      const barHeight = (dbVal / 100) * drawHeight;
      const yTop = drawHeight - barHeight;
      ctx.fillStyle = 'rgba(99, 102, 241, 1)';
      ctx.fillRect(startX, yTop, barW, 2 * dpr);

      // C) Préparation des deux lignes de texte
      const textLine1 = `${dbVal.toFixed(1)} ${unit}`;
      const textLine2 = `${f1} - ${f2} Hz`;

      ctx.font = `bold ${10 * dpr}px sans-serif`;
      const tw1 = ctx.measureText(textLine1).width;
      ctx.font = `${10 * dpr}px sans-serif`;
      const tw2 = ctx.measureText(textLine2).width;
      const tw = Math.max(tw1, tw2) + 16 * dpr;
      const th = 34 * dpr;

      // Position de la bulle (à côté de la barre, mais FIXÉE EN HAUT)
      let tx = startX + barW + 8 * dpr;
      if (tx + tw > width) tx = startX - tw - 8 * dpr;
      
      // On force la bulle à rester tout en haut avec une petite marge
      let ty = 10 * dpr;

      // Fond de la bulle
      ctx.fillStyle = 'rgba(26, 29, 39, 0.96)';
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, th, 4 * dpr);
      ctx.fill();
      ctx.strokeStyle = 'rgba(46, 51, 80, 0.8)';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();

      // Texte Ligne 1 (dB)
      ctx.textAlign = 'left';
      ctx.fillStyle = '#6366f1'; 
      ctx.font = `bold ${11 * dpr}px sans-serif`;
      ctx.fillText(textLine1, tx + 8 * dpr, ty + 14 * dpr);

      // Texte Ligne 2 (Fréquence)
      ctx.fillStyle = '#e2e8f0';
      ctx.font = `${10 * dpr}px sans-serif`;
      ctx.fillText(textLine2, tx + 8 * dpr, ty + 27 * dpr);
    }
  }
}

// Initialiser le chart au démarrage (ajoute cette ligne tout en bas dans la fonction init() juste après initChartDay() ! )

async function renderSystem() {
  config = (await window.hifi.getConfig()) || { profiles: {} };  

  // ══════════════════════════════════════════════════════════
  // 1. GESTION DES PÉRIPHÉRIQUES WASAPI
  // ══════════════════════════════════════════════════════════
  const deviceSelect = document.getElementById('sys-audio-device');
  const btnRefresh = document.getElementById('btn-refresh-devices');

  if (deviceSelect && btnRefresh) {
    deviceSelect.value = config.audio_device || 'default';

    async function refreshDevices() {
      btnRefresh.disabled = true;
      const oldVal = deviceSelect.value;
      deviceSelect.innerHTML = '<option value="default">Recherche en cours...</option>';
      
      const devices = await window.hifi.getAudioDevices();
      
      deviceSelect.innerHTML = '<option value="default">Périphérique par défaut de Windows</option>';
      devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id; 
        opt.textContent = d.name;
        deviceSelect.appendChild(opt);
      });
      
      if (devices.find(d => d.id === oldVal)) deviceSelect.value = oldVal;
      else deviceSelect.value = 'default';
      
      btnRefresh.disabled = false;
    }

    btnRefresh.onclick = refreshDevices;

    // On ne lance la recherche matérielle lourde qu'une seule fois
    if (deviceSelect.options.length <= 1) {
      refreshDevices();
    }
  }

  // ══════════════════════════════════════════════════════════
  // 2. SIMULATEUR SPL
  // ══════════════════════════════════════════════════════════
  const btnSimLoad = document.getElementById('btn-sim-load-active');
  const btnSimulate = document.getElementById('btn-simulate');

  if (btnSimLoad) {
    btnSimLoad.onclick = () => {
      const profile = config.profiles[config.active_profile];
      if (profile) {
        document.getElementById('sim-sens').value = profile.sensitivity;
        document.getElementById('sim-unit').value = profile.sensitivity_unit || 'dB/mW';
        document.getElementById('sim-imp').value = profile.impedance;
        document.getElementById('sim-vout').value = profile.dac_vout;

        // --- VOYANT AUTOEQ ---
        const badge = document.getElementById('sim-eq-badge');
        if (badge) {
          badge.style.display = 'inline-block';
          if (profile.autoeq_file) {
            badge.textContent = `+ EQ: ${profile.autoeq_file}`;
            badge.style.color = 'var(--safe)';
            badge.style.border = '1px solid var(--safe)';
            badge.style.background = 'rgba(34, 197, 94, 0.1)';
            badge.dataset.haseq = 'true'; // On mémorise pour le calcul
          } else {
            badge.textContent = 'Brut (Sans EQ)';
            badge.style.color = 'var(--warn)';
            badge.style.border = '1px solid var(--warn)';
            badge.style.background = 'rgba(249, 115, 22, 0.1)';
            badge.dataset.haseq = 'false';
          }
        }
      } else {
        showToast("Aucun profil actif sélectionné.");
      }
    };
  }

  // Fonction pour afficher le temps proprement
  // Fonction pour afficher le temps proprement (mise à jour pour la semaine)
  function formatTime(minutes) {
    if (minutes === Infinity) return "Illimité (< 70 dB)";
    if (minutes > 10000) return "> 7 jours"; 
    if (minutes < 1) return "< 1 minute";
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    return h > 0 ? `${h}h ${m}m` : `${m} minutes`;
  }

  if (btnSimulate) {
    btnSimulate.onclick = () => {
      const sens = parseFloat(document.getElementById('sim-sens').value);
      const unit = document.getElementById('sim-unit').value;
      const imp  = parseFloat(document.getElementById('sim-imp').value);
      const vout = parseFloat(document.getElementById('sim-vout').value);
      const dbfs = parseFloat(document.getElementById('sim-dbfs').value);
      const vol  = parseFloat(document.getElementById('sim-vol').value);
      const freqStr = document.getElementById('sim-freq').value;
      
      if (isNaN(sens) || isNaN(imp) || isNaN(vout) || isNaN(dbfs) || isNaN(vol) || vol <= 0) {
        document.getElementById('sim-result').textContent = "Veuillez remplir tous les champs obligatoires.";
        return;
      }

      const maxSpl = computeMaxSpl(sens, unit, imp, vout);
      const volAttenuation = 20 * Math.log10(vol / 100);
      const resultZ = maxSpl + dbfs + volAttenuation;
      
      let resultA, displayMsg;

      if (freqStr && !isNaN(parseFloat(freqStr))) {
        const freq = parseFloat(freqStr);
        const offset = getAWeightingOffset(freq);
        resultA = resultZ + offset;
        const sign = offset > 0 ? '+' : '';
        displayMsg = `Ton pur (${freq} Hz) : <span style="color:var(--safe)">${resultA.toFixed(1)} dB(A)</span> <br> <small style="color:var(--muted)">Filtre appliqué : ${sign}${offset.toFixed(1)} dB</small>`;
      } else {
        resultA = resultZ - 5;
        displayMsg = `Musique (Estimé) : <span style="color:var(--safe)">~ ${resultA.toFixed(1)} dB(A)</span> <br> <small style="color:var(--muted)">Filtre estimé : -5.0 dB</small>`;
      }
      
      // Avertissement visuel si un fichier EQ est attaché au profil
      const badge = document.getElementById('sim-eq-badge');
      let eqWarning = '';
      if (badge && badge.dataset.haseq === 'true') {
        eqWarning = `<div style="font-size:10px; color:var(--warn); margin-top:6px; line-height:1.2;">⚠️ Note : L'atténuation (Preamp) du fichier AutoEq n'est pas déduite de cette simulation brute.</div>`;
      }

      document.getElementById('sim-result').innerHTML = `
        MAX SPL : ${maxSpl.toFixed(1)} dB <br>
        Brut physique : <span style="color:var(--muted)">${resultZ.toFixed(1)} dB(Z)</span> <br>
        ${displayMsg}
        ${eqWarning}
      `;

      // --- CALCULS DES LIMITES ---
      // NIOSH: 480 min (8h) à 85 dB, +3 dB divise le temps par 2
      const nioshMins = resultA < 70 ? Infinity : 480 / Math.pow(2, (resultA - 85) / 3);
      
      // OMS: 2400 min (40h) par semaine à 80 dB, +3 dB divise le temps par 2
      const omsWeekMins = resultA < 70 ? Infinity : 2400 / Math.pow(2, (resultA - 80) / 3);
      const omsDayMins  = omsWeekMins / 7;

      const timeNioshEl   = document.getElementById('sim-time-niosh');
      const timeOmsEl     = document.getElementById('sim-time-oms');
      const timeOmsWeekEl = document.getElementById('sim-time-oms-week');
      const refDbEl       = document.getElementById('sim-ref-db');

      if (timeNioshEl && timeOmsEl && timeOmsWeekEl && refDbEl) {
        timeNioshEl.textContent = formatTime(nioshMins);
        timeNioshEl.style.color = nioshMins < 60 ? 'var(--danger)' : 'var(--text)';
        
        timeOmsEl.textContent = formatTime(omsDayMins);
        timeOmsEl.style.color = omsDayMins < 60 ? 'var(--danger)' : 'var(--text)';
        
        timeOmsWeekEl.textContent = formatTime(omsWeekMins);
        timeOmsWeekEl.style.color = omsWeekMins < 120 ? 'var(--danger)' : 'var(--text)';
        
        refDbEl.textContent = `${resultA.toFixed(1)} dB(A)`;
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // 3. GESTIONNAIRE AUTOEQ & PROFILS
  // ══════════════════════════════════════════════════════════
  // --- GESTION DE LA MODALE D'INFORMATION AUTOEQ ---
  const btnInfo = document.getElementById('btn-autoeq-info');
  const modalInfo = document.getElementById('modal-info-overlay');
  const btnCloseInfo = document.getElementById('btn-close-info');
  const linkAutoEqWeb = document.getElementById('link-autoeq-web');

  if (btnInfo && modalInfo && btnCloseInfo) {
    btnInfo.onclick = () => modalInfo.style.display = 'flex';
    btnCloseInfo.onclick = () => modalInfo.style.display = 'none';
    
    // Fermer en cliquant à l'extérieur
    modalInfo.onclick = (e) => {
      if (e.target === modalInfo) modalInfo.style.display = 'none';
    };
  }

  // Ouvrir le lien dans le navigateur par défaut de Windows (pas dans l'app)
  if (linkAutoEqWeb) {
    linkAutoEqWeb.onclick = (e) => {
      e.preventDefault();
      window.hifi.openExternal('https://autoeq.app');
    };
  }
  const managerBody = document.getElementById('autoeq-manager-body');
  const fileInput = document.getElementById('file-autoeq-hidden');
  let targetProfileForUpload = null;

  function refreshAutoEqManager() {
    if (!managerBody) return;
    managerBody.innerHTML = '';

    Object.entries(config.profiles || {}).forEach(([name, p]) => {
      const row = document.createElement('tr');
      row.style.borderBottom = '1px solid var(--bg3)';

      const hasEq = p.autoeq_file;
      const noEqText = L.autoeq_none || 'Aucun EQ';
      const fileName = hasEq ? p.autoeq_file : `<span style="color:var(--muted)">${noEqText}</span>`;
      const activeText = L.profile_active || 'Actif';

      row.innerHTML = `
        <td style="padding: 10px 5px;"><strong>${name}</strong> ${name === config.active_profile ? `<small style="color:var(--accent); margin-left:5px;">(${activeText})</small>` : ''}</td>
        <td style="padding: 10px 5px; font-family: monospace; font-size: 11px;">${fileName}</td>
        <td style="padding: 10px 5px; text-align: right;">
          <button class="btn btn-secondary" style="font-size:10px; padding:4px 8px;" data-add-eq="${name}">${L.btn_associate || 'Associer'}</button>
          ${hasEq ? `<button class="btn btn-danger" style="font-size:10px; padding:4px 8px; margin-left:5px;" data-remove-eq="${name}">X</button>` : ''}
        </td>
      `;

      row.querySelector(`[data-add-eq="${name}"]`).onclick = () => {
        targetProfileForUpload = name;
        fileInput.click();
      };

      if (hasEq) {
        row.querySelector(`[data-remove-eq="${name}"]`).onclick = () => {
          showConfirm(
            `${L.autoeq_remove_title || "Retirer l'EQ du profil"} "${name}" ?`,
            L.autoeq_remove_msg || "Le calcul reviendra au profil neutre.",
            async () => {
              delete config.profiles[name].autoeq_file;
              await window.hifi.saveConfig(config);
              refreshAutoEqManager();
              showToast(L.autoeq_removed || "Égalisation retirée.");
              if (name === config.active_profile) window.hifi.restartDaemon();
            }
          );
        };
      }
      managerBody.appendChild(row);
    });
  }
  // Gérer l'upload et la copie physique du fichier
  if (fileInput) {
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file || !targetProfileForUpload) return;

      // NOUVEAU : Copie physique du fichier dans le dossier data/
      if (file.path) {
        const res = await window.hifi.importCsv(file.path, file.name);
        if (!res.ok) { 
          showToast(L.autoeq_error_copy || "Erreur de copie du fichier"); 
          return; 
        }
      }

      config.profiles[targetProfileForUpload].autoeq_file = file.name;
      await window.hifi.saveConfig(config);
      
      showToast(`${L.autoeq_associated || "Fichier associé à"} ${targetProfileForUpload}`);
      refreshAutoEqManager();

      if (targetProfileForUpload === config.active_profile) {
      }
      
      fileInput.value = ''; 
    };
  }

  // Interrupteur Mode Comparaison
  const toggleCompare = document.getElementById('toggle-compare');
  const compareBox = document.getElementById('compare-box');
  
  if (toggleCompare) {
    toggleCompare.checked = config.compare_eq === true;
    if (compareBox) compareBox.style.display = toggleCompare.checked ? 'block' : 'none';

    toggleCompare.onchange = async () => {
      config.compare_eq = toggleCompare.checked;
      await window.hifi.saveConfig(config);
      if (compareBox) compareBox.style.display = toggleCompare.checked ? 'block' : 'none';
      
      const msgOn = L.compare_mode_on || "Mode Comparaison Activé";
      const msgOff = L.compare_mode_off || "Mode Comparaison Désactivé";
      showToast(toggleCompare.checked ? msgOn : msgOff);
    };
  }

  refreshAutoEqManager();
}

// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
window.__applyLocale = function(newL) {
  L = newL
  MONTHS = L.months || []
  DAYS   = L.days   || []
  applyTranslations()
}

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
  initChartSpectrum()

  renderDoseBars(null)
  await reloadTodayFromCSV()

  const appLoader = document.getElementById('app-loader')
  if (appLoader) { appLoader.classList.add('done'); setTimeout(() => appLoader.remove(), 350) }

  startLivePoll()

  renderSystem()

  document.addEventListener('keydown', e => {
    if (e.code === 'Space') {
      // On empêche la pause si on est en train de taper dans un champ de texte (ex: nom du profil)
      if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.target.id !== 'sys-console') return;
      
      if (currentPage === 'today') {
        e.preventDefault(); 
        togglePause();
      } else if (currentPage === 'system') {
        e.preventDefault();
        toggleConsolePause();
      }
    }
  });
}

init()
