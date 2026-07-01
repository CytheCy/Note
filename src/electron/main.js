/**
 * Electron desktop wrapper.
 *
 * Launches the embedded Express server (src/server.js) in a child process,
 * waits for it to be ready, then opens a BrowserWindow pointed at it.
 *
 * Run with:  npm run electron
 *
 * Requires `electron` to be installed (listed as optionalDependency).
 */

'use strict';

const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const net = require('net');

let serverProc = null;
let win = null;
let PORT = Number(process.env.PORT) || 3777;
let URL = `http://localhost:${PORT}`;

ipcMain.handle('dialog:open-notebook', async () => {
    const result = await dialog.showOpenDialog(win, {
        title: 'Open Notebook',
        properties: ['openFile'],
        filters: [
            { name: 'Notebooks', extensions: ['db', 'sqlite', 'sqlite3'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:create-notebook', async (_event, defaultPath) => {
    const result = await dialog.showSaveDialog(win, {
        title: 'Create Notebook',
        defaultPath: defaultPath || 'Untitled Notebook.db',
        filters: [
            { name: 'Notebooks', extensions: ['db'] },
            { name: 'SQLite', extensions: ['sqlite', 'sqlite3'] },
        ],
    });
    return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:choose-notebook-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
        title: 'Choose Notebook Folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:open-notebook-folder', async (_event, notebookPath) => {
    if (!notebookPath || typeof notebookPath !== 'string') {
        throw new Error('notebook path is required');
    }
    const folder = fs.statSync(notebookPath).isDirectory()
        ? notebookPath
        : path.dirname(notebookPath);
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
    return true;
});

/**
 * Find the SYSTEM node binary — critically NOT Electron itself.
 *
 * Native addons (like better-sqlite3) are compiled against a specific Node ABI.
 * Electron bundles its own Node (different ABI), so `process.execPath` inside
 * Electron is the Electron binary and cannot load a module built for system Node.
 * We must spawn the server with the same system node the addon was built for.
 */
function findSystemNode() {
    if (process.env.NODE_BINARY && fs.existsSync(process.env.NODE_BINARY)) {
        return process.env.NODE_BINARY;
    }
    // Common locations to try before falling back to PATH lookup.
    const candidates = [
        '/usr/bin/node',
        '/usr/local/bin/node',
        '/opt/homebrew/bin/node',
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c) && fs.accessSync(c, fs.constants.X_OK) === undefined) return c; }
        catch (_) {}
    }
    try {
        return execSync('which node', { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim();
    } catch (_) {
        return null;
    }
}

function portIsAvailable(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
    });
}

async function findAvailablePort(startPort) {
    for (let port = startPort; port < startPort + 50; port += 1) {
        if (await portIsAvailable(port)) return port;
    }
    throw new Error(`no available port found from ${startPort} to ${startPort + 49}`);
}

function startServer() {
    const serverPath = path.join(__dirname, '..', 'server.js');
    const nodeBin = findSystemNode();
    if (!nodeBin) {
        console.error('[server] Could not locate system node. Set NODE_BINARY env var.');
        return;
    }
    serverProc = spawn(nodeBin, [serverPath], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => console.log(`[server] ${d}`.trim()));
    serverProc.stderr.on('data', d => console.error(`[server] ${d}`.trim()));
    serverProc.on('exit', code => console.log(`[server] exited ${code}`));
}

async function waitForServer(timeoutMs = 15000) {
    const http = require('http');
    const deadline = Date.now() + timeoutMs;
    const healthy = (pathName) => new Promise(resolve => {
        const req = http.get(URL + pathName, res => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
    });
    while (Date.now() < deadline) {
        const ok = await healthy('/api/tree') && await healthy('/api/notebooks');
        if (ok) return;
        await new Promise(r => setTimeout(r, 400));
    }
    throw new Error('server did not start within timeout');
}

async function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 720,
        minHeight: 480,
        autoHideMenuBar: true,
        backgroundColor: '#fafafa',
        title: '',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const label = ['debug', 'info', 'warn', 'error'][level] || 'log';
        console.log(`[renderer:${label}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
        console.error(`[renderer] failed to load ${validatedURL}: ${code} ${description}`);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        console.error('[renderer] process gone', details);
    });

    // Native application menu. "Settings" lives under File and tells the
    // renderer (via webContents.send) to open the in-app Settings modal.
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Note',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => win.webContents.send('menu:new-note'),
                },
                {
                    label: 'New Folder',
                    click: () => win.webContents.send('menu:new-folder'),
                },
                { type: 'separator' },
                {
                    label: 'Settings…',
                    click: () => win.webContents.send('menu:settings'),
                },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About',
                    click: () => {
                        dialog.showMessageBox(win, {
                            type: 'info',
                            title: 'About',
                            message: 'Note',
                            detail: 'A hierarchical note-taking desktop app.',
                        });
                    },
                },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    win.setMenuBarVisibility(false);

    // open external links in the user's browser, not inside the app
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
        return { action: 'allow' };
    });

    await win.loadURL(URL);
}

app.whenReady().then(async () => {
    if (!process.env.PORT) {
        PORT = await findAvailablePort(PORT);
        URL = `http://localhost:${PORT}`;
    }
    startServer();
    try {
        await waitForServer();
        await createWindow();
    } catch (e) {
        console.error(e);
        // Fallback: load static files directly if server failed.
        await win?.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (serverProc) serverProc.kill();
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (serverProc) serverProc.kill();
});
