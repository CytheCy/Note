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

    // ---- Trilium-style icon mapping ----------------------------------------
    // Default icon + per-type override + per-attribute override.
    const NOTE_TYPE_ICON = {
        text:   'bx bx-file',
        code:   'bx bx-code-alt',
        todo:   'bx bx-check-square',
        search: 'bx bx-search',
    };
    const FOLDER_OPEN   = 'bx bx-folder-open';
    const FOLDER_CLOSED = 'bx bx-folder';

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
        if (node.attributes) {
            // allow iconClass label to override (Trilium behaviour)
            const ic = node.attributes.find(a => a.name === 'iconClass' && a.type === 'label');
            if (ic && ic.value) return ic.value;
        }
        if (isFolder(node)) {
            return node.isExpanded ? FOLDER_OPEN : FOLDER_CLOSED;
        }
        return NOTE_TYPE_ICON[node.type] || 'bx bx-file';
    }

    function isClone(node) {
        // We can't know clone count from the subtree alone reliably, so we
        // surface it via the badge when provided.
        return node.cloneCount && node.cloneCount > 1;
    }

    // ---- recursive render --------------------------------------------------
    function renderNode(node, depth) {
        const wrap = document.createElement('div');
        wrap.className = 'tree-node';
        wrap.dataset.relationId = node.relationId;
        wrap.dataset.noteId = node.noteId;
        wrap.dataset.parentId = node.parentId || '';

        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (depth * 16 + 4) + 'px';   // deep-nesting indent
        row.dataset.relationId = node.relationId;
        row.dataset.noteId = node.noteId;

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
            node.children.forEach(child => childWrap.appendChild(renderNode(child, depth + 1)));
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
        document.querySelectorAll('.drop-inside,.drop-before,.drop-after')
            .forEach(el => el.classList.remove('drop-inside', 'drop-before', 'drop-after'));
        dragSource = null;
    }

    function onDragOver(e) {
        if (!dragSource) return;
        // Don't allow dropping onto yourself.
        if (this.dataset.relationId === dragSource.relationId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        // Decide intent by cursor position within the row.
        const rect = this.getBoundingClientRect();
        const offset = e.clientY - rect.top;
        const h = rect.height;
        this.classList.remove('drop-inside', 'drop-before', 'drop-after');
        if (offset < h * 0.25)              this.classList.add('drop-before');
        else if (offset > h * 0.75)         this.classList.add('drop-after');
        else                                this.classList.add('drop-inside');
    }

    function onDragLeave() {
        this.classList.remove('drop-inside', 'drop-before', 'drop-after');
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
            } else {
                // → reorder as sibling of target
                const targetRow = this;
                const parentId  = targetRow.parentElement.parentElement.dataset.noteId || 'root';
                const siblingRows = [...targetRow.parentElement.querySelectorAll(':scope > .tree-node > .tree-row')];
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

    // close context menu on any outside click / Escape
    document.addEventListener('click', closeContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });

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
            ['dateCreated',  full.dateCreated],
            ['dateModified', full.dateModified],
            ['parents',      (full.parents || []).map(p => p.title).join(', ') || '(root)'],
            ['attributes',   (full.attributes || []).length],
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
            const parentRow = document.querySelector(`.tree-row[data-noteId="${parentId}"]`);
            if (parentRow) {
                const nodeEl = parentRow.parentElement;
                const relId = parentRow.dataset.relationId;
                await Api.setExpanded({ relationId: relId, isExpanded: true });
            }
            await TreeView.reload();
            // select the new note
            const newRow = document.querySelector(`.tree-row[data-noteId="${note.noteId}"]`);
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
        iconFor,
    };
})();
