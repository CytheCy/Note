'use strict';

const { app, BrowserWindow } = require('electron');

const APP_URL = process.env.NOTE_APP_URL || 'http://localhost:3777';

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(win, expression, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = await win.webContents.executeJavaScript(expression);
        if (value) return value;
        await wait(100);
    }
    throw new Error('Timed out waiting for: ' + expression);
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

    const original = await win.webContents.executeJavaScript(`
        fetch('/api/notebooks').then(r => r.json()).then(s => s.current)
    `);
    await win.webContents.executeJavaScript(`
        window.__openedNotebookFolder = null;
        window.__apiOpenFolderCalled = false;
        window.electronAPI = {
            openNotebookFolder: async (notebookPath) => {
                window.__openedNotebookFolder = notebookPath;
                return true;
            },
        };
        window.__realOpenNotebookFolder = Api.openNotebookFolder;
        Api.openNotebookFolder = async () => {
            window.__apiOpenFolderCalled = true;
            return { ok: true };
        };
        undefined;
    `);
    const testName = `Notebook Edit Panel Smoke ${Date.now()}`;
    const testIcon = 'bx bx-star';

    try {
        await win.webContents.executeJavaScript(`
            document.getElementById('notebookMenuButton').click();
            document.querySelector('[data-action="edit-notebook"]').click();
        `);

        await waitFor(win, `!document.getElementById('editNotebookPanel').hidden`);
        const before = await win.webContents.executeJavaScript(`
            (() => {
                const input = document.getElementById('editNotebookName');
                const panel = document.getElementById('editNotebookPanel');
                const menu = document.getElementById('notebookMenu');
                const sourceFile = document.getElementById('editNotebookSourceFile');
                const panelRect = panel.getBoundingClientRect();
                const menuRect = menu.getBoundingClientRect();
                return {
                    active: document.activeElement === input,
                    panelHidden: panel.hidden,
                    createHidden: document.getElementById('createNotebookPanel').hidden,
                    menuHidden: menu.hidden,
                    value: input.value,
                    sourceFile: sourceFile.textContent,
                    sourceFileTitle: sourceFile.title,
                    openFolderVisible: !!document.getElementById('openCurrentNotebookFolderBtn'),
                    panelInsideMenu: panelRect.left >= menuRect.left
                        && panelRect.right <= menuRect.right
                        && panelRect.top >= menuRect.top
                        && panelRect.bottom <= menuRect.bottom,
                };
            })()
        `);

        const expectedSourceFile = original.path.split(/[\\/]/).pop();
        if (!before.active || before.panelHidden || !before.createHidden || before.menuHidden || before.value !== original.name || before.sourceFile !== expectedSourceFile || before.sourceFileTitle !== original.path || !before.openFolderVisible || !before.panelInsideMenu) {
            throw new Error('edit notebook panel was not initialized in the menu: ' + JSON.stringify(before));
        }

        await win.webContents.executeJavaScript(`
            document.getElementById('openCurrentNotebookFolderBtn').click();
        `);
        await waitFor(win, `window.__openedNotebookFolder === ${JSON.stringify(original.path)}`);

        await win.webContents.executeJavaScript(`
            window.__openedNotebookFolder = null;
            window.electronAPI.openNotebookFolder = async () => {
                throw new Error("Error invoking remote method 'shell:open-notebook-folder': Error: No handler registered for 'shell:open-notebook-folder'");
            };
            document.getElementById('openCurrentNotebookFolderBtn').click();
        `);
        await waitFor(win, `window.__apiOpenFolderCalled === true && window.__openedNotebookFolder === null`);

        await waitFor(win, `!!document.querySelector('#editNotebookIcons button[data-icon="${testIcon}"]')`, 12000);
        await win.webContents.executeJavaScript(`
            document.getElementById('editNotebookName').value = ${JSON.stringify(testName)};
            document.querySelector('#editNotebookIcons button[data-icon="${testIcon}"]').click();
            document.getElementById('editNotebookPanel').requestSubmit();
        `);
        await waitFor(win, `document.getElementById('notebookMenu').hidden && document.getElementById('editNotebookPanel').hidden`);
        await wait(300);

        const updated = await win.webContents.executeJavaScript(`
            fetch('/api/notebooks').then(r => r.json()).then(s => s.current)
        `);
        if (updated.name !== testName || updated.icon !== testIcon) {
            throw new Error('notebook metadata was not saved: ' + JSON.stringify(updated));
        }
    } finally {
        await win.webContents.executeJavaScript(`
            fetch('/api/notebooks/current', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: ${JSON.stringify(original.name)}, icon: ${JSON.stringify(original.icon || '')} }),
            })
        `).catch(() => {});
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
