import { describe, expect, it } from "vitest";
import { createGoldenAssessmentDraft, GOLDEN_FIXTURES } from "@/domain-packs/exabytes/golden-fixtures";
import { DEMO_BACKUP_STORAGE_KEY, hasParkedAssessment, openDemoWorkspace, resetDemoWorkspace } from "@/infrastructure/persistence/demo-workspace";
import { ASSESSMENT_STORAGE_KEY, loadAssessmentDraft, saveAssessmentDraft } from "@/infrastructure/persistence/local-assessment-store";
import { ACCOUNT_CASE_STORAGE_KEY } from "@/infrastructure/persistence/account-case-scope";
import { DURABLE_JOURNEY_STORAGE_KEY } from "@/infrastructure/persistence/durable-journey-client";
import { DEMO_SESSION_STORAGE_KEY, loadDemoSession, PROJECT_LOCAL_STORAGE_KEYS, PROJECT_SESSION_STORAGE_KEYS } from "@/infrastructure/persistence/project-storage";
import { DEMO_WORKSPACE_HEADER, workspaceIdentity, workspaceRequest } from "@/infrastructure/persistence/workspace-request";
import { memoryStorage, now } from "./stage04-fixtures";

function stores() {
  return { local: memoryStorage().storage as Storage, session: memoryStorage().storage as Storage };
}

describe("functional demo workspace isolation", () => {
  it("opens a demo after New assessment and restores the unfinished guest draft on reset", () => {
    const { local, session } = stores();
    const draft = { ...createGoldenAssessmentDraft(GOLDEN_FIXTURES[0], "assessment_realguest0001", now), status: "in_progress" as const, currentStep: 1, answers: {}, followUpAnswers: {}, selectedFollowUpIds: [] };
    saveAssessmentDraft(local, draft);
    local.setItem(DURABLE_JOURNEY_STORAGE_KEY, "original guest context");
    openDemoWorkspace(local, session, GOLDEN_FIXTURES[1]);
    expect(loadDemoSession(local)?.fixtureId).toBe("case-b");
    expect(loadAssessmentDraft(local).status).toBe("ok");
    expect(hasParkedAssessment(local)).toBe(true);
    expect(local.getItem(DURABLE_JOURNEY_STORAGE_KEY)).toBeNull();
    expect(resetDemoWorkspace(local, session)).toBe(true);
    expect(loadAssessmentDraft(local)).toEqual({ status: "ok", draft });
    expect(local.getItem(DURABLE_JOURNEY_STORAGE_KEY)).toBe("original guest context");
    expect(local.getItem(DEMO_BACKUP_STORAGE_KEY)).toBeNull();
  });

  it("preserves every real case record through A → B → C and only clears the active demo", () => {
    const { local, session } = stores();
    for (const key of PROJECT_LOCAL_STORAGE_KEYS) if (key !== DEMO_SESSION_STORAGE_KEY) local.setItem(key, `real:${key}`);
    for (const key of PROJECT_SESSION_STORAGE_KEYS) session.setItem(key, `real:${key}`);
    const account = JSON.stringify({ organizationId: crypto.randomUUID(), caseId: crypto.randomUUID(), revision: 4 });
    local.setItem(ACCOUNT_CASE_STORAGE_KEY, account);
    local.setItem("majupilot:account-case-last-stage:1.0.0", "/copilot");
    local.setItem("unrelated", "keep"); session.setItem("unrelated", "keep");
    for (const fixture of GOLDEN_FIXTURES) {
      openDemoWorkspace(local, session, fixture);
      expect(local.getItem(ACCOUNT_CASE_STORAGE_KEY)).toBeNull();
      expect(loadDemoSession(local)?.fixtureId).toBe(fixture.id);
    }
    resetDemoWorkspace(local, session);
    for (const key of PROJECT_LOCAL_STORAGE_KEYS) if (key !== DEMO_SESSION_STORAGE_KEY) expect(local.getItem(key)).toBe(`real:${key}`);
    for (const key of PROJECT_SESSION_STORAGE_KEYS) expect(session.getItem(key)).toBe(`real:${key}`);
    expect(local.getItem(ACCOUNT_CASE_STORAGE_KEY)).toBe(account);
    expect(local.getItem("majupilot:account-case-last-stage:1.0.0")).toBe("/copilot");
    expect(local.getItem("unrelated")).toBe("keep"); expect(session.getItem("unrelated")).toBe("keep");
  });

  it("never deletes a real assessment when reset is clicked outside demo mode", () => {
    const { local, session } = stores();
    local.setItem(ASSESSMENT_STORAGE_KEY, "real assessment");
    local.setItem(DURABLE_JOURNEY_STORAGE_KEY, "real context");
    expect(resetDemoWorkspace(local, session)).toBe(false);
    expect(local.getItem(ASSESSMENT_STORAGE_KEY)).toBe("real assessment");
    expect(local.getItem(DURABLE_JOURNEY_STORAGE_KEY)).toBe("real context");
  });

  it("backs up before modifying work and rolls back a failed demo launch", () => {
    const { local, session } = stores();
    local.setItem(ASSESSMENT_STORAGE_KEY, "real draft");
    const set = local.setItem;
    local.setItem = (key, value) => { if (key === DEMO_SESSION_STORAGE_KEY) throw new Error("quota"); set(key, value); };
    expect(() => openDemoWorkspace(local, session, GOLDEN_FIXTURES[0])).toThrow("quota");
    expect(local.getItem(ASSESSMENT_STORAGE_KEY)).toBe("real draft");
    expect(loadDemoSession(local)).toBeUndefined();
  });

  it("fails before deleting an active demo if its backup is unreadable", () => {
    const { local, session } = stores();
    openDemoWorkspace(local, session, GOLDEN_FIXTURES[0]);
    const draft = local.getItem(ASSESSMENT_STORAGE_KEY);
    local.setItem(DEMO_BACKUP_STORAGE_KEY, "broken-json");
    expect(() => resetDemoWorkspace(local, session)).toThrow();
    expect(local.getItem(ASSESSMENT_STORAGE_KEY)).toBe(draft);
  });

  it("selects the demo cookie on demo requests and preserves caller headers and body", () => {
    const { local, session } = stores();
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    expect(new Headers(workspaceRequest(init, local).headers).has(DEMO_WORKSPACE_HEADER)).toBe(false);
    openDemoWorkspace(local, session, GOLDEN_FIXTURES[0]);
    const request = workspaceRequest(init, local);
    expect(new Headers(request.headers).get(DEMO_WORKSPACE_HEADER)).toBe("demo");
    expect(new Headers(request.headers).get("Content-Type")).toBe("application/json");
    expect(request.body).toBe("{}");
    resetDemoWorkspace(local, session);
    expect(new Headers(workspaceRequest(init, local).headers).has(DEMO_WORKSPACE_HEADER)).toBe(false);
  });

  it("does not treat a successful account autosave as a case switch", () => {
    const { local } = stores();
    const account = { organizationId: crypto.randomUUID(), caseId: crypto.randomUUID(), revision: 2 };
    local.setItem(ACCOUNT_CASE_STORAGE_KEY, JSON.stringify(account));
    const before = workspaceIdentity(local);
    local.setItem(ACCOUNT_CASE_STORAGE_KEY, JSON.stringify({ ...account, revision: 3 }));
    expect(workspaceIdentity(local)).toBe(before);
    local.setItem(ACCOUNT_CASE_STORAGE_KEY, JSON.stringify({ ...account, caseId: crypto.randomUUID() }));
    expect(workspaceIdentity(local)).not.toBe(before);
  });
});
