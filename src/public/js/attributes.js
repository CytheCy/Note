/**
 * attributes.js — Trilium-style attribute panel.
 *
 * Renders the labels/relations of the currently-selected note as removable
 * chips, plus an "Add" flow that lets the user type "name=value" (or just
 * "name" for a valueless label, Trilium's convention).
 */

const AttributesPanel = (() => {
    const elList = document.getElementById('attributesList');
    const elAdd  = document.getElementById('addAttrBtn');
    let currentNoteId = null;

    function setNote(noteId) {
        currentNoteId = noteId;
        elAdd.disabled = !noteId;
        render();
    }

    async function render() {
        if (!currentNoteId) { elList.innerHTML = ''; return; }
        let attrs = [];
        try { attrs = await Api.getAttributes(currentNoteId); }
        catch (e) { elList.innerHTML = `<span style="color:#d33">load failed</span>`; return; }

        if (attrs.length === 0) {
            elList.innerHTML = `<span class="attr-empty" style="color:var(--text-muted);font-size:12px">none</span>`;
            return;
        }
        elList.innerHTML = '';
        attrs.forEach(attr => {
            const chip = document.createElement('span');
            chip.className = 'attr-chip' + (attr.type === 'relation' ? ' relation' : '');
            chip.title = `${attr.type}: ${attr.name} = ${attr.value || '(empty)'}`;

            const name = document.createElement('span');
            name.className = 'attr-name';
            name.textContent = attr.name;

            chip.appendChild(name);

            if (attr.value) {
                const val = document.createElement('span');
                val.className = 'attr-value';
                val.textContent = '=' + attr.value;
                chip.appendChild(val);
            }

            const x = document.createElement('span');
            x.className = 'attr-x';
            x.innerHTML = '<i class="bx bx-x"></i>';
            x.addEventListener('click', async (e) => {
                e.stopPropagation();
                await Api.deleteAttribute(attr.attributeId);
                render();
            });
            chip.appendChild(x);

            // click to edit inline
            chip.addEventListener('click', () => editInline(chip, attr));
            elList.appendChild(chip);
        });
    }

    function editInline(chip, attr) {
        const input = document.createElement('input');
        input.type = 'text';
        const typeChar = attr.type === 'relation' ? '~' : '#';
        input.value = `${typeChar}${attr.name}${attr.value ? '=' + attr.value : ''}`;
        input.style.cssText = 'font-size:12px;padding:2px 6px;border:1px solid var(--accent);border-radius:10px;width:180px;';
        chip.replaceWith(input);
        input.focus(); input.select();

        const commit = async () => {
            const parsed = parseAttrString(input.value);
            if (!parsed) { render(); return; }
            await Api.updateAttribute(attr.attributeId, parsed);
            render();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') render();
            e.stopPropagation();
        });
    }

    /**
     * Parse the Trilium-ish attribute syntax:
     *   #name          → label, no value
     *   #name=value    → label
     *   ~name=noteId   → relation
     * Falls back to "label" if no prefix.
     */
    function parseAttrString(raw) {
        const s = (raw || '').trim();
        if (!s) return null;
        let type = 'label';
        if (s[0] === '#') type = 'label';
        else if (s[0] === '~') type = 'relation';
        const body = s.replace(/^[#~]/, '');
        const eq = body.indexOf('=');
        if (eq === -1) return { type, name: body, value: '' };
        return { type, name: body.slice(0, eq).trim(), value: body.slice(eq + 1).trim() };
    }

    function startAdd() {
        if (!currentNoteId) return;
        const chip = document.createElement('span');
        chip.className = 'attr-chip';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '#label=value   (or ~rel=noteId)';
        input.style.cssText = 'font-size:12px;padding:2px 6px;border:1px solid var(--accent);border-radius:10px;width:200px;';
        chip.appendChild(input);
        elList.appendChild(chip);
        input.focus();

        const commit = async () => {
            const parsed = parseAttrString(input.value);
            if (!parsed) { render(); return; }
            try {
                await Api.addAttribute(currentNoteId, parsed);
            } catch (e) { alert(e.message); }
            render();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') render();
            e.stopPropagation();
        });
    }

    elAdd.addEventListener('click', startAdd);

    return { setNote, render };
})();
