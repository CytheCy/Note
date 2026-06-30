'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-delete-smoke-'));
process.env.NOTE_DB_PATH = path.join(tempDir, 'document.db');

const { Notes, db, ROOT_ID } = require('../src/db');

function activeRelationId(noteId) {
    return db.prepare(`
        SELECT relationId
        FROM note_relations
        WHERE noteId = ? AND isDeleted = 0
    `).get(noteId)?.relationId;
}

const note = Notes.create({
    parentId: ROOT_ID,
    title: 'Simple',
    content: '',
    type: 'text',
});

const relationId = activeRelationId(note.noteId);
assert(relationId, 'expected created note to have an active relation');
assert.equal(Notes.removeRelation(relationId), true, 'expected delete to succeed');
assert.equal(
    db.prepare('SELECT isDeleted FROM note_relations WHERE relationId = ?').get(relationId).isDeleted,
    1,
    'expected relation to be soft-deleted'
);
assert.equal(
    Notes.get(note.noteId).isDeleted,
    1,
    'expected note to be soft-deleted when its last relation is removed'
);

console.log('delete relation smoke test passed');
