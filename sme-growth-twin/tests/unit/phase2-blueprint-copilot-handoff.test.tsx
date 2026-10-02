import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BlueprintHandoff } from "@/components/blueprint/blueprint-client";
import { rebuildCurrentTwin } from "@/core/assessment/rebuild-current-twin";
import { buildBlueprint } from "@/core/blueprint/build-blueprint";
import { buildRecommendationResult } from "@/core/recommendations/build-recommendations";
import { buildScenarioComparison } from "@/core/scenarios/build-scenarios";
import { buildDiagnosticResult } from "@/core/scoring/build-diagnostic";
import { assessmentDraftSchema } from "@/domain/assessment";
import { blueprintSchema } from "@/domain/blueprint";
import { PersistenceError, type OwnershipContext } from "@/domain/persistence";
import { GOLDEN_FIXTURES } from "@/domain-packs/exabytes/golden-fixtures";
import { EXABYTES_CATALOGUE_CURRENT } from "@/domain-packs/exabytes/catalogue";
import { EXABYTES_OFFERING_SELECTION_CURRENT } from "@/domain-packs/exabytes/offering-selection";
import { EXABYTES_RECOMMENDATION_RULE_PACK_1_0_0 } from "@/domain-packs/exabytes/recommendation-rules";
import { EXABYTES_SCENARIO_RULES_1_0_0 } from "@/domain-packs/exabytes/scenario-templates";
import { assertCopilotSessionBinding } from "@/infrastructure/copilot/copilot-session-binding";
import { loadCurrentDurableJourney } from "@/infrastructure/persistence/current-durable-journey";
import { immutableInsertMatches } from "@/infrastructure/persistence/immutable-insert";
import {
  copilotJourneyHref,
  createDurableConsultation,
  DURABLE_JOURNEY_STORAGE_KEY,
  invalidateDurableJourney,
  matchesCopilotDeepLink,
  syncDurableJourney,
  type DurableJourneyContext,
  type DurableJourneySource,
} from "@/infrastructure/persistence/durable-journey-client";
import { loadAssessmentDraft, saveAssessmentDraft } from "@/infrastructure/persistence/local-assessment-store";
import { loadBlueprint, saveBlueprint } from "@/infrastructure/persistence/local-blueprint-store";
import { loadDiagnosticResult, saveDiagnosticResult } from "@/infrastructure/persistence/local-diagnostic-store";
import { loadRecommendationResult, saveRecommendationResult } from "@/infrastructure/persistence/local-recommendation-store";
import { loadScenarioComparison, saveScenarioComparison } from "@/infrastructure/persistence/local-scenario-store";

import { memoryStorage, now } from "./stage04-fixtures";
import { stage05CaseA } from "./stage05-fixtures";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixture = stage05CaseA();
const draft = assessmentDraftSchema.parse({
  schemaVersion: "1.0.0",
  sessionId: fixture.twin.assessmentSessionId,
  status: "ready_for_review",
  currentStep: 6,
  twinRevision: fixture.twin.revision,
  answers: GOLDEN_FIXTURES[0].answers,
  selectedFollowUpIds: GOLDEN_FIXTURES[0].selectedFollowUpIds,
  followUpAnswers: GOLDEN_FIXTURES[0].followUpAnswers,
  updatedAt: now,
});
const source: DurableJourneySource = {
  draft,
  twin: fixture.twin,
  diagnostic: fixture.diagnostic,
  recommendations: fixture.recommendation,
  comparison: fixture.comparison,
  blueprint: fixture.blueprint,
};

const response = (data: unknown, status = 200) => Response.json({ data }, { status });
const asStorage = (storage: ReturnType<typeof memoryStorage>["storage"]) => storage as Storage;

describe("Phase 2 Blueprint to Copilot handoff", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows truthful saving, ready, and failed states with one primary next action", () => {
    const context: DurableJourneyContext = {
      guestSessionId: uuid(1), assessmentSessionId: uuid(2), syncedAt: now,
      artifactIds: { answers: {}, businessTwin: uuid(3), evidence: [], diagnostic: uuid(4), recommendations: uuid(5), scenarioComparison: uuid(6), scenarioRevision: uuid(7), blueprint: uuid(8) },
      sourceFingerprint: "a".repeat(64), leadIdempotencyKey: "lead:phase2-test",
    };
    const saving = renderToStaticMarkup(<BlueprintHandoff state="saving" onRetry={() => undefined} />);
    expect(saving).toContain("Saving evidence");
    expect(saving).toContain("Copilot ready");
    expect(saving).not.toContain("Continue to Copilot");

    const ready = renderToStaticMarkup(<BlueprintHandoff state="ready" context={context} onRetry={() => undefined} />);
    expect(ready).toContain("Continue to Copilot");
    expect(ready).toContain("Request consultation");
    expect(ready).toContain(`assessmentSessionId=${context.assessmentSessionId}`);
    expect(ready).toContain(`blueprintId=${context.artifactIds?.blueprint}`);

    const failed = renderToStaticMarkup(<BlueprintHandoff state="failed" onRetry={() => undefined} />);
    expect(failed).toContain("Retry sync");
    expect(failed).not.toContain("Continue to Copilot");
    expect(failed).toContain("Copilot is not ready");
  });

  it("resumes an identical sync, invalidates a regenerated Blueprint, and resyncs with new immutable IDs", async () => {
    const { storage } = memoryStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ guestSessionId: uuid(1), assessmentSessionId: uuid(2) }, 201))
      .mockImplementation(async (_url: string, init?: RequestInit) => response(JSON.parse(String(init?.body)), 201));
    vi.stubGlobal("fetch", fetchMock);

    const first = await syncDurableJourney(asStorage(storage), source);
    const resumed = await syncDurableJourney(asStorage(storage), source);
    expect(resumed).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const regenerated = blueprintSchema.parse({ ...fixture.blueprint, id: "blueprint_stage0500009", generatedAt: "2026-09-18T11:00:00+08:00" });
    const current = await syncDurableJourney(asStorage(storage), { ...source, blueprint: regenerated });
    expect(current.assessmentSessionId).toBe(first.assessmentSessionId);
    expect(current.artifactIds?.blueprint).not.toBe(first.artifactIds?.blueprint);
    expect(current.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps failed sync unready and retries the same immutable write set", async () => {
    const { storage } = memoryStorage();
    const syncBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ guestSessionId: uuid(11), assessmentSessionId: uuid(12) }, 201))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        syncBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ error: { code: "INTERNAL_RETRYABLE" } }, { status: 503 });
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        syncBodies.push(body);
        return response(body, 201);
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncDurableJourney(asStorage(storage), source)).rejects.toThrow("INTERNAL_RETRYABLE");
    const failed = JSON.parse(storage.getItem(DURABLE_JOURNEY_STORAGE_KEY) ?? "{}") as DurableJourneyContext;
    expect(failed.syncedAt).toBeUndefined();
    expect(copilotJourneyHref(failed)).toBeUndefined();

    const retried = await syncDurableJourney(asStorage(storage), source);
    expect(retried.syncedAt).toBeTruthy();
    expect(syncBodies[1].ids).toEqual(syncBodies[0].ids);
    expect(immutableInsertMatches({ id: uuid(1), payload: { evidence: "stable" } }, { id: uuid(1), payload: { evidence: "stable" }, optional: undefined })).toBe(true);
    expect(immutableInsertMatches({ id: uuid(1), payload: { evidence: "changed" } }, { id: uuid(1), payload: { evidence: "stable" } })).toBe(false);
  });

  it("restores only the current synchronized local chain and rejects stale direct Copilot access", async () => {
    const { storage } = memoryStorage();
    const twin = rebuildCurrentTwin(draft);
    const diagnostic = buildDiagnosticResult(twin, { id: () => "diagnostic_phase2current1", now: () => now });
    const recommendations = buildRecommendationResult(twin, diagnostic, EXABYTES_RECOMMENDATION_RULE_PACK_1_0_0, EXABYTES_CATALOGUE_CURRENT, EXABYTES_OFFERING_SELECTION_CURRENT, { id: () => "recommendation_phase2current1", now: () => now });
    let scenarioSequence = 0;
    const generatedComparison = buildScenarioComparison(twin, diagnostic, recommendations, EXABYTES_SCENARIO_RULES_1_0_0, { id: () => `scenario_phase2current${++scenarioSequence}`, eventId: () => "event_phase2current001", now: () => now });
    const comparison = { ...generatedComparison, selectedScenarioId: generatedComparison.scenarios[1].id };
    const blueprint = buildBlueprint({ twin, diagnostic, recommendations, comparison, panel: fixture.panel }, { id: () => "blueprint_phase2current001", now: () => now });
    const currentSource = { draft, twin, diagnostic, recommendations, comparison, blueprint };
    saveAssessmentDraft(storage, draft);
    saveDiagnosticResult(storage, diagnostic);
    saveRecommendationResult(storage, recommendations);
    saveScenarioComparison(storage, comparison);
    saveBlueprint(storage, blueprint);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ guestSessionId: uuid(21), assessmentSessionId: uuid(22) }, 201))
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => response(JSON.parse(String(init?.body)), 201)));

    const synced = await syncDurableJourney(asStorage(storage), currentSource);
    expect(loadAssessmentDraft(storage).status).toBe("ok");
    expect(rebuildCurrentTwin(draft)).toEqual(twin);
    expect(loadDiagnosticResult(storage, twin).status).toBe("ok");
    const recommendationLoad = loadRecommendationResult(storage, twin, diagnostic);
    if (recommendationLoad.status !== "ok") throw new Error(`recommendation:${JSON.stringify(recommendationLoad)}`);
    expect(loadScenarioComparison(storage, twin, diagnostic, recommendations).status).toBe("ok");
    expect(loadBlueprint(storage, twin, diagnostic, recommendations, comparison).status).toBe("ok");
    await expect(loadCurrentDurableJourney(asStorage(storage))).resolves.toEqual(synced);
    saveAssessmentDraft(storage, { ...draft, twinRevision: draft.twinRevision + 1, updatedAt: "2026-09-18T11:30:00+08:00" });
    await expect(loadCurrentDurableJourney(asStorage(storage))).resolves.toBeUndefined();
    saveAssessmentDraft(storage, draft);
    const regenerated = blueprintSchema.parse({ ...blueprint, id: "blueprint_phase2current002", generatedAt: "2026-09-18T12:00:00+08:00" });
    saveBlueprint(storage, regenerated);
    await expect(loadCurrentDurableJourney(asStorage(storage))).resolves.toBeUndefined();

    invalidateDurableJourney(asStorage(storage));
    const invalidated = JSON.parse(storage.getItem(DURABLE_JOURNEY_STORAGE_KEY) ?? "{}") as DurableJourneyContext;
    expect(invalidated.syncedAt).toBeUndefined();
    expect(invalidated.artifactIds).toBeUndefined();
  });

  it("binds deep links and resumed Copilot sessions to the authorized assessment and Blueprint", () => {
    const owner: OwnershipContext = { kind: "guest", guestSessionId: uuid(31) };
    const input = { assessmentSessionId: uuid(32), businessTwinId: uuid(33), blueprintId: uuid(34), idempotencyKey: "copilot:phase2-binding" };
    const row = { assessment_session_id: input.assessmentSessionId, business_twin_id: input.businessTwinId, blueprint_id: input.blueprintId, guest_session_id: owner.guestSessionId, organization_id: null };
    expect(() => assertCopilotSessionBinding(row, owner, input)).not.toThrow();
    expect(matchesCopilotDeepLink({ guestSessionId: owner.guestSessionId, assessmentSessionId: input.assessmentSessionId, artifactIds: { answers: {}, businessTwin: input.businessTwinId, evidence: [], diagnostic: uuid(35), recommendations: uuid(36), scenarioComparison: uuid(37), scenarioRevision: uuid(38), blueprint: input.blueprintId }, syncedAt: now, sourceFingerprint: "b".repeat(64), leadIdempotencyKey: "lead:phase2" }, input)).toBe(true);
    expect(() => assertCopilotSessionBinding({ ...row, guest_session_id: uuid(39) }, owner, input)).toThrowError(PersistenceError);
    expect(() => assertCopilotSessionBinding(row, owner, { ...input, blueprintId: uuid(40) })).toThrowError("IDEMPOTENCY_CONFLICT");
  });

  it("serializes concurrent handoffs into one guest session and immutable write set", async () => {
    const { storage } = memoryStorage();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ guestSessionId: uuid(41), assessmentSessionId: uuid(42) }, 201))
      .mockResolvedValue(response({ saved: true }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b, c] = await Promise.all(Array.from({ length: 3 }, () => syncDurableJourney(asStorage(storage), source)));
    expect(a).toEqual(b); expect(b).toEqual(c);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired saved guest workspace rather than claiming its old sync is ready", async () => {
    const { storage } = memoryStorage();
    const initialFetch = vi.fn()
      .mockResolvedValueOnce(response({ guestSessionId: uuid(61), assessmentSessionId: uuid(62) }, 201))
      .mockResolvedValueOnce(response({ saved: true }, 201));
    vi.stubGlobal("fetch", initialFetch);
    const initial = await syncDurableJourney(asStorage(storage), source);
    const restored = memoryStorage().storage as Storage;
    restored.setItem(DURABLE_JOURNEY_STORAGE_KEY, JSON.stringify(initial));
    const recoveryFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "SESSION_EXPIRED" } }, { status: 401 }))
      .mockResolvedValueOnce(response({ guestSessionId: uuid(63), assessmentSessionId: uuid(64) }, 201))
      .mockResolvedValueOnce(response({ saved: true }, 201));
    vi.stubGlobal("fetch", recoveryFetch);
    const recovered = await syncDurableJourney(restored, source);
    expect(recoveryFetch.mock.calls[0][1]?.method).toBe("PUT");
    expect(recovered.assessmentSessionId).toBe(uuid(64));
    expect(recovered.artifactIds?.blueprint).not.toBe(initial.artifactIds?.blueprint);
    expect(recovered.syncedAt).toBeTruthy();
  });

  it("does not repopulate local storage after a case is reset during sync", async () => {
    const { storage } = memoryStorage();
    saveAssessmentDraft(storage, draft);
    let complete!: (response: Response) => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ guestSessionId: uuid(41), assessmentSessionId: uuid(42) }, 201))
      .mockImplementationOnce(() => { started(); return new Promise<Response>((resolve) => { complete = resolve; }); }));
    const sync = syncDurableJourney(asStorage(storage), source);
    const rejected = expect(sync).rejects.toThrow("workspace_changed");
    await pending;
    storage.removeItem(DURABLE_JOURNEY_STORAGE_KEY);
    storage.removeItem("sme-growth-twin:assessment-draft:1.0.0");
    complete(response({ saved: true }));
    await rejected;
    expect(storage.getItem(DURABLE_JOURNEY_STORAGE_KEY)).toBeNull();
  });

  it("retries a lost consultation response with the exact consent and lead payload", async () => {
    const { storage } = memoryStorage();
    const leads: unknown[] = []; const consents: unknown[] = [];
    let leadAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v2/guest/session") return response({ guestSessionId: uuid(41), assessmentSessionId: uuid(42) }, 201);
      if (url === "/api/v2/journey/sync") return response({ saved: true }, 201);
      if (url === "/api/v2/reports") return response({ id: uuid(43), contentSha256: "a".repeat(64) }, 201);
      if (url === "/api/v2/consents") { consents.push(JSON.parse(String(init?.body))); return response({ recorded: true }, 201); }
      if (url === "/api/v2/leads") {
        leads.push(JSON.parse(String(init?.body)));
        if (++leadAttempts === 1) throw new Error("response_lost_after_commit");
        return response({ receiptId: uuid(44), leadId: uuid(45), replayed: true }, 201);
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));
    const contact = { name: "Synthetic Tester", businessName: "Synthetic Company", email: "test@example.com", urgency: "exploring" as const };
    await expect(createDurableConsultation(asStorage(storage), source, contact)).rejects.toThrow("response_lost_after_commit");
    const retry = await createDurableConsultation(asStorage(storage), source, contact);
    expect(retry.lead?.replayed).toBe(true);
    expect(leads).toHaveLength(2); expect(leads[1]).toEqual(leads[0]);
    expect(consents[2]).toEqual(consents[0]); expect(consents[3]).toEqual(consents[1]);
  });
});
