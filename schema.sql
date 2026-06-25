-- ============================================================================
--  Trilium-Style Notes — SQLite schema
--  Mirrors Trilium's relational model:
--   * notes          → content & metadata (one logical note = one row)
--   * note_relations → the TREE (many-to-many: enables CLONING — one note
--                      can live under multiple parents)
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;        -- better concurrency for desktop use
PRAGMA synchronous = NORMAL;

-- ---------------------------------------------------------------------------
--  notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
    noteId        TEXT    PRIMARY KEY,                -- ULID-ish client id
    title         TEXT    NOT NULL DEFAULT 'Untitled',
    content       TEXT    NOT NULL DEFAULT '',
    type          TEXT    NOT NULL DEFAULT 'text'     -- text
                    CHECK (type IN ('text')),
    icon          TEXT    DEFAULT NULL,
    dateCreated   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    dateModified  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    isProtected   INTEGER NOT NULL DEFAULT 0,         -- placeholder for future E2EE
    isDeleted     INTEGER NOT NULL DEFAULT 0          -- soft delete (Trilium-style)
);

-- Indexes that back the global search box (title/content LIKE).
CREATE INDEX IF NOT EXISTS idx_notes_title        ON notes (title);
CREATE INDEX IF NOT EXISTS idx_notes_type         ON notes (type);
CREATE INDEX IF NOT EXISTS idx_notes_isDeleted    ON notes (isDeleted);

-- Keep dateModified fresh whenever content/title/type/icon change.
CREATE TRIGGER IF NOT EXISTS trg_notes_touch
    AFTER UPDATE OF title, content, type, icon ON notes
    FOR EACH ROW
    WHEN NEW.dateModified = OLD.dateModified
BEGIN
    UPDATE notes SET dateModified = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE noteId = NEW.noteId;
END;

-- ---------------------------------------------------------------------------
--  note_relations  — the hierarchy (parent → child), supports cloning
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_relations (
    relationId    TEXT    PRIMARY KEY,
    parentId      TEXT    REFERENCES notes(noteId) ON DELETE CASCADE,
    noteId        TEXT    REFERENCES notes(noteId) ON DELETE CASCADE,
    sortOrder     REAL    NOT NULL DEFAULT 0,       -- REAL so inserts can go between
    isExpanded    INTEGER NOT NULL DEFAULT 0,        -- UI expansion state per clone
    prefix        TEXT    DEFAULT NULL,             -- Trilium: per-clone title prefix
    isDeleted     INTEGER NOT NULL DEFAULT 0
);

-- Fast "children of X" lookup ordered by sortOrder.
CREATE INDEX IF NOT EXISTS idx_rel_parent_sort
    ON note_relations (parentId, sortOrder, noteId);
CREATE INDEX IF NOT EXISTS idx_rel_note            ON note_relations (noteId);

-- ---------------------------------------------------------------------------
--  Root note
--  Trilium has a single invisible root ("root"); "none" is the top-level container.
--  We mirror that: a 'root' note + a user-visible 'root' (the document root).
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO notes (noteId, title, content, type)
VALUES ('root', '__root__', '', 'text');

-- ---------------------------------------------------------------------------
--  Schema version (simple migration marker)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
