/**
 * editor.js — the note editor pane.
 *
 * - text/todo → contentEditable WYSIWYG with a tiny format toolbar
 * - code      → <textarea> with mono font
 * - search    → renders results inline (query = first line of content)
 *
 * Autosave is debounced; the title and type inputs also save on change.
 */

const Editor = (() => {
    const elTitle   = document.getElementById('noteTitle');
    const elTypeIcon= document.getElementById('noteTypeIcon');
    const elTypeSel = document.getElementById('noteTypeSelect');
    const elMeta    = document.getElementById('noteMeta');
    const elEmpty   = document.getElementById('emptyState');
    const elRich    = document.getElementById('richTextEditor');
    const elCode    = document.getElementById('codeEditor');
    const elToolbar = document.getElementById('formatToolbar');

    let currentNote = null;
    let saveTimer = null;
    let suppressLoad = false;  // avoid clobbering during save round-trips

    const ICONS = {
        text:   'bx bx-file',
        code:   'bx bx-code-alt',
        todo:   'bx bx-check-square',
        search: 'bx bx-search',
    };

    // ---- load a note into the panes ---------------------------------------
    async function load(noteId) {
        if (!noteId) return clear();
        const note = await Api.getNote(noteId);
        currentNote = note;
        suppressLoad = true;

        elEmpty.hidden = true;
        elTitle.disabled = false;
        elTypeSel.disabled = false;

        elTitle.value = note.title;
        elTypeSel.value = note.type;
        elTypeIcon.className = ICONS[note.type] || 'bx bx-file';
        elMeta.textContent = fmtDate(note.dateModified) + (note.type ? ` · ${note.type}` : '');

        if (note.type === 'code') {
            elRich.hidden = true; elToolbar.hidden = true;
            elCode.hidden = false;
            elCode.value = note.content || '';
        } else if (note.type === 'search') {
            // Render search results inline as HTML
            elRich.hidden = false; elToolbar.hidden = true;
            elCode.hidden = true;
            const query = (note.content || '').split('\n')[0];
            const results = query ? await Api.search(query) : [];
            elRich.innerHTML = renderSearchResults(query, results);
        } else {
            // text / todo → WYSIWYG
            elRich.hidden = false; elToolbar.hidden = false;
            elCode.hidden = true;
            elRich.innerHTML = note.content || '';
        }
        suppressLoad = false;
    }

    function clear() {
        currentNote = null;
        elEmpty.hidden = false;
        elRich.hidden = true; elCode.hidden = true; elToolbar.hidden = true;
        elTitle.disabled = true; elTypeSel.disabled = true;
        elTitle.value = ''; elMeta.textContent = '';
    }

    // ---- autosave ----------------------------------------------------------
    function scheduleSave() {
        if (suppressLoad || !currentNote) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, 600);
    }

    async function saveNow() {
        if (!currentNote) return;
        const content = currentNote.type === 'code' ? elCode.value : elRich.innerHTML;
        const title   = elTitle.value;
        const type    = elTypeSel.value;
        if (content === currentNote.content &&
            title   === currentNote.title &&
            type    === currentNote.type) return; // no-op

        try {
            const updated = await Api.updateNote(currentNote.noteId, { title, content, type });
            const typeChanged = type !== currentNote.type;
            currentNote = updated;
            elMeta.textContent = fmtDate(updated.dateModified) + ` · ${updated.type}`;
            // If the type changed, the tree icon + editor surface should change.
            if (typeChanged) {
                elTypeIcon.className = ICONS[type] || 'bx bx-file';
                await TreeView.reload();
                await load(updated.noteId);
            } else {
                // refresh tree label without full reload
                const row = document.querySelector(`.tree-row[data-noteId="${updated.noteId}"] .tree-label`);
                if (row) row.textContent = updated.title;
            }
        } catch (e) {
            console.error('save failed', e);
        }
    }

    // ---- events ------------------------------------------------------------
    elTitle.addEventListener('input', scheduleSave);
    elCode.addEventListener('input',  scheduleSave);
    elRich.addEventListener('input',  scheduleSave);
    elTypeSel.addEventListener('change', async () => {
        await saveNow();           // commit type change immediately
    });

    // Format toolbar → execCommand (legacy but works for contentEditable).
    elToolbar.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button[data-cmd]');
        if (!btn) return;
        e.preventDefault();          // keep selection in the editor
        const cmd = btn.dataset.cmd;
        const val = btn.dataset.val;
        if (cmd === 'createLink') {
            const url = prompt('Link URL:');
            if (url) document.execCommand('createLink', false, url);
        } else if (val !== undefined) {
            document.execCommand(cmd, false, val);
        } else {
            document.execCommand(cmd, false, null);
        }
        elRich.focus();
        scheduleSave();
    });

    // keyboard: Ctrl+S to force-save
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault(); saveNow();
        }
    });

    // ---- helpers -----------------------------------------------------------
    function fmtDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
        } catch { return iso; }
    }

    function renderSearchResults(query, results) {
        let html = `<p style="color:var(--text-muted)"><i class="bx bx-search"></i> Saved search: "<b>${escapeHtml(query)}</b>" — ${results.length} match(es)</p>`;
        html += '<ul style="list-style:none;padding:0">';
        for (const r of results) {
            html += `<li data-noteid="${r.noteId}" style="padding:8px;border:1px solid var(--border);border-radius:6px;margin:6px 0;cursor:pointer">
                <i class="bx bx-file"></i> <b>${escapeHtml(r.title)}</b>
                <span style="color:var(--text-muted);font-size:12px"> · ${r.type}</span>
            </li>`;
        }
        html += '</ul>';
        return html;
    }

    function escapeHtml(s) {
        return (s || '').replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        })[c]);
    }

    // delegated click for search-result items
    elRich.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-noteid]');
        if (li && TreeView.onNoteSelected) {
            // re-use app's load path by simulating selection
            const fake = { noteId: li.dataset.noteid, relationId: null, title: '', type: 'text', children: [] };
            document.dispatchEvent(new CustomEvent('notes:open', { detail: fake }));
        }
    });

    return { load, clear, saveNow };
})();
