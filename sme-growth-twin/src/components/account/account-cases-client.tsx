"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";

import { createBrowserSupabaseClient, createPasswordRecoveryRequestClient } from "@/infrastructure/supabase/browser";
import { accountCaseResumePath, activeAccountCase, clearAccountCaseStorage, restoreAccountCase, saveActiveAccountCase, setActiveAccountCase } from "@/infrastructure/persistence/account-case-client";
import { accountCaseSnapshotSchema } from "@/domain/account-cases";
import { assessmentDraftSchema } from "@/domain/assessment";
import { ASSESSMENT_STORAGE_KEY } from "@/infrastructure/persistence/local-assessment-store";
import { DEMO_SESSION_STORAGE_KEY } from "@/infrastructure/persistence/project-storage";
import { loadDurableJourney, DURABLE_JOURNEY_STORAGE_KEY } from "@/infrastructure/persistence/durable-journey-client";
import { ACCOUNT_CASE_CHANGED_EVENT } from "@/infrastructure/persistence/account-case-scope";
import { ACCOUNT_CASE_LOCAL_CHANGE_EVENT } from "@/infrastructure/persistence/account-case-events";
import { resetDemoWorkspace } from "@/infrastructure/persistence/demo-workspace";

type CaseListItem = { id: string; businessName: string; state: string; progress: string; revision: number; updatedAt: string };
type Envelope<T> = { data?: T; error?: { code: string } };
type AuthMode = "sign_in" | "sign_up" | "reset";

function authFailureMessage(error: unknown, action: "sign_in" | "email" | "password") {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") return "Email requests are temporarily limited. Please try again later.";
  if (code === "weak_password") return "Choose a stronger password and try again.";
  if (code === "email_address_invalid") return "Enter a valid email address and try again.";
  if (action === "sign_in") return "We couldn't sign you in. Check your email and password, then try again.";
  if (action === "password") return "Could not save your password. Please try again.";
  return "We couldn't send an email right now. Please try again later.";
}

async function parseResponse<T>(result: Response): Promise<T> {
  const body = await result.json() as Envelope<T>;
  if (!result.ok || !body.data) throw new Error(body.error?.code ?? "Request failed");
  return body.data;
}

function subscribeBrowserWork(callback: () => void) {
  window.addEventListener(ACCOUNT_CASE_CHANGED_EVENT, callback);
  window.addEventListener(ACCOUNT_CASE_LOCAL_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(ACCOUNT_CASE_CHANGED_EVENT, callback);
    window.removeEventListener(ACCOUNT_CASE_LOCAL_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function browserWorkSnapshot() {
  try {
    const raw = localStorage.getItem(ASSESSMENT_STORAGE_KEY);
    if (!raw || localStorage.getItem(DEMO_SESSION_STORAGE_KEY)) return false;
    if (!assessmentDraftSchema.safeParse(JSON.parse(raw) as unknown).success) return false;
    const active = activeAccountCase(localStorage);
    return !active || active.revision === 0;
  } catch { return false; }
}

export function AccountCasesClient({ initialAuthError, initialAuthCallback = false, initialRecovery = false }: { initialAuthError: boolean; initialAuthCallback?: boolean; initialRecovery?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("sign_in");
  const [newPassword, setNewPassword] = useState("");
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [organizationId, setOrganizationId] = useState<string>();
  const [cases, setCases] = useState<CaseListItem[]>([]);
  const [conflictCaseId, setConflictCaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const browserWork = useSyncExternalStore(subscribeBrowserWork, browserWorkSnapshot, () => false);
  const [message, setMessage] = useState(initialAuthError ? "This email link has expired. Request a new confirmation or password reset link." : "");

  useEffect(() => {
    const openAccount = async () => {
      resetDemoWorkspace(localStorage, sessionStorage);
      const client = createBrowserSupabaseClient();
      if (initialAuthCallback) {
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const accessToken = fragment.get("access_token");
        const refreshToken = fragment.get("refresh_token");
        const isRecovery = fragment.get("type") === "recovery";
        window.history.replaceState(null, "", "/cases");
        if (!accessToken || !refreshToken) throw new Error("missing_recovery_session");
        const { data, error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (error || !data.user?.email) throw error ?? new Error("invalid_recovery_session");
        setSignedInEmail(data.user.email);
        setEmail(data.user.email);
        if (isRecovery) {
          setShowPasswordForm(true);
          setMessage("Choose a new password to finish resetting your account.");
        }
        return;
      }
      const { data } = await client.auth.getUser();
      if (data.user?.email) {
        setSignedInEmail(data.user.email);
        setEmail(data.user.email);
        if (initialRecovery) {
          setShowPasswordForm(true);
          setMessage("Choose a new password to finish resetting your account.");
        }
      } else if (initialRecovery) throw new Error("missing_recovery_session");
    };
    void openAccount().catch(() => {
      if (initialAuthCallback || initialRecovery) setMessage("This email link is invalid or expired. Request a new password reset link.");
    }).finally(() => setCheckingAuth(false));
  }, [initialAuthCallback, initialRecovery]);

  useEffect(() => {
    if (!signedInEmail) return;
    let cancelled = false;
    const load = async () => {
      try {
        const workspace = await parseResponse<{ organizationId: string }>(await fetch("/api/v2/account/workspace", { method: "POST" }));
        const items = await parseResponse<CaseListItem[]>(await fetch(`/api/v2/cases?organizationId=${encodeURIComponent(workspace.organizationId)}`, { cache: "no-store" }));
        if (!cancelled) { setOrganizationId(workspace.organizationId); setCases(items); }
      } catch {
        if (!cancelled) setMessage("Saved cases are temporarily unavailable. Your work in this browser is still here.");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [signedInEmail]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const client = createBrowserSupabaseClient();
      if (authMode === "reset") {
        const { error } = await createPasswordRecoveryRequestClient().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/auth/confirm` });
        if (error) throw error;
        setMessage("If this address has an account, a password reset link is on its way. After opening it, set a new password in Saved cases.");
      } else if (authMode === "sign_up") {
        if (password.length < 8 || password !== confirmPassword) {
          setMessage("Use at least 8 characters and enter the same password twice.");
          return;
        }
        const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: `${location.origin}/auth/confirm` } });
        if (error) throw error;
        setPassword(""); setConfirmPassword("");
        if (data.session && data.user?.email) {
          setSignedInEmail(data.user.email);
          setMessage("Your account is ready. New cases can now be saved to it.");
        } else {
          setMessage("Check your email once to confirm your account. Then sign in with your password on this or another device.");
        }
      } else {
        const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        setPassword("");
        setSignedInEmail(data.user.email ?? email.trim());
        setMessage("Signed in. Your saved cases are loading.");
      }
    } catch (error) {
      setMessage(authFailureMessage(error, authMode === "sign_in" ? "sign_in" : "email"));
    } finally { setBusy(false); }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 8) { setMessage("Use at least 8 characters for your password."); return; }
    setBusy(true); setMessage("");
    try {
      const { error } = await createBrowserSupabaseClient().auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword(""); setShowPasswordForm(false);
      setMessage("Password saved. You can use it to sign in on another device without an email link.");
    } catch (error) { setMessage(authFailureMessage(error, "password")); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true);
    try {
      const savedCase = activeAccountCase(localStorage);
      await flushCurrent();
      await parseResponse<{ signedOut: true }>(await fetch("/api/v2/account/sign-out", { method: "POST" }));
      if (savedCase) clearAccountCaseStorage(localStorage, sessionStorage);
      setSignedInEmail(null);
      setOrganizationId(undefined);
      setCases([]);
      router.refresh();
    } catch { setMessage("Could not sign out. Please try again."); }
    finally { setBusy(false); }
  }

  async function refreshCases(scope: string) {
    setCases(await parseResponse<CaseListItem[]>(await fetch(`/api/v2/cases?organizationId=${encodeURIComponent(scope)}`, { cache: "no-store" })));
  }

  async function flushCurrent() {
    if (activeAccountCase(localStorage)) await saveActiveAccountCase();
  }

  async function loadSavedCase(caseId: string, scope: string) {
    const record = await parseResponse<{ revision: number; snapshot: unknown }>(await fetch(`/api/v2/cases/${caseId}?organizationId=${encodeURIComponent(scope)}`, { cache: "no-store" }));
    const snapshot = record.snapshot === null ? null : accountCaseSnapshotSchema.parse(record.snapshot);
    restoreAccountCase(record.snapshot, { organizationId: scope, caseId, revision: record.revision });
    router.push(snapshot ? accountCaseResumePath(snapshot) : "/assessment?new=1");
  }

  async function openCase(caseId: string) {
    if (!organizationId || busy) return;
    if (browserWork) { setMessage("Add this browser's work to your account before opening another case."); return; }
    setBusy(true); setMessage(""); setConflictCaseId(null);
    try {
      await flushCurrent();
      await loadSavedCase(caseId, organizationId);
    } catch (error) {
      if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
        setConflictCaseId(caseId);
        setMessage("This browser has edits that differ from the latest saved case. You can open the saved version, which will replace this browser's copy, or keep this page to preserve the browser copy.");
      } else setMessage("Could not open this case. Your current browser work has not been cleared.");
    }
    finally { setBusy(false); }
  }

  async function openSavedVersion() {
    if (!organizationId || !conflictCaseId || busy) return;
    setBusy(true); setMessage("");
    try {
      await loadSavedCase(conflictCaseId, organizationId);
      setConflictCaseId(null);
    } catch { setMessage("Could not open the saved version. This browser's copy is still here."); }
    finally { setBusy(false); }
  }

  async function newCase() {
    if (!organizationId || busy) return;
    if (browserWork) { setMessage("Add this browser's work to your account before starting another case."); return; }
    setBusy(true); setMessage("");
    try {
      await flushCurrent();
      const created = await parseResponse<{ id: string }>(await fetch("/api/v2/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId }) }));
      restoreAccountCase(null, { organizationId, caseId: created.id, revision: 0 });
      router.push("/assessment?new=1");
    } catch { setMessage("Could not start a new case. Your current browser work has not been cleared."); }
    finally { setBusy(false); }
  }

  async function addBrowserWork() {
    if (!organizationId || busy) return;
    setBusy(true); setMessage("");
    try {
      const pendingCase = activeAccountCase(localStorage);
      if (pendingCase) {
        if (pendingCase.organizationId !== organizationId) throw new Error("Case workspace mismatch");
        await saveActiveAccountCase();
        await refreshCases(organizationId);
        setMessage("This browser's work is now saved to your account.");
        return;
      }
      const journey = loadDurableJourney(localStorage);
      let caseId: string;
      if (journey?.guestSessionId) {
        const claimed = await parseResponse<{ assessmentSessionId: string }>(await fetch("/api/v2/guest/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId }) }));
        caseId = claimed.assessmentSessionId;
        localStorage.setItem(DURABLE_JOURNEY_STORAGE_KEY, JSON.stringify({ ...journey, guestSessionId: undefined, organizationId, assessmentSessionId: caseId }));
      } else {
        const created = await parseResponse<{ id: string }>(await fetch("/api/v2/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId }) }));
        caseId = created.id;
        localStorage.setItem(DURABLE_JOURNEY_STORAGE_KEY, JSON.stringify({ organizationId, assessmentSessionId: caseId, leadIdempotencyKey: `lead:${crypto.randomUUID()}` }));
      }
      setActiveAccountCase(localStorage, { organizationId, caseId, revision: 0 });
      await saveActiveAccountCase();
      await refreshCases(organizationId);
      setMessage("This browser's work is now saved to your account.");
    } catch {
      setMessage("Could not add this browser's work yet. The work remains on this device; please retry.");
    } finally { setBusy(false); }
  }

  if (checkingAuth) return <section className="account-card" aria-busy="true"><h2>Checking your account…</h2><p>Opening your saved workspace.</p></section>;

  if (!signedInEmail) return (
    <section className="account-card" aria-labelledby="account-signin-title">
      <p className="account-step">Your account</p>
      <h2 id="account-signin-title">{authMode === "sign_up" ? "Create your account" : authMode === "reset" ? "Reset your password" : "Sign in to your workspace"}</h2>
      <p>{authMode === "sign_up" ? "Confirm your email once, then use your password to sign in on any device." : authMode === "reset" ? "We'll email a link to help you set a new password." : "Return to your saved cases with your email and password."}</p>
      <div className="account-auth-tabs" role="group" aria-label="Account access">
        <button type="button" className={authMode === "sign_in" ? "selected" : ""} aria-pressed={authMode === "sign_in"} onClick={() => { setAuthMode("sign_in"); setMessage(""); }}>Sign in</button>
        <button type="button" className={authMode === "sign_up" ? "selected" : ""} aria-pressed={authMode === "sign_up"} onClick={() => { setAuthMode("sign_up"); setMessage(""); }}>Create account</button>
      </div>
      <form onSubmit={submitAuth} className="account-signin-form">
        <label htmlFor="account-email">Email address</label>
        <input id="account-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
        {authMode !== "reset" && <><label htmlFor="account-password">Password</label><input id="account-password" type="password" autoComplete={authMode === "sign_up" ? "new-password" : "current-password"} minLength={authMode === "sign_up" ? 8 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} /></>}
        {authMode === "sign_up" && <><label htmlFor="account-confirm-password">Confirm password</label><input id="account-confirm-password" type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></>}
        <button className="button" type="submit" disabled={busy}>{busy ? "Working…" : authMode === "sign_up" ? "Create account" : authMode === "reset" ? "Send reset link" : "Sign in"}</button>
      </form>
      <button className="account-text-button account-reset-link" type="button" onClick={() => { setAuthMode(authMode === "reset" ? "sign_in" : "reset"); setMessage(""); }}>{authMode === "reset" ? "Back to sign in" : "Forgot your password?"}</button>
      {message && <p role="status" className="account-message">{message}</p>}
      {authMode === "sign_in" && <p className="account-footnote">Already used an email link? In the browser where you are signed in, open Saved cases and choose <strong>Set or change password</strong>.</p>}
      <p className="account-footnote">Work started without sign-in stays in this browser until you add it to your account.</p>
    </section>
  );

  return (
    <section className="account-card" aria-labelledby="account-cases-title">
      <div className="account-card-header">
        <div><p className="account-step">Your account</p><h2 id="account-cases-title">Saved cases</h2><p>Signed in as {signedInEmail}</p></div>
        <button className="account-text-button" type="button" onClick={signOut} disabled={busy}>Sign out</button>
      </div>
      <div className="account-security">
        <button className="account-text-button" type="button" disabled={busy} onClick={() => setShowPasswordForm((value) => !value)}>{showPasswordForm ? "Cancel password change" : "Set or change password"}</button>
        {showPasswordForm && <form onSubmit={savePassword} className="account-signin-form"><label htmlFor="account-new-password">New password</label><input id="account-new-password" type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><button className="button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save password"}</button></form>}
      </div>
      {message && <p role="status" className="account-message">{message}</p>}
      {conflictCaseId && <button className="button account-secondary-button" type="button" disabled={busy} onClick={() => void openSavedVersion()}>Open latest saved version</button>}
      {!organizationId ? <p>Loading your workspace…</p> : (
        <>
          <div className="account-case-actions">
            <button className="button" type="button" disabled={busy} onClick={() => void newCase()}>New case</button>
            {browserWork && <button className="button account-secondary-button" type="button" disabled={busy} onClick={() => void addBrowserWork()}>Add this browser&apos;s work</button>}
          </div>
          {cases.length ? <ul className="account-case-list">{cases.map((item) => (
            <li key={item.id}><div><strong>{item.businessName}</strong><span>{item.progress} · Updated {new Date(item.updatedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}</span></div><button type="button" className="account-text-button" disabled={busy} onClick={() => void openCase(item.id)}>Resume case</button></li>
          ))}</ul> : <p className="account-empty">No saved cases yet. You can start a new assessment or add the work in this browser.</p>}
        </>
      )}
    </section>
  );
}
