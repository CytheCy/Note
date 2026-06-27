/**
 * app.js — bootstrap + glue between TreeView and Editor.
 * Also wires up: sidebar resize, global search, top-bar buttons, modal close.
 */

(async function bootstrap() {
    // ---- TreeView → Editor wiring ----------------------------------------
    TreeView.onNoteSelected(async (node) => {
        await Editor.load(node.noteId);
    });

    // ---- sidebar "add note" button ---------------------------------------
    // Creates a new note: as a child of the selected note if one is selected
    // (and is not the root), otherwise as a top-level note.
    document.getElementById('newNoteBtn').addEventListener('click', async () => {
        const { noteId } = TreeView.getSelected();
        const parent = noteId || 'root';
        await TreeView.createChild(parent, 'text', 'New Note');
    });

    // ---- native File menu (Electron) -------------------------------------
    // The native application menu emits these events via webContents.send.
    // Fallbacks keep things working in a plain browser (no Electron IPC).
    initNativeMenu();

    // ---- Settings page + theme switching ---------------------------------
    initSettings();

    // ---- modal close ------------------------------------------------------
    // Applies to every .modal-overlay.
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('[data-close]')) overlay.hidden = true;
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.querySelectorAll('.modal-overlay').forEach(o => o.hidden = true);
    });

    // ---- sidebar resizer --------------------------------------------------
    initResizer();

    // ---- global search ----------------------------------------------------
    initSearch();
    document.getElementById('treeExpandBtn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await TreeView.setAllExpanded(true);
    });
    document.getElementById('treeCollapseBtn').addEventListener('click', async (e) => {
        e.stopPropagation();
        await TreeView.setAllExpanded(false);
    });
    document.getElementById('treeSearchBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        openSearch();
    });
    document.getElementById('treeSettingsBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings();
    });

    // ---- initial load -----------------------------------------------------
    await TreeView.reload();
    await restoreLastNote();
})();

// ============================== RESIZER ====================================
function initResizer() {
    const resizer = document.getElementById('resizer');
    const sidebar = document.getElementById('sidebar');
    let dragging = false, startX = 0, startW = 0;

    resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startW = sidebar.getBoundingClientRect().width;
        resizer.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const w = Math.max(180, Math.min(560, startW + (e.clientX - startX)));
        sidebar.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}

// ============================== SEARCH =====================================
function initSearch() {
    const toolbarInput = document.getElementById('toolbarSearch');
    const toolbarResults = document.getElementById('toolbarSearchResults');
    const closeToolbar = document.getElementById('closeSearchToolbar');

    initSearchBox(toolbarInput, toolbarResults, '.search-toolbar', closeSearchToolbar);
    closeToolbar.addEventListener('click', closeSearchToolbar);
}

function initSearchBox(input, resultsEl, containerSelector, onSelect) {
    let timer = null;

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) { resultsEl.hidden = true; return; }
        timer = setTimeout(async () => {
            try {
                const results = await Api.search(q);
                renderSearchResults(resultsEl, results, q, onSelect);
            } catch (e) {
                resultsEl.hidden = true;
            }
        }, 200);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim()) resultsEl.hidden = false;
    });
    document.addEventListener('click', (e) => {
        if (e.target.closest(containerSelector)) return;
        resultsEl.hidden = true;
        if (!input.closest(containerSelector)?.hidden && onSelect) onSelect();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const first = resultsEl.querySelector('li[data-noteid]');
            if (first) first.click();
        }
        if (e.key === 'Escape') {
            input.value = '';
            resultsEl.hidden = true;
            closeSearchToolbar();
        }
    });
}

function openSearch() {
    const toolbar = document.getElementById('searchToolbar');
    const formatToolbar = document.getElementById('formatToolbar');
    const input = document.getElementById('toolbarSearch');
    toolbar.hidden = false;
    formatToolbar.hidden = true;
    input.focus();
    input.select();
    input.dispatchEvent(new Event('focus'));
}

function closeSearchToolbar() {
    const toolbar = document.getElementById('searchToolbar');
    const input = document.getElementById('toolbarSearch');
    const results = document.getElementById('toolbarSearchResults');
    toolbar.hidden = true;
    input.value = '';
    results.hidden = true;
    document.dispatchEvent(new Event('selectionchange'));
}

function renderSearchResults(el, results, q, onSelect) {
    if (results.length === 0) {
        el.innerHTML = `<li class="empty">No matches for "${q}"</li>`;
    } else {
        el.innerHTML = results.map(r => `
            <li data-noteid="${r.noteId}">
                <i class="${escapeHtml(r.icon || typeIconClass(r.type))}"></i>
                <span>${escapeHtml(r.title)}</span>
                <span style="margin-left:auto;color:var(--text-muted);font-size:11px">${r.type}</span>
            </li>`).join('');
    }
    el.hidden = false;

    // wire clicks
    el.querySelectorAll('li[data-noteid]').forEach(li => {
        li.addEventListener('click', async () => {
            const noteId = li.dataset.noteid;
            await Editor.load(noteId);
            el.hidden = true;
            if (onSelect) onSelect();
        });
    });
}

function typeIconClass(type) {
    return ({ text: 'bx bx-file' })[type] || 'bx bx-file';
}

function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
}

async function restoreLastNote() {
    let noteId;
    try { noteId = localStorage.getItem('lastNoteId'); } catch (_) {}
    if (!noteId) return;
    try {
        await Editor.load(noteId);
    } catch (e) {
        try { localStorage.removeItem('lastNoteId'); } catch (_) {}
    }
}

// ============================== NATIVE MENU (Electron) =====================
// The native File menu sends IPC events; we receive them here. When not
// running under Electron (plain browser), these simply never fire.
function initNativeMenu() {
    const api = window.electronAPI;   // exposed by preload.js (no nodeIntegration)
    const handlers = {
        'menu:new-note': async () => {
            const { noteId } = TreeView.getSelected();
            await TreeView.createChild(noteId || 'root', 'text', 'New Note');
        },
        'menu:new-folder': async () => {
            const { noteId } = TreeView.getSelected();
            await TreeView.createChild(noteId || 'root', 'text', 'New Folder');
        },
        'menu:settings': () => openSettings(),
    };
    Object.entries(handlers).forEach(([ch, fn]) => {
        if (api && typeof api.on === 'function') {
            api.on(ch, () => Promise.resolve(fn()).catch(e => alert('Action failed: ' + e.message)));
        }
    });
}

// ============================== SETTINGS / THEME ==========================
function getStoredTheme() {
    try { return localStorage.getItem('theme') || 'auto'; }
    catch (_) { return 'auto'; }
}

function applyTheme(value) {
    const v = ['light', 'dark', 'auto'].includes(value) ? value : 'auto';
    document.documentElement.setAttribute('data-theme', v);
    try { localStorage.setItem('theme', v); } catch (_) {}
    // Sync the selected option in the Settings page.
    document.querySelectorAll('#themeOptions .theme-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === v);
    });
    document.querySelectorAll('input[name="theme"]').forEach(r => {
        r.checked = r.value === v;
    });
}

function openSettings() {
    applyTheme(getStoredTheme());   // refresh selected highlight
    Editor.showSettings().catch(e => alert('Action failed: ' + e.message));
}

function initSettings() {
    // Ensure the saved theme is reflected in the UI on first paint.
    applyTheme(getStoredTheme());

    // Clicking an option card switches the theme immediately and persists it.
    document.getElementById('themeOptions').addEventListener('click', (e) => {
        const opt = e.target.closest('.theme-option');
        if (!opt) return;
        applyTheme(opt.dataset.value);
    });
}
