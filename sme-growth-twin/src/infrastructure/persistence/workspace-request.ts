import { activeAccountCase } from "./account-case-scope";

export const DEMO_WORKSPACE_HEADER = "x-majupilot-workspace";
const demoKey = "sme-growth-twin:demo-session:1.0.0";

export function workspaceIdentity(storage: Storage) {
  const account = activeAccountCase(storage);
  return JSON.stringify([
    storage.getItem("sme-growth-twin:assessment-draft:1.0.0"),
    storage.getItem(demoKey),
    account ? [account.organizationId, account.caseId] : null,
  ]);
}

// Selects an independently authorized guest workspace; never grants account access.
export function workspaceRequest(init: RequestInit = {}, storage?: Pick<Storage, "getItem">): RequestInit {
  const headers = new Headers(init.headers);
  const browserStorage = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (browserStorage?.getItem(demoKey)) headers.set(DEMO_WORKSPACE_HEADER, "demo");
  return { ...init, headers };
}
