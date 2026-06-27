'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

async function readSmokeState(win) {
    return win.webContents.executeJavaScript(`
        ({
            status: document.body.dataset.editorTableSmoke || '',
            error: document.body.dataset.error || '',
        })
    `);
}

async function assertRealHoverHandle(win, selector, label) {
    const point = await win.webContents.executeJavaScript(`
        (() => {
            const editor = document.getElementById('richTextEditor');
            editor.innerHTML = '<p id="regular-hover">Regular text</p><table id="table-hover"><tbody><tr><td>Cell</td></tr></tbody></table>';
            const block = document.querySelector(${JSON.stringify(selector)});
            const rect = block.getBoundingClientRect();
            return {
                x: Math.round(rect.left + Math.min(20, rect.width / 2)),
                y: Math.round(rect.top + Math.min(10, rect.height / 2)),
            };
        })()
    `);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await win.webContents.executeJavaScript(`
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            clientX: ${point.x},
            clientY: ${point.y},
        }));
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const handle = document.querySelector('.block-handle');
            const block = document.querySelector(${JSON.stringify(selector)});
            const hit = document.elementFromPoint(${point.x}, ${point.y});
            if (!handle || handle.hidden) return { ok: false, reason: 'hidden' };
            const handleRect = handle.getBoundingClientRect();
            const blockRect = block.getBoundingClientRect();
            return {
                ok: handleRect.left >= blockRect.left &&
                handleRect.left <= blockRect.right &&
                handleRect.top >= blockRect.top - 1 &&
                handleRect.top <= blockRect.bottom,
                hit: hit?.tagName || '',
                hitClass: hit?.className || '',
                handle: { left: handleRect.left, top: handleRect.top, right: handleRect.right, bottom: handleRect.bottom },
                block: { left: blockRect.left, top: blockRect.top, right: blockRect.right, bottom: blockRect.bottom },
            };
        })()
    `);
    if (!result.ok) throw new Error(`${label} does not show a block handle on real hover: ${JSON.stringify(result)}`);
}

async function main() {
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            contextIsolation: false,
            sandbox: false,
        },
    });

    await win.loadFile(path.join(__dirname, 'editor-table-smoke.html'));
    for (let i = 0; i < 50; i += 1) {
        const state = await readSmokeState(win);
        if (state.status === 'pass') {
            await assertRealHoverHandle(win, '#regular-hover', 'regular text');
            await assertRealHoverHandle(win, '#table-hover', 'table');
            return;
        }
        if (state.status === 'fail') throw new Error(state.error || 'editor smoke failed');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('editor smoke timed out');
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
