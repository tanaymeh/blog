export type PreviewState = "starting" | "ready" | "error";

export interface PostSummary {
  id: string;
  fileName: string;
  title: string;
  date: string;
  slug: string;
  tag: string;
  image: string;
  excerpt: string;
  previewPath: string;
  updatedAt: string;
}

export interface DraftInput {
  sourceId: string | null;
  date: string;
  slug: string;
  title: string;
  tag: string;
  image: string;
  extraFrontmatterText: string;
  body: string;
}

export interface EditorDraft extends DraftInput {
  fileName: string;
  previewPath: string;
  isNew: boolean;
}

export interface PostDocument {
  summary: PostSummary;
  draft: EditorDraft;
}

export interface DeletedPostInfo {
  deletedId: string;
  archivedPath: string;
}

export interface PreviewSessionInfo {
  sessionId: string;
  baseUrl: string | null;
  state: PreviewState;
  previewPath: string | null;
  previewUrl: string | null;
  lastError: string | null;
  recentLogs: string[];
}
