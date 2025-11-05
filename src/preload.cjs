// src/preload.cjs  (CommonJS)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // fen�tres
    focusMainWindow: () => ipcRenderer.invoke('focus-main-window'),
    focusChildWindow: (nameHint) => ipcRenderer.invoke('focus-child-window', String(nameHint || '')),

    // captures
    captureRect: (bounds) => ipcRenderer.invoke('capture-rect', bounds),
    captureToClipboard: (bounds) => ipcRenderer.invoke('sessions-capture-to-clipboard', bounds),
    copyImageDataURL: (dataURL) => ipcRenderer.invoke('copy-image-dataurl', String(dataURL || '')),

    // autres
    closeClient: () => ipcRenderer.send('close-client'),
    onTogglePassthrough: (callback) =>
        ipcRenderer.on('passthrough-toggled', (_event, value) => callback(value)),
    // Global actions triggered by main process shortcuts
    onGlobalClear: (callback) =>
        ipcRenderer.on('global-clear', () => callback()),
    onGlobalTogglePause: (callback) =>
        ipcRenderer.on('global-toggle-pause', () => callback()),
    // Hotkey configuration
    getHotkeys: () => ipcRenderer.invoke('get-hotkeys'),
    setHotkeys: (hotkeys) => ipcRenderer.invoke('set-hotkeys', hotkeys),
    onHotkeysChanged: (callback) => ipcRenderer.on('hotkeys-changed', (_e, h) => callback(h)),
});
