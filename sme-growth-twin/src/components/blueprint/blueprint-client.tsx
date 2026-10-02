"use client";

/* eslint-disable react-hooks/set-state-in-effect -- versioned browser records are restored at this client boundary */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { rebuildCurrentTwin } from "@/core/assessment/rebuild-current-twin";
import { buildAdvisorReviewContext } from "@/core/blueprint/build-review-context";
import { buildBlueprint } from "@/core/blueprint/build-blueprint";
import { advisorPanelResponseSchema, type AdvisorPanelResponse } from "@/domain/advisors";
import type { AssessmentDraft } from "@/domain/assessment";
import type { Blueprint } from "@/domain/blueprint";
import type { BusinessTwin } from "@/domain/business-twin";
import type { RecommendationResult } from "@/domain/recommendations";
import { reportArtifactSchema, signedReportDownloadSchema, type ReportArtifact } from "@/domain/reports";
import type { ScenarioComparison } from "@/domain/scenarios";
import type { DiagnosticResult } from "@/domain/scoring";
import { EXABYTES_ADVISORS_1_0_0, buildExabytesFallbackReview } from "@/domain-packs/exabytes/advisor-rules";
import { loadAssessmentDraft } from "@/infrastructure/persistence/local-assessment-store";
import { loadBlueprint, saveBlueprint } from "@/infrastructure/persistence/local-blueprint-store";
import { loadDiagnosticResult } from "@/infrastructure/persistence/local-diagnostic-store";
import { loadRecommendationResult } from "@/infrastructure/persistence/local-recommendation-store";
import { loadScenarioComparison } from "@/infrastructure/persistence/local-scenario-store";
import { workspaceIdentity, workspaceRequest } from "@/infrastructure/persistence/workspace-request";
import {
  copilotJourneyHref,
  invalidateDurableJourney,
  syncDurableJourney,
  type DurableJourneyContext,
} from "@/infrastructure/persistence/durable-journey-client";

import { Brand } from "../assessment/brand";
import { PostAssessmentShell } from "../diagnostics/post-assessment-shell";
import { BlueprintReport, DecisionOverview, originStatuses } from "./blueprint-report";

export type BlueprintSources = {
  twin: BusinessTwin;
  diagnostic: DiagnosticResult;
  recommendations: RecommendationResult;
  comparison: ScenarioComparison;
};

export type AdvisorStatus = "ready" | "reviewing" | "live" | "fallback" | "failed-safe";
export type DurableSyncState = "idle" | "saving" | "ready" | "failed";

const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const readyStatuses = () => Object.fromEntries(EXABYTES_ADVISORS_1_0_0.map((advisor) => [advisor.id, "ready"])) as Record<string, AdvisorStatus>;
const reviewingStatuses = () => Object.fromEntries(EXABYTES_ADVISORS_1_0_0.map((advisor) => [advisor.id, "reviewing"])) as Record<string, AdvisorStatus>;
const failedStatuses = () => Object.fromEntries(EXABYTES_ADVISORS_1_0_0.map((advisor) => [advisor.id, "failed-safe"])) as Record<string, AdvisorStatus>;

function fallbackPanel(sources: BlueprintSources): AdvisorPanelResponse {
  const context = buildAdvisorReviewContext(sources.twin, sources.diagnostic, sources.recommendations, sources.comparison);
  const reviews = EXABYTES_ADVISORS_1_0_0.map((definition) =>
    buildExabytesFallbackReview(definition, context, makeId("advisor")),
  );
  const modelCalls = EXABYTES_ADVISORS_1_0_0.map((definition) => ({
    id: makeId("modelcall"),
    advisor: definition.id,
    provider: "unavailable" as const,
    model: "request_unavailable",
    promptVersion: "1.0.0" as const,
    schemaVersion: "1.0.0" as const,
    latencyMs: 0,
    retryCount: 0,
    status: "unavailable" as const,
    evidenceIds: [],
    errorCategory: "configuration" as const,
  }));
  return advisorPanelResponseSchema.parse({ reviews, modelCalls });
}

function AdvisorStatusBoard({
  busy,
  blueprint,
  notice,
  statuses,
}: {
  busy: boolean;
  blueprint?: Blueprint;
  notice?: string;
  statuses: Record<string, AdvisorStatus>;
}) {
  const boardTitle = busy ? "Five specialist reviews are resolving" : blueprint ? "Advisor review is complete" : "Five specialist reviews are ready";
  return (
    <section className="phase06-status-board no-print" aria-live="polite" aria-busy={busy}>
      <header>
        <div>
          <p className="eyebrow">Advisor status</p>
          <h2>{boardTitle}</h2>
        </div>
        <p>Live review is optional. Deterministic facts remain authoritative in every state.</p>
      </header>
      <ol>
        {EXABYTES_ADVISORS_1_0_0.map((advisor, index) => {
          const status = statuses[advisor.id];
          return (
            <li className={`advisor-status-item status-${status}`} key={advisor.id}>
              <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{advisor.label}</strong>
                <small>{status === "failed-safe" ? "Failed-safe" : status[0].toUpperCase() + status.slice(1)}</small>
              </div>
            </li>
          );
        })}
      </ol>
      {notice ? <p className="phase06-status-notice">{notice}</p> : null}
    </section>
  );
}

function BlueprintCommandHeader({
  blueprint,
  busy,
  context,
  onGenerate,
  sources,
}: {
  blueprint?: Blueprint;
  busy: boolean;
  context?: DurableJourneyContext;
  onGenerate: () => void;
  sources: BlueprintSources;
}) {
  const selected = sources.comparison.scenarios.find((scenario) => scenario.id === sources.comparison.selectedScenarioId);
  return (
    <header className="phase06-command blueprint-hero no-print">
      <div className="phase06-command-copy">
        <p className="eyebrow">Decision Blueprint</p>
        <h1>Review the decision before the handoff.</h1>
        <p>
          <strong>{sources.twin.identity.businessName}</strong> selected <strong>{selected?.title}</strong>. Costs, value ranges,
          scores, recommendations, and timing stay deterministic while five advisors interpret the evidence.
        </p>
      </div>
      <nav className="phase06-command-actions" aria-label="Blueprint actions">
        <Link className="button secondary" href="/scenarios">Back to scenarios</Link>
        <button className="button secondary" type="button" onClick={onGenerate} disabled={busy}>
          {blueprint ? "Regenerate review" : "Generate review"}
        </button>
        <button className="button secondary" type="button" disabled={!blueprint || busy} onClick={() => window.print()}>
          Print or save as PDF
        </button>
        {context ? <SavedReportDownload key={context.artifactIds?.blueprint} context={context} /> : null}
      </nav>
    </header>
  );
}

function SavedReportDownload({ context }: { context: DurableJourneyContext }) {
  const [report, setReport] = useState<ReportArtifact>();
  const [downloadLink, setDownloadLink] = useState<{ url: string; expiresAt: string }>();
  const [state, setState] = useState<"loading" | "ready" | "preparing" | "failed">("loading");
  const blueprintId = context.artifactIds?.blueprint;
  const { assessmentSessionId, organizationId } = context;

  useEffect(() => {
    if (!blueprintId) return;
    let active = true;
    const query = new URLSearchParams({ assessmentSessionId });
    if (organizationId) query.set("organizationId", organizationId);
    fetch(`/api/v2/reports?${query}`, workspaceRequest({ cache: "no-store" }))
      .then(async (response) => {
        if (!response.ok) throw new Error("report_list_unavailable");
        const body = await response.json() as { data: unknown };
        return reportArtifactSchema.array().parse(body.data);
      })
      .then((reports) => {
        if (!active) return;
        setReport(reports.filter((item) => item.blueprintId === blueprintId && item.status === "completed")
          .sort((left, right) => right.reportVersion - left.reportVersion)[0]);
        setState("ready");
      })
      .catch(() => { if (active) setState("failed"); });
    return () => { active = false; };
  }, [assessmentSessionId, blueprintId, organizationId]);

  const prepareDownload = async () => {
    if (!report) return;
    setState("preparing");
    setDownloadLink(undefined);
    try {
      const query = new URLSearchParams();
      if (organizationId) query.set("organizationId", organizationId);
      const suffix = query.size ? `?${query}` : "";
      const response = await fetch(`/api/v2/reports/${encodeURIComponent(report.id)}/download${suffix}`, workspaceRequest({ cache: "no-store" }));
      if (!response.ok) throw new Error("report_download_unavailable");
      const body = await response.json() as { data: unknown };
      const download = signedReportDownloadSchema.parse(body.data);
      if (download.reportId !== report.id) throw new Error("report_download_mismatch");
      setDownloadLink({ url: download.url, expiresAt: download.expiresAt });
      setState("ready");
    } catch {
      setState("failed");
    }
  };

  if (!blueprintId || (state === "ready" && !report)) return null;
  return (
    <div className="saved-report-action" aria-live="polite">
      {downloadLink ? (
        <a className="button secondary" href={downloadLink.url} target="_blank" rel="noopener noreferrer" download={`${report?.reportNumber ?? "majupilot-report"}.pdf`} onClick={(event) => {
          if (Date.now() < Date.parse(downloadLink.expiresAt) - 5_000) return;
          event.preventDefault();
          void prepareDownload();
        }}>
          Download saved PDF
        </a>
      ) : report ? (
        <button className="button secondary" type="button" onClick={prepareDownload} disabled={state === "preparing"}>
          {state === "preparing" ? "Preparing PDF link…" : "Get saved PDF"}
        </button>
      ) : null}
      {state === "failed" ? <small role="alert">{report ? "Could not prepare the PDF link. Try again." : "Could not check for a saved PDF. Reopen this page to retry."}</small> : null}
    </div>
  );
}

export function BlueprintHandoff({
  context,
  onRetry,
  state,
}: {
  context?: DurableJourneyContext;
  onRetry: () => void;
  state: DurableSyncState;
}) {
  const copilotHref = context ? copilotJourneyHref(context) : undefined;
  const failed = state === "failed";
  const ready = state === "ready" && Boolean(copilotHref);
  return (
    <section className={`phase02-handoff sync-${state} no-print`} role={failed ? "alert" : "status"} aria-live={failed ? "assertive" : "polite"} aria-busy={state === "saving"}>
      <div className="phase02-handoff-copy">
        <p className="eyebrow">Next step</p>
        <h2>{ready ? "Your evidence is ready for Copilot." : failed ? "Evidence sync needs attention." : "Preparing your Copilot workspace."}</h2>
        <p>
          {ready
            ? "Continue with this exact assessment and Blueprint. Copilot can explain saved evidence, while every write still requires explicit confirmation."
            : failed
              ? "Copilot is not ready because the current evidence was not durably synchronized. Your on-device Blueprint remains intact."
              : "MajuPilot is saving the current source-linked evidence before Copilot can open."}
        </p>
        <ol className="phase02-sync-steps" aria-label="Copilot preparation progress">
          <li className={failed ? "is-failed" : ready ? "is-complete" : "is-current"}>
            <span aria-hidden="true">1</span><strong>Saving evidence</strong>
          </li>
          <li className={ready ? "is-complete" : "is-pending"}>
            <span aria-hidden="true">2</span><strong>Copilot ready</strong>
          </li>
        </ol>
      </div>
      <div className="phase02-handoff-actions">
        {ready && copilotHref ? (
          <Link className="button primary" href={copilotHref}>Continue to Copilot</Link>
        ) : failed ? (
          <button className="button primary" type="button" onClick={onRetry}>Retry sync</button>
        ) : (
          <button className="button primary" type="button" disabled aria-busy="true">Saving evidence</button>
        )}
        <Link className="button secondary consultation-cta" href="/consultation">Request consultation</Link>
      </div>
    </section>
  );
}

export function BlueprintView({
  assessment,
  sources,
  initialBlueprint,
  initialNotice,
  onPersist,
}: {
  assessment?: AssessmentDraft;
  sources: BlueprintSources;
  initialBlueprint?: Blueprint;
  initialNotice?: string;
  onPersist?: (blueprint: Blueprint) => void;
}) {
  const [blueprint, setBlueprint] = useState(initialBlueprint);
  const [notice, setNotice] = useState(initialNotice);
  const [busy, setBusy] = useState(false);
  const [generationFailed, setGenerationFailed] = useState(false);
  const [syncState, setSyncState] = useState<DurableSyncState>(blueprint ? "saving" : "idle");
  const [syncContext, setSyncContext] = useState<DurableJourneyContext>();
  const [syncAttempt, setSyncAttempt] = useState(0);
  const generationController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => {
    const controller = generationController.current;
    generationController.current = undefined;
    controller?.abort();
  }, []);
  const [statuses, setStatuses] = useState<Record<string, AdvisorStatus>>(() =>
    initialBlueprint ? originStatuses(initialBlueprint) : readyStatuses(),
  );

  useEffect(() => {
    let openedForPrint: HTMLDetailsElement[] = [];
    const expandReportDisclosures = () => {
      openedForPrint = Array.from(document.querySelectorAll<HTMLDetailsElement>(".phase06-report details:not([open])"));
      openedForPrint.forEach((disclosure) => { disclosure.open = true; });
    };
    const restoreReportDisclosures = () => {
      openedForPrint.forEach((disclosure) => { disclosure.open = false; });
      openedForPrint = [];
    };
    window.addEventListener("beforeprint", expandReportDisclosures);
    window.addEventListener("afterprint", restoreReportDisclosures);
    return () => {
      window.removeEventListener("beforeprint", expandReportDisclosures);
      window.removeEventListener("afterprint", restoreReportDisclosures);
      restoreReportDisclosures();
    };
  }, []);

  useEffect(() => {
    if (!assessment || !blueprint) return;
    let active = true;
    setSyncState("saving");
    setSyncContext(undefined);
    syncDurableJourney(localStorage, { draft: assessment, ...sources, blueprint })
      .then((context) => {
        if (!active) return;
        setSyncContext(context);
        setSyncState("ready");
      })
      .catch(() => {
        if (!active) return;
        setSyncContext(undefined);
        setSyncState("failed");
      });
    return () => { active = false; };
  }, [assessment, blueprint, sources, syncAttempt]);

  const generate = async () => {
    if (generationController.current) return;
    const identity = workspaceIdentity(localStorage);
    setBusy(true);
    setGenerationFailed(false);
    setNotice(undefined);
    setStatuses(reviewingStatuses());
    const controller = new AbortController();
    generationController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);

    try {
      const context = buildAdvisorReviewContext(sources.twin, sources.diagnostic, sources.recommendations, sources.comparison);
      let panel: AdvisorPanelResponse;
      let fallbackUsed = false;
      let requiredFailure = false;

      try {
        const response = await fetch("/api/advisors/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context, advisorIds: EXABYTES_ADVISORS_1_0_0.map((advisor) => advisor.id) }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
          requiredFailure = Boolean(body?.error?.code?.startsWith("AI_"));
          throw new Error(body?.error?.code ?? "review_unavailable");
        }
        panel = advisorPanelResponseSchema.parse(await response.json());
      } catch (error) {
        if (requiredFailure) throw error;
        panel = fallbackPanel(sources);
        fallbackUsed = true;
      }

      if (generationController.current !== controller || workspaceIdentity(localStorage) !== identity) return;
      const next = buildBlueprint(
        { ...sources, panel },
        { id: () => makeId("blueprint"), now: () => new Date().toISOString() },
      );
      onPersist?.(next);
      invalidateDurableJourney(localStorage);
      setSyncContext(undefined);
      setSyncState("saving");
      setBlueprint(next);
      setStatuses(originStatuses(next));
      setNotice(
        fallbackUsed
          ? "Live review was unavailable. All five roles completed with deterministic fallback, and upstream records were not changed."
          : undefined,
      );
    } catch {
      setStatuses(failedStatuses());
      setGenerationFailed(true);
      setNotice("The Blueprint could not be saved safely. Upstream records were not changed. Retry when ready.");
    } finally {
      window.clearTimeout(timeout);
      generationController.current = undefined;
      setBusy(false);
    }
  };

  return (
    <PostAssessmentShell businessName={sources.twin.identity.businessName} context="blueprint">
      <main id="main-content" className="phase06-shell">
        <BlueprintCommandHeader blueprint={blueprint} busy={busy} context={syncContext} onGenerate={generate} sources={sources} />
        <AdvisorStatusBoard blueprint={blueprint} busy={busy} notice={notice} statuses={statuses} />
        {!blueprint ? (
          <section className={`phase06-empty no-print${generationFailed ? " is-error" : ""}`} role={generationFailed ? "alert" : undefined}>
            <p className="eyebrow">{generationFailed ? "Generation paused safely" : "Ready to review"}</p>
            <h2>{generationFailed ? "The Blueprint was not created" : "No Blueprint has been generated"}</h2>
            <p>
              {generationFailed
                ? "Your preferred scenario and all upstream records are unchanged. Try again when the review service is available."
                : "The preferred scenario is ready. Generation creates a new immutable, source-linked record without changing the Business Twin, diagnosis, recommendations, or scenario."}
            </p>
            <button className="button primary" type="button" onClick={generate} disabled={busy}>
              {busy ? "Reviewing five perspectives" : generationFailed ? "Try generation again" : "Generate advisor review and Blueprint"}
            </button>
            {generationFailed ? <Link className="phase06-safe-return" href="/scenarios">Return to scenarios</Link> : null}
          </section>
        ) : (
          <>
            <BlueprintHandoff context={syncContext} state={syncState} onRetry={() => setSyncAttempt((attempt) => attempt + 1)} />
            <DecisionOverview blueprint={blueprint} />
            <BlueprintReport blueprint={blueprint} />
          </>
        )}
      </main>
    </PostAssessmentShell>
  );
}

export function BlueprintClient() {
  const router = useRouter();
  const [loaded, setLoaded] = useState<{ assessment: AssessmentDraft; sources: BlueprintSources; blueprint?: Blueprint; notice?: string }>();

  useEffect(() => {
    const assessment = loadAssessmentDraft(localStorage);
    if (assessment.status !== "ok" || assessment.draft.status !== "ready_for_review") {
      router.replace("/assessment");
      return;
    }

    try {
      const twin = rebuildCurrentTwin(assessment.draft);
      const diagnostic = loadDiagnosticResult(localStorage, twin);
      if (diagnostic.status !== "ok") {
        router.replace("/assessment/analysis");
        return;
      }
      const recommendations = loadRecommendationResult(localStorage, twin, diagnostic.result);
      if (recommendations.status !== "ok") {
        router.replace("/recommendations");
        return;
      }
      const comparison = loadScenarioComparison(localStorage, twin, diagnostic.result, recommendations.result);
      if (comparison.status !== "ok") {
        router.replace("/scenarios");
        return;
      }

      const sources = { twin, diagnostic: diagnostic.result, recommendations: recommendations.result, comparison: comparison.result };
      if (!comparison.result.selectedScenarioId) {
        setLoaded({ assessment: assessment.draft, sources, notice: "Choose a preferred scenario before generating a Blueprint." });
        return;
      }

      const saved = loadBlueprint(localStorage, twin, diagnostic.result, recommendations.result, comparison.result);
      if (saved.status !== "ok") invalidateDurableJourney(localStorage);
      setLoaded({
        assessment: assessment.draft,
        sources,
        blueprint: saved.status === "ok" ? saved.result : undefined,
        notice:
          saved.status === "discarded"
            ? `The previous Blueprint was ${saved.reason} and was safely discarded. Generate a new review when ready.`
            : undefined,
      });
    } catch {
      router.replace("/scenarios");
    }
  }, [router]);

  if (!loaded) {
    return (
      <PostAssessmentShell context="restoring-blueprint">
        <main id="main-content" className="phase06-restoring" aria-busy="true">
          <p className="eyebrow">Validating source chain</p>
          <h1>Preparing the decision Blueprint.</h1>
          <p>The selected scenario, immutable source identities, and saved review are being checked locally.</p>
          <div className="phase06-restoring-shape" aria-hidden="true"><span /><span /><span /></div>
        </main>
      </PostAssessmentShell>
    );
  }

  if (!loaded.sources.comparison.selectedScenarioId) {
    return (
      <PostAssessmentShell businessName={loaded.sources.twin.identity.businessName} context="blueprint">
        <main id="main-content" className="phase06-missing">
          <Brand />
          <p className="eyebrow">Safe return required</p>
          <h1>A preferred scenario is required.</h1>
          <p>{loaded.notice}</p>
          <Link className="button primary" href="/scenarios">Return to scenarios</Link>
        </main>
      </PostAssessmentShell>
    );
  }

  return (
    <BlueprintView
      assessment={loaded.assessment}
      sources={loaded.sources}
      initialBlueprint={loaded.blueprint}
      initialNotice={loaded.notice}
      onPersist={(result) => saveBlueprint(localStorage, result)}
    />
  );
}
