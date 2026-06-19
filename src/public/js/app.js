/**
 * app.js — bootstrap + glue between TreeView, Editor, AttributesPanel.
 * Also wires up: sidebar resize, global search, top-bar buttons, modal close.
 */

(function bootstrap() {
    // ---- TreeView → Editor + Attributes wiring ---------------------------
    TreeView.onNoteSelected(async (node) => {
        await Editor.load(node.noteId);
        AttributesPanel.setNote(node.noteId);
    });

    // support opening from search-result clicks inside the editor
    document.addEventListener('notes:open', async (e) => {
        const node = e.detail;
        await Editor.load(node.noteId);
        AttributesPanel.setNote(node.noteId);
    });

    // ---- top-bar buttons --------------------------------------------------
    document.getElementById('newRootNoteBtn').addEventListener('click', async () => {
        await TreeView.createChild('root', 'text', 'New Note');
    });

    const sidebar = document.getElementById('sidebar');
    document.getElementById('toggleSidebarBtn').addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
    });

    // ---- modal close ------------------------------------------------------
    const overlay = document.getElementById('modalOverlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-close]')) overlay.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') overlay.hidden = true;
    });

    // ---- sidebar resizer --------------------------------------------------
    initResizer();

    // ---- global search ----------------------------------------------------
    initSearch();

    // ---- initial load -----------------------------------------------------
    TreeView.reload();
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
    const input = document.getElementById('globalSearch');
    const resultsEl = document.getElementById('searchResults');
    let timer = null;

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) { resultsEl.hidden = true; return; }
        timer = setTimeout(async () => {
            try {
                const results = await Api.search(q);
                renderSearchResults(resultsEl, results, q);
            } catch (e) {
                resultsEl.hidden = true;
            }
        }, 200);
    });

    input.addEventListener('focus', () => {
        if (input.value.trim()) resultsEl.hidden = false;
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.global-search')) resultsEl.hidden = true;
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const first = resultsEl.querySelector('li[data-noteid]');
            if (first) first.click();
        }
        if (e.key === 'Escape') { input.value = ''; resultsEl.hidden = true; }
    });
}

function renderSearchResults(el, results, q) {
    if (results.length === 0) {
        el.innerHTML = `<li class="empty">No matches for "${q}"</li>`;
    } else {
        el.innerHTML = results.map(r => `
            <li data-noteid="${r.noteId}">
                <i class="bx bx-${typeIconChar(r.type)}"></i>
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
            AttributesPanel.setNote(noteId);
            el.hidden = true;
            document.getElementById('globalSearch').value = '';
        });
    });
}

function typeIconChar(type) {
    return ({ text: 'file', code: 'code-alt', todo: 'check-square', search: 'search' })[type] || 'file';
}

function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
}
