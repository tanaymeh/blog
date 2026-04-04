import { useEffect, useRef, useState, startTransition } from "react";

import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView, placeholder as editorPlaceholder } from "@codemirror/view";

import { derivePostIdentity, isValidPostDate, normalizeSlug } from "../shared/draft";
import { DraftInput, EditorDraft, PostDocument, PostSummary, PreviewSessionInfo } from "../shared/types";
import { api } from "./api";

const previewRefreshMs = 450;
const sessionPollMs = 2000;

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
  const identity = derivePostIdentity(today, "", title);

  return {
    sourceId: null,
    date: today,
    slug: identity.slug,
    title,
    tag: tagOptions[0] ?? "",
    image: "",
    extraFrontmatterText: "",
    body: "",
    fileName: identity.fileName,
    previewPath: identity.previewPath,
    isNew: true,
  };
}

function applyIdentity(draft: EditorDraft) {
  const identity = derivePostIdentity(draft.date, draft.slug, draft.title);
  return {
    ...draft,
    slug: identity.slug,
    fileName: identity.fileName,
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

export default function App() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [activeDraft, setActiveDraft] = useState<EditorDraft | null>(null);
  const [previewSession, setPreviewSession] = useState<PreviewSessionInfo | null>(null);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [loadingPost, setLoadingPost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [previewPushError, setPreviewPushError] = useState<string | null>(null);
  const [slugLocked, setSlugLocked] = useState(true);
  const [baseline, setBaseline] = useState("");
  const previewSessionIdRef = useRef<string | null>(null);

  const tagOptions = Array.from(new Set(posts.map((post) => post.tag).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
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
        const [postIndex, session] = await Promise.all([api.listPosts(), api.createPreviewSession()]);

        if (cancelled) {
          return;
        }

        previewSessionIdRef.current = session.sessionId;
        setPosts(postIndex.posts);
        setPreviewSession(session);

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

  async function handleSave(options?: { confirmCreate?: boolean }) {
    if (!activeDraft || saving) {
      return;
    }

    if (!activeDraft.title.trim()) {
      setAppError("Add a title before saving the post.");
      return;
    }

    if (localDraftError) {
      setAppError(localDraftError);
      return;
    }

    if (!activeDraft.sourceId && options?.confirmCreate) {
      const confirmed = window.confirm(`Create a new blog post titled "${activeDraft.title.trim()}"?`);
      if (!confirmed) {
        return;
      }
    }

    setSaving(true);
    setAppError(null);
    setActionMessage(null);

    try {
      const savedDocument: PostDocument = activeDraft.sourceId
        ? await api.updatePost(activeDraft.sourceId, toDraftInput(activeDraft))
        : await api.createPost(toDraftInput(activeDraft));

      setActiveDraft(savedDocument.draft);
      setBaseline(draftSignature(savedDocument.draft));
      setSelectedId(savedDocument.summary.id);
      setSlugLocked(true);
      setActionMessage(activeDraft.sourceId ? "Post saved." : "Post created.");
      await refreshPosts(savedDocument.summary.id);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to save this post.");
    } finally {
      setSaving(false);
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
  }, [activeDraft, saving, localDraftError]);

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

    if (!window.confirm(`Move "${activeDraft.title}" to the local trash archive?`)) {
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

      setActionMessage("Post moved to draft/deleted.");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Unable to delete this post.");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Tanay's Blog</p>
            <h1>Editor</h1>
          </div>
          <button className="primary-button" onClick={handleCreatePost}>
            New Post
          </button>
        </div>

        <div className="sidebar-status">
          <span className={`status-pill status-${previewSession?.state ?? "starting"}`}>
            Preview {previewSession?.state ?? "starting"}
          </span>
          {dirty ? <span className="status-pill status-dirty">Unsaved changes</span> : null}
        </div>

        <div className="post-list">
          {posts.map((post) => (
            <button
              key={post.id}
              className={`post-card ${selectedId === post.id ? "active" : ""}`}
              onClick={() => void loadPost(post.id)}
            >
              <span className="post-card-title">{post.title}</span>
              <span className="post-card-meta">
                {formatDate(post.date)}
                {post.tag ? ` · ${post.tag}` : ""}
              </span>
              <span className="post-card-excerpt">{post.excerpt || "No excerpt yet."}</span>
            </button>
          ))}
          {posts.length === 0 ? <div className="empty-state">No posts yet. Start a draft from the button above.</div> : null}
        </div>
      </aside>

      <main className="workspace">
        <div className="toolbar">
          <div>
            <p className="eyebrow">Source Post</p>
            <h2>{activeDraft ? activeDraft.title.trim() || "New Draft" : "Loading..."}</h2>
            <p className="toolbar-subtitle">{activeDraft?.fileName ?? "Preparing editor..."}</p>
          </div>

          <div className="toolbar-actions">
            <button className="secondary-button" onClick={() => void handleDelete()} disabled={!activeDraft}>
              {activeDraft?.sourceId ? "Delete" : "Discard"}
            </button>
            <button className="primary-button" onClick={() => void handleSave()} disabled={!activeDraft || saving}>
              {saving ? "Saving..." : activeDraft?.sourceId ? "Save Changes" : "Create Post"}
            </button>
          </div>
        </div>

        {appError ? <div className="banner banner-error">{appError}</div> : null}
        {actionMessage ? <div className="banner banner-success">{actionMessage}</div> : null}

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
                      height="100%"
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
  );
}
