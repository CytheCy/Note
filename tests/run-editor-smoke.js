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
                ok: handleRect.right <= blockRect.left &&
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

async function hoverSelector(win, selector) {
    const point = await win.webContents.executeJavaScript(`
        (() => {
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
}

async function assertBlockActions(win, selector, label, expectedVisible) {
    await hoverSelector(win, selector);
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const actions = document.querySelector('.block-actions');
            const block = document.querySelector(${JSON.stringify(selector)});
            if (!actions) return { ok: false, reason: 'missing actions' };
            const hidden = actions.hidden;
            if (${JSON.stringify(!expectedVisible)}) return { ok: hidden, hidden };
            if (hidden) return { ok: false, reason: 'hidden' };
            const actionsRect = actions.getBoundingClientRect();
            const blockRect = block.getBoundingClientRect();
            const buttons = [...actions.querySelectorAll('button')].map(button => button.getAttribute('aria-label'));
            return {
                ok: buttons.includes('Cut block') &&
                    buttons.includes('Copy block') &&
                    actionsRect.left >= blockRect.left &&
                    actionsRect.right <= blockRect.right + 1 &&
                    actionsRect.top >= blockRect.top - 1 &&
                    actionsRect.top <= blockRect.bottom,
                hidden,
                buttons,
                actions: { left: actionsRect.left, top: actionsRect.top, right: actionsRect.right, bottom: actionsRect.bottom },
                block: { left: blockRect.left, top: blockRect.top, right: blockRect.right, bottom: blockRect.bottom },
            };
        })()
    `);
    if (!result.ok) throw new Error(`${label} block actions visibility/position failed: ${JSON.stringify(result)}`);
}

async function assertBlockCutAction(win) {
    await win.webContents.executeJavaScript(`
        (() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    writeText: async (text) => { window.__copiedText = text; },
                    write: async () => { window.__copiedRich = true; },
                },
            });
            document.getElementById('richTextEditor').innerHTML = '<p id="cut-hover">Cut me</p><p>Keep me</p>';
        })()
    `);
    await hoverSelector(win, '#cut-hover');
    const result = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            document.querySelector('.block-actions [aria-label="Cut block"]').click();
            setTimeout(() => {
                const editor = document.getElementById('richTextEditor');
                resolve({
                    ok: !document.getElementById('cut-hover') &&
                        editor.children.length === 1 &&
                        editor.textContent.trim() === 'Keep me' &&
                        (window.__copiedRich || window.__copiedText === 'Cut me'),
                    html: editor.innerHTML,
                    copiedText: window.__copiedText || '',
                    copiedRich: !!window.__copiedRich,
                });
            }, 100);
        })
    `);
    if (!result.ok) throw new Error(`cut block action failed: ${JSON.stringify(result)}`);
}

async function typeText(win, text) {
    for (const char of text) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: char });
        win.webContents.sendInputEvent({ type: 'char', keyCode: char });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: char });
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

async function assertSlashRealTyping(win, shortcut, label, predicateSource, settleMs = 0) {
    await win.webContents.executeJavaScript(`
        (() => {
            const editor = document.getElementById('richTextEditor');
            editor.innerHTML = '<p><br></p>';
            const paragraph = editor.querySelector('p');
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            editor.focus();
        })()
    `);
    await typeText(win, `/${shortcut}`);
    if (settleMs) await new Promise(resolve => setTimeout(resolve, settleMs));
    const result = await win.webContents.executeJavaScript(`
        (() => {
            const editor = document.getElementById('richTextEditor');
            const predicate = ${predicateSource};
            return {
                ok: predicate(editor),
                html: editor.innerHTML,
                text: editor.textContent,
                slashHidden: document.getElementById('slashMenu').hidden,
            };
        })()
    `);
    if (!result.ok || result.text.includes(shortcut) || result.text.includes('/')) {
        throw new Error(`${label} slash shortcut leaked typed text: ${JSON.stringify(result)}`);
    }
}

async function assertSlashMenuFlipsAboveNearBottom(win) {
    const result = await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
            const editor = document.getElementById('richTextEditor');
            const slash = document.getElementById('slashMenu');
            editor.style.marginTop = Math.max(0, window.innerHeight - 140) + 'px';
            editor.innerHTML = '<p>/</p>';
            const paragraph = editor.querySelector('p');
            paragraph.textContent = '/';
            const range = document.createRange();
            range.setStart(paragraph.firstChild, 1);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            editor.focus();
            editor.dispatchEvent(new KeyboardEvent('keyup', { key: '/', bubbles: true }));
            requestAnimationFrame(() => {
                const slashRect = slash.getBoundingClientRect();
                const caretRect = window.getSelection().getRangeAt(0).getBoundingClientRect();
                const styleTop = Number.parseFloat(slash.style.top);
                editor.style.marginTop = '';
                resolve({
                    ok: Number.isFinite(styleTop) && styleTop < caretRect.top,
                    slashRect: { top: slashRect.top, bottom: slashRect.bottom },
                    caretRect: { top: caretRect.top, bottom: caretRect.bottom },
                    styleTop,
                });
            });
        })
    `);
    if (!result.ok) throw new Error(`slash menu did not flip above the caret near the bottom: ${JSON.stringify(result)}`);
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
            await assertSlashRealTyping(win, 'r', 'regular text', `(editor) =>
                editor.children.length === 1 &&
                editor.children[0].tagName === 'P' &&
                editor.textContent.trim() === ''
            `);
            await assertSlashRealTyping(win, 'h', 'heading', `(editor) =>
                editor.children[0]?.tagName === 'H2' &&
                editor.children[1]?.tagName === 'P' &&
                editor.children[1].textContent.trim() === ''
            `);
            await assertSlashRealTyping(win, 't', 'titled note', `(editor) =>
                editor.children[0]?.classList.contains('titled-note') &&
                editor.textContent.trim() === ''
            `, 300);
            await assertSlashRealTyping(win, 'ta', 'table', `(editor) =>
                editor.children[0]?.tagName === 'TABLE' &&
                editor.children[1]?.tagName === 'P' &&
                editor.textContent.trim() === ''
            `);
            await assertSlashRealTyping(win, 'd', 'divider', `(editor) =>
                editor.children[0]?.classList.contains('editor-divider-block') &&
                editor.textContent.trim() === ''
            `);
            await assertSlashMenuFlipsAboveNearBottom(win);
            await assertRealHoverHandle(win, '#regular-hover', 'regular text');
            await assertRealHoverHandle(win, '#table-hover', 'table');
            await win.webContents.executeJavaScript(`
                document.getElementById('richTextEditor').innerHTML = [
                    '<p id="actions-p">Regular text</p>',
                    '<section id="actions-title" class="titled-note"><h2>Title</h2><p>Body</p></section>',
                    '<ul id="actions-ul"><li>Bullet</li></ul>',
                    '<ol id="actions-ol"><li>Number</li></ol>',
                    '<ul id="actions-check" class="check-list"><li><input type="checkbox"> <span>Check</span></li></ul>',
                    '<h2 id="actions-heading">Heading</h2>',
                    '<table id="actions-table"><tbody><tr><td>Cell</td></tr></tbody></table>',
                ].join('');
            `);
            await assertBlockActions(win, '#actions-p', 'regular text', true);
            await assertBlockActions(win, '#actions-title', 'titled note', true);
            await assertBlockActions(win, '#actions-ul', 'bullet list', true);
            await assertBlockActions(win, '#actions-ol', 'number list', true);
            await assertBlockActions(win, '#actions-check', 'check list', true);
            await assertBlockActions(win, '#actions-heading', 'heading', false);
            await assertBlockActions(win, '#actions-table', 'table', false);
            await assertBlockCutAction(win);
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
