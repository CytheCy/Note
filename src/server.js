/**
 * server.js — Express REST API + static file host.
 *
 * Endpoints (all JSON):
 *   GET    /api/tree                       → full subtree under root
 *   GET    /api/tree/:parentId             → children of a parent
 *   GET    /api/notes/:noteId              → one note (+ its parents)
 *   POST   /api/notes                      { parentId, title?, type?, content? } → new note
 *   PUT    /api/notes/:noteId              { title?, content?, type? }
 *   DELETE /api/notes/relation/:relationId → detach (soft-delete) a clone
 *
 *   POST   /api/tree/move                  { relationId, newParentId, sortOrder? }
 *   POST   /api/tree/reorder               { parentId, relationIds:[] }
 *   POST   /api/tree/expand                { relationId, isExpanded }
 *   POST   /api/tree/clone                 { noteId, newParentId }
 *
 *   GET    /api/search?q=...
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const { Notes, Tree, Notebooks, ROOT_ID, getDbPath, getDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Serve the frontend (index.html + assets).
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
//  Tree
// ---------------------------------------------------------------------------
app.get('/api/tree', (_req, res) => {
    res.json({ noteId: ROOT_ID, children: Tree.subtree(ROOT_ID) });
});

app.get('/api/tree/:parentId', (req, res) => {
    res.json(Tree.children(req.params.parentId));
});

app.post('/api/tree/move', (req, res) => {
    try {
        const { relationId, newParentId, sortOrder } = req.body;
        res.json(Tree.move(relationId, newParentId, sortOrder));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/tree/reorder', (req, res) => {
    const { parentId, relationIds } = req.body;
    Tree.reorder(parentId, relationIds);
    res.json({ ok: true });
});

app.post('/api/tree/expand', (req, res) => {
    Tree.setExpanded(req.body.relationId, req.body.isExpanded);
    res.json({ ok: true });
});

app.post('/api/tree/clone', (req, res) => {
    try {
        res.json({ relationId: Tree.clone(req.body.noteId, req.body.newParentId) });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
//  Notes
// ---------------------------------------------------------------------------
app.get('/api/notes/:noteId', (req, res) => {
    const note = Notes.get(req.params.noteId);
    if (!note || note.isDeleted) return res.status(404).json({ error: 'not found' });
    note.parents = db_parents(note.noteId);
    res.json(note);
});

// Parents of a note (the clones' parent rows). Inline to avoid exposing raw stmts.
function db_parents(noteId) {
    return getDb().prepare(`
        SELECT r.relationId, r.parentId, p.title
        FROM note_relations r JOIN notes p ON p.noteId = r.parentId
        WHERE r.noteId = ? AND r.isDeleted = 0`).all(noteId);
}

function openFolderInSystemExplorer(notebookPath) {
    if (!notebookPath || typeof notebookPath !== 'string') {
        throw new Error('notebook path is required');
    }
    const folder = fs.statSync(notebookPath).isDirectory()
        ? notebookPath
        : path.dirname(notebookPath);
    if (!fs.existsSync(folder)) throw new Error('notebook folder not found');

    const command = process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
            ? 'explorer.exe'
            : 'xdg-open';
    const child = spawn(command, [folder], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
}

// ---------------------------------------------------------------------------
//  Notebooks
// ---------------------------------------------------------------------------
app.get('/api/notebooks', (_req, res) => {
    res.json(Notebooks.list());
});

app.put('/api/notebooks/current', (req, res) => {
    try {
        res.json(Notebooks.update(req.body || {}));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/notebooks/open', (req, res) => {
    try {
        res.json(Notebooks.open(req.body?.path));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/notebooks/create', (req, res) => {
    try {
        res.status(201).json(Notebooks.create(req.body?.path, req.body?.name, req.body?.icon));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/notebooks/switch', (req, res) => {
    try {
        res.json(Notebooks.open(req.body?.path));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/notebooks/close', (req, res) => {
    try {
        res.json(Notebooks.close(req.body?.path));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/notebooks/current/open-folder', (_req, res) => {
    try {
        openFolderInSystemExplorer(Notebooks.current().path);
        res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/notes', (req, res) => {
    try {
        const n = Notes.create(req.body || {});
        res.status(201).json(n);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/notes/:noteId', (req, res) => {
    try {
        const n = Notes.update(req.params.noteId, req.body || {});
        if (!n) return res.status(404).json({ error: 'not found' });
        res.json(n);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/notes/relation/:relationId', (req, res) => {
    try {
        const ok = Notes.removeRelation(req.params.relationId);
        if (!ok) return res.status(404).json({ error: 'relation not found' });
        res.json({ ok: true });
    } catch (e) {
        console.error('[delete relation]', e);
        res.status(500).json({ error: 'internal server error' });
    }
});

// ---------------------------------------------------------------------------
//  Search
// ---------------------------------------------------------------------------
app.get('/api/search', (req, res) => {
    res.json(Notes.search(req.query.q || ''));
});

// ---------------------------------------------------------------------------
//  SPA fallback
// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(idx)) return res.sendFile(idx);
    next();
});

const PORT = process.env.PORT || 3777;
app.listen(PORT, () => {
    console.log(`[Note] serving on http://localhost:${PORT}`);
    console.log(`  DB: ${getDbPath()}`);
});
