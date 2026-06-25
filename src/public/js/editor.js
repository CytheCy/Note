/**
 * editor.js — the note editor pane.
 *
 * - text → contentEditable WYSIWYG with a tiny format toolbar
 *
 * Autosave is debounced; the title input also saves on change.
 */

const Editor = (() => {
    const elTitle   = document.getElementById('noteTitle');
    const elIcon    = document.getElementById('noteTypeIcon');
    const elEmpty   = document.getElementById('emptyState');
    const elRich    = document.getElementById('richTextEditor');
    const elToolbar = document.getElementById('formatToolbar');

    let currentNote = null;
    let saveTimer = null;
    let suppressLoad = false;  // avoid clobbering during save round-trips

    // ---- load a note into the panes ---------------------------------------
    async function load(noteId) {
        if (!noteId) return clear();
        const note = await Api.getNote(noteId);
        currentNote = note;
        suppressLoad = true;

        elEmpty.hidden = true;
        elTitle.disabled = false;

        elTitle.value = note.title;
        elIcon.className = note.icon || 'bx bx-file';
        elIcon.title = 'Right-click to change icon';

        // text → WYSIWYG
        elRich.hidden = false; elToolbar.hidden = false;
        elRich.innerHTML = note.content || '';
        suppressLoad = false;
    }

    function clear() {
        currentNote = null;
        elEmpty.hidden = false;
        elRich.hidden = true; elToolbar.hidden = true;
        elTitle.disabled = true;
        elTitle.value = '';
        elIcon.className = 'bx bx-file';
    }

    // ---- autosave ----------------------------------------------------------
    function scheduleSave() {
        if (suppressLoad || !currentNote) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, 600);
    }

    async function saveNow() {
        if (!currentNote) return;
        const content = elRich.innerHTML;
        const title   = elTitle.value;
        if (content === currentNote.content &&
            title   === currentNote.title) return; // no-op

        try {
            const updated = await Api.updateNote(currentNote.noteId, { title, content });
            currentNote = updated;
            // refresh tree label without full reload
            const row = document.querySelector(`.tree-row[data-note-id="${updated.noteId}"] .tree-label`);
            if (row) row.textContent = updated.title;
        } catch (e) {
            console.error('save failed', e);
        }
    }

    // ---- events ------------------------------------------------------------
    elTitle.addEventListener('input', scheduleSave);
    elRich.addEventListener('input',  scheduleSave);
    elIcon.addEventListener('contextmenu', (e) => {
        if (!currentNote || typeof TreeView === 'undefined' || !TreeView.openIconPicker) return;
        e.preventDefault();
        e.stopPropagation();
        TreeView.openIconPicker(e.clientX, e.clientY, currentNote);
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

    // ---- external title sync ---------------------------------------------
    // Called when a note is renamed elsewhere (e.g. the tree). If that note
    // is the one currently open, update the title box without reloading.
    function setTitleIfCurrent(noteId, title) {
        if (currentNote && currentNote.noteId === noteId) {
            currentNote.title = title;
            elTitle.value = title;
        }
    }

    function setIconIfCurrent(noteId, icon) {
        if (currentNote && currentNote.noteId === noteId) {
            currentNote.icon = icon || null;
            elIcon.className = icon || 'bx bx-file';
        }
    }

    return { load, clear, saveNow, setTitleIfCurrent, setIconIfCurrent };
})();
