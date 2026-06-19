/**
 * api.js — tiny fetch() wrapper around the REST API.
 * Every method returns a Promise that resolves to parsed JSON.
 */
const Api = {
    base: '/api',

    async _req(method, path, body) {
        const opts = { method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(this.base + path, opts);
        if (!res.ok) {
            let msg = `${res.status} ${res.statusText}`;
            try { msg += ' — ' + (await res.json()).error; } catch (_) {}
            throw new Error(msg);
        }
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
    },

    // tree
    getTree:          ()        => Api._req('GET',    '/tree'),
    moveNode:         (b)       => Api._req('POST',   '/tree/move',   b),
    reorderSiblings:  (b)       => Api._req('POST',   '/tree/reorder', b),
    setExpanded:      (b)       => Api._req('POST',   '/tree/expand', b),
    clone:            (b)       => Api._req('POST',   '/tree/clone',  b),

    // notes
    getNote:      (id)         => Api._req('GET',    `/notes/${id}`),
    createNote:   (b)          => Api._req('POST',   '/notes',        b),
    updateNote:   (id, b)      => Api._req('PUT',    `/notes/${id}`,  b),
    deleteRelation:(rid)       => Api._req('DELETE', `/notes/relation/${rid}`),

    // attributes
    getAttributes:(id)         => Api._req('GET',    `/notes/${id}/attributes`),
    addAttribute: (id, b)      => Api._req('POST',   `/notes/${id}/attributes`, b),
    updateAttribute:(aid, b)   => Api._req('PUT',    `/attributes/${aid}`, b),
    deleteAttribute:(aid)      => Api._req('DELETE', `/attributes/${aid}`),

    // search
    search:       (q)          => Api._req('GET',    `/search?q=${encodeURIComponent(q)}`),
};
