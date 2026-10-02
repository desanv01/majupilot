import { createGoldenAssessmentDraft, type GoldenFixture } from "@/domain-packs/exabytes/golden-fixtures";
import { ASSESSMENT_STORAGE_KEY, saveAssessmentDraft } from "./local-assessment-store";
import { ACCOUNT_CASE_STORAGE_KEY, ACCOUNT_CASE_CHANGED_EVENT } from "./account-case-scope";
import { clearKnownProjectStorage, loadDemoSession, saveDemoSession, PROJECT_LOCAL_STORAGE_KEYS, PROJECT_SESSION_STORAGE_KEYS, DEMO_SESSION_CHANGED_EVENT } from "./project-storage";

export const DEMO_BACKUP_STORAGE_KEY = "majupilot:pre-demo-workspace:1.0.0";
const lastStageKey = "majupilot:account-case-last-stage:1.0.0";
const localKeys = [...PROJECT_LOCAL_STORAGE_KEYS, ACCOUNT_CASE_STORAGE_KEY, lastStageKey];
const snapshotSchema = z.object({ local: z.record(z.string(), z.string()), session: z.record(z.string(), z.string()) }).strict();
type Snapshot = z.infer<typeof snapshotSchema>;

function capture(local: Storage, session: Storage): Snapshot {
  const entries = (storage: Storage, keys: readonly string[]) => Object.fromEntries(keys.flatMap((key) => {
    const value = storage.getItem(key);
    return value === null ? [] : [[key, value]];
  }));
  return { local: entries(local, localKeys), session: entries(session, PROJECT_SESSION_STORAGE_KEYS) };
}

function restore(local: Storage, session: Storage, snapshot: Snapshot) {
  clearKnownProjectStorage(local, session);
  local.removeItem(ACCOUNT_CASE_STORAGE_KEY);
  local.removeItem(lastStageKey);
  for (const key of localKeys) if (typeof snapshot.local[key] === "string") local.setItem(key, snapshot.local[key]);
  for (const key of PROJECT_SESSION_STORAGE_KEYS) if (typeof snapshot.session[key] === "string") session.setItem(key, snapshot.session[key]);
}

function notify() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(DEMO_SESSION_CHANGED_EVENT));
  window.dispatchEvent(new Event(ACCOUNT_CASE_CHANGED_EVENT));
}

export function openDemoWorkspace(local: Storage, session: Storage, fixture: GoldenFixture) {
  const previous = capture(local, session);
  if (!loadDemoSession(local)) {
    // Persist the backup before touching the active work, including unsaved guest drafts.
    local.setItem(DEMO_BACKUP_STORAGE_KEY, JSON.stringify(previous));
  }
  try {
    clearKnownProjectStorage(local, session);
    local.removeItem(ACCOUNT_CASE_STORAGE_KEY);
    local.removeItem(lastStageKey);
    const sessionId = `assessment_demo_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const loadedAt = new Date().toISOString();
    saveAssessmentDraft(local, createGoldenAssessmentDraft(fixture, sessionId, loadedAt));
    saveDemoSession(local, { schemaVersion: "1.0.0", fixtureId: fixture.id, fixtureVersion: fixture.fixtureVersion, label: fixture.label, fictional: true, assessmentSessionId: sessionId, loadedAt });
  } catch (error) {
    restore(local, session, previous);
    throw error;
  }
  notify();
}

export function resetDemoWorkspace(local: Storage, session: Storage) {
  if (!loadDemoSession(local)) return false;
  const raw = local.getItem(DEMO_BACKUP_STORAGE_KEY);
  const snapshot = raw ? snapshotSchema.parse(JSON.parse(raw)) : { local: {}, session: {} };
  restore(local, session, snapshot);
  local.removeItem(DEMO_BACKUP_STORAGE_KEY);
  notify();
  return true;
}

export function hasParkedAssessment(local: Pick<Storage, "getItem">) {
  try {
    const raw = local.getItem(DEMO_BACKUP_STORAGE_KEY);
    return raw ? Boolean((JSON.parse(raw) as Snapshot).local[ASSESSMENT_STORAGE_KEY]) : false;
  } catch { return false; }
}
import { z } from "zod";
