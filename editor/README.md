# Blog Editor

This is a companion app for the blog repository. It does not replace or alter the public blog UI. Instead, it gives you a local authoring surface with:

- create, edit, and soft-delete post files in `_posts/`
- a Markdown editor for the source content
- a live preview rendered by the real Jekyll + Kagami theme inside Docker

## Requirements

- Node.js 20+
- Docker

## Run

```bash
cd editor
npm install
npm run dev
```

Then open `http://127.0.0.1:5173`.

## Production-style run

```bash
cd editor
npm install
npm run build
npm run start
```

Then open `http://127.0.0.1:4321`.

## Notes

- Preview workspaces live under `.blog-editor/` and are ignored by git.
- Deleting a post moves it into `.blog-editor/deleted/`, which is outside the published blog content and excluded from Jekyll builds.
- The preview server uses `jekyll/jekyll:pages`, so the rendered pane follows the same remote Kagami theme and local overrides as the blog itself.
