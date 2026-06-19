-- ============================================================================
--  Trilium-Style Notes — SQLite schema
--  Mirrors Trilium's relational model:
--   * notes          → content & metadata (one logical note = one row)
--   * note_relations → the TREE (many-to-many: enables CLONING — one note
--                      can live under multiple parents)
--   * attributes     → Trilium labels (key=value) and relations (value=noteId)
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
    type          TEXT    NOT NULL DEFAULT 'text'     -- text | code | todo | search
                    CHECK (type IN ('text','code','todo','search')),
    dateCreated   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    dateModified  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    isProtected   INTEGER NOT NULL DEFAULT 0,         -- placeholder for future E2EE
    isDeleted     INTEGER NOT NULL DEFAULT 0          -- soft delete (Trilium-style)
);

-- Full-text-ish convenience index for the search note type.
CREATE INDEX IF NOT EXISTS idx_notes_title        ON notes (title);
CREATE INDEX IF NOT EXISTS idx_notes_type         ON notes (type);
CREATE INDEX IF NOT EXISTS idx_notes_isDeleted    ON notes (isDeleted);

-- Keep dateModified fresh whenever content/title/type change.
CREATE TRIGGER IF NOT EXISTS trg_notes_touch
    AFTER UPDATE OF title, content, type ON notes
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
--  attributes — Trilium labels & relations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attributes (
    attributeId   TEXT    PRIMARY KEY,
    noteId        TEXT    NOT NULL REFERENCES notes(noteId) ON DELETE CASCADE,
    type          TEXT    NOT NULL CHECK (type IN ('label','relation')),
    name          TEXT    NOT NULL,                 -- e.g. "color", "inbox"
    value         TEXT    NOT NULL DEFAULT '',      -- for relations: target noteId
    position      INTEGER NOT NULL DEFAULT 0,
    isInheritable INTEGER NOT NULL DEFAULT 0,        -- propagate to children (Trilium)
    dateCreated   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    isDeleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_attr_note        ON attributes (noteId);
CREATE INDEX IF NOT EXISTS idx_attr_name_value  ON attributes (name, value);

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
