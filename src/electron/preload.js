/**
 * preload.js — safe bridge between the sandboxed renderer and the main process.
 *
 * With contextIsolation enabled, the renderer cannot touch Node/Electron APIs
 * directly. We expose a tiny, explicit `electronAPI` surface that the renderer
 * can subscribe to. Currently used by the native File menu (menu:new-note,
 * menu:new-folder, menu:settings) so its items can drive the in-app UI.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    on: (channel, listener) => {
        const allowed = ['menu:new-note', 'menu:new-folder', 'menu:settings'];
        if (!allowed.includes(channel)) return;
        ipcRenderer.on(channel, () => listener());
    },
    openNotebookFile: () => ipcRenderer.invoke('dialog:open-notebook'),
    createNotebookFile: (defaultPath) => ipcRenderer.invoke('dialog:create-notebook', defaultPath),
    chooseNotebookFolder: () => ipcRenderer.invoke('dialog:choose-notebook-folder'),
});
