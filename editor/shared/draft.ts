import slugify from "slugify";

import type { PostStatus } from "./types";

const POST_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/;
const DRAFT_FILE_PATTERN = /^(.+)\.md$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeSlug(slug: string, title = ""): string {
  const candidate = (slug || title).trim();
  const normalized = slugify(candidate, {
    lower: true,
    strict: true,
    trim: true,
  });
  return normalized || "untitled-post";
}

export function isValidPostDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) {
    return false;
  }

  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

export function derivePreviewPath(date: string, slug: string, title = "") {
  const normalizedSlug = normalizeSlug(slug, title);
  const fileName = `${date}-${normalizedSlug}.md`;
  return toPreviewPath(fileName);
}

export function toPreviewPath(fileName: string): string {
  const match = POST_FILE_PATTERN.exec(fileName);

  if (!match) {
    throw new Error(`Invalid post file name: ${fileName}`);
  }

  return `/${match[1]}/${match[2]}/${match[3]}/${match[4]}.html`;
}

export function deriveDocumentIdentity(status: PostStatus, date: string, slug: string, title = "") {
  const normalizedSlug = normalizeSlug(slug, title);
  const fileName = status === "draft" ? `${normalizedSlug}.md` : `${date}-${normalizedSlug}.md`;
  return {
    id: toDocumentId(status, fileName),
    status,
    slug: normalizedSlug,
    fileName,
    relativePath: toRelativePath(status, fileName),
    previewPath: derivePreviewPath(date, normalizedSlug),
  };
}

export function toDocumentId(status: PostStatus, fileName: string) {
  return `${status}:${fileName}`;
}

export function parseDocumentId(documentId: string) {
  const separatorIndex = documentId.indexOf(":");

  if (separatorIndex <= 0) {
    throw new Error(`Invalid document id: ${documentId}`);
  }

  const status = documentId.slice(0, separatorIndex);
  const fileName = documentId.slice(separatorIndex + 1);

  if (status !== "draft" && status !== "published") {
    throw new Error(`Invalid document status: ${status}`);
  }

  if (!fileName.endsWith(".md")) {
    throw new Error(`Invalid document file name: ${fileName}`);
  }

  return {
    status,
    fileName,
    relativePath: toRelativePath(status, fileName),
  } as const;
}

export function toRelativePath(status: PostStatus, fileName: string) {
  return `${status === "draft" ? "_drafts" : "_posts"}/${fileName}`;
}

export function parsePublishedFileName(fileName: string) {
  const match = POST_FILE_PATTERN.exec(fileName);

  if (!match) {
    throw new Error(`Invalid post file name: ${fileName}`);
  }

  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    slug: match[4],
  };
}

export function parseDraftFileName(fileName: string) {
  const match = DRAFT_FILE_PATTERN.exec(fileName);

  if (!match) {
    throw new Error(`Invalid draft file name: ${fileName}`);
  }

  return {
    slug: match[1],
  };
}
