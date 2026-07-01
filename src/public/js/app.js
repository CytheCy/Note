/**
 * app.js — bootstrap + glue between TreeView and Editor.
 * Also wires up: sidebar resize, global search, top-bar buttons, modal close.
 */
let lastNotebookState = null;
let appSettings = null;
let selectedNotebookIcon = 'bx bx-book-open';
let notebookIconChoicesPromise = null;
const NOTEBOOK_BOXICONS_CSS = 'https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css';
const NOTEBOOK_FALLBACK_ICONS = [
    'bx bx-book-open', 'bx bx-book', 'bx bx-notepad', 'bx bx-folder', 'bx bx-briefcase',
    'bx bx-bulb', 'bx bx-brain', 'bx bx-code-alt', 'bx bx-star', 'bx bx-heart',
    'bx bx-rocket', 'bx bx-home', 'bx bx-data', 'bx bx-calendar', 'bx bx-task',
    'bx bx-list-check', 'bx bx-pencil', 'bx bx-image', 'bx bx-music', 'bx bx-map',
    'bx bx-lock-alt', 'bx bx-package', 'bx bx-archive', 'bx bxl-github',
];

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

    // ---- notebooks --------------------------------------------------------
    await initNotebooks();

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
    loadSettings().catch(e => alert('Settings failed to load: ' + e.message));
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

    document.querySelector('.settings-categories').addEventListener('click', (e) => {
        const button = e.target.closest('button[data-settings-category]');
        if (!button) return;
        selectSettingsCategory(button.dataset.settingsCategory);
    });

    const defaultFolderInput = document.getElementById('defaultNotebookFolder');
    const chooseDefaultFolderBtn = document.getElementById('chooseDefaultNotebookFolderBtn');
    defaultFolderInput.addEventListener('change', () => {
        saveDefaultNotebookFolder(defaultFolderInput.value).catch(err => {
            alert('Default notebooks folder failed to save: ' + err.message);
        });
    });
    chooseDefaultFolderBtn.addEventListener('click', async () => {
        const folder = await chooseNotebookFolder();
        if (!folder) return;
        defaultFolderInput.value = folder;
        await saveDefaultNotebookFolder(folder).catch(err => {
            alert('Default notebooks folder failed to save: ' + err.message);
        });
    });

    document.querySelector('[data-settings-section="data"]').addEventListener('click', async (e) => {
        const importButton = e.target.closest('button[data-import-type]');
        if (!importButton) return;
        try {
            await runNotebookImport(importButton.dataset.importType);
        } catch (err) {
            alert('Notebook import failed: ' + err.message);
        }
    });
}

function selectSettingsCategory(category) {
    const value = category || 'appearance';
    document.querySelectorAll('.settings-category[data-settings-category]').forEach(button => {
        button.classList.toggle('active', button.dataset.settingsCategory === value);
    });
    document.querySelectorAll('.settings-section[data-settings-section]').forEach(section => {
        section.hidden = section.dataset.settingsSection !== value;
    });
}

async function loadSettings() {
    appSettings = await Api.getSettings();
    const input = document.getElementById('defaultNotebookFolder');
    if (input) input.value = appSettings.defaultNotebookFolder || '';
    return appSettings;
}

async function saveDefaultNotebookFolder(folder) {
    appSettings = await Api.updateSettings({ defaultNotebookFolder: folder });
    const input = document.getElementById('defaultNotebookFolder');
    if (input) input.value = appSettings.defaultNotebookFolder || '';
    return appSettings;
}

// ============================== NOTEBOOKS =================================
async function initNotebooks() {
    const button = document.getElementById('notebookMenuButton');
    const menu = document.getElementById('notebookMenu');
    initCreateNotebookPanel();
    initEditNotebookPanel();

    button.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNotebookMenu();
    });

    menu.addEventListener('click', async (e) => {
        e.stopPropagation();
        const actionButton = e.target.closest('button[data-action]');
        const closeButton = e.target.closest('button[data-notebook-close]');
        const notebookButton = e.target.closest('button[data-notebook-index]');

        try {
            if (closeButton) {
                const path = closeButton.dataset.path;
                const wasCurrent = closeButton.dataset.current === 'true';
                if (path) {
                    await Api.closeNotebook({ path });
                    if (wasCurrent) {
                        await afterNotebookChanged();
                    } else {
                        await refreshNotebooks();
                    }
                }
            } else if (actionButton) {
                await runNotebookAction(actionButton.dataset.action);
            } else if (notebookButton) {
                const path = notebookButton.dataset.path;
                if (path && notebookButton.dataset.current !== 'true') {
                    await Api.switchNotebook({ path });
                    await afterNotebookChanged();
                }
            }
        } catch (err) {
            alert('Notebook action failed: ' + err.message);
        }
    });

    document.addEventListener('click', (e) => {
        if (e.target.closest('#notebookMenu') || e.target.closest('#notebookMenuButton')) return;
        closeNotebookMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeNotebookMenu();
    });

    await refreshNotebooks().catch(showNotebookLoadError);
}

function toggleNotebookMenu() {
    const menu = document.getElementById('notebookMenu');
    if (menu.hidden) openNotebookMenu();
    else closeNotebookMenu();
}

function openNotebookMenu() {
    document.getElementById('notebookMenu').hidden = false;
    document.getElementById('notebookMenuButton').setAttribute('aria-expanded', 'true');
    refreshNotebooks().catch(showNotebookLoadError);
}

function closeNotebookMenu() {
    document.getElementById('notebookMenu').hidden = true;
    document.getElementById('notebookMenuButton').setAttribute('aria-expanded', 'false');
    hideCreateNotebookPanel();
    hideEditNotebookPanel();
}

async function refreshNotebooks() {
    const state = await Api.getNotebooks();
    lastNotebookState = state;
    const current = state.current || {};
    document.getElementById('notebookName').textContent = current.name || 'Notebook';
    document.getElementById('notebookIcon').className = current.icon || 'bx bx-book-open';
    document.title = current.name || 'Note';

    const list = document.getElementById('openedNotebookList');
    const opened = state.opened || [];
    if (!opened.length) {
        list.innerHTML = '<div class="tree-empty">No opened notebooks.</div>';
        return;
    }
    list.innerHTML = opened.map((notebook, index) => {
        const name = notebook.name || 'Notebook';
        const path = notebook.path || '';
        return `
            <div class="opened-notebook-row ${notebook.current ? 'current' : ''}" title="${escapeAttr(path)}">
                <button type="button"
                        class="opened-notebook-switch"
                        data-notebook-index="${index}"
                        data-path="${escapeAttr(path)}"
                        data-current="${notebook.current ? 'true' : 'false'}">
                    <i class="${notebook.current ? 'bx bx-check' : escapeAttr(notebook.icon || 'bx bx-book')}"></i>
                    <span>${escapeHtml(name)}</span>
                </button>
                <button type="button"
                        class="opened-notebook-close"
                        data-notebook-close="${index}"
                        data-path="${escapeAttr(path)}"
                        data-current="${notebook.current ? 'true' : 'false'}"
                        aria-label="Close ${escapeAttr(name)}"
                        title="Close notebook">
                    <i class="bx bx-x"></i>
                </button>
            </div>`;
    }).join('');
}

function showNotebookLoadError(err) {
    const list = document.getElementById('openedNotebookList');
    document.getElementById('notebookName').textContent = 'Notebook';
    if (list) {
        list.innerHTML = `<div class="tree-empty">Notebook list failed: ${escapeHtml(err.message)}</div>`;
    }
}

async function runNotebookAction(action) {
    switch (action) {
        case 'edit-notebook': {
            await showEditNotebookPanel();
            break;
        }
        case 'open-notebook': {
            const path = await chooseNotebookOpenPath();
            if (!path) return;
            await Api.openNotebook({ path });
            await afterNotebookChanged();
            break;
        }
        case 'create-notebook': {
            showCreateNotebookPanel();
            break;
        }
    }
}

async function runNotebookImport(type) {
    if (type === 'markdown') {
        const folderPath = await chooseNotebookFolder();
        if (!folderPath) return;
        const result = await Api.importMarkdownNotebook({ folderPath });
        await afterNotebookChanged();
        alert(`Imported ${result.imported.files} markdown file${result.imported.files === 1 ? '' : 's'} into ${result.current.name}.`);
        return;
    }

    const labels = {
        html: 'HTML',
        markdown: 'Markdown',
        pdf: 'PDF',
    };
    const label = labels[type] || 'Notebook';
    alert(`${label} notebook import is not implemented yet.`);
}

function initEditNotebookPanel() {
    const panel = document.getElementById('editNotebookPanel');
    const nameInput = document.getElementById('editNotebookName');
    const cancelBtn = document.getElementById('cancelEditNotebookBtn');
    const openFolderBtn = document.getElementById('openCurrentNotebookFolderBtn');
    const iconsEl = document.getElementById('editNotebookIcons');
    const iconSearch = document.getElementById('editNotebookIconSearch');

    panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') e.stopPropagation();
    });
    iconSearch.addEventListener('input', () => renderNotebookIconOptions(selectedNotebookIcon, iconSearch.value, 'editNotebookIcons'));
    cancelBtn.addEventListener('click', hideEditNotebookPanel);
    openFolderBtn.addEventListener('click', openCurrentNotebookFolder);
    iconsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-icon]');
        if (!btn) return;
        selectNotebookIcon(btn.dataset.icon, 'editNotebookIcons');
    });
    panel.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const name = nameInput.value.trim();
            if (!name) return alert('Notebook name is required.');
            await Api.renameNotebook({ name, icon: selectedNotebookIcon || 'bx bx-book-open' });
            await refreshNotebooks();
            closeNotebookMenu();
        } catch (err) {
            alert('Edit notebook failed: ' + err.message);
        }
    });
}

async function showEditNotebookPanel() {
    const state = await Api.getNotebooks();
    lastNotebookState = state;
    const current = state.current || {};
    const panel = document.getElementById('editNotebookPanel');
    const nameInput = document.getElementById('editNotebookName');
    const sourceFile = document.getElementById('editNotebookSourceFile');
    const iconSearch = document.getElementById('editNotebookIconSearch');

    nameInput.value = current.name || 'Notebook';
    sourceFile.textContent = filenameFromPath(current.path || '') || 'Unknown source file';
    sourceFile.title = current.path || '';
    iconSearch.value = '';
    selectNotebookIcon(current.icon || 'bx bx-book-open', 'editNotebookIcons');
    renderNotebookIconOptions(selectedNotebookIcon, '', 'editNotebookIcons');
    hideCreateNotebookPanel();
    panel.hidden = false;
    requestAnimationFrame(() => {
        nameInput.focus();
        nameInput.select();
    });
}

function hideEditNotebookPanel() {
    const panel = document.getElementById('editNotebookPanel');
    if (panel) panel.hidden = true;
}

async function openCurrentNotebookFolder() {
    try {
        const state = lastNotebookState || await Api.getNotebooks();
        const notebookPath = state.current?.path || '';
        if (!notebookPath) return alert('Notebook path is not available.');

        const api = window.electronAPI;
        if (api && typeof api.openNotebookFolder === 'function') {
            try {
                await api.openNotebookFolder(notebookPath);
                return;
            } catch (err) {
                if (!/No handler registered/i.test(err.message || '')) throw err;
            }
        }

        if (typeof Api.openNotebookFolder === 'function') {
            await Api.openNotebookFolder();
            return;
        }

        const folder = dirnameFromPath(notebookPath);
        alert(folder ? `Notebook folder:\n${folder}` : `Notebook path:\n${notebookPath}`);
    } catch (err) {
        alert('Open notebook folder failed: ' + err.message);
    }
}

async function chooseNotebookOpenPath() {
    const api = window.electronAPI;
    if (api && typeof api.openNotebookFile === 'function') {
        return api.openNotebookFile();
    }
    return prompt('Notebook file path:');
}

async function chooseNotebookCreatePath(name) {
    const api = window.electronAPI;
    const filename = `${(name || 'Untitled Notebook').trim().replace(/[\\/:*?"<>|]+/g, '-') || 'Untitled Notebook'}.db`;
    if (api && typeof api.createNotebookFile === 'function') {
        return api.createNotebookFile(filename);
    }
    return prompt('New notebook file path:', filename);
}

async function chooseNotebookFolder() {
    const api = window.electronAPI;
    if (api && typeof api.chooseNotebookFolder === 'function') {
        return api.chooseNotebookFolder();
    }
    return prompt('Notebook folder path:');
}

function initCreateNotebookPanel() {
    const panel = document.getElementById('createNotebookPanel');
    const nameInput = document.getElementById('createNotebookName');
    const folderInput = document.getElementById('createNotebookFolder');
    const chooseFolderBtn = document.getElementById('chooseNotebookFolderBtn');
    const cancelBtn = document.getElementById('cancelCreateNotebookBtn');
    const iconsEl = document.getElementById('createNotebookIcons');
    const iconSearch = document.getElementById('createNotebookIconSearch');

    renderNotebookIconOptions('bx bx-book-open');
    panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') e.stopPropagation();
    });
    nameInput.addEventListener('input', updateCreateNotebookPath);
    folderInput.addEventListener('input', updateCreateNotebookPath);
    iconSearch.addEventListener('input', () => renderNotebookIconOptions(selectedNotebookIcon, iconSearch.value, 'createNotebookIcons'));
    chooseFolderBtn.addEventListener('click', async () => {
        const folder = await chooseNotebookFolder();
        if (!folder) return;
        folderInput.value = folder;
        updateCreateNotebookPath();
    });
    cancelBtn.addEventListener('click', hideCreateNotebookPanel);
    iconsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-icon]');
        if (!btn) return;
        selectNotebookIcon(btn.dataset.icon, 'createNotebookIcons');
    });
    panel.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const name = nameInput.value.trim();
            const folder = folderInput.value.trim();
            if (!name) return alert('Notebook name is required.');
            if (!folder) return alert('Notebook folder is required.');
            const path = buildNotebookPath(folder, name);
            const icon = selectedNotebookIcon || 'bx bx-book-open';
            await Api.createNotebook({ path, name, icon });
            await afterNotebookChanged();
        } catch (err) {
            const hint = /404/.test(err.message)
                ? ' The app is probably connected to an older server process; close other Note windows or restart the server.'
                : '';
            alert('Create notebook failed: ' + err.message + hint);
        }
    });
}

function showCreateNotebookPanel() {
    const panel = document.getElementById('createNotebookPanel');
    const nameInput = document.getElementById('createNotebookName');
    const folderInput = document.getElementById('createNotebookFolder');
    const iconSearch = document.getElementById('createNotebookIconSearch');
    hideEditNotebookPanel();
    nameInput.value = 'Untitled Notebook';
    const initialFolder = appSettings?.defaultNotebookFolder || dirnameFromPath(lastNotebookState?.current?.path || '') || '';
    folderInput.value = initialFolder;
    loadSettings().then(settings => {
        if (folderInput.value === initialFolder) {
            folderInput.value = settings.defaultNotebookFolder || '';
            updateCreateNotebookPath();
        }
    }).catch(() => {});
    iconSearch.value = '';
    selectNotebookIcon('bx bx-book-open', 'createNotebookIcons');
    renderNotebookIconOptions(selectedNotebookIcon, '', 'createNotebookIcons');
    updateCreateNotebookPath();
    panel.hidden = false;
    requestAnimationFrame(() => {
        nameInput.focus();
        nameInput.select();
    });
}

function hideCreateNotebookPanel() {
    const panel = document.getElementById('createNotebookPanel');
    if (panel) panel.hidden = true;
}

function renderNotebookIconOptions(selectedIcon, filter = '', targetId = 'createNotebookIcons') {
    const iconsEl = document.getElementById(targetId);
    iconsEl.innerHTML = '<div class="empty">Loading icons...</div>';
    loadNotebookIconChoices().then(icons => {
        const q = filter.trim().toLowerCase();
        const visible = q ? icons.filter(icon => icon.toLowerCase().includes(q)) : icons;
        iconsEl.innerHTML = visible.length
            ? visible.map(icon => `
                <button type="button" data-icon="${escapeAttr(icon)}" class="${icon === selectedIcon ? 'selected' : ''}" title="${escapeAttr(icon)}">
                    <i class="${escapeAttr(icon)}"></i>
                </button>`).join('')
            : '<div class="empty">No matching icons.</div>';
    });
}

function selectNotebookIcon(icon, targetId) {
    selectedNotebookIcon = icon || 'bx bx-book-open';
    const selector = targetId
        ? `#${targetId} button[data-icon]`
        : '#createNotebookIcons button[data-icon], #editNotebookIcons button[data-icon]';
    document.querySelectorAll(selector).forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.icon === selectedNotebookIcon);
    });
}

function loadNotebookIconChoices() {
    if (!notebookIconChoicesPromise) {
        notebookIconChoicesPromise = fetch(NOTEBOOK_BOXICONS_CSS)
            .then(res => res.ok ? res.text() : Promise.reject(new Error(res.statusText)))
            .then(css => {
                const names = [...css.matchAll(/\.((?:bx|bxs|bxl)-[a-z0-9-]+):before/g)].map(m => m[1]);
                const unique = [...new Set(names)].sort((a, b) => iconRank(a) - iconRank(b) || a.localeCompare(b));
                const icons = unique.map(name => `bx ${name}`);
                return icons.includes('bx bx-book-open') ? icons : ['bx bx-book-open', ...icons];
            })
            .catch(() => NOTEBOOK_FALLBACK_ICONS);
    }
    return notebookIconChoicesPromise;
}

function iconRank(name) {
    if (name.startsWith('bx-')) return 0;
    if (name.startsWith('bxs-')) return 1;
    return 2;
}

function updateCreateNotebookPath() {
    const name = document.getElementById('createNotebookName').value.trim() || 'Untitled Notebook';
    const folder = document.getElementById('createNotebookFolder').value.trim();
    document.getElementById('createNotebookPath').textContent = folder
        ? buildNotebookPath(folder, name)
        : 'Choose a folder';
}

function buildNotebookPath(folder, name) {
    const sep = folder.includes('\\') ? '\\' : '/';
    const cleanFolder = folder.replace(/[\\/]+$/, '');
    return `${cleanFolder}${sep}${safeNotebookFilename(name)}.db`;
}

function safeNotebookFilename(name) {
    return (name || 'Untitled Notebook')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+$/, 'Untitled Notebook') || 'Untitled Notebook';
}

function dirnameFromPath(value) {
    const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    return index > 0 ? value.slice(0, index) : '';
}

function filenameFromPath(value) {
    const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    return index >= 0 ? value.slice(index + 1) : value;
}

async function afterNotebookChanged() {
    closeNotebookMenu();
    try { localStorage.removeItem('lastNoteId'); } catch (_) {}
    TreeView.clearSelection();
    Editor.clear();
    await refreshNotebooks();
    await TreeView.reload();
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
}
