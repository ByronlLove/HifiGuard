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
let sessionData = { labels: [], dba: [], niosh: [], omsj: [] }
const SESSION_MAX = 800

const COLORS = { dba:'#6366f1', niosh:'#f97316', omsj:'#22c55e', dbz:'#475569' }
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const DAYS   = ['L','M','M','J','V','S','D']

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
  if (!db || db === 0) return 'var(--muted)'
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
  initChartToday()
  renderDoseBars(null)
  // Reload depuis CSV au démarrage pour remplir le graphe today
  await reloadTodayFromCSV()
  pollState()
  setInterval(pollState, 250)
}

async function pollState() {
  const state = await window.hifi.getState()
  if (!state) return
  suivi = await window.hifi.getSuivi()
  updateLive(state)
  updateTitlebar(state)
  if (currentPage === 'today') appendTodayPoint(state)
}

window.hifi.onStateUpdate(state => {
  updateLive(state)
  updateTitlebar(state)
  if (currentPage === 'today') appendTodayPoint(state)
})

// ══════════════════════════════════════════════════════════
// TITLEBAR
// ══════════════════════════════════════════════════════════
function updateTitlebar(state) {
  const db = state && state.db_a > 0 ? state.db_a.toFixed(1) + ' dB(A)' : '--'
  document.getElementById('titlebar-db').textContent = db + ' '
  document.getElementById('titlebar-db').style.color = state ? dbColor(state.db_a) : 'var(--muted)'
  if (config) document.getElementById('titlebar-profile').textContent = '— ' + config.active_profile
}

// ══════════════════════════════════════════════════════════
// LIVE SIDEBAR
// ══════════════════════════════════════════════════════════
function updateLive(state) {
  const db  = state ? state.db_a : 0
  const col = dbColor(db)
  const dbTxt = db > 0 ? db.toFixed(1) : '--'
  document.getElementById('live-db').textContent       = dbTxt
  document.getElementById('live-db').style.color       = col
  document.getElementById('live-bar').style.width      = Math.min(db/120*100, 100) + '%'
  document.getElementById('live-bar').style.background = col
  document.getElementById('live-niosh').textContent    = state ? state.dose_niosh.toFixed(1)+'%' : '--%'
  document.getElementById('live-oms-j').textContent    = state ? state.dose_who_j.toFixed(1)+'%'  : '--%'
  document.getElementById('live-oms-7j').textContent   = state ? state.dose_who_7j.toFixed(1)+'%' : '--%'
}

// ══════════════════════════════════════════════════════════
// PAGE TODAY
// ══════════════════════════════════════════════════════════

// Recharge le graphe depuis le CSV au chargement de la page
async function reloadTodayFromCSV() {
  const today = new Date().toISOString().slice(0,10)
  const rows  = await window.hifi.readCsvRange(today+'T00:00:00.000', today+'T23:59:59.999')
  if (!rows.length) return

  // Downsample si trop de points
  const step = Math.ceil(rows.length / SESSION_MAX)
  const data = rows.filter((_,i) => i%step===0)

  sessionData.labels = data.map(r => r.ts.slice(11,19))
  sessionData.dba    = data.map(r => r.db_a)
  // NIOSH et OMS ne sont pas dans le CSV ligne par ligne, on laisse à 0
  sessionData.niosh  = data.map(() => 0)
  sessionData.omsj   = data.map(() => 0)

  if (chartToday) {
    chartToday.data.labels        = sessionData.labels
    chartToday.data.datasets[0].data = sessionData.dba
    chartToday.data.datasets[1].data = sessionData.niosh
    chartToday.data.datasets[2].data = sessionData.omsj
    chartToday.update('none')
  }
}

function appendTodayPoint(state) {
  const today = new Date().toISOString().slice(0,10)
  const d = suivi[today] || {}
  const col = dbColor(state.db_a)

  // Stats
  const dbTxt = state.db_a > 0 ? state.db_a.toFixed(1)+' dB' : '--'
  document.getElementById('s-db').textContent    = dbTxt
  document.getElementById('s-db').style.color    = col
  document.getElementById('s-niosh').textContent = (d.dose_niosh_pct   ||0).toFixed(1)+'%'
  document.getElementById('s-omsj').textContent  = (d.dose_who_day_pct ||0).toFixed(1)+'%'
  document.getElementById('s-oms7j').textContent = state.dose_who_7j.toFixed(1)+'%'
  document.getElementById('s-max').textContent   = (d.max_db_a||0).toFixed(1)+' dB'
  document.getElementById('s-t80').textContent   = (d.minutes_above_80||0).toFixed(1)+' min'

  renderDoseBars({ niosh:d.dose_niosh_pct||0, omsj:d.dose_who_day_pct||0, oms7j:state.dose_who_7j })

  // Graphe — n'ajoute que si db > 0
  const t = new Date()
  const label = t.toTimeString().slice(0,8)
  sessionData.labels.push(label)
  sessionData.dba.push(state.db_a > 0 ? state.db_a : null)
  sessionData.niosh.push(d.dose_niosh_pct||0)
  sessionData.omsj.push(d.dose_who_day_pct||0)
  if (sessionData.labels.length > SESSION_MAX) {
    sessionData.labels.shift(); sessionData.dba.shift()
    sessionData.niosh.shift();  sessionData.omsj.shift()
  }
  if (chartToday) {
    chartToday.data.labels        = sessionData.labels
    chartToday.data.datasets[0].data = sessionData.dba
    chartToday.data.datasets[1].data = sessionData.niosh
    chartToday.data.datasets[2].data = sessionData.omsj
    chartToday.update('none')
  }
}

function renderDoseBars(doses) {
  document.getElementById('dose-bars').innerHTML = [
    { name:'NIOSH',    val:doses?doses.niosh:0,  color:COLORS.niosh, sub:'85 dB(A)/8h'   },
    { name:'OMS/jour', val:doses?doses.omsj:0,   color:COLORS.omsj,  sub:'80 dB(A)/342min'},
    { name:'OMS/7j',   val:doses?doses.oms7j:0,  color:'#a855f7',    sub:'80 dB(A)/40h'  },
  ].map(it => {
    const pct = Math.min(it.val||0, 100)
    const col = it.val>80 ? 'var(--danger)' : it.val>50 ? 'var(--warn)' : it.color
    return `<div class="dose-row">
      <div class="dose-name" title="Seuil : ${it.sub}">${it.name}</div>
      <div class="dose-track"><div class="dose-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="dose-pct" style="color:${col}">${(it.val||0).toFixed(1)}%</div>
    </div>`
  }).join('')
}

// ══════════════════════════════════════════════════════════
// CHARTS avec zoom/pan
// ══════════════════════════════════════════════════════════
const ZOOM_PLUGIN = {
  zoom: {
    wheel: { enabled: true },
    pinch: { enabled: true },
    mode: 'x',
    onZoom: () => {}
  },
  pan: {
    enabled: true,
    mode: 'x'
  }
}

function initChartToday() {
  const ctx = document.getElementById('chart-today').getContext('2d')
  const datasets = [
    { label:'dB(A)',   data:[], borderColor:COLORS.dba,   borderWidth:2,   pointRadius:0, tension:0.3, yAxisID:'y',  spanGaps:true },
    { label:'NIOSH %', data:[], borderColor:COLORS.niosh, borderWidth:1.5, pointRadius:0, tension:0.3, yAxisID:'y2', borderDash:[4,4] },
    { label:'OMS/j %', data:[], borderColor:COLORS.omsj,  borderWidth:1.5, pointRadius:0, tension:0.3, yAxisID:'y2', borderDash:[4,4] },
  ]
  chartToday = new Chart(ctx, {
    type:'line', data:{ labels:[], datasets },
    options:{
      animation:false, responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:false }, zoom:ZOOM_PLUGIN },
      scales:{
        x:{ ticks:{ maxTicksLimit:8, maxRotation:0 } },
        y:{ position:'left',  title:{ display:true, text:'dB(A)' }, min:0, max:120 },
        y2:{ position:'right', title:{ display:true, text:'Dose %' }, min:0, max:100, grid:{ drawOnChartArea:false } }
      }
    }
  })
  // Double-clic = reset zoom
  document.getElementById('chart-today').addEventListener('dblclick', () => chartToday.resetZoom())
  buildLegend('legend-today', chartToday, datasets)
}

function buildLegend(id, chart, datasets) {
  const c = document.getElementById(id)
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
}

// ══════════════════════════════════════════════════════════
// CALENDAR
// ══════════════════════════════════════════════════════════
document.getElementById('cal-prev').addEventListener('click', calPrev)
document.getElementById('cal-next').addEventListener('click', calNext)

function calPrev() {
  if (calView==='year')  { calYear--; renderViewYear() }
  if (calView==='month') { calMonth--; if(calMonth<0){calMonth=11;calYear--}; renderViewMonth() }
}
function calNext() {
  if (calView==='year')  { calYear++; renderViewYear() }
  if (calView==='month') { calMonth++; if(calMonth>11){calMonth=0;calYear++}; renderViewMonth() }
}

async function renderCalendar() {
  suivi = await window.hifi.getSuivi()
  calView='year'; renderViewYear()
}

function renderViewYear() {
  calView='year'
  document.getElementById('cal-title').textContent = calYear
  showCalView('view-year'); updateBreadcrumb()
  document.getElementById('view-year').innerHTML = MONTHS.map((name,mi) => {
    const { avgDose, days, color } = getMonthStats(calYear, mi)
    return `<div class="month-cell" data-month="${mi}">
      <div class="month-name">${name}</div>
      <div class="month-stats">${days}j · ${avgDose.toFixed(0)}% OMS moy.</div>
      <div class="month-bar"><div class="month-bar-fill" style="width:${Math.min(avgDose,100)}%;background:${color}"></div></div>
    </div>`
  }).join('')
  document.querySelectorAll('.month-cell').forEach(el => {
    el.addEventListener('click', () => { calMonth=+el.dataset.month; animTransition(renderViewMonth) })
  })
}

function getMonthStats(year, month) {
  let total=0, days=0
  const dim = new Date(year, month+1, 0).getDate()
  for (let d=1; d<=dim; d++) {
    const key = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    if (suivi[key]) { total+=suivi[key].dose_who_day_pct||0; days++ }
  }
  const avg = days>0 ? total/days : 0
  const color = avg>80?'var(--danger)':avg>50?'var(--warn)':avg>20?'#84cc16':'var(--safe)'
  return { avgDose:avg, days, color }
}

function renderViewMonth() {
  calView='month'
  document.getElementById('cal-title').textContent = MONTHS[calMonth]+' '+calYear
  showCalView('view-month'); updateBreadcrumb()
  const today = new Date().toISOString().slice(0,10)
  const firstMon = (new Date(calYear,calMonth,1).getDay()+6)%7
  const dim = new Date(calYear,calMonth+1,0).getDate()
  const grid = document.getElementById('cal-month-grid')
  grid.innerHTML = DAYS.map(d=>`<div class="cal-day-header">${d}</div>`).join('')
  for(let i=0;i<firstMon;i++) grid.innerHTML+=`<div class="cal-day empty"></div>`
  for(let d=1;d<=dim;d++){
    const key=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const data=suivi[key]; const isToday=key===today
    let cls='nodata',dot='#333',dose=0
    if(data){
      dose=data.dose_who_day_pct||0
      if(dose>80){cls='danger';dot='var(--danger)'}
      else if(dose>50){cls='warn';dot='var(--warn)'}
      else if(dose>20){cls='ok';dot='#84cc16'}
      else{cls='safe';dot='var(--safe)'}
    }
    grid.innerHTML+=`<div class="cal-day ${cls}${isToday?' today':''}" data-key="${key}" title="${key} — OMS/j: ${dose.toFixed(1)}%">
      <div>${d}</div>${data?`<div class="day-dot" style="background:${dot}"></div>`:''}
    </div>`
  }
  grid.querySelectorAll('.cal-day:not(.empty):not(.nodata)').forEach(el => {
    el.addEventListener('click', () => { calDay=el.dataset.key; animTransition(()=>renderViewDay(calDay)) })
  })
}

async function renderViewDay(dateKey) {
  calView='day'
  document.getElementById('cal-title').textContent = formatDateFR(dateKey)
  showCalView('view-day'); updateBreadcrumb()
  const data = suivi[dateKey]||{}
  document.getElementById('day-stats-grid').innerHTML = [
    {v:(data.dose_niosh_pct||0).toFixed(1)+'%',    l:'NIOSH',       sub:'85 dB(A)/8h'},
    {v:(data.dose_who_day_pct||0).toFixed(1)+'%',  l:'OMS/jour',    sub:'80 dB(A)/342min'},
    {v:(data.dose_who_week_pct||0).toFixed(1)+'%', l:'OMS contrib.',sub:'Contribution hebdo'},
    {v:(data.max_db_a||0).toFixed(1)+' dB',        l:'Pic',         sub:'dB(A) max'},
    {v:(data.minutes_above_80||0).toFixed(1)+' min',l:'>80 dB(A)',  sub:''},
    {v:(data.minutes_above_85||0).toFixed(1)+' min',l:'>85 dB(A)',  sub:''},
  ].map(s=>`<div class="stat-card"><div class="stat-val">${s.v}</div><div class="stat-label">${s.l}</div>${s.sub?`<div class="stat-sub">${s.sub}</div>`:''}</div>`).join('')

  document.getElementById('day-chart-title').textContent = 'Courbes du '+formatDateFR(dateKey)
  const rows = await window.hifi.readCsvRange(dateKey+'T00:00:00.000', dateKey+'T23:59:59.999')
  renderDayChart(rows)
}

function renderDayChart(rows) {
  if (chartDay) chartDay.destroy()
  const step = Math.ceil(rows.length/600)
  const data = rows.filter((_,i)=>i%step===0)
  const labels = data.map(r=>r.ts.slice(11,19))
  const datasets = [
    { label:'dB(A)', data:data.map(r=>r.db_a>0?r.db_a:null), borderColor:COLORS.dba, borderWidth:1.5, pointRadius:0, tension:0.2, spanGaps:true },
    { label:'dB(Z)', data:data.map(r=>r.db_z>0?r.db_z:null), borderColor:COLORS.dbz, borderWidth:1,   pointRadius:0, tension:0.2, borderDash:[3,3], spanGaps:true },
  ]
  const ctx = document.getElementById('chart-day').getContext('2d')
  chartDay = new Chart(ctx, {
    type:'line', data:{ labels, datasets },
    options:{
      animation:false, responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:false }, zoom:ZOOM_PLUGIN },
      scales:{
        x:{ ticks:{ maxTicksLimit:10, maxRotation:0 } },
        y:{ title:{ display:true, text:'dB' }, min:0, max:120 }
      }
    }
  })
  document.getElementById('chart-day').addEventListener('dblclick', () => chartDay.resetZoom())
  buildLegend('legend-day', chartDay, datasets)
}

// ══════════════════════════════════════════════════════════
// BREADCRUMB
// ══════════════════════════════════════════════════════════
function updateBreadcrumb() {
  const bc = document.getElementById('breadcrumb')
  const parts = [{ label:String(calYear), action:()=>animTransition(renderViewYear) }]
  if (calView==='month'||calView==='day') parts.push({ label:MONTHS[calMonth], action:()=>animTransition(renderViewMonth) })
  if (calView==='day'&&calDay) parts.push({ label:formatDateFR(calDay), action:null })
  bc.innerHTML = parts.map((p,i)=>{
    const isLast=i===parts.length-1
    return `<span class="${isLast?'bc-current':'bc-item'}" data-i="${i}">${p.label}</span>`+(isLast?'':`<span class="bc-sep">›</span>`)
  }).join('')
  bc.querySelectorAll('.bc-item').forEach((el,i)=>{ if(parts[i].action) el.addEventListener('click',parts[i].action) })
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
  document.getElementById('btn-export').onclick  = () => window.hifi.exportData()
  document.getElementById('btn-restart').onclick = () => window.hifi.restartDaemon()
  document.getElementById('btn-clear-form').onclick   = clearForm
  document.getElementById('btn-save-profile').onclick = saveProfile
  document.getElementById('btn-save-refresh').onclick = saveRefresh
  document.getElementById('btn-save-thresholds').onclick = saveThresholds
  ;['f-sens','f-imp','f-vout','f-sens-unit'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateMaxSplPreview)
  })
}

function renderProfileList() {
  const list = document.getElementById('profile-list')
  list.innerHTML = ''
  Object.entries(config.profiles).forEach(([name,p]) => {
    const unit = p.sensitivity_unit || 'dB/mW'
    const maxSpl = computeMaxSpl(p.sensitivity, unit, p.impedance, p.dac_vout)
    const isActive = name === config.active_profile
    const item = document.createElement('div')
    item.className = 'profile-item'+(isActive?' active':'')
    item.innerHTML = `<div>
      <div class="profile-name">${name}</div>
      <div class="profile-desc">${p.description||''}</div>
      <div class="profile-specs">${p.sensitivity} ${unit} · ${p.impedance}Ω · ${p.dac_vout}Vrms → MAX SPL: ${maxSpl.toFixed(1)} dB</div>
    </div>
    <div style="display:flex;gap:7px;align-items:center;flex-shrink:0;">
      ${isActive?'<span class="profile-badge">Actif</span>':`<button class="btn btn-secondary" style="font-size:11px" data-activate="${name}">Activer</button>`}
      <button class="btn btn-secondary" style="font-size:11px" data-edit="${name}">Modifier</button>
    </div>`
    const ab = item.querySelector('[data-activate]')
    if (ab) ab.addEventListener('click', async()=>{ config.active_profile=name; await window.hifi.saveConfig(config); renderProfileList() })
    item.querySelector('[data-edit]').addEventListener('click', ()=>{
      document.getElementById('f-name').value = name
      document.getElementById('f-sens').value = p.sensitivity
      document.getElementById('f-sens-unit').value = p.sensitivity_unit||'dB/mW'
      document.getElementById('f-imp').value  = p.impedance
      document.getElementById('f-vout').value = p.dac_vout
      document.getElementById('f-desc').value = p.description||''
      updateMaxSplPreview()
    })
    list.appendChild(item)
  })
}

function computeMaxSpl(raw, unit, imp, vout) {
  let sensMw
  if (unit==='dB/mW')      sensMw = raw
  else if (unit==='mV/Pa') sensMw = 20*Math.log10(raw/1000) + 10*Math.log10(1000/imp) + 120
  else if (unit==='dB/V')  sensMw = raw - 10*Math.log10(imp/1000)
  else sensMw = raw
  return sensMw + 10*Math.log10(((vout**2)/imp)*1000)
}

function updateMaxSplPreview() {
  const sens = parseFloat(document.getElementById('f-sens').value)
  const unit = document.getElementById('f-sens-unit').value
  const imp  = parseFloat(document.getElementById('f-imp').value)
  const vout = parseFloat(document.getElementById('f-vout').value)
  const el   = document.getElementById('f-maxspl')
  if (sens && imp && vout) {
    const maxSpl = computeMaxSpl(sens, unit, imp, vout)
    el.textContent = `→ MAX SPL calculé : ${maxSpl.toFixed(1)} dB`
  } else el.textContent = ''
}

async function saveProfile() {
  const name = document.getElementById('f-name').value.trim()
  const sens = parseFloat(document.getElementById('f-sens').value)
  const unit = document.getElementById('f-sens-unit').value
  const imp  = parseFloat(document.getElementById('f-imp').value)
  const vout = parseFloat(document.getElementById('f-vout').value)
  const desc = document.getElementById('f-desc').value.trim()
  if (!name||!sens||!imp||!vout) return alert('Remplis tous les champs obligatoires.')
  config = await window.hifi.getConfig()
  config.profiles[name] = { sensitivity:sens, sensitivity_unit:unit, impedance:imp, dac_vout:vout, description:desc }
  await window.hifi.saveConfig(config)
  clearForm(); renderProfileList()
}

function clearForm() {
  ['f-name','f-sens','f-imp','f-vout','f-desc'].forEach(id=>document.getElementById(id).value='')
  document.getElementById('f-sens-unit').value='dB/mW'
  document.getElementById('f-maxspl').textContent=''
}

// ── Modes refresh ─────────────────────────────────────────
function renderRefreshModes() {
  const mode = config.refresh_mode || 'focus'
  document.querySelectorAll('.refresh-card').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode)
    el.addEventListener('click', () => {
      document.querySelectorAll('.refresh-card').forEach(e=>e.classList.remove('active'))
      el.classList.add('active')
      const isCustom = el.dataset.mode === 'custom'
      document.getElementById('custom-refresh-fields').classList.toggle('visible', isCustom)
    })
  })
  const isCustom = mode === 'custom'
  document.getElementById('custom-refresh-fields').classList.toggle('visible', isCustom)
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
      python_ms: parseInt(document.getElementById('rc-python').value)||25,
      ui_ms:     parseInt(document.getElementById('rc-ui').value)||250,
      tray_ms:   parseInt(document.getElementById('rc-tray').value)||1000,
    }
  }
  await window.hifi.saveConfig(config)
}

// ── Seuils tray ───────────────────────────────────────────
const THRESHOLD_DEFS = [
  { key:'ok',     label:'Vert (sûr)',      color:'#22c55e' },
  { key:'warn',   label:'Orange (modéré)', color:'#f97316' },
  { key:'danger', label:'Rouge (danger)',  color:'#ef4444' },
]

function renderThresholds() {
  const t = getThresholds()
  document.getElementById('threshold-grid').innerHTML = THRESHOLD_DEFS.map(def=>`
    <div class="threshold-row">
      <div class="threshold-color" style="background:${def.color}"></div>
      <div class="threshold-label">${def.label}</div>
      <input class="threshold-input" type="number" data-key="${def.key}" value="${t[def.key]}" min="50" max="130" step="1"> dB
    </div>`).join('')
}

async function saveThresholds() {
  const thresholds = { safe:0, ok:75, warn:80, danger:85 }
  document.querySelectorAll('.threshold-input').forEach(input=>{
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
  ['view-year','view-month','view-day'].forEach(v=>{
    const el=document.getElementById(v)
    el.style.display='none'
  })
  const el=document.getElementById(id)
  el.style.display = id==='view-year' ? 'grid' : 'block'
}

function animTransition(fn) {
  const view = document.getElementById('calendar-view')
  view.classList.add('anim-out')
  setTimeout(()=>{ view.classList.remove('anim-out'); fn(); view.classList.add('anim-in'); setTimeout(()=>view.classList.remove('anim-in'),280) }, 180)
}

function formatDateFR(key) {
  const [y,m,d]=key.split('-')
  return `${parseInt(d)} ${MONTHS[parseInt(m)-1]} ${y}`
}

init()
