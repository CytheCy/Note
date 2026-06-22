/**
 * db.js — SQLite data layer for Trilium-Style Notes.
 *
 * Responsibilities:
 *   - open / migrate the database
 *   - generate ids (ULID-ish)
 *   - CRUD for notes, note_relations (the tree)
 *   - recursive hierarchy fetch (children of a parent, ordered, with clone counts)
 *   - small CLI:  `node src/db.js --init | --seed | --status`
 *
 * Design notes (Trilium-faithful):
 *   - The "tree" is the note_relations table. One note may have many parents
 *     (cloning) — each parent/child pair is its own row with its own sortOrder.
 *   - Everything is soft-deleted (isDeleted flag) so undo/restore is possible.
 *   - All writes go through prepared statements; better-sqlite3 is synchronous
 *     which keeps the API simple and fast for a desktop app.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// better-sqlite3 ships as native code; require lazily so the CLI gives a
// friendly error if it isn't built yet. It exports the constructor as the
// default module.exports.
let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    console.error('[db] better-sqlite3 is not installed/built. Run `npm install`.');
    throw e;
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'document.db');
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

// Crockford base32 — same alphabet as ULID, sorted, unambiguous (no I/L/O/U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ROOT_ID = 'root';

// ---------------------------------------------------------------------------
//  ID generation — 26-char time-sortable id (ULID-like, good enough for local)
// ---------------------------------------------------------------------------
function newId(prefix = '') {
    const ts = Date.now();
    const timeChars = [];
    let t = ts;
    for (let i = 0; i < 10; i++) {
        timeChars.push(CROCKFORD[t % 32]);
        t = Math.floor(t / 32);
    }
    timeChars.reverse();
    const rand = crypto.randomBytes(10);
    let randInt = 0n;
    for (const b of rand) randInt = (randInt << 8n) | BigInt(b);
    const randChars = [];
    for (let i = 0; i < 16; i++) {
        randChars.push(CROCKFORD[Number(randInt % 32n)]);
        randInt /= 32n;
    }
    return prefix + [...timeChars, ...randChars].join('');
}

// ---------------------------------------------------------------------------
//  Open / migrate
// ---------------------------------------------------------------------------
function openDb(dbPath = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    return db;
}

function applySchema(db) {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(sql);
}

// One shared connection for the app (better-sqlite3 is sync → single conn is fine).
const db = openDb();
applySchema(db);

// ---------------------------------------------------------------------------
//  Prepared statements (created once, reused — much faster than re-preparing)
// ---------------------------------------------------------------------------
const stmts = {
    noteGet: db.prepare('SELECT * FROM notes WHERE noteId = ?'),
    noteInsert: db.prepare(`
        INSERT INTO notes (noteId, title, content, type)
        VALUES (@noteId, @title, @content, @type)`),
    noteUpdate: db.prepare(`
        UPDATE notes SET title = @title, content = @content, type = @type
        WHERE noteId = @noteId`),
    noteTouch: db.prepare(`
        UPDATE notes SET dateModified = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE noteId = @noteId`),
    noteSoftDelete: db.prepare(`
        UPDATE notes SET isDeleted = 1 WHERE noteId = @noteId`),
    noteSearch: db.prepare(`
        SELECT noteId, title, type, dateModified FROM notes
        WHERE isDeleted = 0 AND (title LIKE @q OR content LIKE @q)
        ORDER BY dateModified DESC LIMIT 100`),

    // tree
    relChildren: db.prepare(`
        SELECT r.relationId, r.noteId, r.sortOrder, r.isExpanded, r.prefix,
               n.title, n.type, n.isDeleted,
               (SELECT COUNT(*) FROM note_relations c
                  WHERE c.parentId = r.noteId AND c.isDeleted = 0) AS childCount
        FROM note_relations r
        JOIN notes n ON n.noteId = r.noteId
        WHERE r.parentId = ? AND r.isDeleted = 0
        ORDER BY r.sortOrder, r.relationId`),
    relParents: db.prepare(`
        SELECT parentId FROM note_relations
        WHERE noteId = ? AND isDeleted = 0`),
    relInsert: db.prepare(`
        INSERT INTO note_relations (relationId, parentId, noteId, sortOrder, isExpanded, prefix)
        VALUES (@relationId, @parentId, @noteId, @sortOrder, @isExpanded, @prefix)`),
    relGet: db.prepare('SELECT * FROM note_relations WHERE relationId = ?'),
    relDelete: db.prepare('UPDATE note_relations SET isDeleted = 1 WHERE relationId = ?'),
    relUpdateOrder: db.prepare(`
        UPDATE note_relations SET sortOrder = ? WHERE relationId = ?`),
    relSetExpanded: db.prepare(`
        UPDATE note_relations SET isExpanded = ? WHERE relationId = ?`),
    relMaxSort: db.prepare(`
        SELECT COALESCE(MAX(sortOrder), 0) + 1 FROM note_relations
        WHERE parentId = ? AND isDeleted = 0`),
};

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------
const Notes = {
    ROOT_ID,

    get(noteId) {
        return stmts.noteGet.get(noteId);
    },

    create({ title = 'Untitled', content = '', type = 'text', parentId = ROOT_ID } = {}) {
        const noteId = newId();
        const tx = db.transaction((opts) => {
            stmts.noteInsert.run({
                noteId, title: opts.title, content: opts.content, type: opts.type,
            });
            // Attach to parent under last position.
            const sortOrder = stmts.relMaxSort.get(opts.parentId)['COALESCE(MAX(sortOrder), 0) + 1'];
            stmts.relInsert.run({
                relationId: newId(),
                parentId: opts.parentId,
                noteId,
                sortOrder,
                isExpanded: 0,
                prefix: null,
            });
        });
        tx({ title, content, type, parentId });
        return this.get(noteId);
    },

    update(noteId, { title, content, type }) {
        const current = this.get(noteId);
        if (!current) return null;
        stmts.noteUpdate.run({
            noteId,
            title: title ?? current.title,
            content: content ?? current.content,
            type: type ?? current.type,
        });
        return this.get(noteId);
    },

    /**
     * Soft-delete a note. If it has no other parents (no clones left), the
     * note row itself is flagged deleted; otherwise only the relation is.
     */
    removeRelation(relationId) {
        const rel = stmts.relGet.get(relationId);
        if (!rel) return false;
        stmts.relDelete.run(relationId);
        const otherParents = stmts.relParents.all(rel.noteId);
        if (otherParents.length === 0) {
            stmts.noteSoftDelete.run(rel.noteId);
        }
        return true;
    },

    /** Search by title/content — backs the global search box. */
    search(query) {
        if (!query?.trim()) return [];
        return stmts.noteSearch.all({ q: `%${query}%` });
    },
};

const Tree = {
    /** Direct children of parentId, ordered, with childCount for the caret. */
    children(parentId) {
        return stmts.relChildren.all(parentId);
    },

    /**
     * Recursive subtree. Returns a nested object:
     *   { noteId, title, type, relationId, prefix, childCount, children: [...] }
     * Guarded against cycles (cloning can create them).
     */
    subtree(parentId, { maxDepth = 32 } = {}) {
        const build = (pid, depth, seen) => {
            if (depth > maxDepth) return [];
            return stmts.relChildren.all(pid).map((row) => {
                const node = {
                    relationId: row.relationId,
                    noteId: row.noteId,
                    title: row.prefix ? `${row.prefix} - ${row.title}` : row.title,
                    rawTitle: row.title,
                    type: row.type,
                    prefix: row.prefix,
                    isExpanded: !!row.isExpanded,
                    childCount: row.childCount,
                    children: seen.has(row.noteId)
                        ? [] // cycle guard: cloning loop
                        : build(row.noteId, depth + 1, new Set(seen).add(row.noteId)),
                };
                return node;
            });
        };
        return build(parentId, 0, new Set([parentId]));
    },

    /** Move `relationId` under `newParentId` at `sortOrder` (drag-drop reorder/reparent). */
    move(relationId, newParentId, sortOrder = null) {
        const rel = stmts.relGet.get(relationId);
        if (!rel) throw new Error('relation not found');
        if (rel.noteId === newParentId) throw new Error('cannot drop a note into itself');
        // Prevent dropping onto a descendant (would create a cycle).
        if (this._isDescendant(rel.noteId, newParentId)) {
            throw new Error('cannot move a parent into its own descendant');
        }
        const order = sortOrder ?? stmts.relMaxSort.get(newParentId)['COALESCE(MAX(sortOrder), 0) + 1'];
        db.prepare(`
            UPDATE note_relations SET parentId = ?, sortOrder = ?
            WHERE relationId = ?`).run(newParentId, order, relationId);
        return stmts.relGet.get(relationId);
    },

    /** Reorder siblings by passing their relationIds in desired order. */
    reorder(parentId, relationIds) {
        const tx = db.transaction(() => {
            relationIds.forEach((rid, i) => {
                stmts.relUpdateOrder.run(i, rid);
            });
        });
        tx();
    },

    setExpanded(relationId, isExpanded) {
        stmts.relSetExpanded.run(isExpanded ? 1 : 0, relationId);
    },

    /** Clone: create a second relation pointing at the same note under newParentId. */
    clone(noteId, newParentId) {
        if (noteId === newParentId) throw new Error('cannot clone a note into itself');
        if (this._isDescendant(noteId, newParentId)) {
            throw new Error('cannot clone a parent into its own descendant');
        }
        const relationId = newId();
        const sortOrder = stmts.relMaxSort.get(newParentId)['COALESCE(MAX(sortOrder), 0) + 1'];
        stmts.relInsert.run({
            relationId, parentId: newParentId, noteId,
            sortOrder, isExpanded: 0, prefix: null,
        });
        return relationId;
    },

    /** Is `candidate` a descendant of `ancestorId`? (cycle guard) */
    _isDescendant(ancestorId, candidateNoteId) {
        const stack = [ancestorId];
        const seen = new Set();
        while (stack.length) {
            const cur = stack.pop();
            if (cur === candidateNoteId) return true;
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const c of stmts.relChildren.all(cur)) stack.push(c.noteId);
        }
        return false;
    },
};

// ---------------------------------------------------------------------------
//  Seed data (called from CLI `npm run seed`)
// ---------------------------------------------------------------------------
function seed() {
    if (db.prepare('SELECT COUNT(*) c FROM note_relations WHERE parentId = ? AND isDeleted = 0')
        .get(ROOT_ID).c > 0) {
        console.log('[seed] document already has notes; skipping.');
        return;
    }
    const mk = (title, type, parentId, content = '') => {
        const n = Notes.create({ title, type, parentId, content });
        return n.noteId;
    };
    const kb   = mk('Knowledge Base', 'text', ROOT_ID);
    const docs = mk('Documentation', 'text', kb);
    const inst = mk('Installation', 'code', docs,
        '# Installation\n\n```bash\nnpm install\nnpm run init-db\nnpm start\n```');
    const tips = mk('Tips & Tricks', 'text', docs);
    const code1 = mk('Snippets', 'code', ROOT_ID,
        '// example snippet\nconst notes = require("./db");\nnotes.Notes.list();');

    // Demonstrate CLONING: same "Snippets" note also under Documentation.
    Tree.clone(code1, docs);

    console.log('[seed] created example notes & one clone.');
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
    const arg = process.argv[2];
    if (arg === '--seed') {
        seed();
    } else if (arg === '--status') {
        const counts = db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM notes WHERE isDeleted=0)         AS notes,
              (SELECT COUNT(*) FROM note_relations WHERE isDeleted=0) AS relations
        `).get();
        console.log('[status]', counts);
    } else if (arg === '--init') {
        applySchema(db);
        console.log('[init] schema applied at', DB_PATH);
    } else {
        console.log('Usage: node src/db.js --init | --seed | --status');
    }
}

module.exports = { db, Notes, Tree, newId, ROOT_ID };
