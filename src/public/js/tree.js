/**
 * tree.js — recursive notes tree, drag-and-drop, context menu.
 *
 * The tree is rendered recursively from the nested subtree object returned by
 * GET /api/tree. Each node maps to a <div class="tree-node"> with:
 *   - a caret (expand/collapse) for parents,
 *   - a Boxicon chosen by NOTE_TYPE_ICON,
 *   - a label,
 *   - drag handlers (draggable) + drop-zone handlers,
 *   - right-click → context menu.
 */

const TreeView = (() => {
    const elTree = document.getElementById('tree');
    const elCtx  = document.getElementById('ctxMenu');
    const elIconPicker = document.getElementById('iconPicker');

    // ---- Trilium-style icon mapping ----------------------------------------
    // Default icon + per-type override + folder icon for parents.
    const NOTE_TYPE_ICON = {
        text:   'bx bx-file',
    };
    const FOLDER_OPEN   = 'bx bx-folder-open';
    const FOLDER_CLOSED = 'bx bx-folder';
    const BOXICONS_CSS = 'https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css';
    const FALLBACK_ICON_CHOICES = [
        '', 'bx bx-file', 'bx bx-note', 'bx bx-folder', 'bx bx-book', 'bx bx-bookmark',
        'bx bx-star', 'bx bxs-star', 'bx bx-heart', 'bx bxs-heart', 'bx bx-pin',
        'bx bx-check-circle', 'bx bx-error-circle', 'bx bx-info-circle', 'bx bx-help-circle',
        'bx bx-bulb', 'bx bx-brain', 'bx bx-code-alt', 'bx bx-terminal', 'bx bx-data',
        'bx bx-calendar', 'bx bx-time', 'bx bx-task', 'bx bx-list-check', 'bx bx-edit',
        'bx bx-pencil', 'bx bx-link', 'bx bx-image', 'bx bx-music', 'bx bx-video',
        'bx bx-map', 'bx bx-home', 'bx bx-briefcase', 'bx bx-rocket', 'bx bx-flag',
        'bx bx-lock-alt', 'bx bx-key', 'bx bx-cog', 'bx bx-package', 'bx bx-archive',
        'bx bxl-github', 'bx bxl-javascript', 'bx bxl-html5', 'bx bxl-css3',
    ];
    let iconChoicesPromise = null;

    // ---- state -------------------------------------------------------------
    let selectedRelationId = null;   // currently selected row
    let selectedNoteId = null;
    let onNoteSelectedCb = null;     // callback set by app.js

    // ---- helpers -----------------------------------------------------------
    function isFolder(node) {
        // A node is "folder-like" if it has children (Trilium shows the
        // folder icon for any note with children).
        return node.childCount > 0 || (node.children && node.children.length > 0);
    }

    function iconFor(node) {
        if (node.icon) return node.icon;
        if (isFolder(node)) {
            return node.isExpanded ? FOLDER_OPEN : FOLDER_CLOSED;
        }
        return NOTE_TYPE_ICON[node.type] || 'bx bx-file';
    }

    function normalizeIcon(value) {
        const icon = (value || '').trim();
        if (!icon) return null;
        if (/^(bx|bxs|bxl)-[a-z0-9-]+$/.test(icon)) return `bx ${icon}`;
        if (/^bx (bx|bxs|bxl)-[a-z0-9-]+$/.test(icon)) return icon;
        return false;
    }

    function isClone(node) {
        // We can't know clone count from the subtree alone reliably, so we
        // surface it via the badge when provided.
        return node.cloneCount && node.cloneCount > 1;
    }

    // ---- recursive render --------------------------------------------------
    function renderNode(node, depth, parentId = 'root') {
        const wrap = document.createElement('div');
        wrap.className = 'tree-node';
        wrap.dataset.relationId = node.relationId;
        wrap.dataset.noteId = node.noteId;
        wrap.dataset.parentId = parentId;

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (depth * 16 + 4) + 'px';   // deep-nesting indent
        row.dataset.relationId = node.relationId;
        row.dataset.noteId = node.noteId;
        row.dataset.depth = depth;

        // caret
        const caret = document.createElement('span');
        const hasChildren = isFolder(node);
        caret.className = 'tree-caret' + (hasChildren ? '' : ' empty');
        caret.innerHTML = hasChildren
            ? `<i class="bx bx-chevron-${node.isExpanded ? 'down' : 'right'}"></i>`
            : '';
        caret.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleExpand(node, wrap, depth);
        });

        // icon
        const icon = document.createElement('i');
        icon.className = 'tree-icon ' + iconFor(node);
        icon.title = 'Right-click to change icon';
        icon.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectRow(row, node);
            openIconPicker(e.clientX, e.clientY, node);
        });

        // label
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.title || 'Untitled';

        row.appendChild(caret);
        row.appendChild(icon);
        row.appendChild(label);

        // clone badge
        if (isClone(node)) {
            const badge = document.createElement('span');
            badge.className = 'tree-clone-flag';
            badge.title = 'This note is cloned (appears in multiple places)';
            badge.innerHTML = '<i class="bx bx-copy-alt"></i>';
            row.appendChild(badge);
        }

        // selection + open
        row.addEventListener('click', () => selectRow(row, node));
        row.addEventListener('dblclick', () => triggerRename(row, node));

        // drag-drop
        row.draggable = true;
        row.addEventListener('dragstart', onDragStart);
        row.addEventListener('dragend',   onDragEnd);
        row.addEventListener('dragover',  onDragOver);
        row.addEventListener('dragleave', onDragLeave);
        row.addEventListener('drop',      onDrop);

        // context menu
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            selectRow(row, node);
            openContextMenu(e.clientX, e.clientY, node, row);
        });

        wrap.appendChild(row);

        // children container (only present if expanded)
        if (hasChildren && node.isExpanded && node.children) {
            const childWrap = document.createElement('div');
            childWrap.className = 'tree-children';
            node.children.forEach(child => childWrap.appendChild(renderNode(child, depth + 1, node.noteId)));
            wrap.appendChild(childWrap);
        }
        return wrap;
    }

    function renderAll(rootTree) {
        elTree.innerHTML = '';
        const kids = rootTree.children || [];
        if (kids.length === 0) {
            elTree.innerHTML = '<div class="tree-empty">No notes yet. Click <i class="bx bx-file-plus"></i> to create one.</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        kids.forEach(child => frag.appendChild(renderNode(child, 0)));
        elTree.appendChild(frag);
    }

    // ---- selection ---------------------------------------------------------
    function selectRow(rowEl, node) {
        document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
        rowEl.classList.add('selected');
        selectedRelationId = node.relationId;
        selectedNoteId = node.noteId;
        if (onNoteSelectedCb) onNoteSelectedCb(node);
    }

    function getSelected() {
        return { relationId: selectedRelationId, noteId: selectedNoteId };
    }

    // ---- expand / collapse -------------------------------------------------
    async function toggleExpand(node, wrap, depth) {
        const newState = !node.isExpanded;
        node.isExpanded = newState;
        await Api.setExpanded({ relationId: node.relationId, isExpanded: newState });
        // re-render this node in place
        const fresh = renderNode(node, depth);
        wrap.replaceWith(fresh);
    }

    async function expandCollapseAll(node, wrap, depth, expand) {
        const walk = (n) => {
            n.isExpanded = expand;
            if (n.children) n.children.forEach(walk);
        };
        walk(node);
        // persist to backend
        const persist = (n) => {
            if (n.childCount > 0) Api.setExpanded({ relationId: n.relationId, isExpanded: expand });
            if (n.children) n.children.forEach(persist);
        };
        persist(node);
        const fresh = renderNode(node, depth);
        wrap.replaceWith(fresh);
    }

    // ---- rename (inline) ---------------------------------------------------
    function triggerRename(rowEl, node) {
        const label = rowEl.querySelector('.tree-label');
        const old = node.title;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = old;
        input.className = 'inline-rename';
        input.style.cssText = 'font-size:13px;padding:0 2px;border:1px solid var(--accent);border-radius:3px;width:80%;';
        label.replaceWith(input);
        input.focus();
        input.select();

        const commit = async () => {
            const val = input.value.trim() || old;
            await Api.updateNote(node.noteId, { title: val });
            node.title = val;
            const span = document.createElement('span');
            span.className = 'tree-label';
            span.textContent = val;
            input.replaceWith(span);
            // keep the editor's title box in sync if this note is open
            if (typeof Editor !== 'undefined' && Editor.setTitleIfCurrent) {
                Editor.setTitleIfCurrent(node.noteId, val);
            }
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') { input.value = old; input.blur(); }
            e.stopPropagation();
        });
    }

    // ============================ DRAG & DROP ==============================
    let dragSource = null;   // { relationId, noteId }
    const DROP_CLASSES = ['drop-inside', 'drop-before', 'drop-after', 'drop-first-child', 'drop-parent-after'];
    let dropLine = null;

    function clearDropClasses(row) {
        row.classList.remove(...DROP_CLASSES);
    }

    function getDropLine() {
        if (!dropLine || !elTree.contains(dropLine)) {
            dropLine = document.createElement('div');
            dropLine.className = 'tree-drop-line';
            elTree.appendChild(dropLine);
        }
        return dropLine;
    }

    function hideDropLine() {
        if (dropLine) dropLine.hidden = true;
    }

    function showDropLine(row, intent, depth) {
        if (intent === 'inside') {
            hideDropLine();
            return;
        }
        const treeRect = elTree.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const line = getDropLine();
        const y = (intent === 'before' || intent === 'parent-after') ? rowRect.top : rowRect.bottom;
        const x = rowRect.left - treeRect.left + elTree.scrollLeft + (depth * 16 + 4);
        line.style.top = (y - treeRect.top + elTree.scrollTop - 1) + 'px';
        line.style.left = x + 'px';
        line.style.right = '4px';
        line.hidden = false;
    }

    function isChildDropSide(e) {
        const rect = elTree.getBoundingClientRect();
        // ponytail: a single midpoint split matches the requested left/right pane behavior.
        // If this needs per-user tuning later, make the ratio configurable.
        return e.clientX >= rect.left + rect.width / 2;
    }

    function getDropIntent(row, e) {
        const rect = row.getBoundingClientRect();
        const offset = e.clientY - rect.top;
        const h = rect.height;
        if (offset < h * 0.25) {
            const depth = Number(row.dataset.depth || 0);
            if (depth > 0 && isFirstChildRow(row)) return isChildDropSide(e) ? 'before' : 'parent-after';
            return 'before';
        }
        if (offset <= h * 0.75) return 'inside';

        const nodeEl = row.parentElement;
        const hasVisibleChildren = !!nodeEl.querySelector(':scope > .tree-children > .tree-node');
        if (hasVisibleChildren && isChildDropSide(e)) return 'first-child';
        return 'after';
    }

    function getSiblingRows(row) {
        return [...row.parentElement.parentElement.querySelectorAll(':scope > .tree-node > .tree-row')];
    }

    function isFirstChildRow(row) {
        const nodeEl = row.parentElement;
        const childrenEl = nodeEl.parentElement;
        return childrenEl && childrenEl.classList.contains('tree-children') && childrenEl.firstElementChild === nodeEl;
    }

    function getParentRow(row) {
        const childrenEl = row.parentElement.parentElement;
        if (!childrenEl || !childrenEl.classList.contains('tree-children')) return null;
        return childrenEl.parentElement.querySelector(':scope > .tree-row');
    }

    function onDragStart(e) {
        dragSource = {
            relationId: this.dataset.relationId,
            noteId:     this.dataset.noteId,
        };
        this.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSource.relationId);
    }

    function onDragEnd() {
        this.classList.remove('dragging');
        document.querySelectorAll('.drop-inside,.drop-before,.drop-after,.drop-first-child,.drop-parent-after')
            .forEach(clearDropClasses);
        hideDropLine();
        dragSource = null;
    }

    function onDragOver(e) {
        if (!dragSource) return;
        // Don't allow dropping onto yourself.
        if (this.dataset.relationId === dragSource.relationId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const depth = Number(this.dataset.depth || 0);
        const intent = getDropIntent(this, e);
        const lineDepth = intent === 'first-child' ? depth + 1
            : intent === 'parent-after' ? Math.max(0, depth - 1)
            : depth;
        clearDropClasses(this);
        showDropLine(this, intent, lineDepth);
        this.classList.add(`drop-${intent}`);
    }

    function onDragLeave() {
        clearDropClasses(this);
        hideDropLine();
    }

    async function onDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!dragSource) return;
        const targetRelationId = this.dataset.relationId;
        const targetNoteId     = this.dataset.noteId;
        if (targetRelationId === dragSource.relationId) return;

        const cls = this.classList;
        try {
            if (cls.contains('drop-inside')) {
                // → drop INTO target (becomes child)
                await Api.moveNode({
                    relationId: dragSource.relationId,
                    newParentId: targetNoteId,
                });
            } else if (cls.contains('drop-parent-after')) {
                const parentRow = getParentRow(this);
                const parentId  = parentRow.parentElement.dataset.parentId || 'root';
                const siblingRows = getSiblingRows(parentRow);
                const order = siblingRows.map(r => r.dataset.relationId);
                const filtered = order.filter(rid => rid !== dragSource.relationId);
                const targetIdx = filtered.indexOf(parentRow.dataset.relationId);
                filtered.splice(targetIdx + 1, 0, dragSource.relationId);

                await Api.moveNode({
                    relationId: dragSource.relationId,
                    newParentId: parentId,
                });
                await Api.reorderSiblings({ parentId, relationIds: filtered });
            } else if (cls.contains('drop-first-child')) {
                const targetRow = this;
                const childRows = [...targetRow.parentElement.querySelectorAll(':scope > .tree-children > .tree-node > .tree-row')];
                const order = childRows.map(r => r.dataset.relationId).filter(rid => rid !== dragSource.relationId);
                order.unshift(dragSource.relationId);

                await Api.moveNode({
                    relationId: dragSource.relationId,
                    newParentId: targetNoteId,
                });
                await Api.reorderSiblings({ parentId: targetNoteId, relationIds: order });
            } else {
                // → reorder as sibling of target
                const targetRow = this;
                const parentId  = targetRow.parentElement.dataset.parentId || 'root';
                const siblingRows = getSiblingRows(targetRow);
                const order = siblingRows.map(r => r.dataset.relationId);

                // remove dragged (if present among siblings) and insert at target index
                const filtered = order.filter(rid => rid !== dragSource.relationId);
                const targetIdx = filtered.indexOf(targetRelationId);
                if (cls.contains('drop-before')) filtered.splice(targetIdx, 0, dragSource.relationId);
                else                             filtered.splice(targetIdx + 1, 0, dragSource.relationId);

                // First move (re-parent) if needed, then reorder.
                await Api.moveNode({
                    relationId: dragSource.relationId,
                    newParentId: parentId,
                });
                await Api.reorderSiblings({ parentId, relationIds: filtered });
            }
            await TreeView.reload();
            hideDropLine();
        } catch (err) {
            alert('Move failed: ' + err.message);
        }
    }

    // ============================ CONTEXT MENU =============================
    let ctxTarget = null;     // { node, rowEl }

    function openContextMenu(x, y, node, rowEl) {
        ctxTarget = { node, rowEl };
        elCtx.style.left = Math.min(x, window.innerWidth - 220) + 'px';
        elCtx.style.top  = Math.min(y, window.innerHeight - 280) + 'px';
        elCtx.hidden = false;
    }

    function closeContextMenu() {
        elCtx.hidden = true;
        ctxTarget = null;
    }

    elCtx.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-action]');
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.action;
        const { node, rowEl } = ctxTarget || {};
        closeContextMenu();
        if (!node) return;

        try {
            switch (action) {
                case 'create-child':
                    await TreeView.createChild(node.noteId, 'text', 'New Note');
                    break;
                case 'create-folder':
                    // a "folder" is just a text note that will get children
                    await TreeView.createChild(node.noteId, 'text', 'New Folder');
                    break;
                case 'change-icon':
                    openIconPicker(rowEl.getBoundingClientRect().left + 28, rowEl.getBoundingClientRect().top, node);
                    break;
                case 'rename':
                    triggerRename(rowEl, node);
                    break;
                case 'clone': {
                    // Clone under root for simplicity; Trilium has a picker.
                    await Api.clone({ noteId: node.noteId, newParentId: 'root' });
                    await TreeView.reload();
                    break;
                }
                case 'expand-all': {
                    const depth = getNodeDepth(rowEl);
                    await expandCollapseAll(node, rowEl, depth, true);
                    break;
                }
                case 'collapse-all': {
                    const depth = getNodeDepth(rowEl);
                    await expandCollapseAll(node, rowEl, depth, false);
                    break;
                }
                case 'properties':
                    TreeView.showProperties(node);
                    break;
                case 'delete':
                    if (confirm(`Delete "${node.title}"?\nIf this note has no other clones, it will be removed entirely.`)) {
                        await Api.deleteRelation(node.relationId);
                        await TreeView.reload();
                    }
                    break;
            }
        } catch (err) {
            alert('Action failed: ' + err.message);
        }
    });

    function getNodeDepth(rowEl) {
        // climb parents counting .tree-node
        let d = 0, cur = rowEl.parentElement;
        while (cur && cur !== elTree) {
            if (cur.classList.contains('tree-children')) d++;
            cur = cur.parentElement;
        }
        return d;
    }

    function openIconPicker(x, y, node) {
        closeContextMenu();
        elIconPicker.innerHTML = '<div class="icon-picker-loading">Loading icons...</div>';
        elIconPicker.style.left = Math.min(x, window.innerWidth - 360) + 'px';
        elIconPicker.style.top = Math.min(y, window.innerHeight - 420) + 'px';
        elIconPicker.hidden = false;
        elIconPicker._node = node;
        loadIconChoices().then(icons => {
            if (elIconPicker._node === node && !elIconPicker.hidden) renderIconPicker(icons, node);
        });
    }

    function renderIconPicker(icons, node, filter = '') {
        const q = filter.trim().toLowerCase();
        const visible = q
            ? icons.filter(icon => icon.toLowerCase().includes(q))
            : icons;
        elIconPicker.innerHTML = `
            <input class="icon-picker-search" type="search" placeholder="Search icons" value="${escapeAttr(filter)}" />
            <div class="icon-picker-grid">
                ${visible.map(icon => `
            <button data-icon="${icon}" class="${(node.icon || '') === icon ? 'selected' : ''}"
                    title="${icon || 'Default icon'}">
                <i class="${icon || 'bx bx-reset'}"></i>
            </button>`).join('')}
            </div>`;
        const search = elIconPicker.querySelector('.icon-picker-search');
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
    }

    function loadIconChoices() {
        if (!iconChoicesPromise) {
            iconChoicesPromise = fetch(BOXICONS_CSS)
                .then(res => res.ok ? res.text() : Promise.reject(new Error(res.statusText)))
                .then(css => {
                    const names = [...css.matchAll(/\.((?:bx|bxs|bxl)-[a-z0-9-]+):before/g)].map(m => m[1]);
                    const unique = [...new Set(names)].sort((a, b) => iconRank(a) - iconRank(b) || a.localeCompare(b));
                    return ['', ...unique.map(name => `bx ${name}`)];
                })
                .catch(() => FALLBACK_ICON_CHOICES);
        }
        return iconChoicesPromise;
    }

    function iconRank(name) {
        if (name.startsWith('bx-')) return 0;
        if (name.startsWith('bxs-')) return 1;
        return 2;
    }

    function escapeAttr(s) {
        return (s || '').replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        })[c]);
    }

    function closeIconPicker() {
        elIconPicker.hidden = true;
        elIconPicker._node = null;
    }

    async function setIcon(node, value) {
        const icon = normalizeIcon(value);
        if (icon === false) return alert('Use a Boxicons v2 class like bx-star, bxs-star, or bxl-github.');
        const updated = await Api.updateNote(node.noteId, { icon });
        node.icon = updated.icon;
        if (typeof Editor !== 'undefined' && Editor.setIconIfCurrent) {
            Editor.setIconIfCurrent(node.noteId, updated.icon);
        }
        await TreeView.reload();
    }

    elIconPicker.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.target.closest('button[data-icon]');
        if (!btn) return;
        const node = elIconPicker._node;
        closeIconPicker();
        if (!node) return;
        try { await setIcon(node, btn.dataset.icon); }
        catch (err) { alert('Action failed: ' + err.message); }
    });
    elIconPicker.addEventListener('input', async (e) => {
        if (!e.target.classList.contains('icon-picker-search')) return;
        e.stopPropagation();
        const node = elIconPicker._node;
        const icons = await loadIconChoices();
        renderIconPicker(icons, node, e.target.value);
    });

    // close context menu on any outside click / Escape
    document.addEventListener('click', () => { closeContextMenu(); closeIconPicker(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeContextMenu(); closeIconPicker(); }
    });

    // ============================ PROPERTIES ===============================
    async function showProperties(node) {
        const overlay = document.getElementById('modalOverlay');
        const body = document.getElementById('propsBody');
        let full;
        try { full = await Api.getNote(node.noteId); }
        catch (e) { return alert(e.message); }
        const rows = [
            ['noteId',       full.noteId],
            ['type',         full.type],
            ['parents',      (full.parents || []).map(p => p.title).join(', ') || '(root)'],
        ];
        body.innerHTML = rows.map(([k, v]) =>
            `<div class="prop-row"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
        overlay.hidden = false;
    }

    // ============================ PUBLIC API ===============================
    return {
        NOTE_TYPE_ICON,

        onNoteSelected(cb) { onNoteSelectedCb = cb; },

        async reload() {
            try {
                const tree = await Api.getTree();
                renderAll(tree);
            } catch (e) {
                elTree.innerHTML = `<div class="tree-empty">Error loading tree: ${e.message}</div>`;
            }
        },

        async createChild(parentId, type = 'text', title = 'New Note') {
            const note = await Api.createNote({ parentId, type, title });
            // make sure parent is expanded so the new child is visible
            const parentRow = document.querySelector(`.tree-row[data-note-id="${parentId}"]`);
            if (parentRow) {
                const nodeEl = parentRow.parentElement;
                const relId = parentRow.dataset.relationId;
                await Api.setExpanded({ relationId: relId, isExpanded: true });
            }
            await TreeView.reload();
            // select the new note
            const newRow = document.querySelector(`.tree-row[data-note-id="${note.noteId}"]`);
            if (newRow) newRow.click();
            // begin inline rename
            if (newRow) {
                const node = { noteId: note.noteId, relationId: newRow.dataset.relationId, title: note.title };
                triggerRename(newRow, node);
            }
            return note;
        },

        getSelected,
        triggerRename,
        showProperties,
        openIconPicker,
        iconFor,
    };
})();
