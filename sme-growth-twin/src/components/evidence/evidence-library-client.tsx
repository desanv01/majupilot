"use client";

import { workspaceRequest } from "@/infrastructure/persistence/workspace-request";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import Link from "next/link";

import { ProductHeader } from "@/components/navigation/product-header";
import { DOCUMENT_LIMITS, type EvidenceDocument } from "@/domain/documents";
import { loadCurrentDurableJourney } from "@/infrastructure/persistence/current-durable-journey";

type ApiError = { error?: { code?: string; requestId?: string } };
type Notice = { kind: "info" | "error" | "success"; text: string };

const statusCopy: Record<EvidenceDocument["status"], string> = {
  processing: "Extracting and embedding",
  ready: "Ready for Copilot",
  failed: "Processing failed",
  unsupported: "Unsupported",
  duplicate: "Duplicate not stored",
  deleted: "Deleted and excluded",
};

const failureCopy: Record<string, string> = {
  DOCUMENT_CORRUPT: "The file is corrupt or contains no extractable text.",
  DOCUMENT_SUSPICIOUS: "The file was rejected because its structure is unsafe.",
  DOCUMENT_PAGE_LIMIT: `The PDF exceeds the ${DOCUMENT_LIMITS.maxPdfPages} page limit.`,
  DOCUMENT_TEXT_LIMIT: "The extracted text exceeds the bounded processing limit.",
  DOCUMENT_CHUNK_LIMIT: "The document would create too many evidence chunks.",
  DOCUMENT_PROCESSING_FAILED: "Document processing did not complete.",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function api<T>(url: string, init?: RequestInit) {
  const result = await fetch(url, workspaceRequest({ ...init, cache: "no-store" }));
  const body = await result.json().catch(() => undefined) as { data?: T } & ApiError | undefined;
  if (!result.ok || body?.data === undefined) throw new Error(body?.error?.code ?? `request_${result.status}`);
  return body.data;
}

export function EvidenceLibraryClient() {
  const [assessmentSessionId, setAssessmentSessionId] = useState<string>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [documents, setDocuments] = useState<EvidenceDocument[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<File>();
  const [pendingDelete, setPendingDelete] = useState<EvidenceDocument>();
  const [notice, setNotice] = useState<Notice>({ kind: "info", text: "Opening your assessment-scoped Evidence Library..." });
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async (assessmentId: string, organizationScope?: string) => {
    const scope = organizationScope ? `&organizationId=${encodeURIComponent(organizationScope)}` : "";
    const data = await api<EvidenceDocument[]>(`/api/v2/evidence-documents?assessmentSessionId=${encodeURIComponent(assessmentId)}${scope}`);
    setDocuments(data);
  }, []);

  const openLibrary = useCallback(async () => {
    try {
      const context = await loadCurrentDurableJourney(localStorage);
      if (!context?.artifactIds?.blueprint) {
        setNotice({ kind: "error", text: "Complete and sync the current Blueprint before adding uploaded evidence." });
        return;
      }
      setAssessmentSessionId(context.assessmentSessionId);
      setOrganizationId(context.organizationId);
      await refresh(context.assessmentSessionId, context.organizationId);
      setNotice({ kind: "info", text: "Files stay private and are available only inside this assessment." });
    } catch {
      setNotice({ kind: "error", text: "The Evidence Library could not be opened safely. Your saved work was not changed." });
    } finally {
      setReady(true);
    }
  }, [refresh]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void openLibrary(); });
    return () => window.cancelAnimationFrame(frame);
  }, [openLibrary]);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setSelected(undefined);
    if (!file) return;
    const extension = file.name.toLowerCase().split(".").pop();
    if (!extension || !["pdf", "docx", "txt"].includes(extension)) {
      setNotice({ kind: "error", text: "Unsupported file. Choose a PDF, DOCX, or TXT document." });
      event.target.value = "";
      return;
    }
    if (file.size > DOCUMENT_LIMITS.maxFileBytes) {
      setNotice({ kind: "error", text: `Oversized file. The secure upload limit is ${formatBytes(DOCUMENT_LIMITS.maxFileBytes)}.` });
      event.target.value = "";
      return;
    }
    setSelected(file);
    setNotice({ kind: "info", text: `${file.name} is ready to upload and process.` });
  };

  const upload = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !assessmentSessionId || busy) return;
    setBusy(true);
    setNotice({ kind: "info", text: "Uploading privately, extracting text, and creating bounded embeddings..." });
    try {
      const form = new FormData();
      form.set("assessmentSessionId", assessmentSessionId);
      if (organizationId) form.set("organizationId", organizationId);
      form.set("file", selected);
      const document = await api<EvidenceDocument>("/api/v2/evidence-documents", { method: "POST", body: form });
      await refresh(assessmentSessionId, organizationId);
      setSelected(undefined);
      if (inputRef.current) inputRef.current.value = "";
      setNotice(document.status === "ready"
        ? { kind: "success", text: `${document.originalFilename} is ready for cited Copilot answers.` }
        : document.status === "duplicate"
          ? { kind: "info", text: "This exact file already exists in the assessment. A duplicate was not stored." }
          : { kind: "error", text: failureCopy[document.failureCode ?? ""] ?? "The document was safely rejected." });
    } catch (error) {
      const code = error instanceof Error ? error.message : "DOCUMENT_PROCESSING_FAILED";
      setNotice({ kind: "error", text: failureCopy[code] ?? (code === "DOCUMENT_TOO_LARGE" ? "The file exceeds the secure upload limit." : "The upload could not be completed safely.") });
    } finally { setBusy(false); }
  };

  const requestDelete = (document: EvidenceDocument) => {
    setPendingDelete(document);
    deleteDialogRef.current?.showModal();
  };

  const cancelDelete = () => {
    deleteDialogRef.current?.close();
    setPendingDelete(undefined);
  };

  const remove = async () => {
    const document = pendingDelete;
    if (!document || !assessmentSessionId || busy) return;
    deleteDialogRef.current?.close();
    setBusy(true);
    try {
      await api(`/api/v2/evidence-documents/${document.id}?assessmentSessionId=${assessmentSessionId}${organizationId ? `&organizationId=${organizationId}` : ""}`, { method: "DELETE" });
      await refresh(assessmentSessionId, organizationId);
      setNotice({ kind: "success", text: `${document.originalFilename} was deleted and excluded from retrieval.` });
    } catch { setNotice({ kind: "error", text: "The document could not be deleted safely." }); }
    finally { setBusy(false); setPendingDelete(undefined); }
  };

  const reprocess = async (document: EvidenceDocument) => {
    if (!assessmentSessionId || busy) return;
    setBusy(true);
    setNotice({ kind: "info", text: `Reprocessing ${document.originalFilename} with the current embedding version...` });
    try {
      const updated = await api<EvidenceDocument>(`/api/v2/evidence-documents/${document.id}/reprocess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assessmentSessionId, organizationId }) });
      await refresh(assessmentSessionId, organizationId);
      setNotice(updated.status === "ready" ? { kind: "success", text: `${updated.originalFilename} is ready again.` } : { kind: "error", text: failureCopy[updated.failureCode ?? ""] ?? "Reprocessing failed safely." });
    } catch { setNotice({ kind: "error", text: "The document could not be reprocessed safely." }); }
    finally { setBusy(false); }
  };

  const download = async (document: EvidenceDocument) => {
    if (!assessmentSessionId || busy) return;
    setBusy(true);
    try {
      const signed = await api<{ url: string }>(`/api/v2/evidence-documents/${document.id}/download?assessmentSessionId=${assessmentSessionId}${organizationId ? `&organizationId=${organizationId}` : ""}`);
      window.location.assign(signed.url);
    } catch { setNotice({ kind: "error", text: "A short-lived authorized download could not be created." }); }
    finally { setBusy(false); }
  };

  return (
    <div className="evidence-page">
      <ProductHeader current="evidence" />
      <main id="main-content" className="evidence-shell">
        <section className="evidence-intro">
          <div><p className="eyebrow">Assessment Evidence Library</p><h1>Give Copilot a private source shelf.</h1><p>Upload bounded documents for cited answers without changing your deterministic Business Twin, scores, or Blueprint.</p></div>
          <dl><div><dt>Formats</dt><dd>PDF, DOCX, TXT</dd></div><div><dt>Limit</dt><dd>{formatBytes(DOCUMENT_LIMITS.maxFileBytes)}</dd></div><div><dt>PDF cap</dt><dd>{DOCUMENT_LIMITS.maxPdfPages} pages</dd></div></dl>
        </section>

        {!ready || !assessmentSessionId ? (
          <section className="evidence-gate" aria-busy={!ready} role={ready && notice.kind === "error" ? "alert" : undefined}>
            <h2>{ready ? (notice.text.startsWith("Complete") ? "A completed Blueprint is required" : "The library could not open") : "Opening your library"}</h2>
            <p>{notice.text}</p>
            {ready ? <div className="evidence-gate-actions"><Link className="button primary" href="/blueprint">Return to Blueprint</Link>{!notice.text.startsWith("Complete") ? <button className="button secondary" type="button" onClick={() => { setReady(false); setNotice({ kind: "info", text: "Opening your assessment-scoped Evidence Library..." }); void openLibrary(); }}>Try again</button> : null}</div> : null}
          </section>
        ) : (
          <div className="evidence-grid">
            <section className="evidence-upload" aria-labelledby="upload-heading">
              <p className="eyebrow">Private upload</p><h2 id="upload-heading">Add one trusted source</h2>
              <p>Uploaded text is treated as untrusted evidence, never as instructions. Files are scanned structurally, extracted server-side, and never executed.</p>
              <form onSubmit={upload}>
                <div className="evidence-file-control">
                  <input className="evidence-file-input" ref={inputRef} id="evidence-file" name="file" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" onChange={choose} disabled={busy} />
                  <label className="evidence-file" htmlFor="evidence-file"><span>{selected ? selected.name : "Choose a PDF, DOCX, or TXT file"}</span><small>{selected ? formatBytes(selected.size) : `Maximum ${formatBytes(DOCUMENT_LIMITS.maxFileBytes)}`}</small></label>
                </div>
                <button className="button primary" type="submit" disabled={!selected || busy}>{busy ? "Processing securely..." : "Upload and process"}</button>
              </form>
              <p className={`evidence-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>
            </section>

            <section className="evidence-list" aria-labelledby="library-heading" aria-busy={busy}>
              <header><div><p className="eyebrow">Source ledger</p><h2 id="library-heading">Documents in this assessment</h2></div><span>{documents.filter((document) => document.status === "ready").length} ready</span></header>
              {!documents.length ? <div className="evidence-empty"><h3>No uploaded evidence yet</h3><p>Copilot still works with deterministic platform facts. Uploads only add a clearly labelled document source.</p></div> : (
                <ul>
                  {documents.map((document) => (
                    <li key={document.id} className={`document-row status-${document.status}`}>
                      <div className="document-main"><span className="document-type">{document.mimeType === "application/pdf" ? "PDF" : document.mimeType === "text/plain" ? "TXT" : "DOCX"}</span><div><h3>{document.originalFilename}</h3><p>{formatBytes(document.byteLength)}; {document.pageCount ? `${document.pageCount} pages; ` : ""}{document.chunkCount} searchable chunks</p></div></div>
                      <div className="document-state"><strong>{statusCopy[document.status]}</strong><small>{document.status === "failed" && document.canReprocess ? "The private original is stored and can be reprocessed." : document.failureCode ? failureCopy[document.failureCode] ?? document.failureCode : document.status === "ready" ? "Available for grounded answers" : "Processing record retained"}</small><details className="evidence-technical"><summary>Technical details</summary><dl><div><dt>Document reference</dt><dd>{document.id}</dd></div>{document.embeddingVersion ? <div><dt>Embedding version</dt><dd>{document.embeddingVersion}</dd></div> : null}</dl></details></div>
                      <div className="document-actions">
                        {document.status === "ready" ? <button type="button" onClick={() => void download(document)} disabled={busy}>Download</button> : null}
                        {document.status === "failed" && document.canReprocess ? <button type="button" onClick={() => void reprocess(document)} disabled={busy}>Reprocess</button> : null}
                        {document.status !== "deleted" ? <button className="danger-link" type="button" onClick={() => requestDelete(document)} disabled={busy}>Delete</button> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </main>
      <dialog className="evidence-delete-dialog" ref={deleteDialogRef} onClose={() => setPendingDelete(undefined)}>
        <div>
          <p className="eyebrow">Remove private evidence</p>
          <h2>Delete {pendingDelete?.originalFilename}?</h2>
          <p>Its original file and searchable chunks will no longer be available to Copilot. This cannot be undone.</p>
          <div className="evidence-delete-actions">
            <button className="button secondary" type="button" onClick={cancelDelete}>Keep document</button>
            <button className="button danger" type="button" onClick={() => void remove()} disabled={busy}>Delete document</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
