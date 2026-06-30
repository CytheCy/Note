/**
 * db.js — SQLite data layer for Note.
 *
 * Responsibilities:
 *   - open / migrate the database
 *   - generate ids (ULID-ish)
 *   - CRUD for notes, note_relations (the tree)
 *   - recursive hierarchy fetch (children of a parent, ordered, with clone counts)
 *   - small CLI:  `node src/db.js --init | --seed | --status`
 *
 * Design notes:
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
const DEFAULT_DB_PATH = process.env.NOTE_DB_PATH
    ? path.resolve(process.env.NOTE_DB_PATH)
    : path.join(DATA_DIR, 'document.db');
const NOTEBOOKS_CONFIG_PATH = path.join(DATA_DIR, 'notebooks.json');
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

function normalizeIcon(icon) {
    if (icon == null || icon === '') return null;
    if (typeof icon !== 'string') throw new Error('invalid icon');
    const value = icon.trim();
    if (/^bx (bx|bxs|bxl)-[a-z0-9-]+$/.test(value)) return value;
    if (/^(bx|bxs|bxl)-[a-z0-9-]+$/.test(value)) return `bx ${value}`;
    throw new Error('invalid icon');
}

// ---------------------------------------------------------------------------
//  Open / migrate
// ---------------------------------------------------------------------------
function openDb(dbPath = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    return db;
}

function notebookNameFromPath(dbPath) {
    const base = path.basename(dbPath, path.extname(dbPath));
    return base
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim() || 'Notebook';
}

function sanitizeNotebookPath(dbPath) {
    if (!dbPath || typeof dbPath !== 'string') throw new Error('notebook path is required');
    const resolved = path.resolve(dbPath);
    const ext = path.extname(resolved).toLowerCase();
    if (ext && ext !== '.db' && ext !== '.sqlite' && ext !== '.sqlite3') {
        throw new Error('notebook file must use .db, .sqlite, or .sqlite3');
    }
    return resolved;
}

function readNotebookConfig() {
    if (process.env.NOTE_DB_PATH) {
        return {
            currentPath: DEFAULT_DB_PATH,
            opened: [{ path: DEFAULT_DB_PATH, name: notebookNameFromPath(DEFAULT_DB_PATH), icon: null }],
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(NOTEBOOKS_CONFIG_PATH, 'utf8'));
        return {
            currentPath: parsed.currentPath || DEFAULT_DB_PATH,
            opened: Array.isArray(parsed.opened) ? parsed.opened : [],
        };
    } catch (_) {
        return { currentPath: DEFAULT_DB_PATH, opened: [] };
    }
}

function writeNotebookConfig(config) {
    if (process.env.NOTE_DB_PATH) return;
    fs.mkdirSync(path.dirname(NOTEBOOKS_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(NOTEBOOKS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function normalizeOpened(opened) {
    const seen = new Set();
    return opened
        .filter(item => item && item.path)
        .map(item => ({
            path: path.resolve(item.path),
            name: item.name || notebookNameFromPath(item.path),
            icon: item.icon || null,
            lastOpened: item.lastOpened || null,
        }))
        .filter(item => {
            if (seen.has(item.path)) return false;
            seen.add(item.path);
            return true;
        });
}

function upsertOpenedNotebook(dbPath, meta = {}) {
    const currentMeta = typeof meta === 'string' ? { name: meta } : meta;
    const fileMeta = getNotebookMetaFromFile(dbPath);
    const config = readNotebookConfig();
    const opened = normalizeOpened(config.opened).filter(item => item.path !== dbPath);
    opened.unshift({
        path: dbPath,
        name: currentMeta.name || fileMeta.name,
        icon: currentMeta.icon === undefined ? fileMeta.icon : currentMeta.icon,
        lastOpened: new Date().toISOString(),
    });
    const next = { currentPath: dbPath, opened };
    writeNotebookConfig(next);
    return next;
}

function applySchema(db, dbPath = DEFAULT_DB_PATH) {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(sql);
    const noteCols = new Set(db.prepare('PRAGMA table_info(notes)').all().map(c => c.name));
    if (!noteCols.has('icon')) db.exec('ALTER TABLE notes ADD COLUMN icon TEXT DEFAULT NULL');
    db.exec(`
        DROP TRIGGER IF EXISTS trg_notes_touch;
        CREATE TRIGGER trg_notes_touch
            AFTER UPDATE OF title, content, type, icon ON notes
            FOR EACH ROW
            WHEN NEW.dateModified = OLD.dateModified
        BEGIN
            UPDATE notes SET dateModified = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE noteId = NEW.noteId;
        END;
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS notebook_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
    db.prepare(`
        INSERT OR IGNORE INTO notebook_meta (key, value)
        VALUES ('name', ?)`).run(notebookNameFromPath(dbPath));
    db.prepare(`
        INSERT OR IGNORE INTO notebook_meta (key, value)
        VALUES ('icon', '')`).run();

    // Repair notes orphaned by older failed delete attempts.
    db.prepare(`
        UPDATE notes
        SET isDeleted = 1
        WHERE noteId <> @rootId
          AND isDeleted = 0
          AND NOT EXISTS (
              SELECT 1
              FROM note_relations r
              WHERE r.noteId = notes.noteId
                AND r.isDeleted = 0
          )`).run({ rootId: ROOT_ID });
}

function getNotebookMetaFromFile(dbPath) {
    try {
        const temp = openDb(dbPath);
        applySchema(temp, dbPath);
        const rows = temp.prepare("SELECT key, value FROM notebook_meta WHERE key IN ('name', 'icon')").all();
        temp.close();
        const meta = Object.fromEntries(rows.map(row => [row.key, row.value]));
        return {
            name: meta.name || notebookNameFromPath(dbPath),
            icon: meta.icon || null,
        };
    } catch (_) {
        return {
            name: notebookNameFromPath(dbPath),
            icon: null,
        };
    }
}

// ---------------------------------------------------------------------------
//  Prepared statements (created once, reused — much faster than re-preparing)
// ---------------------------------------------------------------------------
function createStatements(db) {
    return {
        noteGet: db.prepare('SELECT * FROM notes WHERE noteId = ?'),
        noteInsert: db.prepare(`
            INSERT INTO notes (noteId, title, content, type, icon)
            VALUES (@noteId, @title, @content, @type, @icon)`),
        noteUpdate: db.prepare(`
            UPDATE notes SET title = @title, content = @content, type = @type, icon = @icon
            WHERE noteId = @noteId`),
        noteSoftDelete: db.prepare(`
            UPDATE notes SET isDeleted = 1 WHERE noteId = @noteId`),
        noteSearch: db.prepare(`
            SELECT noteId, title, type, icon, dateModified FROM notes
            WHERE isDeleted = 0 AND (title LIKE @q OR content LIKE @q)
            ORDER BY dateModified DESC LIMIT 100`),

        // tree
        relChildren: db.prepare(`
            SELECT r.relationId, r.noteId, r.sortOrder, r.isExpanded, r.prefix,
                   n.title, n.type, n.icon, n.isDeleted,
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
        notebookNameGet: db.prepare("SELECT value FROM notebook_meta WHERE key = 'name'"),
        notebookNameSet: db.prepare(`
            INSERT INTO notebook_meta (key, value)
            VALUES ('name', @name)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
        notebookIconGet: db.prepare("SELECT value FROM notebook_meta WHERE key = 'icon'"),
        notebookIconSet: db.prepare(`
            INSERT INTO notebook_meta (key, value)
            VALUES ('icon', @icon)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
    };
}

function createConnection(dbPath) {
    const resolved = sanitizeNotebookPath(dbPath);
    const db = openDb(resolved);
    applySchema(db, resolved);
    return {
        db,
        dbPath: resolved,
        stmts: createStatements(db),
    };
}

const initialConfig = readNotebookConfig();
let state = createConnection(initialConfig.currentPath || DEFAULT_DB_PATH);
upsertOpenedNotebook(state.dbPath, {
    name: getStmts().notebookNameGet.get()?.value || notebookNameFromPath(state.dbPath),
    icon: getStmts().notebookIconGet.get()?.value || null,
});

function getDb() {
    return state.db;
}

function getDbPath() {
    return state.dbPath;
}

function getStmts() {
    return state.stmts;
}

function removeRelationTx(relationId) {
    const db = getDb();
    const stmts = getStmts();
    return db.transaction((id) => {
        const rel = stmts.relGet.get(id);
        if (!rel || rel.isDeleted) return false;

        stmts.relDelete.run(id);

        const otherParents = stmts.relParents.all(rel.noteId);
        if (otherParents.length === 0) {
            stmts.noteSoftDelete.run({ noteId: rel.noteId });
        }

        return true;
    })(relationId);
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------
const Notes = {
    ROOT_ID,

    get(noteId) {
        return getStmts().noteGet.get(noteId);
    },

    create({ title = 'Untitled', content = '', type = 'text', icon = null, parentId = ROOT_ID } = {}) {
        const db = getDb();
        const stmts = getStmts();
        const noteId = newId();
        const iconClass = normalizeIcon(icon);
        const tx = db.transaction((opts) => {
            stmts.noteInsert.run({
                noteId, title: opts.title, content: opts.content, type: opts.type, icon: iconClass,
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

    update(noteId, { title, content, type, icon }) {
        const stmts = getStmts();
        const current = this.get(noteId);
        if (!current) return null;
        stmts.noteUpdate.run({
            noteId,
            title: title ?? current.title,
            content: content ?? current.content,
            type: type ?? current.type,
            icon: icon === undefined ? current.icon : normalizeIcon(icon),
        });
        return this.get(noteId);
    },

    /**
     * Soft-delete a note. If it has no other parents (no clones left), the
     * note row itself is flagged deleted; otherwise only the relation is.
     */
    removeRelation(relationId) {
        return removeRelationTx(relationId);
    },

    /** Search by title/content — backs the global search box. */
    search(query) {
        if (!query?.trim()) return [];
        return getStmts().noteSearch.all({ q: `%${query}%` });
    },
};

const Tree = {
    /** Direct children of parentId, ordered, with childCount for the caret. */
    children(parentId) {
        return getStmts().relChildren.all(parentId);
    },

    /**
     * Recursive subtree. Returns a nested object:
     *   { noteId, title, type, relationId, prefix, childCount, children: [...] }
     * Guarded against cycles (cloning can create them).
     */
    subtree(parentId, { maxDepth = 32 } = {}) {
        const build = (pid, depth, seen) => {
            if (depth > maxDepth) return [];
            return getStmts().relChildren.all(pid).map((row) => {
                const node = {
                    relationId: row.relationId,
                    noteId: row.noteId,
                    title: row.prefix ? `${row.prefix} - ${row.title}` : row.title,
                    rawTitle: row.title,
                    type: row.type,
                    icon: row.icon,
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
        const db = getDb();
        const stmts = getStmts();
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
        const db = getDb();
        const stmts = getStmts();
        const tx = db.transaction(() => {
            relationIds.forEach((rid, i) => {
                stmts.relUpdateOrder.run(i, rid);
            });
        });
        tx();
    },

    setExpanded(relationId, isExpanded) {
        getStmts().relSetExpanded.run(isExpanded ? 1 : 0, relationId);
    },

    /** Clone: create a second relation pointing at the same note under newParentId. */
    clone(noteId, newParentId) {
        const stmts = getStmts();
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
            for (const c of getStmts().relChildren.all(cur)) stack.push(c.noteId);
        }
        return false;
    },
};

const Notebooks = {
    current() {
        const nameRow = getStmts().notebookNameGet.get();
        const iconRow = getStmts().notebookIconGet.get();
        const pathValue = getDbPath();
        return {
            path: pathValue,
            name: nameRow?.value || notebookNameFromPath(pathValue),
            icon: iconRow?.value || null,
        };
    },

    list() {
        const current = this.current();
        const config = readNotebookConfig();
        const opened = normalizeOpened(config.opened);
        if (!opened.some(item => item.path === current.path)) {
            opened.unshift({ path: current.path, name: current.name, lastOpened: new Date().toISOString() });
        }
        return {
            current,
            opened: opened.map(item => ({
                ...item,
                current: item.path === current.path,
                name: item.path === current.path ? current.name : item.name,
                icon: item.path === current.path ? current.icon : item.icon,
            })),
        };
    },

    update({ name, icon } = {}) {
        const current = this.current();
        const cleanName = name === undefined ? current.name : String(name || '').trim();
        if (!cleanName) throw new Error('notebook name is required');
        const cleanIcon = icon === undefined ? current.icon : normalizeIcon(icon);
        getStmts().notebookNameSet.run({ name: cleanName });
        getStmts().notebookIconSet.run({ icon: cleanIcon || '' });
        upsertOpenedNotebook(getDbPath(), { name: cleanName, icon: cleanIcon });
        return this.current();
    },

    rename(name) {
        return this.update({ name });
    },

    open(dbPath, { create = false, name = null, icon = undefined } = {}) {
        const resolved = sanitizeNotebookPath(dbPath);
        if (!create && !fs.existsSync(resolved)) throw new Error('notebook file not found');
        const next = createConnection(resolved);
        const previous = state;
        state = next;
        try { previous.db.close(); } catch (_) {}
        if (name || icon !== undefined) this.update({ name: name || undefined, icon });
        upsertOpenedNotebook(state.dbPath, this.current());
        return this.current();
    },

    create(dbPath, name = null, icon = undefined) {
        const resolved = sanitizeNotebookPath(dbPath);
        if (fs.existsSync(resolved)) throw new Error('notebook file already exists');
        return this.open(resolved, { create: true, name, icon });
    },
};

// ---------------------------------------------------------------------------
//  Seed data (called from CLI `npm run seed`)
// ---------------------------------------------------------------------------
function seed() {
    const db = getDb();
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
    const inst = mk('Installation', 'text', docs,
        '# Installation\n\n```bash\nnpm install\nnpm run init-db\nnpm start\n```');
    const tips = mk('Tips & Tricks', 'text', docs);
    const code1 = mk('Snippets', 'text', ROOT_ID,
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
        const counts = getDb().prepare(`
            SELECT
              (SELECT COUNT(*) FROM notes WHERE isDeleted=0)         AS notes,
              (SELECT COUNT(*) FROM note_relations WHERE isDeleted=0) AS relations
        `).get();
        console.log('[status]', counts);
    } else if (arg === '--init') {
        applySchema(getDb(), getDbPath());
        console.log('[init] schema applied at', getDbPath());
    } else {
        console.log('Usage: node src/db.js --init | --seed | --status');
    }
}

module.exports = {
    db: getDb(),
    getDb,
    Notes,
    Tree,
    Notebooks,
    newId,
    ROOT_ID,
    DB_PATH: getDbPath(),
    getDbPath,
};
