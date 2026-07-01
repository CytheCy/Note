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
    const elTableToolbar = document.createElement('div');
    const elBlockHandle = document.createElement('button');
    const elBlockActions = document.createElement('div');
    const elBlockCut = document.createElement('button');
    const elBlockCopy = document.createElement('button');
    const elBlockDropLine = document.createElement('div');
    const LAST_NOTE_KEY = 'lastNoteId';

    let currentNote = null;
    let saveTimer = null;
    let suppressLoad = false;  // avoid clobbering during save round-trips
    let slashRange = null;
    let slashIndex = 0;
    let slashCommitTimer = null;
    let hoveredCodeBlock = null;
    let hoveredBlock = null;
    let selectedBlock = null;
    let draggedBlock = null;
    let pendingHandleDrag = null;
    let blockDropTarget = null;
    let blockDropIntent = 'before';
    let blockHandleHideTimer = null;
    let selectedDividerBlock = null;
    let activeTableCell = null;
    const boundEditorBlocks = new WeakSet();
    let codeExitArmed = false;
    let codeExitBreak = null;
    const inlineFormatCommands = new Set(['bold', 'italic', 'underline']);
    const tableSlashBlocks = new Set(['table-row-below', 'table-col-right', 'table-row-delete', 'table-col-delete']);
    // ponytail: /t waits briefly because /ta shares its prefix; distinct aliases can remove this timer.
    const SLASH_PREFIX_COMMIT_DELAY = 250;
    const slashBlocks = [
        { id: 'text', icon: 'bx bx-text', label: 'Regular text', alias: 'r', content: '<p><br></p>' },
        { id: 'titled', icon: 'bx bx-note', label: 'Titled Note', alias: 't', content: '<section class="titled-note"><h2><span data-slash-caret></span><br></h2><p><br></p></section><p><br></p>' },
        { id: 'bullet', icon: 'bx bx-list-ul', label: 'Bullet list', alias: 'b', content: '<ul><li><br></li></ul>' },
        { id: 'number', icon: 'bx bx-list-ol', label: 'Number list', alias: 'n', content: '<ol><li><br></li></ol>' },
        { id: 'check', icon: 'bx bx-list-check', label: 'Check list', alias: 'c', content: '<ul class="check-list"><li><input type="checkbox"> <span><br></span></li></ul>' },
        { id: 'table', icon: 'bx bx-table', label: 'Table', alias: 'ta', content: '<table><tbody><tr><th><br></th><th><br></th></tr><tr><td><br></td><td><br></td></tr></tbody></table><p><br></p>' },
        { id: 'table-row-below', icon: 'bx bx-plus', label: 'Insert table row below', alias: 'tr', content: insertTableRowBelow },
        { id: 'table-col-right', icon: 'bx bx-plus', label: 'Insert table column right', alias: 'cr', content: insertTableColumnRight },
        { id: 'table-row-delete', icon: 'bx bx-trash', label: 'Delete table row', alias: 'rd', content: deleteTableRow },
        { id: 'table-col-delete', icon: 'bx bx-trash', label: 'Delete table column', alias: 'cd', content: deleteTableColumn },
        { id: 'heading', icon: 'bx bx-heading', label: 'Heading', alias: 'h', content: '<h2><span data-slash-caret></span><br></h2><p><br></p>' },
        { id: 'divider', icon: 'bx bx-minus', label: 'Divider', alias: 'd', content: insertDividerBlock },
    ];
    const slashBlockMap = new Map(slashBlocks.map(block => [block.id, block]));
    elCodeCopy.type = 'button';
    elCodeCopy.className = 'code-copy-btn';
    elCodeCopy.title = 'Copy code';
    elCodeCopy.innerHTML = '<i class="bx bx-copy"></i>';
    elCodeCopy.hidden = true;
    document.body.appendChild(elCodeCopy);
    elTableToolbar.id = 'tableToolbar';
    elTableToolbar.className = 'table-toolbar';
    elTableToolbar.hidden = true;
    elTableToolbar.innerHTML = `
        <button type="button" class="table-toolbar-row" data-table-action="table-row-below" title="Insert row below" aria-label="Insert row below">
            <i class="bx bx-table"></i><i class="bx bx-plus table-toolbar-action-mark"></i>
        </button>
        <button type="button" class="table-toolbar-col" data-table-action="table-col-right" title="Insert column right" aria-label="Insert column right">
            <i class="bx bx-table"></i><i class="bx bx-plus table-toolbar-action-mark"></i>
        </button>
        <span class="sep"></span>
        <button type="button" class="table-toolbar-row" data-table-action="table-row-delete" title="Delete row" aria-label="Delete row">
            <i class="bx bx-table"></i><i class="bx bx-trash table-toolbar-action-mark"></i>
        </button>
        <button type="button" class="table-toolbar-col" data-table-action="table-col-delete" title="Delete column" aria-label="Delete column">
            <i class="bx bx-table"></i><i class="bx bx-trash table-toolbar-action-mark"></i>
        </button>
    `;
    elToolbar.after(elTableToolbar);
    elBlockHandle.type = 'button';
    elBlockHandle.className = 'block-handle';
    elBlockHandle.title = 'Drag block';
    elBlockHandle.innerHTML = '<i class="bx bx-dots-vertical-rounded"></i>';
    elBlockHandle.hidden = true;
    document.body.appendChild(elBlockHandle);
    elBlockActions.className = 'block-actions';
    elBlockActions.hidden = true;
    elBlockCut.type = 'button';
    elBlockCut.title = 'Cut block';
    elBlockCut.setAttribute('aria-label', 'Cut block');
    elBlockCut.innerHTML = '<i class="bx bx-cut"></i>';
    elBlockCopy.type = 'button';
    elBlockCopy.title = 'Copy block';
    elBlockCopy.setAttribute('aria-label', 'Copy block');
    elBlockCopy.innerHTML = '<i class="bx bx-copy"></i>';
    elBlockActions.append(elBlockCut, elBlockCopy);
    document.body.appendChild(elBlockActions);
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
        hideTableToolbar();
        hideBlockHandle();
        hideBlockActions();
        hideBlockDropLine();
        hideDividerSelection();
        clearSelectedBlock();
        suppressLoad = false;
    }

    function clear() {
        currentNote = null;
        elEmpty.hidden = false;
        elRich.hidden = true; elSettings.hidden = true; elToolbar.hidden = true;
        hideTableToolbar();
        elTitle.disabled = true;
        elTitle.value = '';
        elIcon.className = 'bx bx-file';
        hideSlashMenu();
        hideBlockHandle();
        hideBlockActions();
        hideBlockDropLine();
        hideDividerSelection();
        clearSelectedBlock();
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
        const content = editorContentForStorage();
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

    function editorContentForStorage() {
        const clone = elRich.cloneNode(true);
        clone.querySelectorAll('.editor-block-selected, .editor-block-dragging').forEach((block) => {
            block.classList.remove('editor-block-selected', 'editor-block-dragging');
        });
        clone.querySelectorAll('.editor-divider-block').forEach((divider) => {
            divider.replaceWith(document.createElement('hr'));
        });
        return clone.innerHTML;
    }

    // ---- events ------------------------------------------------------------
    elTitle.addEventListener('input', scheduleSave);
    elRich.addEventListener('input', () => {
        ensureEditorBlocks();
        scheduleSave();
        syncToolbarVisibility();
        syncTableToolbarVisibility();
        syncDividerSelection();
    });
    elRich.addEventListener('beforeinput', (e) => {
        if (handleSlashBeforeInput(e)) return;
        handleDividerBeforeInput(e);
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
        if (!draggedBlock && !blockHoverUiContains(e.relatedTarget)) scheduleBlockHoverUiHide();
        if (!elCodeCopy.contains(e.relatedTarget)) hideCodeCopy();
    });
    elRich.addEventListener('scroll', () => {
        positionBlockHandle();
        positionBlockActions();
        positionBlockDropLine();
    });
    elRich.addEventListener('mousedown', (e) => {
        disarmCodeExit();
        setActiveTableCellFromTarget(e.target);
        if (!elBlockHandle.contains(e.target) && !e.target.closest?.('.editor-divider-block')) clearSelectedBlock();
    });
    elRich.addEventListener('mouseup', (e) => {
        if (e.button !== 0 || draggedBlock || pendingHandleDrag) return;
        if (!ensureCaretFromClick(e)) return;
        syncDividerSelection();
        syncToolbarVisibility();
        syncTableToolbarVisibility();
    });
    elRich.addEventListener('keyup', (e) => {
        syncToolbarVisibility();
        if (!selectionInEditor()) return;
        if (!elSlash.hidden) return refreshSlashMenu();
        if (e.key === '/') openSlashMenu();
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
            } else if (e.key === ' ') {
                hideSlashMenu();
            } else if (e.key.length > 1 && e.key !== 'Backspace' && e.key !== 'Delete') {
                hideSlashMenu();
            }
            return;
        }
        if (e.key === 'Enter' && handleDividerBoundaryEnter()) {
            e.preventDefault();
            scheduleSave();
        } else if ((e.key === 'Backspace' || e.key === 'Delete') && handleDividerDelete()) {
            e.preventDefault();
            scheduleSave();
        } else
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

    elSlash.innerHTML = slashBlocks.map(({ id, icon, label, alias }) =>
        `<button type="button" data-block="${id}" data-alias="${alias}">
            <i class="${icon}"></i>
            <span class="slash-menu-label">${label}</span>
            <span class="slash-menu-shortcut">/${alias}</span>
        </button>`
    ).join('');

    elSlash.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('button[data-block]');
        if (!btn) return;
        e.preventDefault();
        insertSlashBlock(btn.dataset.block);
    });

    document.addEventListener('mousedown', (e) => {
        if (!elSlash.hidden && !elSlash.contains(e.target)) hideSlashMenu();
        if (!elTableToolbar.hidden && !elTableToolbar.contains(e.target) && !tableCellFromTarget(e.target)) hideTableToolbar();
    });
    document.addEventListener('selectionchange', syncToolbarVisibility);
    document.addEventListener('selectionchange', syncTableToolbarVisibility);
    document.addEventListener('selectionchange', syncDividerSelection);

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
    elTableToolbar.addEventListener('mousedown', (e) => e.preventDefault());
    elTableToolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-table-action]');
        if (!btn) return;
        runTableToolbarAction(btn.dataset.tableAction);
    });
    elBlockHandle.addEventListener('mouseenter', () => {
        cancelBlockHandleHide();
        if (hoveredBlock) positionBlockHandle();
    });
    elBlockHandle.addEventListener('mouseleave', (e) => {
        if (!draggedBlock && !blockHoverUiContains(e.relatedTarget) && !elRich.contains(e.relatedTarget)) scheduleBlockHoverUiHide();
    });
    elBlockHandle.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !hoveredBlock || !hoveredBlock.isConnected) return;
        e.preventDefault();
        e.stopPropagation();
        selectBlock(hoveredBlock);
        pendingHandleDrag = { block: hoveredBlock, x: e.clientX, y: e.clientY };
    });
    elBlockActions.addEventListener('mouseenter', () => {
        cancelBlockHandleHide();
        if (hoveredBlock) positionBlockActions();
    });
    elBlockActions.addEventListener('mouseleave', (e) => {
        if (!draggedBlock && !blockHoverUiContains(e.relatedTarget) && !elRich.contains(e.relatedTarget)) scheduleBlockHoverUiHide();
    });
    elBlockActions.addEventListener('mousedown', (e) => e.preventDefault());
    elBlockCopy.addEventListener('click', async () => {
        if (!hoveredBlock || !isBlockActionTarget(hoveredBlock)) return;
        await copyBlock(hoveredBlock);
        showBlockActionFeedback(elBlockCopy);
    });
    elBlockCut.addEventListener('click', async () => {
        if (!hoveredBlock || !isBlockActionTarget(hoveredBlock)) return;
        const block = hoveredBlock;
        await copyBlock(block);
        removeBlock(block);
        showBlockActionFeedback(elBlockCut);
    });
    document.addEventListener('mousemove', onDocumentPointerMove, true);
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    window.addEventListener('mousemove', onBlockDragMove);
    window.addEventListener('mouseup', onBlockDragEnd);
    window.addEventListener('resize', () => {
        positionBlockHandle();
        positionBlockActions();
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
        hideTableToolbar();
        hideCodeCopy();
        hideBlockHandle();
        hideBlockActions();
        hideBlockDropLine();
        hideDividerSelection();
    }

    function selectionInEditor() {
        const sel = window.getSelection();
        return sel && sel.rangeCount && elRich.contains(sel.anchorNode);
    }

    function syncToolbarVisibility() {
        elToolbar.hidden = !selectedTextInEditor() || elSearchToolbar?.hidden === false;
    }

    function syncTableToolbarVisibility() {
        const cell = currentTableCell();
        if (!cell || elSearchToolbar?.hidden === false || elSettings?.hidden === false) return hideTableToolbar();
        activeTableCell = cell;
        elTableToolbar.hidden = false;
    }

    function hideTableToolbar() {
        activeTableCell = null;
        elTableToolbar.hidden = true;
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
        refreshSlashMenu();
    }

    function refreshSlashMenu() {
        if (!slashRange || !selectionInEditor() || !slashQueryIsValid()) return hideSlashMenu();
        const query = currentSlashQuery().toLowerCase();
        const exactMatch = currentSlashExactAliasMatch();
        if (exactMatch) {
            if (!slashAliasHasLongerMatch(query)) return insertSlashBlock(exactMatch.id);
            scheduleSlashBlockCommit(exactMatch.id, query);
        } else {
            clearSlashCommitTimer();
        }
        syncSlashMenuItems();
        const buttons = visibleSlashButtons();
        if (!buttons.length) return hideSlashMenu();
        elSlash.hidden = false;
        positionSlashMenu();
        setActiveSlash(0);
    }

    function positionSlashMenu() {
        if (!slashRange) return;
        const rect = slashRange.getBoundingClientRect();
        const editorRect = elRich.getBoundingClientRect();
        const menuWidth = elSlash.offsetWidth || 220;
        const menuHeight = Math.min(Math.max(elSlash.scrollHeight || 0, visibleSlashButtons().length * 35 + 8), 320);
        const left = Math.max(8, Math.min(rect.left || editorRect.left + 24, window.innerWidth - menuWidth - 8));
        const belowTop = (rect.bottom || editorRect.top + 24) + 6;
        const aboveTop = (rect.top || editorRect.top + 24) - menuHeight - 6;
        const top = belowTop + menuHeight > window.innerHeight - 8 && aboveTop >= 8
            ? aboveTop
            : Math.max(8, Math.min(belowTop, window.innerHeight - menuHeight - 8));
        elSlash.style.left = `${left}px`;
        elSlash.style.top = `${top}px`;
    }

    function hideSlashMenu() {
        clearSlashCommitTimer();
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
        const query = currentSlashQuery().toLowerCase();
        const exactAliasMatch = !!slashBlockForAlias(query, inTable) && !slashAliasHasLongerMatch(query, inTable);
        elSlash.querySelectorAll('button').forEach(btn => {
            const block = slashBlockMap.get(btn.dataset.block);
            const tableHidden = tableSlashBlocks.has(btn.dataset.block) && !inTable;
            const queryHidden = query && !slashBlockMatchesQuery(block, query, exactAliasMatch);
            btn.hidden = tableHidden || queryHidden;
        });
    }

    function handleSlashBeforeInput(e) {
        if (elSlash.hidden || e.inputType !== 'insertText' || !e.data || !slashRange || !selectionInEditor()) return false;
        const token = currentSlashToken();
        if (!token) return false;
        const query = `${token.query}${e.data}`.toLowerCase();
        const block = slashBlockForAlias(query);
        if (!block) return false;
        if (slashAliasHasLongerMatch(query)) return false;
        e.preventDefault();
        insertSlashBlock(block.id);
        return true;
    }

    function insertSlashBlock(id) {
        clearSlashCommitTimer();
        const block = slashBlockMap.get(id);
        if (!block || !slashRange) return hideSlashMenu();
        const content = block.content;
        const sel = window.getSelection();
        if (typeof content === 'function') {
            const range = currentSlashSelectionRange() || slashRange.cloneRange();
            sel.removeAllRanges();
            sel.addRange(range);
            if (!content()) return hideSlashMenu();
        } else {
            insertSlashHtml(content);
        }
        hideSlashMenu();
        ensureEditorBlocks();
        elRich.focus();
        scheduleSave();
    }

    function insertSlashHtml(content) {
        const sel = window.getSelection();
        const range = rangeWithSlashSelected();
        sel.removeAllRanges();
        sel.addRange(range);
        const insertRange = sel.getRangeAt(0);
        const block = editorBlockForNode(insertRange.startContainer);
        insertRange.deleteContents();
        const fragment = insertRange.createContextualFragment(content);
        const insertedNodes = [...fragment.childNodes];
        if (isEmptyParagraph(block)) block.replaceWith(fragment);
        else insertRange.insertNode(fragment);
        if (placeCaretAtSlashMarker()) return;
        const target = insertedNodes.find(node => node.nodeType === Node.ELEMENT_NODE && elRich.contains(node));
        if (isEmptyParagraph(target) && !target.innerHTML) target.innerHTML = '<br>';
        if (target) placeCaretIn(target);
    }

    function rangeWithSlashSelected() {
        return selectedSlashRange() || currentSlashSelectionRange() || fallbackSlashSelectionRange();
    }

    function selectedSlashRange() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed || !elRich.contains(sel.anchorNode) || !elRich.contains(sel.focusNode)) return null;
        const range = sel.getRangeAt(0).cloneRange();
        return range.toString().startsWith('/') ? range : null;
    }

    function fallbackSlashSelectionRange() {
        const range = slashRange.cloneRange();
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node.nodeType === Node.TEXT_NODE && offset > 0 && node.data[offset - 1] === '/') {
            range.setStart(node, offset - 1);
        }
        return range;
    }

    function currentSlashToken() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed || !elRich.contains(sel.anchorNode)) return null;
        if (sel.anchorNode.nodeType !== Node.TEXT_NODE) return null;
        const text = sel.anchorNode.data.slice(0, sel.anchorOffset);
        const slashIndex = text.lastIndexOf('/');
        if (slashIndex < 0) return null;
        const prefix = text.slice(0, slashIndex);
        if (prefix && !/\s$/.test(prefix)) return null;
        const query = text.slice(slashIndex + 1);
        if (/[\s/]/.test(query)) return null;
        return { node: sel.anchorNode, startOffset: slashIndex, endOffset: sel.anchorOffset, query };
    }

    function currentSlashSelectionRange() {
        const token = currentSlashToken();
        if (!token) return null;
        const range = document.createRange();
        range.setStart(token.node, token.startOffset);
        range.setEnd(token.node, token.endOffset);
        return range;
    }

    function currentSlashQuery() {
        return currentSlashToken()?.query || '';
    }

    function currentSlashExactAliasMatch() {
        const inTable = !!currentTableCell();
        const query = currentSlashQuery().toLowerCase();
        return slashBlockForAlias(query, inTable);
    }

    function slashBlockForAlias(query, inTable = !!currentTableCell()) {
        if (!query) return null;
        return slashBlocks.find(block =>
            (!tableSlashBlocks.has(block.id) || inTable) &&
            block.alias.toLowerCase() === query
        ) || null;
    }

    function slashAliasHasLongerMatch(query, inTable = !!currentTableCell()) {
        if (!query) return false;
        return slashBlocks.some(block =>
            (!tableSlashBlocks.has(block.id) || inTable) &&
            block.alias.length > query.length &&
            block.alias.toLowerCase().startsWith(query)
        );
    }

    function scheduleSlashBlockCommit(id, query) {
        clearSlashCommitTimer();
        slashCommitTimer = setTimeout(() => {
            slashCommitTimer = null;
            const match = currentSlashExactAliasMatch();
            if (!elSlash.hidden && match?.id === id && currentSlashQuery().toLowerCase() === query) {
                insertSlashBlock(id);
            }
        }, SLASH_PREFIX_COMMIT_DELAY);
    }

    function clearSlashCommitTimer() {
        clearTimeout(slashCommitTimer);
        slashCommitTimer = null;
    }

    function slashQueryIsValid() {
        return !!currentSlashToken();
    }

    function slashBlockMatchesQuery(block, query, exactAliasMatch = false) {
        if (!block || !query) return true;
        const alias = block.alias.toLowerCase();
        const label = block.label.toLowerCase();
        if (exactAliasMatch) return alias === query;
        return alias.startsWith(query) || label.startsWith(query);
    }

    function removeSlashTrigger() {
        const sel = window.getSelection();
        const range = rangeWithSlashSelected();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
    }

    function insertDividerBlock() {
        const sel = window.getSelection();
        const range = rangeWithSlashSelected();
        sel.removeAllRanges();
        sel.addRange(range);
        const block = editorBlockForNode(sel.anchorNode);
        document.execCommand('delete', false, null);

        const divider = createDividerBlock();
        if (isEmptyParagraph(block)) {
            block.replaceWith(divider);
        } else {
            sel.getRangeAt(0).insertNode(divider);
        }
        placeCaretAfter(divider);
        showDividerSelection(divider);
        return true;
    }

    function createDividerBlock() {
        const block = document.createElement('div');
        block.className = 'editor-divider-block';
        resetDividerBlock(block);
        return block;
    }

    function resetDividerBlock(divider) {
        const isTextBlock = divider.classList.contains('editor-text-block');
        const isSelected = divider.classList.contains('selected');
        divider.className = 'editor-divider-block';
        if (isTextBlock) divider.classList.add('editor-text-block');
        if (isSelected) divider.classList.add('selected');
        divider.setAttribute('contenteditable', 'false');
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-label', 'Divider');
        divider.replaceChildren(document.createElement('hr'));
    }

    function placeCaretAtSlashMarker() {
        const marker = elRich.querySelector('[data-slash-caret]');
        if (!marker) return false;
        const target = marker.parentElement;
        marker.remove();
        placeCaretIn(target);
        return true;
    }

    function currentTableCell() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && elRich.contains(sel.anchorNode)) {
            const node = sel.anchorNode.nodeType === Node.ELEMENT_NODE
                ? sel.anchorNode
                : sel.anchorNode.parentElement;
            const cell = node?.closest?.('td,th');
            if (cell && elRich.contains(cell)) return cell;
        }
        return activeTableCell?.isConnected && elRich.contains(activeTableCell) ? activeTableCell : null;
    }

    function tableCellFromTarget(target) {
        const element = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
        const directCell = element?.closest?.('td,th');
        if (directCell && elRich.contains(directCell)) return directCell;
        const table = element?.closest?.('table');
        return table && elRich.contains(table) ? table.rows[0]?.cells[0] || null : null;
    }

    function setActiveTableCellFromTarget(target) {
        const cell = tableCellFromTarget(target);
        if (!cell) return;
        activeTableCell = cell;
        elTableToolbar.hidden = false;
    }

    function removeSlashTriggerIfPresent() {
        if (slashRange) removeSlashTrigger();
    }

    function runTableToolbarAction(id) {
        const block = slashBlockMap.get(id);
        if (!block || typeof block.content !== 'function') return;
        if (!currentTableCell()) return hideTableToolbar();
        if (!block.content()) return hideTableToolbar();
        ensureEditorBlocks();
        syncTableToolbarVisibility();
        elRich.focus();
        scheduleSave();
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
        removeSlashTriggerIfPresent();

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
        removeSlashTriggerIfPresent();

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
        removeSlashTriggerIfPresent();

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
        removeSlashTriggerIfPresent();

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

    function isDividerBlock(node) {
        return node?.nodeType === Node.ELEMENT_NODE && node.classList.contains('editor-divider-block');
    }

    function currentDividerSelection() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed || !elRich.contains(sel.anchorNode)) return null;
        if (sel.anchorNode === elRich) {
            const dividerBefore = elRich.childNodes[sel.anchorOffset - 1];
            const dividerAfter = elRich.childNodes[sel.anchorOffset];
            if (isDividerBlock(dividerBefore)) return { divider: dividerBefore, side: 'after' };
            if (isDividerBlock(dividerAfter)) return { divider: dividerAfter, side: 'before' };
            return null;
        }

        const element = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
        const divider = element?.closest?.('.editor-divider-block');
        return divider && elRich.contains(divider) ? { divider, side: 'inside' } : null;
    }

    function handleDividerBoundaryEnter() {
        const selection = currentDividerSelection();
        if (!selection) return false;
        insertParagraphAfterDivider(selection.divider);
        return true;
    }

    function insertParagraphAfterDivider(divider) {
        const paragraph = document.createElement('p');
        paragraph.innerHTML = '<br>';
        divider.after(paragraph);
        placeCaretIn(paragraph);
        hideDividerSelection();
    }

    function handleDividerBeforeInput(e) {
        const selection = currentDividerSelection();
        if (!selection) return false;
        const inputType = e.inputType || '';
        if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') {
            e.preventDefault();
            insertParagraphAfterDivider(selection.divider);
            scheduleSave();
            return true;
        }
        if (inputType.startsWith('delete')) {
            e.preventDefault();
            removeDividerBlock(selection.divider);
            scheduleSave();
            return true;
        }
        if (!inputType.startsWith('insert')) return false;
        e.preventDefault();
        resetDividerBlock(selection.divider);
        placeCaretAfter(selection.divider);
        showDividerSelection(selection.divider);
        return true;
    }

    function handleDividerDelete() {
        const selection = currentDividerSelection();
        if (!selection) return false;
        removeDividerBlock(selection.divider);
        return true;
    }

    function removeDividerBlock(divider) {
        const target = divider.nextElementSibling || divider.previousElementSibling;
        divider.remove();
        hideDividerSelection();
        if (isDividerBlock(target)) {
            placeCaretAfter(target);
            showDividerSelection(target);
        } else if (target) {
            placeCaretIn(target);
        }
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
        elRich.focus();
        const range = document.createRange();
        range.selectNodeContents(node);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function placeCaretAfter(node) {
        elRich.focus();
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function syncDividerSelection() {
        const selection = currentDividerSelection();
        if (selection) showDividerSelection(selection.divider);
        else hideDividerSelection();
    }

    function showDividerSelection(divider) {
        if (selectedDividerBlock !== divider) hideDividerSelection();
        selectedDividerBlock = divider;
        divider.classList.add('selected');
        elRich.classList.add('divider-selected-active');
    }

    function hideDividerSelection() {
        selectedDividerBlock?.classList.remove('selected');
        selectedDividerBlock = null;
        elRich.classList.remove('divider-selected-active');
    }

    function selectBlock(block) {
        if (!block || !elRich.contains(block)) return clearSelectedBlock();
        if (selectedBlock && selectedBlock !== block) selectedBlock.classList.remove('editor-block-selected');
        selectedBlock = block;
        selectedBlock.classList.add('editor-block-selected');
    }

    function clearSelectedBlock() {
        selectedBlock?.classList.remove('editor-block-selected');
        selectedBlock = null;
    }

    function caretAtStartOf(node) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return false;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return false;
        const start = document.createRange();
        start.selectNodeContents(node);
        start.collapse(true);
        return range.compareBoundaryPoints(Range.START_TO_START, start) === 0;
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

    async function copyBlock(block) {
        const clone = block.cloneNode(true);
        clone.classList.remove('editor-block-selected', 'editor-block-dragging', 'editor-text-block');
        clone.querySelectorAll('input[type="checkbox"]').forEach((input) => {
            if (input.checked) input.setAttribute('checked', '');
            else input.removeAttribute('checked');
        });
        const html = clone.outerHTML;
        const text = block.innerText || block.textContent || '';

        if (navigator.clipboard?.write && window.ClipboardItem && window.isSecureContext) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        'text/html': new Blob([html], { type: 'text/html' }),
                        'text/plain': new Blob([text], { type: 'text/plain' }),
                    }),
                ]);
                return;
            } catch (_) {
                // Fall through to plain text when rich clipboard writes are denied.
            }
        }
        await copyText(text);
    }

    function removeBlock(block) {
        const target = block.nextElementSibling || block.previousElementSibling;
        block.remove();
        if (!elRich.children.length) {
            const paragraph = document.createElement('p');
            paragraph.innerHTML = '<br>';
            elRich.append(paragraph);
            placeCaretIn(paragraph);
        } else if (target?.isConnected) {
            placeCaretIn(target);
        } else {
            elRich.focus();
        }
        hideBlockHandle();
        scheduleSave();
    }

    function showBlockActionFeedback(button) {
        button.classList.add('done');
        setTimeout(() => button.classList.remove('done'), 900);
    }

    function updateHoveredBlock(node, clientX, clientY) {
        if (draggedBlock) return;
        cancelBlockHandleHide();
        ensureEditorBlocks();
        const block = editorBlockFromPoint(clientX, clientY) || editorBlockForNode(node);
        if (!block) return scheduleBlockHoverUiHide();
        hoveredBlock = block;
        positionBlockHandle();
        positionBlockActions();
        elBlockHandle.hidden = false;
    }

    function onDocumentPointerMove(e) {
        if (draggedBlock) return;
        if (blockHoverUiContains(e.target)) {
            cancelBlockHandleHide();
            return;
        }
        const block = editorBlockFromPoint(e.clientX, e.clientY);
        if (block) {
            hoveredBlock = block;
            cancelBlockHandleHide();
            positionBlockHandle();
            positionBlockActions();
        } else if (!elRich.contains(e.target)) {
            scheduleBlockHoverUiHide();
        }
    }

    function bindEditorBlock(block) {
        if (boundEditorBlocks.has(block)) return;
        boundEditorBlocks.add(block);
        if (isDividerBlock(block)) block.addEventListener('mousedown', focusDividerBoundaryFromClick);
        block.addEventListener('mouseenter', showBlockHandleForEvent);
        block.addEventListener('mousemove', showBlockHandleForEvent);
    }

    function focusDividerBoundaryFromClick(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        placeCaretAfter(e.currentTarget);
        showDividerSelection(e.currentTarget);
    }

    function showBlockHandleForEvent(e) {
        updateHoveredBlock(e.currentTarget, e.clientX, e.clientY);
    }

    function ensureCaretFromClick(e) {
        const target = e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
        if (!target || target.closest('.editor-divider-block, input, button, select, textarea')) return false;

        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) return false;

        const range = caretRangeFromPoint(e.clientX, e.clientY) || fallbackClickRange(e.clientX, e.clientY, target);
        if (!range) return false;

        e.preventDefault();
        elRich.focus();
        sel?.removeAllRanges();
        sel?.addRange(range);
        hideDividerSelection();
        return true;
    }

    function startBlockDrag(block, clientX, clientY) {
        if (!block?.isConnected) return;
        hideSlashMenu();
        disarmCodeExit();
        cancelBlockHandleHide();
        pendingHandleDrag = null;
        draggedBlock = block;
        hoveredBlock = draggedBlock;
        selectBlock(block);
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

    function caretRangeFromPoint(clientX, clientY) {
        const domRange = document.caretRangeFromPoint?.(clientX, clientY);
        if (domRange && elRich.contains(domRange.startContainer)) {
            if (domRange.startContainer === elRich) return null;
            return domRange;
        }

        const position = document.caretPositionFromPoint?.(clientX, clientY);
        if (!position || !elRich.contains(position.offsetNode)) return null;
        if (position.offsetNode === elRich) return null;

        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
    }

    function fallbackClickRange(clientX, clientY, target) {
        const block = editorBlockForNode(target) || nearestEditorBlock(clientY) || elRich.lastElementChild;
        if (!block) return null;

        const rect = block.getBoundingClientRect();
        if (clientY > rect.bottom && block === elRich.lastElementChild) {
            const paragraph = document.createElement('p');
            paragraph.innerHTML = '<br>';
            elRich.append(paragraph);
            ensureEditorBlocks();
            return collapsedRangeAtBlockBoundary(paragraph, 'start');
        }
        if (clientY > rect.bottom) return collapsedRangeAtBlockBoundary(block, 'end');
        if (clientY < rect.top) return collapsedRangeAtBlockBoundary(block, 'start');
        return collapsedRangeAtBlockBoundary(block, clientX <= rect.left + rect.width / 2 ? 'start' : 'end');
    }

    function collapsedRangeAtBlockBoundary(block, side) {
        const range = document.createRange();
        range.selectNodeContents(block);
        range.collapse(side !== 'end');
        return range;
    }

    function editorBlockByRect(clientX, clientY) {
        const editorRect = elRich.getBoundingClientRect();
        if (clientX < editorRect.left || clientX > editorRect.right ||
            clientY < editorRect.top || clientY > editorRect.bottom) return null;

        return [...elRich.children].find(block => {
            const rect = blockHitRect(block);
            return clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top && clientY <= rect.bottom;
        }) || null;
    }

    function blockHitRect(block) {
        const rect = block.getBoundingClientRect();
        if (!isDividerBlock(block)) return rect;
        return {
            left: rect.left,
            right: rect.right,
            top: rect.top - 10,
            bottom: rect.bottom + 10,
        };
    }

    function positionBlockHandle() {
        if (!hoveredBlock || !hoveredBlock.isConnected || draggedBlock) return hideBlockHandle();
        const rect = hoveredBlock.getBoundingClientRect();
        const editorRect = elRich.getBoundingClientRect();
        if (rect.bottom < editorRect.top || rect.top > editorRect.bottom) return hideBlockHandle();
        elBlockHandle.style.left = `${Math.max(8, rect.left - 32)}px`;
        elBlockHandle.style.top = `${blockHandleTop(hoveredBlock, rect)}px`;
        elBlockHandle.hidden = false;
    }

    function blockHandleTop(block, rect) {
        if (isDividerBlock(block)) return rect.top - 7;
        return rect.top + Math.max(0, Math.min(rect.height - 24, 4));
    }

    function positionBlockActions() {
        if (!hoveredBlock || !hoveredBlock.isConnected || draggedBlock || !isBlockActionTarget(hoveredBlock)) {
            return hideBlockActions();
        }
        const rect = hoveredBlock.getBoundingClientRect();
        const editorRect = elRich.getBoundingClientRect();
        if (rect.bottom < editorRect.top || rect.top > editorRect.bottom) return hideBlockActions();
        const width = elBlockActions.offsetWidth || 58;
        elBlockActions.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width - 6))}px`;
        elBlockActions.style.top = `${blockHandleTop(hoveredBlock, rect)}px`;
        elBlockActions.hidden = false;
    }

    function isBlockActionTarget(block) {
        if (!block || block.parentElement !== elRich || isDividerBlock(block)) return false;
        if (block.matches('p, section.titled-note, ol')) return true;
        if (block.matches('ul')) return true;
        return false;
    }

    function blockHoverUiContains(target) {
        return elBlockHandle.contains(target) || elBlockActions.contains(target);
    }

    function hideBlockHandle() {
        cancelBlockHandleHide();
        hoveredBlock = null;
        elBlockHandle.hidden = true;
        hideBlockActions();
    }

    function hideBlockActions() {
        elBlockActions.hidden = true;
        elBlockCut.classList.remove('done');
        elBlockCopy.classList.remove('done');
    }

    function scheduleBlockHoverUiHide() {
        scheduleBlockHandleHide();
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

    function showBlockDropLine(target, intent) {
        const rect = target.getBoundingClientRect();
        elBlockDropLine.style.left = `${rect.left}px`;
        elBlockDropLine.style.top = `${intent === 'before' ? rect.top : rect.bottom}px`;
        elBlockDropLine.style.width = `${rect.width}px`;
        elBlockDropLine.hidden = false;
    }

    function showBlockDropSlot(slot) {
        elBlockDropLine.style.left = `${slot.left}px`;
        elBlockDropLine.style.top = `${slot.top}px`;
        elBlockDropLine.style.width = `${slot.width}px`;
        elBlockDropLine.hidden = false;
    }

    function positionBlockDropLine() {
        if (!draggedBlock || !blockDropTarget?.isConnected) return hideBlockDropLine();
        const slot = currentDropSlot(blockDropTarget, blockDropIntent);
        if (!slot) return hideBlockDropLine();
        showBlockDropSlot(slot);
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
        pendingHandleDrag = null;
        blockDropIntent = 'before';
        elBlockHandle.classList.remove('dragging');
        hideBlockDropLine();
    }

    function onBlockDragMove(e) {
        if (pendingHandleDrag && !draggedBlock) {
            const distance = Math.hypot(e.clientX - pendingHandleDrag.x, e.clientY - pendingHandleDrag.y);
            if (distance < 5) return;
            e.preventDefault();
            startBlockDrag(pendingHandleDrag.block, e.clientX, e.clientY);
        }
        if (!draggedBlock) return;
        e.preventDefault();
        updateBlockDropFromPointer(e.clientX, e.clientY);
    }

    function onBlockDragEnd(e) {
        if (pendingHandleDrag && !draggedBlock) {
            pendingHandleDrag = null;
            positionBlockHandle();
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
        const slot = nearestDropSlot(clientY);
        if (!slot || slot.target === draggedBlock) return hideBlockDropLine();
        blockDropTarget = slot.target;
        blockDropIntent = slot.intent;
        showBlockDropSlot(slot);
    }

    function pointInEditorLane(clientX, clientY) {
        const rect = elRich.getBoundingClientRect();
        return clientX >= rect.left - 40 &&
            clientX <= rect.right &&
            clientY >= rect.top - 20 &&
            clientY <= rect.bottom + 20;
    }

    function nearestDropSlot(clientY) {
        ensureEditorBlocks();
        const blocks = draggableBlocks();
        if (!blocks.length) return null;
        const slots = dropSlots(blocks);
        return slots.reduce((closest, slot) => {
            const distance = Math.abs(slot.top - clientY);
            if (!closest || distance < closest.distance) return { ...slot, distance };
            return closest;
        }, null);
    }

    function draggableBlocks() {
        return [...elRich.children].filter(block => block !== draggedBlock);
    }

    function dropSlots(blocks) {
        const slots = [dropEdgeSlot(blocks[0], 'before')];
        for (let i = 0; i < blocks.length - 1; i += 1) {
            slots.push(dropGapSlot(blocks[i], blocks[i + 1]));
        }
        slots.push(dropEdgeSlot(blocks.at(-1), 'after'));
        return slots;
    }

    function currentDropSlot(target, intent) {
        return dropSlots(draggableBlocks()).find(slot => slot.target === target && slot.intent === intent) || null;
    }

    function dropEdgeSlot(target, intent) {
        const rect = target.getBoundingClientRect();
        return { target, intent, left: rect.left, top: intent === 'before' ? rect.top : rect.bottom, width: rect.width };
    }

    function dropGapSlot(previous, target) {
        const prevRect = previous.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        return {
            target,
            intent: 'before',
            left: Math.min(prevRect.left, rect.left),
            top: (prevRect.bottom + rect.top) / 2,
            width: Math.max(prevRect.right, rect.right) - Math.min(prevRect.left, rect.left),
        };
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
        normalizeDividerBlocks();
        [...elRich.children].forEach(block => {
            block.classList.add('editor-text-block');
            bindEditorBlock(block);
        });
    }

    function normalizeDividerBlocks() {
        const sel = window.getSelection();
        const dividerSelection = currentDividerSelection();
        [...elRich.children].forEach((block) => {
            if (block.tagName !== 'HR') return;
            const divider = createDividerBlock();
            block.replaceWith(divider);
        });
        [...elRich.children].filter(isDividerBlock).forEach((divider) => {
            let shouldMoveCaret = dividerSelection?.divider === divider;
            resetDividerBlock(divider);
            const paragraph = divider.nextElementSibling;
            if (isEmptyParagraph(paragraph)) {
                shouldMoveCaret = shouldMoveCaret || (sel?.anchorNode && paragraph.contains(sel.anchorNode));
                paragraph.remove();
            }
            if (shouldMoveCaret) placeCaretAfter(divider);
        });
        syncDividerSelection();
    }

    return { load, clear, saveNow, showSettings, setTitleIfCurrent, setIconIfCurrent };
})();
