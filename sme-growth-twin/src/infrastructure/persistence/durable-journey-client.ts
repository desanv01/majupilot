import type { AssessmentDraft } from "@/domain/assessment";
import type { Blueprint } from "@/domain/blueprint";
import type { BusinessTwin } from "@/domain/business-twin";
import type { LeadReceiptV2 } from "@/domain/lead-sales";
import type { RecommendationResult } from "@/domain/recommendations";
import type { ReportArtifact } from "@/domain/reports";
import type { ScenarioComparison } from "@/domain/scenarios";
import type { DiagnosticResult } from "@/domain/scoring";
import { canonicalJson } from "@/core/reports/canonical-json";
import { activeAccountCase } from "./account-case-scope";
import { notifyAccountCaseLocalChange } from "./account-case-events";
import { workspaceIdentity, workspaceRequest } from "./workspace-request";

export const DURABLE_JOURNEY_STORAGE_KEY = "majupilot:durable-journey:1.0.0";

export type DurableArtifactIds = {
  answers: Record<string, string>;
  businessTwin: string;
  evidence: string[];
  diagnostic: string;
  recommendations: string;
  scenarioComparison: string;
  scenarioRevision: string;
  blueprint: string;
};

export type DurableJourneyContext = {
  guestSessionId?: string;
  expiresAt?: string;
  organizationId?: string;
  assessmentSessionId: string;
  artifactIds?: DurableArtifactIds;
  sourceFingerprint?: string;
  syncedAt?: string;
  report?: ReportArtifact;
  lead?: LeadReceiptV2;
  leadIdempotencyKey: string;
};

export type DurableJourneySource = {
  draft: AssessmentDraft;
  twin: BusinessTwin;
  diagnostic: DiagnosticResult;
  recommendations: RecommendationResult;
  comparison: ScenarioComparison;
  blueprint: Blueprint;
};

function load(storage: Storage): DurableJourneyContext | undefined {
  const raw = storage.getItem(DURABLE_JOURNEY_STORAGE_KEY);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as DurableJourneyContext; }
  catch { storage.removeItem(DURABLE_JOURNEY_STORAGE_KEY); return undefined; }
}

function save(storage: Storage, context: DurableJourneyContext) {
  storage.setItem(DURABLE_JOURNEY_STORAGE_KEY, JSON.stringify(context));
  notifyAccountCaseLocalChange(storage);
  return context;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function invalidateDurableJourney(storage: Storage) {
  const context = load(storage);
  if (!context) return;
  save(storage, {
    ...context,
    artifactIds: undefined,
    sourceFingerprint: undefined,
    syncedAt: undefined,
    report: undefined,
    lead: undefined,
    leadIdempotencyKey: `lead:${crypto.randomUUID()}`,
  });
}

export async function durableJourneySourceFingerprint(source: DurableJourneySource) {
  const wireSource = JSON.parse(JSON.stringify(source)) as DurableJourneySource;
  return sha256(canonicalJson(wireSource));
}

export function copilotJourneyHref(context: DurableJourneyContext) {
  const blueprintId = context.artifactIds?.blueprint;
  if (!context.syncedAt || !blueprintId) return undefined;
  const query = new URLSearchParams({ assessmentSessionId: context.assessmentSessionId, blueprintId });
  return `/copilot?${query.toString()}`;
}

export function matchesCopilotDeepLink(
  context: DurableJourneyContext,
  requested: { assessmentSessionId?: string; blueprintId?: string },
) {
  if (requested.assessmentSessionId && requested.assessmentSessionId !== context.assessmentSessionId) return false;
  if (requested.blueprintId && requested.blueprintId !== context.artifactIds?.blueprint) return false;
  return true;
}

async function json<T>(url: string, init?: RequestInit, storage?: Storage): Promise<T> {
  const response = await fetch(url, workspaceRequest(init, storage));
  const payload = await response.json().catch(() => undefined) as { data?: T; error?: { code?: string } } | undefined;
  if (!response.ok || !payload?.data) throw new Error(payload?.error?.code ?? `request_${response.status}`);
  return payload.data;
}

const checkedGuests = new WeakMap<Storage, { id: string; checkedAt: number }>();

async function ensureSession(storage: Storage, assertCurrent: () => void) {
  const existing = load(storage);
  if (existing?.organizationId) return existing;
  if (existing?.guestSessionId) {
    const checked = checkedGuests.get(storage);
    if (checked?.id === existing.guestSessionId && Date.now() - checked.checkedAt < 5 * 60_000 && (!existing.expiresAt || Date.parse(existing.expiresAt) > Date.now())) return existing;
    try {
      const resumed = await json<{ guestSessionId: string; assessmentSessionId: string; expiresAt?: string }>("/api/v2/guest/session", { method: "PUT" }, storage);
      assertCurrent();
      // A replaced cookie authorizes another assessment; never reuse this case's IDs.
      if (resumed.guestSessionId === existing.guestSessionId && resumed.assessmentSessionId === existing.assessmentSessionId) {
        checkedGuests.set(storage, { id: resumed.guestSessionId, checkedAt: Date.now() });
        return save(storage, { ...existing, ...resumed });
      }
    } catch (error) {
      if (!(error instanceof Error) || !["UNAUTHENTICATED", "SESSION_EXPIRED"].includes(error.message)) throw error;
    }
    assertCurrent();
  }
  const accountCase = activeAccountCase(storage);
  if (accountCase) return save(storage, { organizationId: accountCase.organizationId, assessmentSessionId: accountCase.caseId, leadIdempotencyKey: `lead:${crypto.randomUUID()}` });
  const receipt = await json<{ guestSessionId: string; assessmentSessionId: string; expiresAt?: string }>("/api/v2/guest/session", { method: "POST" }, storage);
  assertCurrent();
  checkedGuests.set(storage, { id: receipt.guestSessionId, checkedAt: Date.now() });
  return save(storage, {
    ...receipt,
    leadIdempotencyKey: `lead:${crypto.randomUUID()}`,
  });
}

function createIds(source: DurableJourneySource): DurableArtifactIds {
  const answerKeys = [
    ...Object.keys(source.draft.answers),
    ...Object.keys(source.draft.followUpAnswers).map((key) => `followUp.${key}`),
  ];
  return {
    answers: Object.fromEntries(answerKeys.map((key) => [key, crypto.randomUUID()])),
    businessTwin: crypto.randomUUID(),
    evidence: source.twin.evidence.map(() => crypto.randomUUID()),
    diagnostic: crypto.randomUUID(),
    recommendations: crypto.randomUUID(),
    scenarioComparison: crypto.randomUUID(),
    scenarioRevision: crypto.randomUUID(),
    blueprint: crypto.randomUUID(),
  };
}

const syncQueue = new WeakMap<Storage, Promise<unknown>>();

// React effects and consultation can request the same sync concurrently. Keep one
// write set and prevent a request from restoring a case after a reset or switch.
export function syncDurableJourney(storage: Storage, source: DurableJourneySource): Promise<DurableJourneyContext> {
  const identity = workspaceIdentity(storage);
  const assertCurrent = () => {
    if (workspaceIdentity(storage) !== identity) throw new Error("workspace_changed");
  };
  const next = (syncQueue.get(storage) ?? Promise.resolve()).catch(() => undefined).then(() => {
    assertCurrent();
    return syncOnce(storage, source, assertCurrent);
  });
  syncQueue.set(storage, next);
  return next;
}

async function syncOnce(storage: Storage, source: DurableJourneySource, assertCurrent: () => void) {
  let context = await ensureSession(storage, assertCurrent);
  const sourceFingerprint = await durableJourneySourceFingerprint(source);
  assertCurrent();
  if (context.syncedAt && context.artifactIds && context.sourceFingerprint === sourceFingerprint) return context;
  const sourceChanged = context.sourceFingerprint !== sourceFingerprint;
  const artifactIds = sourceChanged || !context.artifactIds ? createIds(source) : context.artifactIds;
  context = save(storage, {
    ...context,
    artifactIds,
    sourceFingerprint,
    syncedAt: undefined,
    report: sourceChanged ? undefined : context.report,
    lead: sourceChanged ? undefined : context.lead,
    leadIdempotencyKey: sourceChanged ? `lead:${crypto.randomUUID()}` : context.leadIdempotencyKey,
  });
  await json("/api/v2/journey/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: context.organizationId, assessmentSessionId: context.assessmentSessionId, ids: artifactIds, ...source }),
  }, storage);
  assertCurrent();
  const latest = load(storage);
  if (latest?.sourceFingerprint !== sourceFingerprint || latest.artifactIds?.blueprint !== artifactIds.blueprint) throw new Error("workspace_changed");
  return save(storage, { ...context, artifactIds, syncedAt: new Date().toISOString() });
}

const consultationQueue = new WeakMap<Storage, Promise<unknown>>();

export function createDurableConsultation(
  storage: Storage,
  source: DurableJourneySource,
  contact: { name: string; businessName: string; email: string; phone?: string; urgency: "within_30_days" | "one_to_three_months" | "three_to_six_months" | "exploring" },
) {
  const identity = workspaceIdentity(storage);
  const assertCurrent = () => {
    if (workspaceIdentity(storage) !== identity) throw new Error("workspace_changed");
  };
  const next = (consultationQueue.get(storage) ?? Promise.resolve()).catch(() => undefined).then(() => {
    assertCurrent();
    return consultationOnce(storage, source, contact, assertCurrent);
  });
  consultationQueue.set(storage, next);
  return next;
}

async function consultationOnce(
  storage: Storage,
  source: DurableJourneySource,
  contact: Parameters<typeof createDurableConsultation>[2],
  assertCurrent: () => void,
) {
  let context = await syncDurableJourney(storage, source);
  const artifactIds = context.artifactIds;
  if (!artifactIds) throw new Error("journey_not_synced");
  const assertSubmissionCurrent = () => {
    assertCurrent();
    if (load(storage)?.artifactIds?.blueprint !== artifactIds.blueprint) throw new Error("workspace_changed");
  };
  assertSubmissionCurrent();
  if (context.lead) return context;
  const report = context.report ?? await json<ReportArtifact>("/api/v2/reports", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: context.organizationId, assessmentSessionId: context.assessmentSessionId, blueprintId: artifactIds.blueprint, locale: "en-MY", acceptedNoteIds: [] }),
  }, storage);
  assertSubmissionCurrent();
  context = save(storage, { ...context, report });
  if (!report.contentSha256) throw new Error("report_not_ready");
  // Retries must send the same consent and request identities as the lead that
  // may already have committed before a response was lost.
  const requestIdentity = async (purpose: string) => {
    const hash = await sha256(`${context.leadIdempotencyKey}:${purpose}`);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  };
  const [contactConsentId, reportConsentId, requestId] = await Promise.all([
    requestIdentity("contact"), requestIdentity("report"), requestIdentity("request"),
  ]);
  const common = {
    assessmentSessionId: context.assessmentSessionId,
    organizationId: context.organizationId,
    blueprintId: artifactIds.blueprint,
    reportArtifactId: report.id,
    action: "granted",
    consentVersion: "majupilot-consultation-1.0.0",
    policyVersion: "majupilot-privacy-1.0.0",
    locale: "en-MY",
    presentationSurface: "consultation",
    requestId,
    channel: "web",
  } as const;
  assertSubmissionCurrent();
  await json("/api/v2/consents", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: context.organizationId, consent: { ...common, id: contactConsentId, purpose: "consultation_contact", textHash: await sha256("I consent to MajuPilot using my contact details to respond to this consultation request."), snapshot: { contact, granted: true } } }),
  }, storage);
  assertSubmissionCurrent();
  await json("/api/v2/consents", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationId: context.organizationId, consent: { ...common, id: reportConsentId, purpose: "report_share_with_sales", textHash: await sha256("I consent to MajuPilot sharing this exact Blueprint report with the assigned consultation team."), snapshot: { reportId: report.id, contentSha256: report.contentSha256, granted: true } } }),
  }, storage);
  assertSubmissionCurrent();
  const lead = await json<LeadReceiptV2>("/api/v2/leads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      assessmentSessionId: context.assessmentSessionId,
      organizationId: context.organizationId,
      blueprintId: artifactIds.blueprint,
      blueprintRevision: 1,
      reportArtifactId: report.id,
      reportContentSha256: report.contentSha256,
      contactConsentId,
      reportConsentId,
      idempotencyKey: context.leadIdempotencyKey,
      contact,
      region: "Malaysia",
      preferredLanguage: "English",
    }),
  }, storage);
  assertSubmissionCurrent();
  return save(storage, { ...context, lead });
}

export function loadDurableJourney(storage: Storage) { return load(storage); }
