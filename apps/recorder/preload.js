// meetcap bridge + a tiny app channel for tray state.
const { contextBridge, ipcRenderer } = require('electron')
const { exposeMeetcapBridge } = require('meetcap-core/preload')

exposeMeetcapBridge(contextBridge, ipcRenderer)

contextBridge.exposeInMainWorld('recorderApp', {
  reportState: (state) => ipcRenderer.send('recorder-app:state', state),
  reportMeeting: (active) => ipcRenderer.send('recorder-app:meeting', active),
  library: () => ipcRenderer.invoke('recorder-app:library'),
  openFolder: () => ipcRenderer.invoke('recorder-app:open-folder'),
  pip: (show) => ipcRenderer.invoke('recorder-app:pip', show),
})
