# Blog Editor

This is a companion app for the blog repository. It does not replace or alter the public blog UI. Instead, it gives you a local authoring surface with:

- create, edit, and soft-delete published posts in `_posts/`
- save unpublished drafts in `_drafts/`
- a Markdown editor for the source content
- a live preview rendered by the real Jekyll + Kagami theme inside Docker
- a publish flow that creates a local git commit and then lets you push it, keep it locally for preview, or cancel the commit

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
- Drafts are stored in `_drafts/` and stay out of the normal Jekyll site build.
- Publishing creates a local commit tagged via the commit message as editor-generated. The follow-up dialog lets you push that commit, keep it locally, or remove just the commit while keeping the saved files in your working tree.
- The preview server uses `jekyll/jekyll:pages`, so the rendered pane follows the same remote Kagami theme and local overrides as the blog itself.
