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
    const elSettings = document.getElementById('settingsPage');
    const elToolbar = document.getElementById('formatToolbar');
    const elSearchToolbar = document.getElementById('searchToolbar');
    const elSlash   = document.getElementById('slashMenu');
    const elCodeCopy = document.createElement('button');
    const elBlockHandle = document.createElement('button');
    const elBlockDropLine = document.createElement('div');
    const LAST_NOTE_KEY = 'lastNoteId';

    let currentNote = null;
    let saveTimer = null;
    let suppressLoad = false;  // avoid clobbering during save round-trips
    let slashRange = null;
    let slashIndex = 0;
    let hoveredCodeBlock = null;
    let hoveredBlock = null;
    let draggedBlock = null;
    let pendingBlockDrag = null;
    let blockDropTarget = null;
    let blockDropIntent = 'before';
    let blockHandleHideTimer = null;
    const boundEditorBlocks = new WeakSet();
    let codeExitArmed = false;
    let codeExitBreak = null;
    const inlineFormatCommands = new Set(['bold', 'italic', 'underline']);
    const tableSlashBlocks = new Set(['table-row-below', 'table-col-right', 'table-row-delete', 'table-col-delete']);
    const slashBlocks = [
        ['text', 'bx bx-text', 'Regular text', '<p><br></p>'],
        ['bullet', 'bx bx-list-ul', 'Bullet list', '<ul><li><br></li></ul>'],
        ['number', 'bx bx-list-ol', 'Number list', '<ol><li><br></li></ol>'],
        ['check', 'bx bx-list-check', 'Check list', '<ul class="check-list"><li><input type="checkbox"> <span><br></span></li></ul>'],
        ['table', 'bx bx-table', 'Table', '<table><tbody><tr><th><br></th><th><br></th></tr><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>'],
        ['table-row-below', 'bx bx-plus', 'Insert table row below', insertTableRowBelow],
        ['table-col-right', 'bx bx-plus', 'Insert table column right', insertTableColumnRight],
        ['table-row-delete', 'bx bx-trash', 'Delete table row', deleteTableRow],
        ['table-col-delete', 'bx bx-trash', 'Delete table column', deleteTableColumn],
        ['code', 'bx bx-code-alt', 'Code block', '<pre><code><span data-slash-caret></span><br></code></pre><p><br></p>'],
        ['heading', 'bx bx-heading', 'Heading', '<h2><span data-slash-caret></span><br></h2><p><br></p>'],
        ['divider', 'bx bx-minus', 'Divider', '<hr><p><br></p>'],
        ['titled', 'bx bx-note', 'Titled Note', '<section class="titled-note"><h2><span data-slash-caret></span><br></h2><p><br></p></section><p><br></p>'],
    ];
    elCodeCopy.type = 'button';
    elCodeCopy.className = 'code-copy-btn';
    elCodeCopy.title = 'Copy code';
    elCodeCopy.innerHTML = '<i class="bx bx-copy"></i>';
    elCodeCopy.hidden = true;
    document.body.appendChild(elCodeCopy);
    elBlockHandle.type = 'button';
    elBlockHandle.className = 'block-handle';
    elBlockHandle.title = 'Drag block';
    elBlockHandle.innerHTML = '<i class="bx bx-dots-vertical-rounded"></i>';
    elBlockHandle.hidden = true;
    document.body.appendChild(elBlockHandle);
    elBlockDropLine.className = 'editor-block-drop-line';
    elBlockDropLine.hidden = true;
    document.body.appendChild(elBlockDropLine);

    // ---- load a note into the panes ---------------------------------------
    async function load(noteId) {
        if (!noteId) return clear();
        const note = await Api.getNote(noteId);
        try { localStorage.setItem(LAST_NOTE_KEY, note.noteId); } catch (_) {}
        currentNote = note;
        suppressLoad = true;

        elEmpty.hidden = true;
        elSettings.hidden = true;
        elTitle.disabled = false;

        elTitle.value = note.title;
        elIcon.className = note.icon || 'bx bx-file';
        elIcon.title = 'Right-click to change icon';

        // text → WYSIWYG
        elRich.hidden = false;
        elRich.innerHTML = note.content || '';
        ensureEditorBlocks();
        syncToolbarVisibility();
        hideSlashMenu();
        hideBlockHandle();
        hideBlockDropLine();
        suppressLoad = false;
    }

    function clear() {
        currentNote = null;
        elEmpty.hidden = false;
        elRich.hidden = true; elSettings.hidden = true; elToolbar.hidden = true;
        elTitle.disabled = true;
        elTitle.value = '';
        elIcon.className = 'bx bx-file';
        hideSlashMenu();
        hideBlockHandle();
        hideBlockDropLine();
    }

    // ---- autosave ----------------------------------------------------------
    function scheduleSave() {
        if (suppressLoad || !currentNote) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, 600);
    }

    async function saveNow() {
        if (!currentNote) return;
        ensureEditorBlocks();
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
    elRich.addEventListener('input', () => {
        scheduleSave();
        syncToolbarVisibility();
    });
    elRich.addEventListener('mouseover', handleEditorPointer);
    elRich.addEventListener('mousemove', handleEditorPointer);
    function handleEditorPointer(e) {
        updateHoveredBlock(e.target, e.clientX, e.clientY);
        const target = e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
        const pre = target?.closest('pre');
        if (!pre || !elRich.contains(pre)) return hideCodeCopy();
        showCodeCopy(pre);
    }
    elRich.addEventListener('mouseleave', (e) => {
        if (!draggedBlock && !elBlockHandle.contains(e.relatedTarget)) scheduleBlockHandleHide();
        if (!elCodeCopy.contains(e.relatedTarget)) hideCodeCopy();
    });
    elRich.addEventListener('scroll', () => {
        positionBlockHandle();
        positionBlockDropLine();
    });
    elRich.addEventListener('mousedown', (e) => {
        disarmCodeExit();
        prepareBlockDrag(e);
    });
    elRich.addEventListener('keyup', (e) => {
        syncToolbarVisibility();
        if (e.key !== '/' || !selectionInEditor()) return;
        openSlashMenu();
    });
    elRich.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') disarmCodeExit();
        if (!elSlash.hidden) {
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
            return;
        }
        if (e.key === 'Enter' && handleTitledNoteTitleEnter()) {
            e.preventDefault();
            scheduleSave();
        } else if (e.key === 'Enter' && handleTitledNoteBodyExit()) {
            e.preventDefault();
            scheduleSave();
        } else if (e.key === 'Enter' && handleCodeBlockEnter()) {
            e.preventDefault();
            scheduleSave();
        } else if (e.key === 'Enter' && handleChecklistEnter()) {
            e.preventDefault();
            scheduleSave();
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
        const selectionOnly = inlineFormatCommands.has(cmd) && selectedTextInEditor();
        if (cmd === 'createLink') {
            const url = prompt('Link URL:');
            if (url) document.execCommand('createLink', false, url);
        } else if (val !== undefined) {
            document.execCommand(cmd, false, val);
        } else {
            document.execCommand(cmd, false, null);
        }
        if (selectionOnly) finishInlineFormatCommand(cmd);
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
    document.addEventListener('selectionchange', syncToolbarVisibility);

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
    elBlockHandle.addEventListener('mouseenter', () => {
        cancelBlockHandleHide();
        if (hoveredBlock) positionBlockHandle();
    });
    elBlockHandle.addEventListener('mouseleave', (e) => {
        if (!draggedBlock && !elRich.contains(e.relatedTarget)) scheduleBlockHandleHide();
    });
    elBlockHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !hoveredBlock || !hoveredBlock.isConnected) return;
        e.preventDefault();
        startBlockDrag(hoveredBlock, e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', onDocumentPointerMove, true);
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    window.addEventListener('mousemove', onBlockDragMove);
    window.addEventListener('mouseup', onBlockDragEnd);
    window.addEventListener('resize', () => {
        positionBlockHandle();
        positionBlockDropLine();
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

    async function showSettings() {
        await saveNow();
        currentNote = null;
        elEmpty.hidden = true;
        elRich.hidden = true;
        elToolbar.hidden = true;
        elSearchToolbar.hidden = true;
        elSettings.hidden = false;
        elTitle.disabled = true;
        elTitle.value = 'Settings';
        elIcon.className = 'bx bx-cog';
        hideSlashMenu();
        hideCodeCopy();
        hideBlockHandle();
        hideBlockDropLine();
    }

    function selectionInEditor() {
        const sel = window.getSelection();
        return sel && sel.rangeCount && elRich.contains(sel.anchorNode);
    }

    function syncToolbarVisibility() {
        elToolbar.hidden = !selectedTextInEditor() || elSearchToolbar?.hidden === false;
    }

    function selectedTextInEditor() {
        const sel = window.getSelection();
        if (!currentNote || !sel || !sel.rangeCount || sel.isCollapsed) return false;
        return elRich.contains(sel.anchorNode) && elRich.contains(sel.focusNode) && sel.toString().trim() !== '';
    }

    function finishInlineFormatCommand(cmd) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        const formatted = currentInlineFormatElement(cmd);
        if (formatted) placeCaretAfter(formatted);
        if (document.queryCommandState(cmd)) document.execCommand(cmd, false, null);
        syncToolbarVisibility();
    }

    function currentInlineFormatElement(cmd) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        const selectors = {
            bold: 'b,strong,[style*="font-weight"]',
            italic: 'i,em,[style*="font-style"]',
            underline: 'u,[style*="text-decoration"]',
        };
        const node = sel.anchorNode;
        const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest?.(selectors[cmd]);
        return el && elRich.contains(el) ? el : null;
    }

    function openSlashMenu() {
        const sel = window.getSelection();
        slashRange = sel.getRangeAt(0).cloneRange();
        const rect = slashRange.getBoundingClientRect();
        const editorRect = elRich.getBoundingClientRect();
        elSlash.style.left = `${Math.min(rect.left || editorRect.left + 24, window.innerWidth - 230)}px`;
        elSlash.style.top = `${(rect.bottom || editorRect.top + 24) + 6}px`;
        syncSlashMenuItems();
        elSlash.hidden = false;
        setActiveSlash(0);
    }

    function hideSlashMenu() {
        elSlash.hidden = true;
        slashRange = null;
    }

    function setActiveSlash(index) {
        const buttons = visibleSlashButtons();
        if (!buttons.length) return;
        slashIndex = (index + buttons.length) % buttons.length;
        [...elSlash.querySelectorAll('button')].forEach(btn => btn.classList.remove('active'));
        buttons[slashIndex].classList.add('active');
    }

    function visibleSlashButtons() {
        return [...elSlash.querySelectorAll('button')].filter(btn => !btn.hidden);
    }

    function syncSlashMenuItems() {
        const inTable = !!currentTableCell();
        elSlash.querySelectorAll('button').forEach(btn => {
            btn.hidden = tableSlashBlocks.has(btn.dataset.block) && !inTable;
        });
    }

    function insertSlashBlock(id) {
        const block = slashBlocks.find(([blockId]) => blockId === id);
        if (!block || !slashRange) return hideSlashMenu();
        const content = block[3];
        const sel = window.getSelection();
        if (typeof content === 'function') {
            sel.removeAllRanges();
            sel.addRange(slashRange.cloneRange());
            if (!content()) return hideSlashMenu();
        } else {
            sel.removeAllRanges();
            sel.addRange(rangeWithSlashSelected());
            document.execCommand('insertHTML', false, content);
            placeCaretAtSlashMarker();
        }
        hideSlashMenu();
        ensureEditorBlocks();
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

    function removeSlashTrigger() {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(rangeWithSlashSelected());
        document.execCommand('delete', false, null);
    }

    function placeCaretAtSlashMarker() {
        const marker = elRich.querySelector('[data-slash-caret]');
        if (!marker) return;
        const target = marker.parentElement;
        marker.remove();
        placeCaretIn(target);
    }

    function currentTableCell() {
        if (!slashRange) return null;
        const node = slashRange.startContainer.nodeType === Node.ELEMENT_NODE
            ? slashRange.startContainer
            : slashRange.startContainer.parentElement;
        const cell = node?.closest?.('td,th');
        return cell && elRich.contains(cell) ? cell : null;
    }

    function tableRows(table) {
        return [...table.rows];
    }

    function cellIndex(cell) {
        return [...cell.parentElement.cells].indexOf(cell);
    }

    function fillEmpty(cell) {
        cell.innerHTML = '<br>';
        return cell;
    }

    function insertTableRowBelow() {
        const cell = currentTableCell();
        if (!cell) return false;
        removeSlashTrigger();

        const row = cell.parentElement;
        const next = row.cloneNode(false);
        [...row.cells].forEach(source => next.appendChild(fillEmpty(document.createElement(source.tagName.toLowerCase()))));
        row.after(next);
        placeCaretIn(next.cells[cellIndex(cell)] || next.cells[0]);
        return true;
    }

    function insertTableColumnRight() {
        const cell = currentTableCell();
        if (!cell) return false;
        removeSlashTrigger();

        const index = cellIndex(cell) + 1;
        tableRows(cell.closest('table')).forEach(row => {
            const reference = row.cells[index] || null;
            const tag = row.parentElement.tagName === 'THEAD' || row.cells[0]?.tagName === 'TH' ? 'th' : 'td';
            row.insertBefore(fillEmpty(document.createElement(tag)), reference);
        });
        placeCaretIn(cell.parentElement.cells[index]);
        return true;
    }

    function deleteTableRow() {
        const cell = currentTableCell();
        if (!cell) return false;
        removeSlashTrigger();

        const row = cell.parentElement;
        const table = cell.closest('table');
        const next = row.nextElementSibling || row.previousElementSibling;
        if (tableRows(table).length === 1) {
            table.remove();
            return true;
        }
        row.remove();
        placeCaretIn(next.cells[Math.min(cellIndex(cell), next.cells.length - 1)]);
        return true;
    }

    function deleteTableColumn() {
        const cell = currentTableCell();
        if (!cell) return false;
        removeSlashTrigger();

        const table = cell.closest('table');
        const index = cellIndex(cell);
        const rows = tableRows(table);
        if (rows.every(row => row.cells.length <= 1)) {
            table.remove();
            return true;
        }
        rows.forEach(row => row.cells[index]?.remove());
        const targetRow = rows.find(row => row.isConnected && row.cells.length);
        if (targetRow) placeCaretIn(targetRow.cells[Math.min(index, targetRow.cells.length - 1)]);
        return true;
    }

    function handleCodeBlockEnter() {
        const code = currentCodeBlock();
        if (!code) return false;

        const sel = window.getSelection();
        const range = sel.getRangeAt(0);
        if (range.collapsed && codeExitArmed && caretIsAfter(codeExitBreak, range)) {
            exitCodeBlock(code, codeExitBreak);
            disarmCodeExit();
            return true;
        }

        codeExitBreak = insertCodeLineBreak(code, range);
        codeExitArmed = true;
        return true;
    }

    function insertCodeLineBreak(code, range) {
        range.deleteContents();
        const br = document.createElement('br');
        range.insertNode(br);
        if (!nextMeaningfulSibling(br)) br.after(document.createElement('br'));
        placeCaretAfter(br);
        return br;
    }

    function currentCodeBlock() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !elRich.contains(sel.anchorNode)) return null;
        const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        const code = node?.closest?.('pre code');
        return code && elRich.contains(code) ? code : null;
    }

    function caretIsAfter(node, range) {
        if (!node?.isConnected || !range.collapsed) return false;
        return range.startContainer === node.parentNode && range.startOffset === [...node.parentNode.childNodes].indexOf(node) + 1;
    }

    function nextMeaningfulSibling(node) {
        let next = node.nextSibling;
        while (next?.nodeType === Node.TEXT_NODE && next.data === '') next = next.nextSibling;
        return next;
    }

    function exitCodeBlock(code, lineBreak) {
        lineBreak.remove();
        trimTrailingCodeBreaks(code);
        if (!code.textContent) code.innerHTML = '<br>';

        const pre = code.closest('pre');
        const p = isEmptyParagraph(pre.nextElementSibling) ? pre.nextElementSibling : document.createElement('p');
        if (!p.isConnected) {
            p.innerHTML = '<br>';
            pre.after(p);
        }
        placeCaretIn(p);
    }

    function isEmptyParagraph(node) {
        return node?.tagName === 'P' && node.textContent.trim() === '';
    }

    function trimTrailingCodeBreaks(code) {
        while (code.textContent && code.lastChild?.tagName === 'BR') code.lastChild.remove();
    }

    function disarmCodeExit() {
        codeExitArmed = false;
        codeExitBreak = null;
    }

    function handleTitledNoteTitleEnter() {
        const title = currentTitledNoteTitle();
        if (!title) return false;

        const section = title.closest('.titled-note');
        let body = section.querySelector('p');
        if (!body) {
            body = document.createElement('p');
            body.innerHTML = '<br>';
            section.append(body);
        }
        placeCaretIn(body);
        return true;
    }

    function currentTitledNoteTitle() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !elRich.contains(sel.anchorNode)) return null;
        const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        const title = node?.closest?.('.titled-note h2');
        return title && elRich.contains(title) ? title : null;
    }

    function handleTitledNoteBodyExit() {
        const body = currentTitledNoteBody();
        if (!body || !isEmptyParagraph(body)) return false;

        const section = body.closest('.titled-note');
        const p = isEmptyParagraph(section.nextElementSibling) ? section.nextElementSibling : document.createElement('p');
        if (!p.isConnected) {
            p.innerHTML = '<br>';
            section.after(p);
        }
        body.remove();
        placeCaretIn(p);
        return true;
    }

    function currentTitledNoteBody() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !elRich.contains(sel.anchorNode)) return null;
        const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        const body = node?.closest?.('.titled-note p');
        return body && elRich.contains(body) ? body : null;
    }

    function handleChecklistEnter() {
        const li = currentChecklistItem();
        if (!li) return false;
        if (isEmptyChecklistItem(li)) {
            exitChecklist(li);
            return true;
        }
        const next = newChecklistItem();
        li.after(next);
        placeCaretIn(next.querySelector('span'));
        return true;
    }

    function currentChecklistItem() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !elRich.contains(sel.anchorNode)) return null;
        const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        const li = node?.closest?.('li');
        return li && li.closest('ul.check-list') ? li : null;
    }

    function isEmptyChecklistItem(li) {
        return li.textContent.replace(/\u00a0/g, ' ').trim() === '';
    }

    function newChecklistItem() {
        const li = document.createElement('li');
        const input = document.createElement('input');
        const span = document.createElement('span');
        input.type = 'checkbox';
        span.innerHTML = '<br>';
        li.append(input, span);
        return li;
    }

    function exitChecklist(li) {
        const list = li.closest('ul.check-list');
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        const tail = document.createElement('ul');
        tail.className = 'check-list';
        while (li.nextElementSibling) tail.append(li.nextElementSibling);
        list.after(p);
        if (tail.children.length) p.after(tail);
        li.remove();
        if (!list.children.length) list.remove();
        placeCaretIn(p);
    }

    function placeCaretIn(node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        elRich.focus();
    }

    function placeCaretAfter(node) {
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        elRich.focus();
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

    function updateHoveredBlock(node, clientX, clientY) {
        if (draggedBlock) return;
        cancelBlockHandleHide();
        ensureEditorBlocks();
        const block = editorBlockFromPoint(clientX, clientY) || editorBlockForNode(node);
        if (!block) return scheduleBlockHandleHide();
        hoveredBlock = block;
        positionBlockHandle();
        elBlockHandle.hidden = false;
    }

    function onDocumentPointerMove(e) {
        if (draggedBlock) return;
        if (elBlockHandle.contains(e.target)) {
            cancelBlockHandleHide();
            return;
        }
        const block = editorBlockFromPoint(e.clientX, e.clientY);
        if (block) {
            hoveredBlock = block;
            cancelBlockHandleHide();
            positionBlockHandle();
        } else if (!elRich.contains(e.target)) {
            scheduleBlockHandleHide();
        }
    }

    function bindEditorBlock(block) {
        if (boundEditorBlocks.has(block)) return;
        boundEditorBlocks.add(block);
        block.addEventListener('mouseenter', showBlockHandleForEvent);
        block.addEventListener('mousemove', showBlockHandleForEvent);
    }

    function showBlockHandleForEvent(e) {
        updateHoveredBlock(e.currentTarget, e.clientX, e.clientY);
    }

    function prepareBlockDrag(e) {
        if (e.button !== 0 || elBlockHandle.contains(e.target)) return;
        const target = e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
        if (target?.closest?.('input, button, select, textarea')) return;
        const block = editorBlockForNode(e.target) || editorBlockFromPoint(e.clientX, e.clientY);
        pendingBlockDrag = block ? { block, x: e.clientX, y: e.clientY } : null;
    }

    function startBlockDrag(block, clientX, clientY) {
        if (!block?.isConnected) return;
        hideSlashMenu();
        disarmCodeExit();
        cancelBlockHandleHide();
        pendingBlockDrag = null;
        draggedBlock = block;
        hoveredBlock = draggedBlock;
        draggedBlock.classList.add('editor-block-dragging');
        elBlockHandle.classList.add('dragging');
        updateBlockDropFromPointer(clientX, clientY);
    }

    function editorBlockForNode(node) {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (!element) return null;
        let current = element;
        while (current && current !== elRich) {
            if (current.parentElement === elRich) return current;
            current = current.parentElement;
        }
        return null;
    }

    function editorBlockFromPoint(clientX, clientY) {
        const rectBlock = editorBlockByRect(clientX, clientY);
        if (rectBlock) return rectBlock;

        const hit = document.elementFromPoint(clientX, clientY);
        const hitBlock = editorBlockForNode(hit);
        if (hitBlock) return hitBlock;

        const range = document.caretRangeFromPoint?.(clientX, clientY);
        const rangeBlock = editorBlockForNode(range?.startContainer);
        if (rangeBlock) return rangeBlock;

        const position = document.caretPositionFromPoint?.(clientX, clientY);
        const positionBlock = editorBlockForNode(position?.offsetNode);
        if (positionBlock) return positionBlock;

        return editorBlockByRect(clientX, clientY);
    }

    function editorBlockByRect(clientX, clientY) {
        const editorRect = elRich.getBoundingClientRect();
        if (clientX < editorRect.left || clientX > editorRect.right ||
            clientY < editorRect.top || clientY > editorRect.bottom) return null;

        return [...elRich.children].find(block => {
            const rect = block.getBoundingClientRect();
            return clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top && clientY <= rect.bottom;
        }) || null;
    }

    function positionBlockHandle() {
        if (!hoveredBlock || !hoveredBlock.isConnected || draggedBlock) return hideBlockHandle();
        const rect = hoveredBlock.getBoundingClientRect();
        const editorRect = elRich.getBoundingClientRect();
        if (rect.bottom < editorRect.top || rect.top > editorRect.bottom) return hideBlockHandle();
        elBlockHandle.style.left = `${Math.max(8, rect.left - 32)}px`;
        elBlockHandle.style.top = `${rect.top + Math.max(0, Math.min(rect.height - 24, 4))}px`;
        elBlockHandle.hidden = false;
    }

    function hideBlockHandle() {
        cancelBlockHandleHide();
        hoveredBlock = null;
        elBlockHandle.hidden = true;
    }

    function scheduleBlockHandleHide() {
        cancelBlockHandleHide();
        blockHandleHideTimer = setTimeout(() => {
            if (!draggedBlock) hideBlockHandle();
        }, 180);
    }

    function cancelBlockHandleHide() {
        clearTimeout(blockHandleHideTimer);
        blockHandleHideTimer = null;
    }

    function nearestEditorBlock(clientY) {
        ensureEditorBlocks();
        const blocks = [...elRich.children];
        if (!blocks.length) return null;
        return blocks.reduce((closest, block) => {
            if (block === draggedBlock) return closest;
            const rect = block.getBoundingClientRect();
            const distance = Math.abs((rect.top + rect.bottom) / 2 - clientY);
            if (!closest || distance < closest.distance) return { block, distance };
            return closest;
        }, null)?.block || null;
    }

    function blockDropIntentFromPointer(clientY, target) {
        const rect = target.getBoundingClientRect();
        return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    }

    function showBlockDropLine(target, intent) {
        const rect = target.getBoundingClientRect();
        elBlockDropLine.style.left = `${rect.left}px`;
        elBlockDropLine.style.top = `${intent === 'before' ? rect.top : rect.bottom}px`;
        elBlockDropLine.style.width = `${rect.width}px`;
        elBlockDropLine.hidden = false;
    }

    function positionBlockDropLine() {
        if (!draggedBlock || !blockDropTarget?.isConnected) return hideBlockDropLine();
        showBlockDropLine(blockDropTarget, blockDropIntent);
    }

    function hideBlockDropLine() {
        blockDropTarget = null;
        elBlockDropLine.hidden = true;
    }

    function moveDraggedBlock(target, intent) {
        if (!draggedBlock || !target || draggedBlock === target) return cleanupBlockDrag();
        if (intent === 'before') elRich.insertBefore(draggedBlock, target);
        else elRich.insertBefore(draggedBlock, target.nextSibling);
        scheduleSave();
        cleanupBlockDrag();
    }

    function cleanupBlockDrag() {
        draggedBlock?.classList.remove('editor-block-dragging');
        draggedBlock = null;
        pendingBlockDrag = null;
        blockDropIntent = 'before';
        elBlockHandle.classList.remove('dragging');
        hideBlockDropLine();
    }

    function onBlockDragMove(e) {
        if (pendingBlockDrag && !draggedBlock) {
            const distance = Math.hypot(e.clientX - pendingBlockDrag.x, e.clientY - pendingBlockDrag.y);
            if (distance < 5) return;
            e.preventDefault();
            startBlockDrag(pendingBlockDrag.block, e.clientX, e.clientY);
        }
        if (!draggedBlock) return;
        e.preventDefault();
        updateBlockDropFromPointer(e.clientX, e.clientY);
    }

    function onBlockDragEnd(e) {
        if (pendingBlockDrag && !draggedBlock) {
            pendingBlockDrag = null;
            return;
        }
        if (!draggedBlock) return;
        if (blockDropTarget && pointInEditorLane(e.clientX, e.clientY)) {
            moveDraggedBlock(blockDropTarget, blockDropIntent);
        } else {
            cleanupBlockDrag();
        }
        positionBlockHandle();
    }

    function updateBlockDropFromPointer(clientX, clientY) {
        if (!pointInEditorLane(clientX, clientY)) return hideBlockDropLine();
        const target = nearestEditorBlock(clientY);
        if (!target || target === draggedBlock) return hideBlockDropLine();
        blockDropTarget = target;
        blockDropIntent = blockDropIntentFromPointer(clientY, target);
        showBlockDropLine(target, blockDropIntent);
    }

    function pointInEditorLane(clientX, clientY) {
        const rect = elRich.getBoundingClientRect();
        return clientX >= rect.left - 40 &&
            clientX <= rect.right &&
            clientY >= rect.top - 20 &&
            clientY <= rect.bottom + 20;
    }

    function ensureEditorBlocks() {
        const nodes = [...elRich.childNodes];
        let paragraph = null;

        nodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                if (!node.textContent.trim()) {
                    node.remove();
                    return;
                }
                paragraph = paragraph || document.createElement('p');
                node.before(paragraph);
                paragraph.append(node);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                paragraph = null;
                return;
            }
            paragraph = null;
        });
        [...elRich.children].forEach(block => {
            block.classList.add('editor-text-block');
            bindEditorBlock(block);
        });
    }

    return { load, clear, saveNow, showSettings, setTitleIfCurrent, setIconIfCurrent };
})();
