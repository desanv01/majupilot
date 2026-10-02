"use client";

/* eslint-disable react-hooks/set-state-in-effect -- resume availability is client-only */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DemoResetControl } from "@/components/demo/demo-reset-control";
import { activeAccountCase, saveActiveAccountCase } from "@/infrastructure/persistence/account-case-client";
import { openDemoWorkspace, resetDemoWorkspace, hasParkedAssessment } from "@/infrastructure/persistence/demo-workspace";
import { createBrowserSupabaseClient } from "@/infrastructure/supabase/browser";

import {
  GOLDEN_FIXTURES,
  type GoldenFixture,
} from "@/domain-packs/exabytes/golden-fixtures";
import {
  loadAssessmentDraft,
} from "@/infrastructure/persistence/local-assessment-store";
import {
  DEMO_SESSION_CHANGED_EVENT,
  loadDemoSession,
  RESET_STATUS_SESSION_KEY,
} from "@/infrastructure/persistence/project-storage";

const demoPathNotes: Record<GoldenFixture["id"], string> = {
  "case-a": "Shows a broad foundation-first path across customer operations, continuity, and growth.",
  "case-b": "Shows workflow and data foundations taking priority before AI.",
  "case-c": "Shows a selective path for a digitally mature team with governed AI readiness.",
};

export function DemoLauncher() {
  const router = useRouter();
  const [loadingFixtureId, setLoadingFixtureId] = useState<GoldenFixture["id"] | null>(null);
  const [demoAvailable, setDemoAvailable] = useState(true);
  const [hasProjectRecords, setHasProjectRecords] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const refresh = () => {
      setHasProjectRecords(Boolean(loadDemoSession(localStorage)));

      const resetStatus = sessionStorage.getItem(RESET_STATUS_SESSION_KEY);
      if (resetStatus) {
        sessionStorage.removeItem(RESET_STATUS_SESSION_KEY);
        setStatus(resetStatus);
      }
    };

    try {
      refresh();
      window.addEventListener(DEMO_SESSION_CHANGED_EVENT, refresh);
    } catch {
      setDemoAvailable(false);
    }

    return () => window.removeEventListener(DEMO_SESSION_CHANGED_EVENT, refresh);
  }, []);

  const loadFixture = async (fixture: GoldenFixture) => {
    setLoadingFixtureId(fixture.id);
    setStatus(`Loading ${fixture.label} as fictional demonstration data.`);
    try {
      if (activeAccountCase(localStorage)) {
        try { await saveActiveAccountCase(); }
        catch {
          setLoadingFixtureId(null);
          setStatus("Your account case could not be saved. Your work is still here; retry before opening a demo.");
          return;
        }
      }
      openDemoWorkspace(localStorage, sessionStorage, fixture);
      setHasProjectRecords(true);
      router.push("/assessment/review");
    } catch {
      setLoadingFixtureId(null);
      setDemoAvailable(false);
      setStatus("Demo cases are unavailable in this browser. Starting a new assessment is still available above.");
    }
  };

  const reset = () => {
    try {
      resetDemoWorkspace(localStorage, sessionStorage);
      setHasProjectRecords(false);
      setStatus("MajuPilot demonstration data was reset. Other browser storage was not changed.");
    } catch {
      setDemoAvailable(false);
      setStatus("Demo storage is unavailable in this browser. No other browser data was changed.");
    }
  };

  return (
      <section className="demo-launcher" id="demo-cases" aria-labelledby="demo-title" aria-busy={loadingFixtureId !== null}>
        <div className="demo-launcher-heading">
          <div>
            <p className="eyebrow">Fictional demonstration cases</p>
            <h2 id="demo-title">Explore the complete journey with sample businesses.</h2>
            <p id="demo-disclosure">
              Your current assessment is kept on this device while you explore a demo. Resetting the demo restores it.
              It does not create consent or a consultation lead.
            </p>
          </div>
          {demoAvailable && loadingFixtureId === null ? (
            <DemoResetControl recordsPresent={hasProjectRecords} onConfirm={reset} />
          ) : (
            <button className="reset-demo" type="button" disabled>
              Reset demo data
            </button>
          )}
        </div>
        <div className="demo-case-grid">
          {GOLDEN_FIXTURES.map((fixture, index) => (
            <article className="demo-case" key={fixture.id}>
              <div className="demo-case-labels">
                <span>Fictional demo</span>
                {index === 0 ? <strong>Recommended</strong> : null}
              </div>
              <h3>{fixture.label}</h3>
              <p className="demo-sector">{fixture.sector}</p>
              <p>{fixture.challengeSummary}</p>
              <p className="demo-path-note"><strong>Rules path:</strong> {demoPathNotes[fixture.id]}</p>
              <button
                className="button secondary"
                data-fixture-id={fixture.id}
                type="button"
                aria-label={`Load fictional ${fixture.label} demonstration case`}
                aria-describedby="demo-disclosure"
                disabled={!demoAvailable || loadingFixtureId !== null}
                onClick={() => loadFixture(fixture)}
              >
                {loadingFixtureId === fixture.id
                  ? `Loading CASE ${fixture.id.slice(-1).toUpperCase()}`
                  : `Load CASE ${fixture.id.slice(-1).toUpperCase()}`}
              </button>
            </article>
          ))}
        </div>
        {status ? (
          <p className="reset-status demo-status" role="status" aria-live="polite">
            {status}
          </p>
        ) : null}
      </section>
  );
}

export function HomePrimaryActions() {
  const [resume, setResume] = useState(false);
  const [accountCaseActive, setAccountCaseActive] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => createBrowserSupabaseClient().auth.getUser()).then(({ data }) => setSignedIn(Boolean(data.user))).catch(() => undefined);
    const refresh = () => { try {
      const storedDraft = loadAssessmentDraft(localStorage);
      setResume(storedDraft.status === "ok" || hasParkedAssessment(localStorage));
      setAccountCaseActive(Boolean(activeAccountCase(localStorage)));
      if (storedDraft.status === "discarded") {
        setStatus("A saved assessment could not be restored and was safely removed. You can start again.");
      }

      const resetStatus = sessionStorage.getItem(RESET_STATUS_SESSION_KEY);
      if (resetStatus) {
        sessionStorage.removeItem(RESET_STATUS_SESSION_KEY);
        setStatus(resetStatus);
      }
    } catch {
      setStatus("Saved assessment tools are unavailable in this browser. You can still start a new assessment.");
    } };
    refresh();
    window.addEventListener(DEMO_SESSION_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(DEMO_SESSION_CHANGED_EVENT, refresh);
  }, []);

  return (
    <>
      <div className="home-actions">
        <Link className="button primary home-primary-action" href={signedIn || accountCaseActive ? "/cases" : "/assessment?new=1"} onClick={() => resetDemoWorkspace(localStorage, sessionStorage)}>
          Start assessment
        </Link>
        <Link className="button secondary home-account-action" href="/cases">{signedIn ? "Saved cases" : "Sign in or create account"}</Link>
        {resume ? (
          <Link className="button secondary home-resume-action" href="/assessment" onClick={() => { if (hasParkedAssessment(localStorage)) resetDemoWorkspace(localStorage, sessionStorage); }}>
            Resume assessment
          </Link>
        ) : null}
      </div>
      <p className="home-action-status" role="status" aria-live="polite">
        {status}
      </p>
    </>
  );
}
