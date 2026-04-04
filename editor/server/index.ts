import path from "node:path";
import { existsSync } from "node:fs";

import cors from "cors";
import express from "express";

import { DraftInput } from "../shared/types";
import { HttpError } from "./errors";
import { PostService } from "./post-service";
import { PreviewManager } from "./preview-manager";

const editorRoot = process.cwd();
const repoRoot = path.resolve(editorRoot, "..");
const clientDist = path.join(editorRoot, "dist");

const postService = new PostService(repoRoot);
const previewManager = new PreviewManager(repoRoot);

const app = express();
const port = 4321;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/posts", async (_req, res) => {
  res.json({ posts: await postService.listPosts() });
});

app.get("/api/posts/:id", async (req, res) => {
  res.json(await postService.getPost(req.params.id));
});

app.post("/api/posts", async (req, res) => {
  const saved = await postService.savePost({
    ...(req.body as DraftInput),
    sourceId: null,
  });

  res.status(201).json(saved);
});

app.put("/api/posts/:id", async (req, res) => {
  const saved = await postService.savePost({
    ...(req.body as DraftInput),
    sourceId: req.params.id,
  });

  res.json(saved);
});

app.delete("/api/posts/:id", async (req, res) => {
  res.json(await postService.deletePost(req.params.id));
});

app.post("/api/preview/sessions", async (_req, res) => {
  res.status(201).json(await previewManager.createSession());
});

app.get("/api/preview/sessions/:id", async (req, res) => {
  res.json(await previewManager.getSessionInfo(req.params.id));
});

app.put("/api/preview/sessions/:id", async (req, res) => {
  res.json(await previewManager.updateSession(req.params.id, req.body as DraftInput, postService));
});

app.delete("/api/preview/sessions/:id", async (req, res) => {
  await previewManager.deleteSession(req.params.id);
  res.status(204).send();
});

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected server error.";
  res.status(500).json({ error: message });
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Blog editor server listening on http://127.0.0.1:${port}`);
});

async function shutdown() {
  await previewManager.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdown()
      .catch((error) => {
        console.error(error);
      })
      .finally(() => process.exit(0));
  });
}
