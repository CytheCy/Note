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
    const elSlash   = document.getElementById('slashMenu');
    const elCodeCopy = document.createElement('button');

    let currentNote = null;
    let saveTimer = null;
    let suppressLoad = false;  // avoid clobbering during save round-trips
    let slashRange = null;
    let slashIndex = 0;
    let hoveredCodeBlock = null;
    const slashBlocks = [
        ['text', 'bx bx-text', 'Regular text', '<p><br></p>'],
        ['bullet', 'bx bx-list-ul', 'Bullet list', '<ul><li><br></li></ul>'],
        ['number', 'bx bx-list-ol', 'Number list', '<ol><li><br></li></ol>'],
        ['check', 'bx bx-list-check', 'Check list', '<ul class="check-list"><li><input type="checkbox"> <span><br></span></li></ul>'],
        ['table', 'bx bx-table', 'Table', '<table><tbody><tr><th>Header</th><th>Header</th></tr><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>'],
        ['code', 'bx bx-code-alt', 'Code block', '<pre><code><br></code></pre><p><br></p>'],
        ['heading', 'bx bx-heading', 'Heading', '<h2>Heading</h2><p><br></p>'],
        ['divider', 'bx bx-minus', 'Divider', '<hr><p><br></p>'],
        ['titled', 'bx bx-note', 'Titled Note', '<section class="titled-note"><h2>Title</h2><p>Note text</p></section><p><br></p>'],
    ];
    elCodeCopy.type = 'button';
    elCodeCopy.className = 'code-copy-btn';
    elCodeCopy.title = 'Copy code';
    elCodeCopy.innerHTML = '<i class="bx bx-copy"></i>';
    elCodeCopy.hidden = true;
    document.body.appendChild(elCodeCopy);

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
        hideSlashMenu();
        suppressLoad = false;
    }

    function clear() {
        currentNote = null;
        elEmpty.hidden = false;
        elRich.hidden = true; elToolbar.hidden = true;
        elTitle.disabled = true;
        elTitle.value = '';
        elIcon.className = 'bx bx-file';
        hideSlashMenu();
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
    elRich.addEventListener('mousemove', (e) => {
        const pre = e.target.closest('pre');
        if (!pre || !elRich.contains(pre)) return hideCodeCopy();
        showCodeCopy(pre);
    });
    elRich.addEventListener('mouseleave', (e) => {
        if (!elCodeCopy.contains(e.relatedTarget)) hideCodeCopy();
    });
    elRich.addEventListener('keyup', (e) => {
        if (e.key !== '/' || !selectionInEditor()) return;
        openSlashMenu();
    });
    elRich.addEventListener('keydown', (e) => {
        if (elSlash.hidden) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            hideSlashMenu();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveSlash(slashIndex + (e.key === 'ArrowDown' ? 1 : -1));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insertSlashBlock(elSlash.querySelector('.active')?.dataset.block);
        } else if (e.key.length === 1) {
            hideSlashMenu();
        }
    });
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

    elSlash.innerHTML = slashBlocks.map(([id, icon, label]) =>
        `<button type="button" data-block="${id}"><i class="${icon}"></i>${label}</button>`
    ).join('');

    elSlash.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button[data-block]');
        if (!btn) return;
        e.preventDefault();
        insertSlashBlock(btn.dataset.block);
    });

    document.addEventListener('mousedown', (e) => {
        if (!elSlash.hidden && !elSlash.contains(e.target)) hideSlashMenu();
    });

    elCodeCopy.addEventListener('mouseleave', (e) => {
        if (!hoveredCodeBlock || !hoveredCodeBlock.contains(e.relatedTarget)) hideCodeCopy();
    });
    elCodeCopy.addEventListener('mousedown', (e) => e.preventDefault());
    elCodeCopy.addEventListener('click', async () => {
        if (!hoveredCodeBlock) return;
        await copyText(hoveredCodeBlock.innerText);
        elCodeCopy.classList.add('copied');
        setTimeout(() => elCodeCopy.classList.remove('copied'), 900);
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

    function selectionInEditor() {
        const sel = window.getSelection();
        return sel && sel.rangeCount && elRich.contains(sel.anchorNode);
    }

    function openSlashMenu() {
        const sel = window.getSelection();
        slashRange = sel.getRangeAt(0).cloneRange();
        const rect = slashRange.getBoundingClientRect();
        const editorRect = elRich.getBoundingClientRect();
        elSlash.style.left = `${Math.min(rect.left || editorRect.left + 24, window.innerWidth - 230)}px`;
        elSlash.style.top = `${(rect.bottom || editorRect.top + 24) + 6}px`;
        elSlash.hidden = false;
        setActiveSlash(0);
    }

    function hideSlashMenu() {
        elSlash.hidden = true;
        slashRange = null;
    }

    function setActiveSlash(index) {
        const buttons = [...elSlash.querySelectorAll('button')];
        slashIndex = (index + buttons.length) % buttons.length;
        buttons.forEach((btn, i) => btn.classList.toggle('active', i === slashIndex));
    }

    function insertSlashBlock(id) {
        const block = slashBlocks.find(([blockId]) => blockId === id);
        if (!block || !slashRange) return hideSlashMenu();
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(rangeWithSlashSelected());
        document.execCommand('insertHTML', false, block[3]);
        hideSlashMenu();
        elRich.focus();
        scheduleSave();
    }

    function rangeWithSlashSelected() {
        const range = slashRange.cloneRange();
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node.nodeType === Node.TEXT_NODE && offset > 0 && node.data[offset - 1] === '/') {
            range.setStart(node, offset - 1);
        }
        return range;
    }

    function showCodeCopy(pre) {
        hoveredCodeBlock = pre;
        const rect = pre.getBoundingClientRect();
        elCodeCopy.style.left = `${rect.right - 34}px`;
        elCodeCopy.style.top = `${rect.top + 6}px`;
        elCodeCopy.hidden = false;
    }

    function hideCodeCopy() {
        hoveredCodeBlock = null;
        elCodeCopy.hidden = true;
        elCodeCopy.classList.remove('copied');
    }

    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
    }

    return { load, clear, saveNow, setTitleIfCurrent, setIconIfCurrent };
})();
