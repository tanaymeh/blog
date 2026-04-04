import path from "node:path";
import { promises as fs } from "node:fs";

import matter from "gray-matter";
import YAML from "yaml";

import { derivePostIdentity, isValidPostDate, parsePostFileName } from "../shared/draft";
import { DraftInput, EditorDraft, PostDocument, PostSummary } from "../shared/types";
import { HttpError } from "./errors";

const RESERVED_FRONTMATTER_KEYS = new Set(["layout", "title", "tag", "image"]);

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

export class PostService {
  private readonly postsDir: string;
  private readonly trashDir: string;

  constructor(private readonly repoRoot: string) {
    this.postsDir = path.join(repoRoot, "_posts");
    this.trashDir = path.join(repoRoot, ".blog-editor", "deleted");
  }

  async listPosts(): Promise<PostSummary[]> {
    const entries = await fs.readdir(this.postsDir, { withFileTypes: true });
    const posts = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => this.loadSummary(entry.name)),
    );

    return posts.sort((left, right) => {
      if (left.date !== right.date) {
        return left.date < right.date ? 1 : -1;
      }

      return left.fileName.localeCompare(right.fileName);
    });
  }

  async getPost(fileName: string): Promise<PostDocument> {
    const targetPath = path.join(this.postsDir, fileName);

    if (!(await this.exists(targetPath))) {
      throw new HttpError(404, `Post "${fileName}" was not found.`);
    }

    const rawContent = await fs.readFile(targetPath, "utf8");
    return this.toDocument(fileName, rawContent, await fs.stat(targetPath));
  }

  async savePost(input: DraftInput): Promise<PostDocument> {
    const materialized = this.materializeDraft(input);
    const sourceId = input.sourceId;
    const targetPath = path.join(this.postsDir, materialized.fileName);

    if (sourceId) {
      const sourcePath = path.join(this.postsDir, sourceId);

      if (!(await this.exists(sourcePath))) {
        throw new HttpError(404, `Post "${sourceId}" was not found.`);
      }
    }

    if (sourceId !== materialized.fileName && (await this.exists(targetPath))) {
      throw new HttpError(409, `A post named "${materialized.fileName}" already exists.`);
    }

    await fs.mkdir(this.postsDir, { recursive: true });
    await fs.writeFile(targetPath, materialized.content, "utf8");

    if (sourceId && sourceId !== materialized.fileName) {
      await fs.rm(path.join(this.postsDir, sourceId), { force: true });
    }

    return this.getPost(materialized.fileName);
  }

  async deletePost(fileName: string) {
    const sourcePath = path.join(this.postsDir, fileName);

    if (!(await this.exists(sourcePath))) {
      throw new HttpError(404, `Post "${fileName}" was not found.`);
    }

    await fs.mkdir(this.trashDir, { recursive: true });

    const archivedName = `${new Date().toISOString().replace(/[:.]/g, "-")}__${fileName}`;
    const archivedPath = path.join(this.trashDir, archivedName);

    await fs.rename(sourcePath, archivedPath);

    return {
      deletedId: fileName,
      archivedPath,
    };
  }

  materializeDraft(input: DraftInput, options?: { allowUntitled?: boolean }) {
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
    const identity = derivePostIdentity(date, input.slug, effectiveTitle);
    const extras = parseExtraFrontmatter(input.extraFrontmatterText);

    const frontmatter: Record<string, unknown> = {
      layout: "post",
      title: effectiveTitle,
    };

    if (tag) {
      frontmatter.tag = tag;
    }

    if (image) {
      frontmatter.image = image;
    }

    Object.assign(frontmatter, extras);

    const content = `${matter.stringify(normalizeBody(input.body), frontmatter).trimEnd()}\n`;

    return {
      fileName: identity.fileName,
      previewPath: identity.previewPath,
      slug: identity.slug,
      content,
    };
  }

  async copySourcePostTo(destinationPostsDir: string, fileName: string) {
    const sourcePath = path.join(this.postsDir, fileName);

    if (!(await this.exists(sourcePath))) {
      await fs.rm(path.join(destinationPostsDir, fileName), { force: true });
      return;
    }

    await fs.mkdir(destinationPostsDir, { recursive: true });
    await fs.copyFile(sourcePath, path.join(destinationPostsDir, fileName));
  }

  private async loadSummary(fileName: string): Promise<PostSummary> {
    const targetPath = path.join(this.postsDir, fileName);
    const rawContent = await fs.readFile(targetPath, "utf8");
    const document = this.toDocument(fileName, rawContent, await fs.stat(targetPath));
    return document.summary;
  }

  private toDocument(fileName: string, rawContent: string, stats: { mtime: Date }): PostDocument {
    const parsed = matter(rawContent);
    const identity = parsePostFileName(fileName);

    const data = { ...(parsed.data as Record<string, unknown>) };
    const title = typeof data.title === "string" ? data.title : identity.slug.replace(/-/g, " ");
    const tag = typeof data.tag === "string" ? data.tag : "";
    const image = typeof data.image === "string" ? data.image : "";

    delete data.layout;
    delete data.title;
    delete data.tag;
    delete data.image;

    const extraFrontmatterText = Object.keys(data).length > 0 ? YAML.stringify(data).trim() : "";
    const body = normalizeBody(parsed.content);
    const excerpt = stripMarkdown(body).slice(0, 180);
    const previewPath = derivePostIdentity(identity.date, identity.slug).previewPath;

    const draft: EditorDraft = {
      sourceId: fileName,
      date: identity.date,
      slug: identity.slug,
      title,
      tag,
      image,
      extraFrontmatterText,
      body,
      fileName,
      previewPath,
      isNew: false,
    };

    return {
      summary: {
        id: fileName,
        fileName,
        title,
        date: identity.date,
        slug: identity.slug,
        tag,
        image,
        excerpt,
        previewPath,
        updatedAt: stats.mtime.toISOString(),
      },
      draft,
    };
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
