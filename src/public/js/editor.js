/**
 * editor.js — the note editor pane.
 *
 * - text → contentEditable WYSIWYG with a tiny format toolbar
 * - code → <textarea> with mono font
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
        } else {
            // text → WYSIWYG
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

    return { load, clear, saveNow };
})();
