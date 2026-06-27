'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

async function readSmokeState(win) {
    return win.webContents.executeJavaScript(`
        ({
            status: document.body.dataset.treeDragDropSmoke || '',
            error: document.body.dataset.error || '',
        })
    `);
}

async function main() {
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: false,
            sandbox: false,
        },
    });

    await win.loadFile(path.join(__dirname, 'tree-drag-drop-smoke.html'));
    for (let i = 0; i < 50; i += 1) {
        const state = await readSmokeState(win);
        if (state.status === 'pass') return;
        if (state.status === 'fail') throw new Error(state.error || 'tree drag-drop smoke failed');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('tree drag-drop smoke timed out');
}

app.whenReady().then(async () => {
    try {
        await main();
        app.exit(0);
    } catch (error) {
        console.error(error.message || error);
        app.exit(1);
    }
});
