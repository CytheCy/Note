# Note

A hierarchical note-taking desktop application.
It features a deeply nestable notes tree, **note cloning** (a single note can appear in multiple
places in the tree), and **Boxicons** for note icons.

## Architecture

| Layer        | Technology                                            |
|--------------|-------------------------------------------------------|
| Desktop wrap | Electron (optional)                                  |
| Runtime      | Node.js (Express REST API on `http://localhost:3777`)|
| Database     | SQLite via `better-sqlite3`                           |
| Frontend     | Vanilla JS + HTML5 + CSS3 + Boxicons (CDN)            |

```
Notes/
├── package.json
├── schema.sql              # SQLite DDL (tables, triggers, seed data)
├── data/                   # gitignored — holds document.db
└── src/
    ├── db.js               # DB helper: open, migrate, CRUD, hierarchy fetch
    ├── server.js           # Express REST API
    ├── electron/
    │   └── main.js         # Electron desktop wrapper
    └── public/
        ├── index.html      # Three-pane split layout
        ├── css/styles.css  # Tree & editor styling
        └── js/
            ├── api.js      # Tiny fetch() wrapper
            ├── tree.js     # Recursive tree render, drag-drop, context menu
            ├── editor.js   # Note editor + autosave
            └── app.js      # Glue / bootstrap
```

## Getting started

```bash
cd /home/cport/MEGA/Zed/Notes
npm install            # installs express, better-sqlite3, cors (+ optional electron)
npm run init-db        # creates data/document.db and seeds example notes
npm start              # serves the app at http://localhost:3777
```

Then open <http://localhost:3777> in your browser.

### Desktop (Electron) mode

```bash
npm run electron
```

## Concepts implemented

- **Nested tree** — unlimited depth, lazy-expandable, indentation padding per level.
- **Cloning** — `note_relations` is a many-to-many bridge, so one `notes` row can have many
  parents (each `relationId` is its own place in the tree).
- **Note types** — `text`, each with its own Boxicon.
- **Boxicons** — loaded via CDN, mapped per note type in `tree.js → NOTE_TYPE_ICON`.
