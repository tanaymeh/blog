import slugify from "slugify";

const POST_FILE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(.+)\.md$/;
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

export function derivePostIdentity(date: string, slug: string, title = "") {
  const normalizedSlug = normalizeSlug(slug, title);
  const fileName = `${date}-${normalizedSlug}.md`;
  return {
    slug: normalizedSlug,
    fileName,
    previewPath: toPreviewPath(fileName),
  };
}

export function toPreviewPath(fileName: string): string {
  const match = POST_FILE_PATTERN.exec(fileName);

  if (!match) {
    throw new Error(`Invalid post file name: ${fileName}`);
  }

  return `/${match[1]}/${match[2]}/${match[3]}/${match[4]}.html`;
}

export function parsePostFileName(fileName: string) {
  const match = POST_FILE_PATTERN.exec(fileName);

  if (!match) {
    throw new Error(`Invalid post file name: ${fileName}`);
  }

  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    slug: match[4],
  };
}
