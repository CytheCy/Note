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

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

let serverProc = null;
let win = null;
const PORT = process.env.PORT || 3777;
const URL = `http://localhost:${PORT}`;

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
    while (Date.now() < deadline) {
        const ok = await new Promise(resolve => {
            const req = http.get(URL + '/api/tree', res => {
                res.resume();
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(800, () => { req.destroy(); resolve(false); });
        });
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
        backgroundColor: '#fafafa',
        title: 'Trilium-Style Notes',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // open external links in the user's browser, not inside the app
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
        return { action: 'allow' };
    });

    await win.loadURL(URL);
}

app.whenReady().then(async () => {
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
