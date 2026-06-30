'use strict';

const { app, BrowserWindow } = require('electron');

const APP_URL = process.env.NOTE_APP_URL || 'http://localhost:3777';

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function typeText(win, text) {
    for (const char of text) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: char });
        win.webContents.sendInputEvent({ type: 'char', keyCode: char });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: char });
        await wait(20);
    }
}

async function main() {
    const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 700,
        webPreferences: {
            contextIsolation: false,
            sandbox: false,
        },
    });

    await win.loadURL(APP_URL);
    await wait(1000);

    await win.webContents.executeJavaScript(`
        document.getElementById('notebookMenuButton').click();
        document.querySelector('[data-action="create-notebook"]').click();
    `);
    await wait(1000);

    const before = await win.webContents.executeJavaScript(`
        (() => {
            const input = document.getElementById('createNotebookName');
            return {
                active: document.activeElement === input,
                panelHidden: document.getElementById('createNotebookPanel').hidden,
                menuHidden: document.getElementById('notebookMenu').hidden,
                value: input.value,
            };
        })()
    `);

    if (!before.active || before.panelHidden || before.menuHidden) {
        throw new Error('create notebook name input is not ready for typing: ' + JSON.stringify(before));
    }

    await typeText(win, 'Project Notes');
    await wait(100);

    const after = await win.webContents.executeJavaScript(`
        (() => {
            const input = document.getElementById('createNotebookName');
            return {
                active: document.activeElement === input,
                value: input.value,
                path: document.getElementById('createNotebookPath').textContent,
            };
        })()
    `);

    if (!after.active || after.value !== 'Project Notes') {
        throw new Error('create notebook name input did not accept typing: ' + JSON.stringify(after));
    }
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
