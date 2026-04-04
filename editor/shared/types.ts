export type PostStatus = "draft" | "published";
export type PreviewState = "starting" | "ready" | "error";

export interface PostSummary {
  id: string;
  status: PostStatus;
  fileName: string;
  relativePath: string;
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
  status: PostStatus;
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
  relativePath: string;
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

export interface DiscardPostResult {
  document: PostDocument | null;
  removed: boolean;
  cancelledPendingPublish: boolean;
}

export interface PublishTransactionInfo {
  transactionId: string;
  commitSha: string;
  branchName: string;
  upstreamBranch: string | null;
  pushAvailable: boolean;
  commitMessage: string;
  affectedPaths: string[];
}

export interface PublishResult {
  document: PostDocument;
  transaction: PublishTransactionInfo;
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
