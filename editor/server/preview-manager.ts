import path from "node:path";
import { promises as fs } from "node:fs";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { DraftInput, PreviewSessionInfo, PreviewState } from "../shared/types";
import { HttpError } from "./errors";
import { PostService } from "./post-service";

interface PreviewSession {
  sessionId: string;
  containerName: string;
  workspaceRoot: string;
  hostPort: number | null;
  child: ChildProcess;
  state: PreviewState;
  activeSourceId: string | null;
  activeOverlayId: string | null;
  previewPath: string | null;
  lastError: string | null;
  recentLogs: string[];
  exited: boolean;
}

export class PreviewManager {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly workingRoot: string;

  constructor(private readonly repoRoot: string) {
    this.workingRoot = path.join(repoRoot, ".blog-editor", "sessions");
  }

  async createSession() {
    const sessionId = randomUUID();
    const workspaceRoot = path.join(this.workingRoot, sessionId, "workspace");
    const containerName = `blog-editor-${sessionId}`;

    await this.prepareWorkspace(workspaceRoot);

    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containerName,
        "-p",
        "127.0.0.1::4000",
        "-v",
        `${workspaceRoot}:/srv/jekyll`,
        "-w",
        "/srv/jekyll",
        "jekyll/jekyll:pages",
        "sh",
        "-lc",
        "if ! gem list -i webrick >/dev/null 2>&1; then gem install webrick -N >/dev/null; fi && jekyll serve --host 0.0.0.0 --port 4000 --incremental --force_polling --future --drafts --trace",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const session: PreviewSession = {
      sessionId,
      containerName,
      workspaceRoot,
      hostPort: null,
      child,
      state: "starting",
      activeSourceId: null,
      activeOverlayId: null,
      previewPath: null,
      lastError: null,
      recentLogs: [],
      exited: false,
    };

    child.stdout.on("data", (chunk) => this.appendLogs(session, chunk.toString()));
    child.stderr.on("data", (chunk) => this.appendLogs(session, chunk.toString()));
    child.on("exit", (code) => {
      session.exited = true;
      if (code !== 0 && !session.lastError) {
        session.lastError = `Jekyll preview exited with status ${code ?? "unknown"}.`;
      }
    });

    this.sessions.set(sessionId, session);
    return this.toInfo(await this.refresh(session));
  }

  async updateSession(sessionId: string, draft: DraftInput, postService: PostService) {
    const session = this.getSession(sessionId);
    const materialized = postService.materializeDraft(draft, { allowUntitled: true });

    if (session.activeSourceId) {
      await postService.syncSourceDocumentToWorkspace(session.workspaceRoot, session.activeSourceId);
    }

    if (session.activeOverlayId && session.activeOverlayId !== session.activeSourceId) {
      await postService.removeDocumentFromWorkspace(session.workspaceRoot, session.activeOverlayId);
    }

    if (draft.sourceId && draft.sourceId !== materialized.id) {
      await postService.removeDocumentFromWorkspace(session.workspaceRoot, draft.sourceId);
    }

    const workspaceTargetPath = path.join(session.workspaceRoot, materialized.relativePath);
    await fs.mkdir(path.dirname(workspaceTargetPath), { recursive: true });
    await fs.writeFile(workspaceTargetPath, materialized.content, "utf8");

    session.activeSourceId = draft.sourceId;
    session.activeOverlayId = materialized.id;
    session.previewPath = materialized.previewPath;
    session.lastError = null;

    return this.toInfo(await this.refresh(session));
  }

  async getSessionInfo(sessionId: string) {
    return this.toInfo(await this.refresh(this.getSession(sessionId)));
  }

  async deleteSession(sessionId: string) {
    const session = this.getSession(sessionId);
    await this.stopSession(session);
    this.sessions.delete(sessionId);
  }

  async shutdown() {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      await this.deleteSession(sessionId);
    }
  }

  private getSession(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new HttpError(404, `Preview session "${sessionId}" was not found.`);
    }

    return session;
  }

  private async refresh(session: PreviewSession) {
    if (session.exited) {
      session.state = "error";
      return session;
    }

    if (session.hostPort === null) {
      session.hostPort = await this.resolveHostPort(session);
    }

    const baseUrl = this.getBaseUrl(session);

    if (!baseUrl) {
      session.state = session.lastError ? "error" : "starting";
      return session;
    }

    const probeTarget = session.previewPath ? `${baseUrl}${session.previewPath}` : baseUrl;

    try {
      const response = await fetch(probeTarget, {
        signal: AbortSignal.timeout(800),
      });

      session.state = response.ok ? "ready" : "starting";
    } catch {
      session.state = session.lastError ? "error" : "starting";
    }

    return session;
  }

  private toInfo(session: PreviewSession): PreviewSessionInfo {
    const baseUrl = this.getBaseUrl(session);

    return {
      sessionId: session.sessionId,
      baseUrl,
      state: session.state,
      previewPath: session.previewPath,
      previewUrl: session.previewPath && baseUrl ? `${baseUrl}${session.previewPath}` : null,
      lastError: session.lastError,
      recentLogs: session.recentLogs,
    };
  }

  private appendLogs(session: PreviewSession, message: string) {
    const lines = message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return;
    }

    session.recentLogs = [...session.recentLogs, ...lines].slice(-20);

    const lastErrorLine = [...lines]
      .reverse()
      .find((line) => /error|exception|conflict|invalid/i.test(line));

    if (lastErrorLine) {
      session.lastError = lastErrorLine;
    }
  }

  private async stopSession(session: PreviewSession) {
    if (!session.exited) {
      await new Promise<void>((resolve) => {
        const stopper = spawn("docker", ["rm", "-f", session.containerName], {
          stdio: "ignore",
        });

        stopper.on("exit", () => resolve());
        stopper.on("error", () => resolve());
      });
    }

    session.child.kill("SIGTERM");
    await fs.rm(path.dirname(session.workspaceRoot), { recursive: true, force: true });
  }

  private async prepareWorkspace(workspaceRoot: string) {
    await fs.rm(path.dirname(workspaceRoot), { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });

    const entries = await fs.readdir(this.repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (this.shouldExclude(entry.name)) {
        continue;
      }

      await fs.cp(path.join(this.repoRoot, entry.name), path.join(workspaceRoot, entry.name), {
        recursive: true,
      });
    }
  }

  private shouldExclude(topLevelName: string) {
    return [".git", "_site", ".blog-editor", "editor", "node_modules"].includes(topLevelName);
  }

  private getBaseUrl(session: PreviewSession) {
    return session.hostPort === null ? null : `http://127.0.0.1:${session.hostPort}`;
  }

  private async resolveHostPort(session: PreviewSession) {
    try {
      const output = await this.runDockerCommand(["port", session.containerName, "4000/tcp"]);
      const match = output.match(/:(\d+)\s*$/m);
      return match ? Number.parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  private async runDockerCommand(args: string[]) {
    return await new Promise<string>((resolve, reject) => {
      execFile("docker", args, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve(stdout.trim());
      });
    });
  }
}
