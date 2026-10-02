"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ProductHeader } from "@/components/navigation/product-header";
import type { CopilotMessage } from "@/domain/copilot";
import { loadCurrentDurableJourney } from "@/infrastructure/persistence/current-durable-journey";
import { matchesCopilotDeepLink } from "@/infrastructure/persistence/durable-journey-client";
import { workspaceIdentity, workspaceRequest } from "@/infrastructure/persistence/workspace-request";

import {
  CopilotApiError,
  type CopilotApiErrorBody,
  type CopilotClientMessage,
  copilotErrorPresentation,
  COPILOT_WELCOME_TEXT,
  prepareCopilotRetry,
  restoreCopilotMessages,
  shouldOfferCopilotRetry,
} from "./copilot-client-utils";

export type ToolCall = { toolName: string; status: "completed" | "confirmation_required" | "rejected"; confirmationId: string | null; result?: Record<string, unknown> | null };
type Message = CopilotClientMessage & { tools?: ToolCall[]; streaming?: boolean; draft?: boolean };
type Session = { id: string };
type HistoryResponse = { session: Session; messages: CopilotMessage[] };
type HealthResponse = { state: string; liveAvailable: boolean };
type TurnResult = { turnId: string; text: string; state: string; toolCalls: ToolCall[] };
type StreamEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "status"; phase: "thinking" | "tool_running" | "tool_completed" | "persisting"; toolName?: string }
  | { type: "text_delta"; delta: string }
  | { type: "completed"; data: TurnResult }
  | { type: "error"; error: CopilotApiErrorBody };

type Citation = { documentId: string; chunkId: string; documentName: string; pageNumber: number | null; sectionRef: string; excerpt: string; reference: string };
type WebSource = { title: string; url: string; snippet: string; date: string | null; lastUpdated: string | null };

function citationsFor(tools: ToolCall[] | undefined) {
  const citations: Citation[] = [];
  for (const call of tools ?? []) {
    if (call.toolName === "searchUploadedEvidence" && Array.isArray(call.result?.citations)) citations.push(...call.result.citations as Citation[]);
    if (call.toolName === "getDocumentExcerpt" && call.result?.citation) citations.push(call.result.citation as Citation);
  }
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (!citation?.documentId || !citation?.chunkId || !citation?.documentName || !citation?.excerpt) return false;
    const key = `${citation.documentId}:${citation.chunkId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function webSourcesFor(tools: ToolCall[] | undefined) {
  const sources = (tools ?? []).flatMap((call) => call.toolName === "searchWeb" && Array.isArray(call.result?.sources) ? call.result.sources as WebSource[] : []);
  const seen = new Set<string>();
  return sources.filter((source) => {
    try { const parsed = new URL(source.url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false; } catch { return false; }
    if (!source.title || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

export function UploadedCitations({ tools }: { tools: ToolCall[] | undefined }) {
  const citations = citationsFor(tools);
  if (!citations.length) return null;
  return <aside className="copilot-citations" aria-label="Uploaded evidence citations"><strong>Uploaded evidence</strong>{citations.map((citation) => <blockquote key={citation.chunkId}><header><b>{citation.documentName}</b><span>{citation.pageNumber ? `Page ${citation.pageNumber}` : citation.sectionRef}</span></header><p>{citation.excerpt}</p><details><summary>Technical citation</summary><code>{citation.reference}</code></details></blockquote>)}</aside>;
}

export function WebSources({ tools }: { tools: ToolCall[] | undefined }) {
  const sources = webSourcesFor(tools);
  if (!sources.length) return null;
  return <aside className="copilot-web-sources" aria-label="Public web sources"><strong>Public web sources</strong><ol>{sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer"><span>{source.title}</span><small>{new URL(source.url).hostname} · {source.lastUpdated ? `Updated ${source.lastUpdated}` : source.date ? `Published ${source.date}` : "Date not provided"}</small></a>{source.snippet ? <p>{source.snippet}</p> : null}</li>)}</ol></aside>;
}

export function Markdown({ children }: { children: string }) {
  const safeLink = (url: string) => {
    try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ""; }
    catch { return ""; }
  };
  return <div className="copilot-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeLink} components={{
    a: ({ href, children: label }) => href ? <a href={href} target="_blank" rel="noreferrer">{label}</a> : <span>{label}</span>,
    img: () => null,
  }}>{children}</ReactMarkdown></div>;
}

function TechnicalDiagnostic({ requestId }: { requestId: string }) {
  return <details className="copilot-diagnostic"><summary>Technical details for support</summary><code>{requestId}</code></details>;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, workspaceRequest({ ...init, cache: "no-store" }));
  const body = await response.json().catch(() => undefined) as { data?: T; error?: CopilotApiErrorBody } | undefined;
  if (!response.ok || body?.data === undefined) {
    const error = body?.error;
    throw new CopilotApiError(error?.code ?? `request_${response.status}`, error?.category ?? null, error?.requestId ?? response.headers.get("x-correlation-id"), error?.retryable ?? response.status >= 500, response.status);
  }
  return body.data;
}

async function streamTurn(url: string, body: Record<string, unknown>, signal: AbortSignal, onEvent: (event: StreamEvent) => void) {
  const response = await fetch(url, workspaceRequest({ method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify(body), cache: "no-store", signal }));
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => undefined) as { error?: CopilotApiErrorBody } | undefined;
    const error = payload?.error;
    throw new CopilotApiError(error?.code ?? `request_${response.status}`, error?.category ?? null, error?.requestId ?? response.headers.get("x-correlation-id"), error?.retryable ?? response.status >= 500, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: TurnResult | undefined;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as StreamEvent;
      onEvent(event);
      if (event.type === "completed") completed = event.data;
      if (event.type === "error") throw new CopilotApiError(event.error.code ?? "INTERNAL_RETRYABLE", event.error.category ?? null, event.error.requestId ?? null, event.error.retryable ?? true, 503);
    }
    if (done) break;
  }
  if (!completed) throw new CopilotApiError("INTERNAL_RETRYABLE", "persistence_failure", response.headers.get("x-correlation-id"), true, 503);
  return completed;
}

const activityText = (phase: string, toolName?: string) => {
  if (phase === "tool_running") return toolName === "searchWeb" ? "Searching the public web…" : toolName === "searchUploadedEvidence" || toolName === "getDocumentExcerpt" ? "Searching your private Evidence Library…" : "Reading your authorized MajuPilot records…";
  if (phase === "persisting") return "Saving this turn securely…";
  return "Thinking through your question…";
};

export function CopilotClient({ requestedAssessmentSessionId, requestedBlueprintId }: { requestedAssessmentSessionId?: string; requestedBlueprintId?: string }) {
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [session, setSession] = useState<Session>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [openFailure, setOpenFailure] = useState<{ message: string; requestId: string | null; retryable: boolean }>();
  const [messages, setMessages] = useState<Message[]>([{ id: "welcome", role: "assistant", text: COPILOT_WELCOME_TEXT }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [status, setStatus] = useState("Checking your secure MajuPilot workspace...");
  const logRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const manualPauseRef = useRef(false);
  const touchYRef = useRef<number | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const identity = workspaceIdentity(localStorage);
    const current = () => active && workspaceIdentity(localStorage) === identity;
    const openWorkspace = async () => {
      try {
        const query = new URLSearchParams(window.location.search);
        setAvailable(false);
        setSession(undefined);
        setOpenFailure(undefined);
        setReady(false);
        const linkedAssessmentSessionId = requestedAssessmentSessionId ?? query.get("assessmentSessionId") ?? undefined;
        const linkedBlueprintId = requestedBlueprintId ?? query.get("blueprintId") ?? undefined;
        const context = await loadCurrentDurableJourney(localStorage);
        if (!current()) return;
        const artifactIds = context?.artifactIds;
        if (!context || !artifactIds) { setStatus("Complete and sync the current Blueprint before opening Copilot."); return; }
        if (!matchesCopilotDeepLink(context, { assessmentSessionId: linkedAssessmentSessionId, blueprintId: linkedBlueprintId })) {
          setStatus("This Copilot link does not match the current secure workspace.");
          setOpenFailure({ message: "Return to the current Blueprint and continue from its Copilot action.", requestId: null, retryable: false });
          return;
        }
        setSession(undefined);
        setOpenFailure(undefined);
        setOrganizationId(context.organizationId);
        const [healthResult, sessionResult] = await Promise.allSettled([
          api<HealthResponse>("/api/v2/copilot/status?detail=safe"),
          api<Session>("/api/v2/copilot/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId: context.organizationId, assessmentSessionId: context.assessmentSessionId, businessTwinId: artifactIds.businessTwin, blueprintId: artifactIds.blueprint, idempotencyKey: `copilot:${context.assessmentSessionId}:${artifactIds.blueprint}` }) }),
        ]);
        if (!current()) return;
        if (sessionResult.status === "rejected") throw sessionResult.reason;
        const nextSession = sessionResult.value;
        const history = await api<HistoryResponse>(`/api/v2/copilot/sessions/${nextSession.id}/messages${context.organizationId ? `?organizationId=${context.organizationId}` : ""}`);
        if (!current()) return;
        setSession(nextSession);
        setAvailable(true);
        setMessages(restoreCopilotMessages(history.messages));
        if (healthResult.status === "fulfilled") setStatus(healthResult.value.liveAvailable ? "Live AI, private evidence tools, and bounded public web search are available." : "Copilot is using its safe deterministic response path.");
        else setStatus(copilotErrorPresentation(healthResult.reason).message);
      } catch (error) {
        if (!current()) return;
        const presentation = copilotErrorPresentation(error);
        setStatus(presentation.message);
        setOpenFailure({ message: presentation.message, requestId: presentation.requestId, retryable: presentation.retryable });
        setAvailable(false);
      } finally { if (current()) setReady(true); }
    };
    void openWorkspace();
    return () => { active = false; abortRef.current?.abort(); };
  }, [requestedAssessmentSessionId, requestedBlueprintId]);

  useEffect(() => {
    if (!followLatestRef.current) return;
    const frame = requestAnimationFrame(() => {
      const log = logRef.current;
      if (log && followLatestRef.current) log.scrollTop = log.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, activity]);

  const onLogScroll = () => {
    const log = logRef.current;
    if (!log) return;
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    if (manualPauseRef.current && distance <= 4) manualPauseRef.current = false;
    const nearBottom = !manualPauseRef.current && distance < 96;
    followLatestRef.current = nearBottom;
    setShowLatest(!nearBottom);
  };

  const pauseFollowing = () => {
    manualPauseRef.current = true;
    followLatestRef.current = false;
    setShowLatest(true);
  };

  const jumpToLatest = () => {
    manualPauseRef.current = false;
    followLatestRef.current = true;
    setShowLatest(false);
    const log = logRef.current;
    if (log) {
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
    }
  };

  const sendTurn = async (message: string, idempotencyKey = `turn:${crypto.randomUUID()}`, appendOptimisticUser = true) => {
    if (!message || !session || busy) return;
    const streamingId = `stream:${crypto.randomUUID()}`;
    const controller = new AbortController();
    abortRef.current = controller;
    manualPauseRef.current = false;
    followLatestRef.current = true;
    setShowLatest(false);
    setInput(""); setBusy(true); setActivity("Thinking through your question…");
    setMessages((current) => [...current, ...(appendOptimisticUser ? [{ id: crypto.randomUUID(), role: "user" as const, text: message }] : []), { id: streamingId, role: "assistant", text: "", streaming: true }]);
    try {
      const result = await streamTurn(`/api/v2/copilot/sessions/${session.id}/turns`, { message, idempotencyKey, organizationId }, controller.signal, (event) => {
        if (event.type === "status") setActivity(activityText(event.phase, event.toolName));
        if (event.type === "text_delta") setMessages((current) => current.map((item) => item.id === streamingId ? { ...item, text: item.text + event.delta } : item));
      });
      setMessages((current) => current.map((item) => item.id === streamingId ? { id: crypto.randomUUID(), role: "assistant", text: result.text, tools: result.toolCalls } : item));
    } catch (error) {
      const stopped = error instanceof DOMException && error.name === "AbortError";
      const presentation = stopped ? { message: "Response stopped. You can retry this turn without duplicating saved messages.", requestId: null, retryable: true } : copilotErrorPresentation(error);
      setMessages((current) => {
        const draft = current.find((item) => item.id === streamingId);
        const retained = current.flatMap((item) => item.id === streamingId ? draft?.text ? [{ ...item, streaming: false, draft: true }] : [] : [item]);
        return [...retained, { id: crypto.randomUUID(), role: "status" as const, text: draft?.text ? `${presentation.message} The draft above was interrupted and may not be saved.` : presentation.message, requestId: presentation.requestId, retryMessage: presentation.retryable ? message : undefined, retryIdempotencyKey: presentation.retryable ? idempotencyKey : undefined }];
      });
    } finally { abortRef.current = undefined; setActivity(""); setBusy(false); }
  };

  const submit = (event: FormEvent) => { event.preventDefault(); void sendTurn(input.trim()); };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (input.trim()) void sendTurn(input.trim()); } };
  const retryTurn = (failedStatusId: string, message: string, idempotencyKey: string) => { setMessages((current) => prepareCopilotRetry(current, failedStatusId)); void sendTurn(message, idempotencyKey, false); };
  const confirm = async (confirmationId: string) => {
    setBusy(true);
    try {
      await api(`/api/v2/copilot/confirmations/${confirmationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId, confirmationText: "CONFIRM", idempotencyKey: `confirm:${crypto.randomUUID()}` }) });
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "status", text: "Confirmed action completed and added to the audit trail." }]);
    } catch (error) {
      const presentation = copilotErrorPresentation(error);
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "status", text: presentation.message, requestId: presentation.requestId }]);
    } finally { setBusy(false); }
  };

  return <div className="copilot-page"><ProductHeader current="copilot" /><main id="main-content" className="copilot-shell">
    <section className="copilot-intro"><p className="eyebrow">MajuPilot Transformation Copilot</p><h1>A practical copilot for the work after your Blueprint.</h1><p>Ask anything, inspect your private assessment evidence with exact citations, or search the public web when current information matters.</p><span className="copilot-live-status" role="status">{status}</span></section>
    {!ready ? <section className="copilot-empty" aria-busy="true"><h2>Opening your workspace</h2><p>Your authorized Twin and completed Blueprint are being loaded.</p></section> : !available ? <section className="copilot-empty" role={openFailure ? "alert" : undefined}><p className="eyebrow">Workspace status</p><h2>{openFailure ? "Copilot could not open this workspace" : "Your Blueprint comes first"}</h2><p>{openFailure?.message ?? "Copilot opens only after a completed Blueprint is securely synced."}</p>{openFailure?.requestId ? <TechnicalDiagnostic requestId={openFailure.requestId} /> : null}<div className="copilot-recovery-actions">{shouldOfferCopilotRetry(openFailure) ? <button className="button primary" type="button" onClick={() => window.location.reload()}>Try again</button> : !openFailure ? <Link className="button primary" href="/assessment">Start or resume assessment</Link> : null}<Link className="button secondary" href="/blueprint">Return to Blueprint</Link></div></section> : <section className="copilot-workspace" aria-label="Transformation Copilot conversation">
      <header className="copilot-workspace-header"><div><p className="eyebrow">Saved conversation</p><h2>Ask, explore, decide</h2></div><Link href="/evidence" className="button secondary">Evidence Library</Link></header>
      <div className="copilot-log-frame"><div className="copilot-log" ref={logRef} onScroll={onLogScroll} onWheel={(event) => { if (event.deltaY < 0) pauseFollowing(); }} onTouchStart={(event) => { touchYRef.current = event.touches[0]?.clientY ?? null; }} onTouchMove={(event) => { const y = event.touches[0]?.clientY; if (y !== undefined && touchYRef.current !== null && y > touchYRef.current) pauseFollowing(); if (y !== undefined) touchYRef.current = y; }} onTouchEnd={() => { touchYRef.current = null; }} onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseFollowing(); }} tabIndex={0} role="log" aria-label="Copilot messages" aria-live="polite" aria-relevant="additions text">
        {messages.map((message) => <article key={message.id} className={`copilot-message ${message.role}${message.streaming ? " streaming" : ""}${message.draft ? " draft" : ""}`}><header><span>{message.role === "user" ? "You" : message.role === "assistant" ? "MajuPilot" : "Status"}</span>{message.streaming ? <small>Streaming</small> : message.draft ? <small>Interrupted draft · save unconfirmed</small> : null}</header>{message.text ? <Markdown>{message.text}</Markdown> : <span className="copilot-thinking-dots" aria-label="MajuPilot is thinking">•••</span>}<UploadedCitations tools={message.tools} /><WebSources tools={message.tools} />{message.requestId ? <TechnicalDiagnostic requestId={message.requestId} /> : null}{message.role === "assistant" && !message.streaming && !message.draft && message.text.includes("This answer is incomplete. Use Continue answer") ? <button type="button" className="button secondary" disabled={busy} onClick={() => void sendTurn("Continue your previous answer from its last point. Avoid repeating it; use only the same evidence and citations already established.")}>Continue answer</button> : null}{message.retryMessage && message.retryIdempotencyKey ? <button type="button" className="button secondary" disabled={busy} onClick={() => retryTurn(message.id, message.retryMessage!, message.retryIdempotencyKey!)}>Retry turn</button> : null}{message.tools?.filter((toolCall) => toolCall.status === "confirmation_required" && toolCall.confirmationId).map((toolCall) => <button key={toolCall.confirmationId} type="button" className="button secondary" disabled={busy} onClick={() => confirm(toolCall.confirmationId!)}>Confirm {toolCall.toolName}</button>)}</article>)}
        {busy && activity ? <div className="copilot-activity" role="status"><span aria-hidden="true" />{activity}</div> : null}
      </div>{showLatest ? <button type="button" className="copilot-jump-latest" onClick={jumpToLatest}>Jump to latest ↓</button> : null}</div>
      {messages.length <= 1 ? <div className="copilot-prompts" aria-label="Conversation starters">{["Explain my top Blueprint priority", "Compare a document claim with current public information", "What can you help me reason through today?"].map((prompt) => <button type="button" key={prompt} onClick={() => setInput(prompt)}>{prompt}</button>)}</div> : null}
      <form className="copilot-composer" onSubmit={submit}><label htmlFor="copilot-message">Message MajuPilot</label><div><textarea id="copilot-message" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} maxLength={4000} rows={3} placeholder="Ask a general question, reference your Blueprint, or request a current web check…" disabled={!session} /><div className="copilot-composer-actions">{busy ? <button className="button secondary" type="button" onClick={() => abortRef.current?.abort()}>Stop</button> : <button className="button primary" type="submit" disabled={!session || !input.trim()}>Send</button>}</div></div><footer><small>Enter to send · Shift+Enter for a new line · writes always require confirmation</small><small>{input.length}/4000</small></footer></form>
    </section>}
  </main></div>;
}
