import {
  DiscardPostResult,
  DeletedPostInfo,
  DraftInput,
  PostDocument,
  PostSummary,
  PreviewSessionInfo,
  PublishResult,
  PublishTransactionInfo,
} from "../shared/types";

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed with ${response.status}.`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  async listPosts() {
    return request<{ posts: PostSummary[] }>("/api/posts");
  },
  async getPost(id: string) {
    return request<PostDocument>(`/api/posts/${encodeURIComponent(id)}`);
  },
  async createPost(draft: DraftInput) {
    return request<PostDocument>("/api/posts", {
      method: "POST",
      body: JSON.stringify(draft),
    });
  },
  async updatePost(id: string, draft: DraftInput) {
    return request<PostDocument>(`/api/posts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
  },
  async deletePost(id: string) {
    return request<DeletedPostInfo>(`/api/posts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  async discardPost(id: string) {
    return request<DiscardPostResult>(`/api/posts/${encodeURIComponent(id)}/discard`, {
      method: "POST",
    });
  },
  async publishPost(draft: DraftInput) {
    return request<PublishResult>("/api/publish", {
      method: "POST",
      body: JSON.stringify(draft),
    });
  },
  async listPendingPublishes() {
    return request<{ transactions: PublishTransactionInfo[] }>("/api/publish");
  },
  async updatePublish(transactionId: string, commitMessage: string) {
    return request<PublishTransactionInfo>(`/api/publish/${encodeURIComponent(transactionId)}`, {
      method: "PUT",
      body: JSON.stringify({ commitMessage }),
    });
  },
  async pushPublish(transactionId: string) {
    return request<PublishTransactionInfo>(`/api/publish/${encodeURIComponent(transactionId)}/push`, {
      method: "POST",
    });
  },
  async cancelPublish(transactionId: string) {
    return request<PublishTransactionInfo>(`/api/publish/${encodeURIComponent(transactionId)}/cancel`, {
      method: "POST",
    });
  },
  async keepPublish(transactionId: string) {
    return request<PublishTransactionInfo>(`/api/publish/${encodeURIComponent(transactionId)}/keep`, {
      method: "POST",
    });
  },
  async createPreviewSession() {
    return request<PreviewSessionInfo>("/api/preview/sessions", {
      method: "POST",
    });
  },
  async getPreviewSession(id: string) {
    return request<PreviewSessionInfo>(`/api/preview/sessions/${encodeURIComponent(id)}`);
  },
  async updatePreviewSession(id: string, draft: DraftInput) {
    return request<PreviewSessionInfo>(`/api/preview/sessions/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
  },
  async deletePreviewSession(id: string) {
    return request<void>(`/api/preview/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};
