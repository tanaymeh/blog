import path from "node:path";
import { promises as fs } from "node:fs";

import matter from "gray-matter";
import YAML from "yaml";

import {
  deriveDocumentIdentity,
  derivePreviewPath,
  isValidPostDate,
  normalizeSlug,
  parseDocumentId,
  parseDraftFileName,
  parsePublishedFileName,
} from "../shared/draft";
import { DraftInput, EditorDraft, PostDocument, PostStatus, PostSummary } from "../shared/types";
import { HttpError } from "./errors";

const RESERVED_FRONTMATTER_KEYS = new Set(["layout", "title", "tag", "image", "date"]);

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]+`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBody(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/^\n/, "");
}

function parseExtraFrontmatter(extraFrontmatterText: string): Record<string, unknown> {
  const trimmed = extraFrontmatterText.trim();

  if (!trimmed) {
    return {};
  }

  const parsed = YAML.parse(trimmed);

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Advanced front matter must be a YAML object.");
  }

  const extras = { ...parsed } as Record<string, unknown>;

  for (const key of RESERVED_FRONTMATTER_KEYS) {
    delete extras[key];
  }

  return extras;
}

interface MaterializedDocument {
  id: string;
  status: PostStatus;
  fileName: string;
  relativePath: string;
  previewPath: string;
  content: string;
}

interface DocumentLocation {
  id: string;
  status: PostStatus;
  fileName: string;
  relativePath: string;
  absolutePath: string;
}

export class PostService {
  private readonly postsDir: string;
  private readonly draftsDir: string;
  private readonly trashDir: string;

  constructor(private readonly repoRoot: string) {
    this.postsDir = path.join(repoRoot, "_posts");
    this.draftsDir = path.join(repoRoot, "_drafts");
    this.trashDir = path.join(repoRoot, ".blog-editor", "deleted");
  }

  async listPosts(): Promise<PostSummary[]> {
    const [publishedPosts, drafts] = await Promise.all([
      this.listDirectory("published", this.postsDir),
      this.listDirectory("draft", this.draftsDir),
    ]);

    return [...drafts, ...publishedPosts].sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "draft" ? -1 : 1;
      }

      if (left.updatedAt !== right.updatedAt) {
        return left.updatedAt < right.updatedAt ? 1 : -1;
      }

      if (left.date !== right.date) {
        return left.date < right.date ? 1 : -1;
      }

      return left.fileName.localeCompare(right.fileName);
    });
  }

  async getPost(documentId: string): Promise<PostDocument> {
    const location = this.resolveLocation(documentId);

    if (!(await this.exists(location.absolutePath))) {
      throw new HttpError(404, `Document "${documentId}" was not found.`);
    }

    const rawContent = await fs.readFile(location.absolutePath, "utf8");
    return this.toDocument(location.status, location.fileName, rawContent, await fs.stat(location.absolutePath));
  }

  async hasPost(documentId: string) {
    const location = this.resolveLocation(documentId);
    return await this.exists(location.absolutePath);
  }

  getRelativePath(documentId: string) {
    return this.resolveLocation(documentId).relativePath;
  }

  async savePost(input: DraftInput): Promise<PostDocument> {
    const materialized = this.materializeDraft(input);
    const targetPath = path.join(this.repoRoot, materialized.relativePath);
    const source = input.sourceId ? this.resolveLocation(input.sourceId) : null;

    if (source && !(await this.exists(source.absolutePath))) {
      throw new HttpError(404, `Document "${input.sourceId}" was not found.`);
    }

    if (input.sourceId !== materialized.id && (await this.exists(targetPath))) {
      throw new HttpError(409, `A ${materialized.status} post named "${materialized.fileName}" already exists.`);
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, materialized.content, "utf8");

    if (source && source.id !== materialized.id) {
      await fs.rm(source.absolutePath, { force: true });
    }

    return this.getPost(materialized.id);
  }

  async publishPost(input: DraftInput): Promise<PostDocument> {
    return this.savePost({
      ...input,
      status: "published",
    });
  }

  async deletePost(documentId: string) {
    const source = this.resolveLocation(documentId);

    if (!(await this.exists(source.absolutePath))) {
      throw new HttpError(404, `Document "${documentId}" was not found.`);
    }

    await fs.mkdir(this.trashDir, { recursive: true });

    const archivedName = `${new Date().toISOString().replace(/[:.]/g, "-")}__${source.status}__${source.fileName}`;
    const archivedPath = path.join(this.trashDir, archivedName);

    await fs.rename(source.absolutePath, archivedPath);

    return {
      deletedId: documentId,
      archivedPath,
    };
  }

  materializeDraft(input: DraftInput, options?: { allowUntitled?: boolean }): MaterializedDocument {
    const status = input.status;
    const date = input.date.trim();
    const title = input.title.trim();
    const tag = input.tag.trim();
    const image = input.image.trim();

    if (!title && !options?.allowUntitled) {
      throw new HttpError(400, "Title is required.");
    }

    if (!isValidPostDate(date)) {
      throw new HttpError(400, "Date must use YYYY-MM-DD.");
    }

    const effectiveTitle = title || "Untitled Post";
    const identity = deriveDocumentIdentity(status, date, input.slug, effectiveTitle);
    const extras = parseExtraFrontmatter(input.extraFrontmatterText);

    const frontmatter: Record<string, unknown> = {
      layout: "post",
      title: effectiveTitle,
    };

    if (status === "draft") {
      frontmatter.date = date;
    }

    if (tag) {
      frontmatter.tag = tag;
    }

    if (image) {
      frontmatter.image = image;
    }

    Object.assign(frontmatter, extras);

    const content = `${matter.stringify(normalizeBody(input.body), frontmatter).trimEnd()}\n`;

    return {
      id: identity.id,
      status: identity.status,
      fileName: identity.fileName,
      relativePath: identity.relativePath,
      previewPath: identity.previewPath,
      content,
    };
  }

  async syncSourceDocumentToWorkspace(workspaceRoot: string, documentId: string) {
    const location = this.resolveLocation(documentId);
    const workspacePath = path.join(workspaceRoot, location.relativePath);

    if (!(await this.exists(location.absolutePath))) {
      await fs.rm(workspacePath, { force: true });
      return;
    }

    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.copyFile(location.absolutePath, workspacePath);
  }

  async removeDocumentFromWorkspace(workspaceRoot: string, documentId: string) {
    const location = this.resolveLocation(documentId);
    await fs.rm(path.join(workspaceRoot, location.relativePath), { force: true });
  }

  async collectPublishPaths(draft: EditorDraft, previousSourceId: string | null) {
    const paths = new Set<string>([draft.relativePath]);

    if (previousSourceId && previousSourceId !== draft.sourceId) {
      paths.add(this.resolveLocation(previousSourceId).relativePath);
    }

    for (const referencedPath of this.extractReferencedPaths(draft)) {
      if (await this.exists(path.join(this.repoRoot, referencedPath))) {
        paths.add(referencedPath);
      }
    }

    return [...paths].sort((left, right) => left.localeCompare(right));
  }

  private async listDirectory(status: PostStatus, directoryPath: string) {
    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      const posts = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map(async (entry) => this.loadSummary(status, entry.name)),
      );

      return posts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private resolveLocation(documentId: string): DocumentLocation {
    const location = parseDocumentId(documentId);

    return {
      ...location,
      id: documentId,
      absolutePath: path.join(this.repoRoot, location.relativePath),
    };
  }

  private async loadSummary(status: PostStatus, fileName: string): Promise<PostSummary> {
    const relativePath = status === "draft" ? path.join("_drafts", fileName) : path.join("_posts", fileName);
    const targetPath = path.join(this.repoRoot, relativePath);
    const rawContent = await fs.readFile(targetPath, "utf8");
    const document = this.toDocument(status, fileName, rawContent, await fs.stat(targetPath));
    return document.summary;
  }

  private toDocument(status: PostStatus, fileName: string, rawContent: string, stats: { mtime: Date }): PostDocument {
    const parsed = matter(rawContent);
    const data = { ...(parsed.data as Record<string, unknown>) };

    const date =
      status === "published"
        ? parsePublishedFileName(fileName).date
        : typeof data.date === "string" && isValidPostDate(data.date)
          ? data.date
          : stats.mtime.toISOString().slice(0, 10);

    const slug =
      status === "published" ? parsePublishedFileName(fileName).slug : normalizeSlug(parseDraftFileName(fileName).slug);
    const title = typeof data.title === "string" ? data.title : slug.replace(/-/g, " ");
    const tag = typeof data.tag === "string" ? data.tag : "";
    const image = typeof data.image === "string" ? data.image : "";

    delete data.layout;
    delete data.title;
    delete data.tag;
    delete data.image;
    delete data.date;

    const extraFrontmatterText = Object.keys(data).length > 0 ? YAML.stringify(data).trim() : "";
    const body = normalizeBody(parsed.content);
    const excerpt = stripMarkdown(body).slice(0, 180);
    const identity = deriveDocumentIdentity(status, date, slug, title);

    const draft: EditorDraft = {
      sourceId: identity.id,
      status,
      date,
      slug,
      title,
      tag,
      image,
      extraFrontmatterText,
      body,
      fileName: identity.fileName,
      relativePath: identity.relativePath,
      previewPath: identity.previewPath,
      isNew: false,
    };

    return {
      summary: {
        id: identity.id,
        status,
        fileName: identity.fileName,
        relativePath: identity.relativePath,
        title,
        date,
        slug,
        tag,
        image,
        excerpt,
        previewPath: identity.previewPath,
        updatedAt: stats.mtime.toISOString(),
      },
      draft,
    };
  }

  private extractReferencedPaths(draft: EditorDraft) {
    const references = new Set<string>();

    const addReference = (candidate: string) => {
      const trimmed = candidate.trim();

      if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
        return;
      }

      const normalized = trimmed.split(/[?#]/)[0].replace(/^\/+/, "");

      if (!normalized) {
        return;
      }

      const absolutePath = path.resolve(this.repoRoot, normalized);

      if (!absolutePath.startsWith(this.repoRoot)) {
        return;
      }

      references.add(normalized);
    };

    addReference(draft.image);

    for (const match of draft.body.matchAll(/\]\((\/[^)\s]+(?:\?[^)\s#]*)?(?:#[^)]+)?)\)/g)) {
      addReference(match[1]);
    }

    for (const match of draft.body.matchAll(/\bsrc=["'](\/[^"']+)["']/g)) {
      addReference(match[1]);
    }

    return references;
  }

  private async exists(targetPath: string) {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
