const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hifi', {
  getState:        ()                       => ipcRenderer.invoke('get-state'),
  getConfig:       ()                       => ipcRenderer.invoke('get-config'),
  getSuivi:        ()                       => ipcRenderer.invoke('get-suivi'),
  saveConfig:      (config)                 => ipcRenderer.invoke('save-config', config),
  // secondsPerBucket : 0 = auto (max 600 pts), >0 = résolution fixe en secondes
  // Le downsampling est fait dans le main process — le renderer reçoit des données légères
  readCsvRange:    (from, to, spb = 0)      => ipcRenderer.invoke('read-csv-range', from, to, spb),
  exportData:      ()                       => ipcRenderer.invoke('export-data'),
  restartDaemon:   ()                       => ipcRenderer.invoke('restart-daemon'),
  onStateUpdate:   (cb)                     => ipcRenderer.on('state-update', (_, s) => cb(s)),
  onNavigate:      (cb)                     => ipcRenderer.on('navigate', (_, page) => cb(page)),
  // Contrôles fenêtre (titlebar custom)
  winMinimize:     ()                       => ipcRenderer.send('win-minimize'),
  winMaximize:     ()                       => ipcRenderer.send('win-maximize'),
  winClose:        ()                       => ipcRenderer.send('win-close'),
  deleteDayData:   (dateKey)                 => ipcRenderer.invoke('delete-day-data', dateKey),
  deleteMonthData: (year, month)             => ipcRenderer.invoke('delete-month-data', year, month),
  deleteOldData:   (keepDays)                => ipcRenderer.invoke('delete-old-data', keepDays),
  getLocale:       ()                          => ipcRenderer.invoke('get-locale'),
  setLanguage:     (lang)                      => ipcRenderer.invoke('set-language', lang),
})
