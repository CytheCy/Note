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

function titleFromMarkdownPath(filePath) {
    return path.basename(filePath, path.extname(filePath))
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim() || 'Untitled';
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

function normalizeNotebookFolder(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') return null;
    const value = folderPath.trim();
    return value ? path.resolve(value) : null;
}

function uniqueNotebookPath(folderPath, name) {
    const safeName = (name || 'Imported Notebook')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ') || 'Imported Notebook';
    let candidate = path.join(folderPath, `${safeName}.db`);
    let index = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(folderPath, `${safeName} ${index}.db`);
        index += 1;
    }
    return candidate;
}

function safeFilenamePart(value, fallback = 'Untitled') {
    const clean = String(value || '')
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+$/, '');
    return (clean || fallback).slice(0, 96).trim() || fallback;
}

function uniqueFilesystemPath(dirPath, baseName, ext = '') {
    const safeBase = safeFilenamePart(baseName);
    let candidate = path.join(dirPath, `${safeBase}${ext}`);
    let index = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dirPath, `${safeBase} ${index}${ext}`);
        index += 1;
    }
    return candidate;
}

function uniqueExportDirectory(parentPath, notebookName, format, exportName = null) {
    const label = format === 'html' ? 'HTML' : 'Markdown';
    return uniqueFilesystemPath(parentPath, exportName || `${notebookName} ${label} Export`);
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function markdownInlineToHtml(value) {
    return escapeHtmlText(value)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let paragraph = [];
    let listType = null;
    let inCode = false;
    let code = [];

    const flushParagraph = () => {
        if (!paragraph.length) return;
        html.push(`<p>${markdownInlineToHtml(paragraph.join(' '))}</p>`);
        paragraph = [];
    };
    const closeList = () => {
        if (!listType) return;
        html.push(`</${listType}>`);
        listType = null;
    };
    const openList = (type) => {
        if (listType === type) return;
        closeList();
        listType = type;
        html.push(`<${type}>`);
    };

    for (const line of lines) {
        const fence = line.match(/^```/);
        if (fence) {
            if (inCode) {
                html.push(`<pre><code>${escapeHtmlText(code.join('\n'))}</code></pre>`);
                code = [];
                inCode = false;
            } else {
                flushParagraph();
                closeList();
                inCode = true;
            }
            continue;
        }
        if (inCode) {
            code.push(line);
            continue;
        }

        if (!line.trim()) {
            flushParagraph();
            closeList();
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            closeList();
            const level = heading[1].length;
            html.push(`<h${level}>${markdownInlineToHtml(heading[2].trim())}</h${level}>`);
            continue;
        }
        if (/^[-*_]\s*[-*_]\s*[-*_][\s\-*_]*$/.test(line.trim())) {
            flushParagraph();
            closeList();
            html.push('<hr>');
            continue;
        }
        const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
        if (unordered) {
            flushParagraph();
            openList('ul');
            html.push(`<li>${markdownInlineToHtml(unordered[1].trim())}</li>`);
            continue;
        }
        const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
        if (ordered) {
            flushParagraph();
            openList('ol');
            html.push(`<li>${markdownInlineToHtml(ordered[1].trim())}</li>`);
            continue;
        }
        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
            flushParagraph();
            closeList();
            html.push(`<blockquote>${markdownInlineToHtml(quote[1].trim())}</blockquote>`);
            continue;
        }
        paragraph.push(line.trim());
    }

    if (inCode) html.push(`<pre><code>${escapeHtmlText(code.join('\n'))}</code></pre>`);
    flushParagraph();
    closeList();
    html.push('<p><br></p>');
    return html.join('\n') || '<p><br></p>';
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function htmlInlineToMarkdown(html) {
    let value = String(html || '');
    value = value.replace(/<br\s*\/?>/gi, '\n');
    value = value.replace(/<a\b[^>]*href=["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
        (_, href, text) => `[${htmlInlineToMarkdown(text).trim()}](${decodeHtmlEntities(href)})`);
    value = value.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
        (_, _tag, text) => `**${htmlInlineToMarkdown(text).trim()}**`);
    value = value.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
        (_, _tag, text) => `*${htmlInlineToMarkdown(text).trim()}*`);
    value = value.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi,
        (_, text) => `\`${decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()}\``);
    value = value.replace(/<[^>]+>/g, '');
    return decodeHtmlEntities(value).replace(/[ \t]+/g, ' ');
}

function htmlTableToMarkdown(tableHtml) {
    const rows = [...String(tableHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map(match => [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
            .map(cell => htmlInlineToMarkdown(cell[1]).replace(/\s*\n+\s*/g, ' ').trim()))
        .filter(row => row.length);
    if (!rows.length) return '';
    const columnCount = Math.max(...rows.map(row => row.length));
    const normalize = row => Array.from({ length: columnCount }, (_, i) => row[i] || '');
    const lines = [];
    lines.push(`| ${normalize(rows[0]).join(' | ')} |`);
    lines.push(`| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`);
    rows.slice(1).forEach(row => lines.push(`| ${normalize(row).join(' | ')} |`));
    return `\n\n${lines.join('\n')}\n\n`;
}

function htmlToMarkdown(html) {
    if (!html) return '';
    const codeBlocks = [];
    let value = String(html).replace(/\r\n?/g, '\n');

    value = value.replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code) => {
        const token = `@@NOTE_EXPORT_CODE_${codeBlocks.length}@@`;
        codeBlocks.push(decodeHtmlEntities(code).replace(/\n+$/g, ''));
        return `\n\n${token}\n\n`;
    });
    value = value.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, table) => htmlTableToMarkdown(table));
    value = value.replace(/<div\b[^>]*class=["'][^"']*editor-divider-block[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '\n\n---\n\n');
    value = value.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n');
    value = value.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level, text) => `\n\n${'#'.repeat(Number(level))} ${htmlInlineToMarkdown(text).trim()}\n\n`);
    value = value.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
        (_, text) => `\n\n${htmlInlineToMarkdown(text).trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`);
    value = value.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => {
        const checked = /<input\b[^>]*checked/i.test(item) ? '[x] ' : /<input\b/i.test(item) ? '[ ] ' : '';
        const clean = item.replace(/<input\b[^>]*>/gi, '');
        return `\n- ${checked}${htmlInlineToMarkdown(clean).trim()}`;
    });
    value = value.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');
    value = value.replace(/<\/(p|div|section)>/gi, '\n\n');
    value = value.replace(/<br\s*\/?>/gi, '\n');
    value = htmlInlineToMarkdown(value);
    value = value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    codeBlocks.forEach((code, index) => {
        value = value.replace(`@@NOTE_EXPORT_CODE_${index}@@`, `\`\`\`\n${code}\n\`\`\``);
    });
    return value.trim();
}

function htmlDocumentForNote(noteTitle, noteContent, notebookName) {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtmlText(noteTitle)}</title>
    <style>
        body { color: #202124; font: 16px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #fff; }
        main { max-width: 760px; margin: 40px auto; padding: 0 24px 56px; }
        h1 { font-size: 32px; line-height: 1.2; margin: 0 0 24px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #d6d6d6; padding: 6px 8px; text-align: left; vertical-align: top; }
        pre { background: #f5f5f5; border-radius: 6px; overflow: auto; padding: 12px; }
        blockquote { border-left: 3px solid #d0d7de; color: #57606a; margin-left: 0; padding-left: 14px; }
        .editor-divider-block::before { content: ""; display: block; border-top: 1px solid #d6d6d6; margin: 20px 0; }
        .export-meta { color: #6b7280; font-size: 12px; margin-top: 40px; }
    </style>
</head>
<body>
    <main>
        <h1>${escapeHtmlText(noteTitle)}</h1>
        <article>${noteContent || '<p><br></p>'}</article>
        <div class="export-meta">Exported from ${escapeHtmlText(notebookName)}</div>
    </main>
</body>
</html>
`;
}

function noteMarkdownDocument(noteTitle, noteContent) {
    const body = htmlToMarkdown(noteContent);
    return `# ${String(noteTitle || 'Untitled').replace(/\s+/g, ' ').trim() || 'Untitled'}\n${body ? `\n${body}\n` : '\n'}`;
}

function isBlankNoteContent(content) {
    const value = String(content || '')
        .replace(/<br\s*\/?>/gi, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .trim();
    return !value && !/<(img|table|hr|pre|input)\b/i.test(String(content || '')) &&
        !/editor-divider-block/i.test(String(content || ''));
}

function stripHtmlTags(value) {
    return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim();
}

function titleFromHtml(filePath, html) {
    const title = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (title && stripHtmlTags(title[1])) return stripHtmlTags(title[1]);
    const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1 && stripHtmlTags(h1[1])) return stripHtmlTags(h1[1]);
    return titleFromMarkdownPath(filePath);
}

function htmlFragmentForImport(html) {
    let fragment = String(html || '');
    const article = fragment.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
    const body = fragment.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    fragment = article?.[1] || body?.[1] || fragment;
    fragment = fragment
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
        .replace(/<meta\b[^>]*>/gi, '')
        .replace(/<link\b[^>]*>/gi, '')
        .trim();
    return fragment || '<p><br></p>';
}

function readNotebookConfig() {
    if (process.env.NOTE_DB_PATH) {
        return {
            currentPath: DEFAULT_DB_PATH,
            opened: [{ path: DEFAULT_DB_PATH, name: notebookNameFromPath(DEFAULT_DB_PATH), icon: null }],
            defaultNotebookFolder: path.dirname(DEFAULT_DB_PATH),
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(NOTEBOOKS_CONFIG_PATH, 'utf8'));
        return {
            currentPath: parsed.currentPath || DEFAULT_DB_PATH,
            opened: Array.isArray(parsed.opened) ? parsed.opened : [],
            defaultNotebookFolder: normalizeNotebookFolder(parsed.defaultNotebookFolder),
        };
    } catch (_) {
        return { currentPath: DEFAULT_DB_PATH, opened: [], defaultNotebookFolder: null };
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
    const next = { ...config, currentPath: dbPath, opened };
    writeNotebookConfig(next);
    return next;
}

function removeOpenedNotebook(dbPath) {
    const resolved = sanitizeNotebookPath(dbPath);
    const config = readNotebookConfig();
    const opened = normalizeOpened(config.opened);
    const remaining = opened.filter(item => item.path !== resolved);
    if (remaining.length === opened.length) {
        return { ...config, currentPath: getDbPath(), opened };
    }
    const next = { ...config, currentPath: getDbPath(), opened: remaining };
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

function readMarkdownImportTree(folderPath) {
    const root = path.resolve(folderPath);
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error('markdown import source must be a folder');

    const readDir = (dirPath) => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(entry => !entry.name.startsWith('.'))
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });
        const dirs = [];
        const files = [];
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const child = readDir(entryPath);
                if (child.dirs.length || child.files.length) dirs.push(child);
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
                files.push({
                    path: entryPath,
                    title: titleFromMarkdownPath(entryPath),
                    content: fs.readFileSync(entryPath, 'utf8'),
                });
            }
        }
        return {
            path: dirPath,
            title: titleFromMarkdownPath(dirPath),
            dirs,
            files,
        };
    };

    const tree = readDir(root);
    const countFiles = (node) => node.files.length + node.dirs.reduce((sum, child) => sum + countFiles(child), 0);
    const markdownCount = countFiles(tree);
    if (!markdownCount) throw new Error('no markdown files found in selected folder');
    return { root, tree, markdownCount };
}

function readHtmlImportTree(folderPath) {
    const root = path.resolve(folderPath);
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error('html import source must be a folder');

    const readDir = (dirPath) => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(entry => !entry.name.startsWith('.'))
            .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });
        const dirs = [];
        const files = [];
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const child = readDir(entryPath);
                if (child.dirs.length || child.files.length) dirs.push(child);
            } else if (entry.isFile() && ['.html', '.htm'].includes(path.extname(entry.name).toLowerCase())) {
                const html = fs.readFileSync(entryPath, 'utf8');
                files.push({
                    path: entryPath,
                    title: titleFromHtml(entryPath, html),
                    content: htmlFragmentForImport(html),
                });
            }
        }
        return {
            path: dirPath,
            title: titleFromMarkdownPath(dirPath),
            dirs,
            files,
        };
    };

    const tree = readDir(root);
    const countFiles = (node) => node.files.length + node.dirs.reduce((sum, child) => sum + countFiles(child), 0);
    const htmlCount = countFiles(tree);
    if (!htmlCount) throw new Error('no html files found in selected folder');
    return { root, tree, htmlCount };
}

function insertImportedNote(stmts, { title, content, parentId, icon = null }) {
    const noteId = newId();
    stmts.noteInsert.run({
        noteId,
        title,
        content,
        type: 'text',
        icon: normalizeIcon(icon),
    });
    const sortOrder = stmts.relMaxSort.get(parentId)['COALESCE(MAX(sortOrder), 0) + 1'];
    stmts.relInsert.run({
        relationId: newId(),
        parentId,
        noteId,
        sortOrder,
        isExpanded: 1,
        prefix: null,
    });
    return noteId;
}

function importMarkdownTree(tree, parentId, counters) {
    const stmts = getStmts();
    for (const dir of tree.dirs) {
        const dirNoteId = insertImportedNote(stmts, {
            title: dir.title,
            content: '<p><br></p>',
            parentId,
            icon: 'bx bx-folder',
        });
        counters.folders += 1;
        importMarkdownTree(dir, dirNoteId, counters);
    }
    for (const file of tree.files) {
        insertImportedNote(stmts, {
            title: file.title,
            content: markdownToHtml(file.content),
            parentId,
            icon: 'bx bx-text',
        });
        counters.files += 1;
    }
}

function importHtmlTree(tree, parentId, counters) {
    const stmts = getStmts();
    for (const dir of tree.dirs) {
        const dirNoteId = insertImportedNote(stmts, {
            title: dir.title,
            content: '<p><br></p>',
            parentId,
            icon: 'bx bx-folder',
        });
        counters.folders += 1;
        importHtmlTree(dir, dirNoteId, counters);
    }
    for (const file of tree.files) {
        insertImportedNote(stmts, {
            title: file.title,
            content: file.content,
            parentId,
            icon: 'bx bx-code-alt',
        });
        counters.files += 1;
    }
}

function notebookExportTree(parentId = ROOT_ID, { maxDepth = 32 } = {}) {
    const stmts = getStmts();
    const build = (pid, depth, seen) => {
        if (depth > maxDepth) return [];
        return stmts.relChildren.all(pid)
            .filter(row => !row.isDeleted)
            .map((row) => {
                const note = stmts.noteGet.get(row.noteId);
                if (!note || note.isDeleted) return null;
                const title = row.prefix ? `${row.prefix} - ${note.title}` : note.title;
                return {
                    noteId: row.noteId,
                    title: title || 'Untitled',
                    content: note.content || '',
                    children: seen.has(row.noteId)
                        ? []
                        : build(row.noteId, depth + 1, new Set(seen).add(row.noteId)),
                };
            })
            .filter(Boolean);
    };
    return build(parentId, 0, new Set([parentId]));
}

function writeExportNode(node, dirPath, format, notebookName, counters) {
    const ext = format === 'html' ? '.html' : '.md';
    const hasChildren = node.children.length > 0;
    const hasContent = !isBlankNoteContent(node.content);
    const shouldWriteFile = format === 'html' || hasContent || !hasChildren;

    if (shouldWriteFile) {
        const filePath = uniqueFilesystemPath(dirPath, node.title, ext);
        const body = format === 'html'
            ? htmlDocumentForNote(node.title, node.content, notebookName)
            : noteMarkdownDocument(node.title, node.content);
        fs.writeFileSync(filePath, body, 'utf8');
        counters.files += 1;
    }

    if (hasChildren) {
        const childDir = uniqueFilesystemPath(dirPath, node.title);
        fs.mkdirSync(childDir, { recursive: true });
        counters.folders += 1;
        node.children.forEach(child => writeExportNode(child, childDir, format, notebookName, counters));
    }
}

function exportNotebookFolder(format, folderPath, notebook, exportName = null) {
    const outputFormat = String(format || '').toLowerCase();
    if (!['html', 'markdown'].includes(outputFormat)) throw new Error('export format must be html or markdown');
    if (!folderPath || typeof folderPath !== 'string') throw new Error('export folder is required');

    const parentPath = path.resolve(folderPath);
    fs.mkdirSync(parentPath, { recursive: true });
    if (!fs.statSync(parentPath).isDirectory()) throw new Error('export folder must be a folder');

    const cleanExportName = exportName == null ? null : safeFilenamePart(exportName, '');
    if (exportName != null && !cleanExportName) throw new Error('export name is required');

    const exportPath = uniqueExportDirectory(parentPath, notebook.name, outputFormat, cleanExportName);
    fs.mkdirSync(exportPath, { recursive: true });

    const counters = { files: 0, folders: 0 };
    notebookExportTree().forEach(node => writeExportNode(node, exportPath, outputFormat, notebook.name, counters));
    return {
        format: outputFormat,
        path: exportPath,
        exported: counters,
    };
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

    close(dbPath) {
        const resolved = sanitizeNotebookPath(dbPath);
        const currentPath = getDbPath();
        const config = readNotebookConfig();
        const opened = normalizeOpened(config.opened);
        if (!opened.some(item => item.path === resolved)) {
            return this.list();
        }
        if (opened.length <= 1) {
            throw new Error('cannot close the only opened notebook');
        }

        const remaining = removeOpenedNotebook(resolved).opened;
        if (resolved === currentPath) {
            this.open(remaining[0].path);
            return this.list();
        }
        return this.list();
    },

    importMarkdownFolder(folderPath, notebookName = null) {
        const source = readMarkdownImportTree(folderPath);
        const config = readNotebookConfig();
        const defaultFolder = config.defaultNotebookFolder || path.dirname(getDbPath());
        fs.mkdirSync(defaultFolder, { recursive: true });

        const cleanName = String(notebookName || titleFromMarkdownPath(source.root)).trim();
        if (!cleanName) throw new Error('notebook name is required');
        const dbPath = uniqueNotebookPath(defaultFolder, cleanName);
        const previous = state;
        const next = createConnection(dbPath);
        const counters = { files: 0, folders: 0 };

        state = next;
        try {
            const stmts = getStmts();
            stmts.notebookNameSet.run({ name: cleanName });
            stmts.notebookIconSet.run({ icon: 'bx bx-import' });
            getDb().transaction(() => {
                importMarkdownTree(source.tree, ROOT_ID, counters);
            })();
            upsertOpenedNotebook(state.dbPath, this.current());
            try { previous.db.close(); } catch (_) {}
            return {
                current: this.current(),
                opened: this.list().opened,
                imported: counters,
            };
        } catch (err) {
            try { next.db.close(); } catch (_) {}
            state = previous;
            for (const suffix of ['', '-wal', '-shm']) {
                try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
            }
            throw err;
        }
    },

    importHtmlFolder(folderPath, notebookName) {
        const source = readHtmlImportTree(folderPath);
        const cleanName = String(notebookName || '').trim();
        if (!cleanName) throw new Error('notebook name is required');

        const config = readNotebookConfig();
        const defaultFolder = config.defaultNotebookFolder || path.dirname(getDbPath());
        fs.mkdirSync(defaultFolder, { recursive: true });

        const dbPath = uniqueNotebookPath(defaultFolder, cleanName);
        const previous = state;
        const next = createConnection(dbPath);
        const counters = { files: 0, folders: 0 };

        state = next;
        try {
            const stmts = getStmts();
            stmts.notebookNameSet.run({ name: cleanName });
            stmts.notebookIconSet.run({ icon: 'bx bx-code-alt' });
            getDb().transaction(() => {
                importHtmlTree(source.tree, ROOT_ID, counters);
            })();
            upsertOpenedNotebook(state.dbPath, this.current());
            try { previous.db.close(); } catch (_) {}
            return {
                current: this.current(),
                opened: this.list().opened,
                imported: counters,
            };
        } catch (err) {
            try { next.db.close(); } catch (_) {}
            state = previous;
            for (const suffix of ['', '-wal', '-shm']) {
                try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
            }
            throw err;
        }
    },

    export(folderPath, format, exportName = null) {
        return {
            current: this.current(),
            ...exportNotebookFolder(format, folderPath, this.current(), exportName),
        };
    },
};

const AppSettings = {
    get() {
        const config = readNotebookConfig();
        return {
            defaultNotebookFolder: config.defaultNotebookFolder || path.dirname(getDbPath()),
        };
    },

    update({ defaultNotebookFolder } = {}) {
        const config = readNotebookConfig();
        const folder = defaultNotebookFolder === undefined
            ? config.defaultNotebookFolder
            : normalizeNotebookFolder(defaultNotebookFolder);
        if (!folder) throw new Error('default notebooks folder is required');
        writeNotebookConfig({ ...config, defaultNotebookFolder: folder });
        return this.get();
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
    AppSettings,
    newId,
    ROOT_ID,
    DB_PATH: getDbPath(),
    getDbPath,
};
