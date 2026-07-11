// meetcap bridge + a tiny app channel (bar / library / pip plumbing).
const { contextBridge, ipcRenderer } = require('electron')
const { exposeMeetcapBridge } = require('meetcap-core/preload')

exposeMeetcapBridge(contextBridge, ipcRenderer)

contextBridge.exposeInMainWorld('recorderApp', {
  reportState: (state) => ipcRenderer.send('recorder-app:state', state),
  reportMeeting: (active) => ipcRenderer.send('recorder-app:meeting', active),
  library: () => ipcRenderer.invoke('recorder-app:library'),
  openFolder: () => ipcRenderer.invoke('recorder-app:open-folder'),
  reveal: (filePath) => ipcRenderer.invoke('recorder-app:reveal', filePath),
  showLibrary: () => ipcRenderer.invoke('recorder-app:show-library'),
  hideBar: () => ipcRenderer.invoke('recorder-app:hide-bar'),
  pip: (show, deviceId) => ipcRenderer.invoke('recorder-app:pip', show, deviceId),
  barHeight: (h) => ipcRenderer.invoke('recorder-app:bar-height', h),
  captureSources: () => ipcRenderer.invoke('recorder-app:capture-sources'),
  pickScreen: (currentId) => ipcRenderer.invoke('recorder-app:pick-screen', currentId),
  pickerDone: (result) => ipcRenderer.send('recorder-app:picker-done', result),
  onToggleRecord: (cb) => ipcRenderer.on('recorder-app:toggle-record', cb),
  onLibraryUpdated: (cb) => ipcRenderer.on('recorder-app:library-updated', cb),
})
