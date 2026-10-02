import { rebuildCurrentTwin } from "@/core/assessment/rebuild-current-twin";
import { activeAccountCase } from "./account-case-scope";
import { workspaceIdentity } from "./workspace-request";

import { loadAssessmentDraft } from "./local-assessment-store";
import { loadBlueprint } from "./local-blueprint-store";
import { loadDiagnosticResult } from "./local-diagnostic-store";
import { loadRecommendationResult } from "./local-recommendation-store";
import { loadScenarioComparison } from "./local-scenario-store";
import {
  durableJourneySourceFingerprint,
  loadDurableJourney,
  type DurableJourneyContext,
} from "./durable-journey-client";

export async function loadCurrentDurableJourney(storage: Storage): Promise<DurableJourneyContext | undefined> {
  const identity = workspaceIdentity(storage);
  const context = loadDurableJourney(storage);
  if (!context?.syncedAt || !context.artifactIds || !context.sourceFingerprint) return undefined;
  const accountCase = activeAccountCase(storage);
  if (accountCase && (context.organizationId !== accountCase.organizationId || context.assessmentSessionId !== accountCase.caseId)) return undefined;

  try {
    const assessment = loadAssessmentDraft(storage);
    if (assessment.status !== "ok" || assessment.draft.status !== "ready_for_review") return undefined;
    const twin = rebuildCurrentTwin(assessment.draft);
    const diagnostic = loadDiagnosticResult(storage, twin);
    if (diagnostic.status !== "ok") return undefined;
    const recommendations = loadRecommendationResult(storage, twin, diagnostic.result);
    if (recommendations.status !== "ok") return undefined;
    const comparison = loadScenarioComparison(storage, twin, diagnostic.result, recommendations.result);
    if (comparison.status !== "ok") return undefined;
    const blueprint = loadBlueprint(storage, twin, diagnostic.result, recommendations.result, comparison.result);
    if (blueprint.status !== "ok") return undefined;
    const fingerprint = await durableJourneySourceFingerprint({
      draft: assessment.draft,
      twin,
      diagnostic: diagnostic.result,
      recommendations: recommendations.result,
      comparison: comparison.result,
      blueprint: blueprint.result,
    });
    return workspaceIdentity(storage) === identity && fingerprint === context.sourceFingerprint ? context : undefined;
  } catch {
    return undefined;
  }
}
