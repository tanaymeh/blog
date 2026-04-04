import { useEffect, useRef, useState, startTransition } from "react";

import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView, placeholder as editorPlaceholder } from "@codemirror/view";

import { deriveDocumentIdentity, isValidPostDate, normalizeSlug } from "../shared/draft";
import {
  DraftInput,
  EditorDraft,
  PostDocument,
  PostStatus,
  PostSummary,
  PreviewSessionInfo,
  PublishTransactionInfo,
} from "../shared/types";
import { api } from "./api";

const previewRefreshMs = 450;
const sessionPollMs = 2000;

type SidebarFilter = "all" | PostStatus;
type PublishDecision = "push" | "keep" | "cancel";

function formatDate(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

function draftSignature(draft: EditorDraft | null) {
  if (!draft) {
    return "";
  }

  return JSON.stringify({
    sourceId: draft.sourceId,
    status: draft.status,
    date: draft.date,
    slug: draft.slug,
    title: draft.title,
    tag: draft.tag,
    image: draft.image,
    extraFrontmatterText: draft.extraFrontmatterText,
    body: draft.body,
  });
}

function toDraftInput(draft: EditorDraft): DraftInput {
  return {
    sourceId: draft.sourceId,
    status: draft.status,
    date: draft.date,
    slug: draft.slug,
    title: draft.title,
    tag: draft.tag,
    image: draft.image,
    extraFrontmatterText: draft.extraFrontmatterText,
    body: draft.body,
  };
}

function createNewDraft(tagOptions: string[]): EditorDraft {
  const today = new Date().toISOString().slice(0, 10);
  const title = "";
  const identity = deriveDocumentIdentity("draft", today, "", title);

  return {
    sourceId: null,
    status: "draft",
    date: today,
    slug: identity.slug,
    title,
    tag: tagOptions[0] ?? "",
    image: "",
    extraFrontmatterText: "",
    body: "",
    fileName: identity.fileName,
    relativePath: identity.relativePath,
    previewPath: identity.previewPath,
    isNew: true,
  };
}

function applyIdentity(draft: EditorDraft) {
  const identity = deriveDocumentIdentity(draft.status, draft.date, draft.slug, draft.title);
  return {
    ...draft,
    slug: identity.slug,
    fileName: identity.fileName,
    relativePath: identity.relativePath,
    previewPath: identity.previewPath,
  };
}

function getLocalDraftError(draft: EditorDraft | null) {
  if (!draft) {
    return null;
  }

  if (!isValidPostDate(draft.date)) {
    return "Date must use YYYY-MM-DD.";
  }

  return null;
}

function getSaveButtonLabel(draft: EditorDraft | null, saving: boolean) {
  if (saving) {
    return "Saving...";
  }

  if (!draft) {
    return "Save";
  }

  if (draft.status === "draft") {
    return draft.sourceId ? "Save Draft" : "Create Draft";
  }

  return draft.sourceId ? "Save Changes" : "Create Post";
}

function getSaveMessage(previousDraft: EditorDraft, savedDraft: EditorDraft) {
  if (savedDraft.status === "draft") {
    return previousDraft.sourceId ? "Draft saved." : "Draft created.";
  }

  if (previousDraft.status === "draft") {
    return previousDraft.sourceId ? "Draft saved as a published post." : "Published post created.";
  }

  return previousDraft.sourceId ? "Post saved." : "Post created.";
}

function getEmptyListMessage(filter: SidebarFilter) {
  if (filter === "draft") {
    return "No drafts yet. Start one from the button above.";
  }

  if (filter === "published") {
    return "No published posts yet.";
  }

  return "No posts yet. Start a draft from the button above.";
}

function shortSha(commitSha: string) {
  return commitSha.slice(0, 7);
}

export default function App() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [activeDraft, setActiveDraft] = useState<EditorDraft | null>(null);
  const [previewSession, setPreviewSession] = useState<PreviewSessionInfo | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>("all");
  const [booting, setBooting] = useState(true);
  const [loadingPost, setLoadingPost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pendingPublish, setPendingPublish] = useState<PublishTransactionInfo | null>(null);
  const [publishDialog, setPublishDialog] = useState<PublishTransactionInfo | null>(null);
  const [publishCommitMessage, setPublishCommitMessage] = useState("");
  const [publishDecisionBusy, setPublishDecisionBusy] = useState<PublishDecision | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [previewPushError, setPreviewPushError] = useState<string | null>(null);
  const [slugLocked, setSlugLocked] = useState(true);
  const [baseline, setBaseline] = useState("");
  const previewSessionIdRef = useRef<string | null>(null);

  const tagOptions = Array.from(new Set(posts.map((post) => post.tag).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
  const visiblePosts = posts.filter((post) => sidebarFilter === "all" || post.status === sidebarFilter);
  const dirty = draftSignature(activeDraft) !== baseline;
  const localDraftError = getLocalDraftError(activeDraft);

  async function refreshPosts(nextSelectedId?: string | null) {
    const postIndex = await api.listPosts();
    setPosts(postIndex.posts);

    if (nextSelectedId !== undefined) {
      setSelectedId(nextSelectedId);
    }
  }

  async function loadPost(postId: string, options?: { skipDirtyCheck?: boolean }) {
    if (!options?.skipDirtyCheck && dirty && !window.confirm("You have unsaved changes. Discard them?")) {
      return;
    }

    setLoadingPost(true);
    setActionMessage(null);
    setAppError(null);

    try {
      const document = await api.getPost(postId);
      startTransition(() => {
        setActiveDraft(document.draft);
        setSelectedId(document.summary.id);
        setBaseline(draftSignature(document.draft));
        setSlugLocked(true);
      });
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to load the selected post.");
    } finally {
      setLoadingPost(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setBooting(true);
      try {
        const [postIndex, session, pending] = await Promise.all([
          api.listPosts(),
          api.createPreviewSession(),
          api.listPendingPublishes(),
        ]);

        if (cancelled) {
          return;
        }

        previewSessionIdRef.current = session.sessionId;
        setPosts(postIndex.posts);
        setPreviewSession(session);
        setPendingPublish(pending.transactions.at(-1) ?? null);

        if (postIndex.posts.length > 0) {
          await loadPost(postIndex.posts[0].id, { skipDirtyCheck: true });
        } else {
          const draft = createNewDraft([]);
          setActiveDraft(draft);
          setBaseline(draftSignature(draft));
          setSelectedId(null);
          setSlugLocked(false);
        }
      } catch (error) {
        if (!cancelled) {
          setAppError(error instanceof Error ? error.message : "Unable to start the editor.");
        }
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    previewSessionIdRef.current = previewSession?.sessionId ?? null;
  }, [previewSession?.sessionId]);

  useEffect(() => {
    setPublishCommitMessage(publishDialog?.commitMessage ?? "");
  }, [publishDialog?.transactionId, publishDialog?.commitMessage]);

  useEffect(() => {
    if (!previewSession?.sessionId) {
      return;
    }

    const interval = window.setInterval(async () => {
      try {
        const status = await api.getPreviewSession(previewSession.sessionId);
        setPreviewSession(status);
      } catch (error) {
        setPreviewPushError(error instanceof Error ? error.message : "Preview status check failed.");
      }
    }, sessionPollMs);

    return () => window.clearInterval(interval);
  }, [previewSession?.sessionId]);

  useEffect(() => {
    if (!previewSession?.previewUrl || previewSession.state !== "ready") {
      setIframeUrl((current) => (current === null ? current : null));
      return;
    }

    setIframeUrl((current) => {
      if (current && (current === previewSession.previewUrl || current.startsWith(`${previewSession.previewUrl}?`))) {
        return current;
      }

      return `${previewSession.previewUrl}?v=${Date.now()}`;
    });
  }, [previewSession?.previewUrl, previewSession?.state]);

  useEffect(() => {
    if (!activeDraft || !previewSession?.sessionId) {
      return;
    }

    if (localDraftError) {
      setPreviewPushError(localDraftError);
      return;
    }

    const timeout = window.setTimeout(async () => {
      try {
        const status = await api.updatePreviewSession(previewSession.sessionId, toDraftInput(activeDraft));
        setPreviewSession(status);
        setPreviewPushError(status.lastError);
        if (status.state === "ready" && status.previewUrl) {
          setIframeUrl(`${status.previewUrl}?v=${Date.now()}`);
        } else if (status.state !== "ready") {
          setIframeUrl(null);
        }
      } catch (error) {
        setPreviewPushError(error instanceof Error ? error.message : "Unable to refresh the preview.");
      }
    }, previewRefreshMs);

    return () => window.clearTimeout(timeout);
  }, [
    activeDraft?.status,
    activeDraft?.date,
    activeDraft?.slug,
    activeDraft?.title,
    activeDraft?.tag,
    activeDraft?.image,
    activeDraft?.extraFrontmatterText,
    activeDraft?.body,
    activeDraft?.sourceId,
    previewSession?.sessionId,
    localDraftError,
  ]);

  useEffect(() => {
    if (!dirty) {
      return;
    }

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  useEffect(() => {
    return () => {
      const sessionId = previewSessionIdRef.current;
      if (sessionId) {
        void api.deletePreviewSession(sessionId).catch(() => undefined);
      }
    };
  }, []);

  function patchDraft(updater: (draft: EditorDraft) => EditorDraft) {
    setActiveDraft((current) => {
      if (!current) {
        return current;
      }

      return applyIdentity(updater(current));
    });
  }

  function handleTitleChange(nextTitle: string) {
    patchDraft((draft) => {
      const nextDraft = { ...draft, title: nextTitle };
      if (!slugLocked) {
        nextDraft.slug = normalizeSlug(draft.slug === normalizeSlug(draft.title) ? "" : draft.slug, nextTitle);
      }
      return nextDraft;
    });
  }

  function handleCreatePost() {
    if (dirty && !window.confirm("You have unsaved changes. Discard them and create a new draft?")) {
      return;
    }

    const draft = createNewDraft(tagOptions);
    setActiveDraft(draft);
    setBaseline(draftSignature(draft));
    setSelectedId(null);
    setActionMessage("Started a new draft.");
    setSlugLocked(false);
  }

  async function handleSave(options?: { confirmCreate?: boolean; targetStatus?: PostStatus }) {
    if (!activeDraft || saving || publishing) {
      return;
    }

    const nextDraft = applyIdentity({
      ...activeDraft,
      status: options?.targetStatus ?? activeDraft.status,
    });

    if (!nextDraft.title.trim()) {
      setAppError(`Add a title before saving the ${nextDraft.status === "draft" ? "draft" : "post"}.`);
      return;
    }

    if (localDraftError) {
      setAppError(localDraftError);
      return;
    }

    if (!activeDraft.sourceId && options?.confirmCreate) {
      const noun = nextDraft.status === "draft" ? "draft" : "blog post";
      const confirmed = window.confirm(`Create a new ${noun} titled "${nextDraft.title.trim()}"?`);
      if (!confirmed) {
        return;
      }
    }

    setSaving(true);
    setAppError(null);
    setActionMessage(null);

    try {
      const savedDocument: PostDocument = activeDraft.sourceId
        ? await api.updatePost(activeDraft.sourceId, toDraftInput(nextDraft))
        : await api.createPost(toDraftInput(nextDraft));

      setActiveDraft(savedDocument.draft);
      setBaseline(draftSignature(savedDocument.draft));
      setSelectedId(savedDocument.summary.id);
      setSlugLocked(true);
      setActionMessage(getSaveMessage(activeDraft, savedDocument.draft));
      await refreshPosts(savedDocument.summary.id);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to save this post.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!activeDraft || saving || publishing) {
      return;
    }

    if (pendingPublish) {
      setPublishDialog(pendingPublish);
      return;
    }

    if (!activeDraft.title.trim()) {
      setAppError("Add a title before publishing this post.");
      return;
    }

    if (localDraftError) {
      setAppError(localDraftError);
      return;
    }

    setPublishing(true);
    setAppError(null);
    setActionMessage(null);

    try {
      const result = await api.publishPost(toDraftInput(activeDraft));

      setActiveDraft(result.document.draft);
      setBaseline(draftSignature(result.document.draft));
      setSelectedId(result.document.summary.id);
      setSlugLocked(true);
      await refreshPosts(result.document.summary.id);
      setPendingPublish(result.transaction);
      setPublishDialog(result.transaction);
      setActionMessage(`Created local publish commit ${shortSha(result.transaction.commitSha)}.`);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to publish this post.");
    } finally {
      setPublishing(false);
    }
  }

  async function handlePublishDecision(decision: PublishDecision) {
    if (!publishDialog || publishDecisionBusy) {
      return;
    }

    setPublishDecisionBusy(decision);
    setAppError(null);

    try {
      let transaction = publishDialog;

      if (decision !== "cancel") {
        const nextMessage = publishCommitMessage.trim();

        if (!nextMessage) {
          setAppError("Commit message is required.");
          return;
        }

        if (nextMessage !== publishDialog.commitMessage) {
          transaction = await api.updatePublish(publishDialog.transactionId, nextMessage);
          setPendingPublish(transaction);
          setPublishDialog(transaction);
        }
      }

      if (decision === "push") {
        const pushedTransaction = await api.pushPublish(transaction.transactionId);
        setPendingPublish(null);
        setActionMessage(
          `Pushed publish commit ${shortSha(pushedTransaction.commitSha)} to ${pushedTransaction.upstreamBranch ?? pushedTransaction.branchName}.`,
        );
      } else if (decision === "keep") {
        const keptTransaction = await api.keepPublish(transaction.transactionId);
        setPendingPublish(keptTransaction);
        setActionMessage(
          `Kept local publish commit ${shortSha(keptTransaction.commitSha)} on ${keptTransaction.branchName}. Use Publish to push it later.`,
        );
      } else {
        const cancelledTransaction = await api.cancelPublish(transaction.transactionId);
        setPendingPublish(null);
        setActionMessage(
          `Removed local publish commit ${shortSha(cancelledTransaction.commitSha)}. Your saved files remain in the working tree.`,
        );
      }

      setPublishDialog(null);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to finish the publish workflow.");
    } finally {
      setPublishDecisionBusy(null);
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s";

      if (!isSaveShortcut) {
        return;
      }

      event.preventDefault();
      void handleSave({ confirmCreate: true });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeDraft, saving, publishing, localDraftError]);

  async function handleDelete() {
    if (!activeDraft) {
      return;
    }

    if (!activeDraft.sourceId) {
      if (!window.confirm("Discard this unsaved draft?")) {
        return;
      }

      const draft = createNewDraft(tagOptions);
      setActiveDraft(draft);
      setBaseline(draftSignature(draft));
      setSelectedId(null);
      setSlugLocked(false);
      setActionMessage("Draft discarded.");
      return;
    }

    const noun = activeDraft.status === "draft" ? "draft" : "post";
    if (!window.confirm(`Move "${activeDraft.title}" ${activeDraft.status === "draft" ? "draft " : ""}to the local archive?`)) {
      return;
    }

    try {
      await api.deletePost(activeDraft.sourceId);
      await refreshPosts(null);

      const refreshed = await api.listPosts();
      setPosts(refreshed.posts);

      if (refreshed.posts.length > 0) {
        await loadPost(refreshed.posts[0].id, { skipDirtyCheck: true });
      } else {
        const draft = createNewDraft(tagOptions);
        setActiveDraft(draft);
        setBaseline(draftSignature(draft));
        setSelectedId(null);
        setSlugLocked(false);
      }

      setActionMessage(`${noun[0].toUpperCase()}${noun.slice(1)} moved to the local archive.`);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to delete this post.");
    }
  }

  async function handleDiscardUnpublished() {
    if (!activeDraft?.sourceId) {
      return;
    }

    const confirmed = window.confirm(
      `Discard all unpublished changes for "${activeDraft.title}" and restore the upstream version?\n\nThis removes unsaved editor edits and local file changes. If this file does not exist on the remote, it will be removed locally.`,
    );

    if (!confirmed) {
      return;
    }

    setAppError(null);
    setActionMessage(null);

    try {
      const discarded = await api.discardPost(activeDraft.sourceId);

      if (discarded.cancelledPendingPublish) {
        setPendingPublish(null);
        setPublishDialog(null);
      }

      if (discarded.document) {
        await refreshPosts(discarded.document.summary.id);
        await loadPost(discarded.document.summary.id, { skipDirtyCheck: true });
        setActionMessage(
          discarded.cancelledPendingPublish
            ? "Restored the upstream version and removed the pending local publish commit."
            : "Restored the upstream version.",
        );
        return;
      }

      await refreshPosts(null);

      const refreshed = await api.listPosts();
      setPosts(refreshed.posts);

      if (refreshed.posts.length > 0) {
        await loadPost(refreshed.posts[0].id, { skipDirtyCheck: true });
      } else {
        const draft = createNewDraft(tagOptions);
        setActiveDraft(draft);
        setBaseline(draftSignature(draft));
        setSelectedId(null);
        setSlugLocked(false);
      }

      setActionMessage(
        discarded.cancelledPendingPublish
          ? "Removed the local-only file to match upstream and cleared the pending local publish commit."
          : "Removed the local-only file to match upstream.",
      );
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to discard unpublished changes for this post.");
    }
  }

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-header">
            <div>
              <p className="eyebrow">Tanay&apos;s Blog</p>
              <h1>Editor</h1>
            </div>
            <button className="primary-button" onClick={handleCreatePost}>
              New Draft
            </button>
          </div>

          <div className="sidebar-status">
            <span className={`status-pill status-${previewSession?.state ?? "starting"}`}>
              Preview {previewSession?.state ?? "starting"}
            </span>
            {dirty ? <span className="status-pill status-dirty">Unsaved changes</span> : null}
          </div>

          <div className="filter-bar" aria-label="Post filter">
            <button
              className={`filter-chip ${sidebarFilter === "all" ? "active" : ""}`}
              onClick={() => setSidebarFilter("all")}
            >
              All
            </button>
            <button
              className={`filter-chip ${sidebarFilter === "draft" ? "active" : ""}`}
              onClick={() => setSidebarFilter("draft")}
            >
              Drafts
            </button>
            <button
              className={`filter-chip ${sidebarFilter === "published" ? "active" : ""}`}
              onClick={() => setSidebarFilter("published")}
            >
              Published
            </button>
          </div>

          <div className="post-list">
            {visiblePosts.map((post) => (
              <button
                key={post.id}
                className={`post-card ${selectedId === post.id ? "active" : ""}`}
                onClick={() => void loadPost(post.id)}
              >
                <div className="post-card-header">
                  <span className="post-card-title">{post.title}</span>
                  <span className={`status-pill post-status post-status-${post.status}`}>
                    {post.status === "draft" ? "Draft" : "Published"}
                  </span>
                </div>
                <span className="post-card-meta">
                  {formatDate(post.date)}
                  {post.tag ? ` · ${post.tag}` : ""}
                </span>
                <span className="post-card-excerpt">{post.excerpt || "No excerpt yet."}</span>
              </button>
            ))}
            {visiblePosts.length === 0 ? <div className="empty-state">{getEmptyListMessage(sidebarFilter)}</div> : null}
          </div>
        </aside>

        <main className="workspace">
          <div className="toolbar">
            <div>
              <p className="eyebrow">{activeDraft?.status === "draft" ? "Source Draft" : "Source Post"}</p>
              <h2>{activeDraft ? activeDraft.title.trim() || "New Draft" : "Loading..."}</h2>
              <div className="toolbar-meta">
                <span className={`status-pill post-status post-status-${activeDraft?.status ?? "draft"}`}>
                  {activeDraft?.status === "published" ? "Published" : "Draft"}
                </span>
                <p className="toolbar-subtitle">{activeDraft?.fileName ?? "Preparing editor..."}</p>
              </div>
            </div>

            <div className="toolbar-actions">
              <button className="secondary-button" onClick={() => void handleDelete()} disabled={!activeDraft}>
                {activeDraft?.sourceId ? "Delete" : "Discard"}
              </button>
              {activeDraft?.sourceId ? (
                <button
                  className="secondary-button"
                  onClick={() => void handleDiscardUnpublished()}
                  disabled={saving || publishing}
                >
                  Discard Unpublished
                </button>
              ) : null}
              {activeDraft?.status === "draft" ? (
                <button
                  className="secondary-button"
                  onClick={() => void handleSave({ confirmCreate: true, targetStatus: "published" })}
                  disabled={!activeDraft || saving || publishing}
                >
                  Save As Post
                </button>
              ) : null}
              <button
                className="secondary-button"
                onClick={() => void handleSave({ confirmCreate: true })}
                disabled={!activeDraft || saving || publishing}
              >
                {getSaveButtonLabel(activeDraft, saving)}
              </button>
              <button className="primary-button" onClick={() => void handlePublish()} disabled={!activeDraft || publishing}>
                {publishing ? "Committing..." : pendingPublish ? "Publish Commit" : "Publish"}
              </button>
            </div>
          </div>

          {appError ? <div className="banner banner-error">{appError}</div> : null}
          {actionMessage ? <div className="banner banner-success">{actionMessage}</div> : null}
          {pendingPublish && !publishDialog ? (
            <div className="banner banner-publish">
              <div className="banner-copy">
                Local publish commit <code>{shortSha(pendingPublish.commitSha)}</code> is waiting on{" "}
                <code>{pendingPublish.branchName}</code>.
              </div>
              <div className="banner-actions">
                <button className="secondary-button" onClick={() => setPublishDialog(pendingPublish)}>
                  Review Commit
                </button>
              </div>
            </div>
          ) : null}

          <div className="editor-grid">
            <section className="editor-panel">
              <div className="panel-header">
                <h3>Writing</h3>
                <p>The left side edits the Markdown source. The right side shows the real Jekyll render.</p>
              </div>

              <div className="editor-panel-body">
                {booting || loadingPost || !activeDraft ? (
                  <div className="panel-empty">Preparing the editor...</div>
                ) : (
                  <div className="editor-form">
                    <div className="metadata-grid">
                      <label>
                        <span>Title</span>
                        <input
                          value={activeDraft.title}
                          onChange={(event) => handleTitleChange(event.target.value)}
                          placeholder="Post title"
                        />
                      </label>

                      <label>
                        <span>Date</span>
                        <input
                          value={activeDraft.date}
                          onChange={(event) => patchDraft((draft) => ({ ...draft, date: event.target.value }))}
                          placeholder="YYYY-MM-DD"
                        />
                      </label>

                      <label>
                        <span>Slug</span>
                        <input
                          value={activeDraft.slug}
                          onChange={(event) => {
                            setSlugLocked(true);
                            patchDraft((draft) => ({ ...draft, slug: event.target.value }));
                          }}
                          placeholder="post-slug"
                        />
                      </label>

                      <label>
                        <span>Tag</span>
                        <input
                          list="tag-options"
                          value={activeDraft.tag}
                          onChange={(event) => patchDraft((draft) => ({ ...draft, tag: event.target.value }))}
                          placeholder="CS"
                        />
                        <datalist id="tag-options">
                          {tagOptions.map((tag) => (
                            <option key={tag} value={tag} />
                          ))}
                        </datalist>
                      </label>

                      <label className="metadata-span">
                        <span>Preview image</span>
                        <input
                          value={activeDraft.image}
                          onChange={(event) => patchDraft((draft) => ({ ...draft, image: event.target.value }))}
                          placeholder="/images/example.png"
                        />
                      </label>
                    </div>

                    <label className="advanced-frontmatter">
                      <span>Advanced front matter</span>
                      <textarea
                        value={activeDraft.extraFrontmatterText}
                        onChange={(event) =>
                          patchDraft((draft) => ({ ...draft, extraFrontmatterText: event.target.value }))
                        }
                        placeholder={"cover_url: https://...\ncover_meta: >\n  Photo by ..."}
                      />
                    </label>

                    <div className="editor-surface">
                      <CodeMirror
                        value={activeDraft.body}
                        height="auto"
                        extensions={[
                          markdown({ codeLanguages: languages }),
                          EditorView.lineWrapping,
                          editorPlaceholder("Start writing your post..."),
                        ]}
                        basicSetup={{
                          foldGutter: false,
                          dropCursor: false,
                          allowMultipleSelections: false,
                        }}
                        onChange={(value) => patchDraft((draft) => ({ ...draft, body: value }))}
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="preview-panel">
              <div className="panel-header">
                <h3>Rendered Blog</h3>
                <p>{activeDraft?.previewPath ?? "Waiting for a draft..."}</p>
              </div>

              <div className="preview-panel-body">
                {localDraftError ? <div className="banner banner-warning">{localDraftError}</div> : null}
                {previewPushError && previewPushError !== localDraftError ? (
                  <div className="banner banner-error">{previewPushError}</div>
                ) : null}

                <div className="preview-frame-shell">
                  {!iframeUrl ? (
                    <div className="panel-empty">Starting the Jekyll preview...</div>
                  ) : (
                    <iframe className="preview-frame" src={iframeUrl} title="Rendered blog preview" />
                  )}
                </div>

                {previewSession?.recentLogs.length ? (
                  <details className="log-panel">
                    <summary className="log-header">Preview logs</summary>
                    <pre>{previewSession.recentLogs.join("\n")}</pre>
                  </details>
                ) : null}
              </div>
            </section>
          </div>
        </main>
      </div>

      {publishDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title">
            <p className="eyebrow">Publish Ready</p>
            <h3 id="publish-dialog-title">Local publish commit created</h3>
            <p className="modal-copy">
              Commit <code>{shortSha(publishDialog.commitSha)}</code> is on <code>{publishDialog.branchName}</code>.
              Choose whether to push it now, keep it locally for preview, or remove the commit while leaving the saved
              files in your working tree.
            </p>

            <div className="modal-meta">
              <div>
                <span>Commit message</span>
                <input
                  value={publishCommitMessage}
                  onChange={(event) => setPublishCommitMessage(event.target.value)}
                  placeholder="blog(editor): publish your-post-slug"
                />
              </div>
              <div>
                <span>Upstream</span>
                <strong>{publishDialog.upstreamBranch ?? "Not configured"}</strong>
              </div>
            </div>

            {!publishDialog.pushAvailable ? (
              <div className="banner banner-warning">
                This branch has no upstream configured, so Publish is unavailable. Use Preview to keep the local commit
                or Cancel to remove it.
              </div>
            ) : null}

            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => void handlePublishDecision("cancel")}
                disabled={publishDecisionBusy !== null}
              >
                {publishDecisionBusy === "cancel" ? "Cancelling..." : "Cancel"}
              </button>
              <button
                className="secondary-button"
                onClick={() => void handlePublishDecision("keep")}
                disabled={publishDecisionBusy !== null}
              >
                {publishDecisionBusy === "keep" ? "Keeping..." : "Preview"}
              </button>
              <button
                className="primary-button"
                onClick={() => void handlePublishDecision("push")}
                disabled={publishDecisionBusy !== null || !publishDialog.pushAvailable}
              >
                {publishDecisionBusy === "push" ? "Publishing..." : "Publish"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
