"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

import { ProductHeader } from "@/components/navigation/product-header";
import { rebuildCurrentTwin } from "@/core/assessment/rebuild-current-twin";
import type { AssessmentDraft } from "@/domain/assessment";
import type { Blueprint } from "@/domain/blueprint";
import type { BusinessTwin } from "@/domain/business-twin";
import type { LeadReceiptV2 } from "@/domain/lead-sales";
import { contactSchema, leadReceiptSchema, type LeadReceipt } from "@/domain/leads";
import type { RecommendationResult } from "@/domain/recommendations";
import type { ScenarioComparison } from "@/domain/scenarios";
import type { DiagnosticResult } from "@/domain/scoring";
import { EXABYTES_CONSULTATION_POLICY } from "@/domain-packs/exabytes/consultation-rules";
import { loadAssessmentDraft } from "@/infrastructure/persistence/local-assessment-store";
import { loadBlueprint } from "@/infrastructure/persistence/local-blueprint-store";
import { loadDiagnosticResult } from "@/infrastructure/persistence/local-diagnostic-store";
import { loadRecommendationResult } from "@/infrastructure/persistence/local-recommendation-store";
import { clearKnownProjectStorage } from "@/infrastructure/persistence/project-storage";
import { activeAccountCase } from "@/infrastructure/persistence/account-case-scope";
import { resetDemoWorkspace } from "@/infrastructure/persistence/demo-workspace";
import { loadCurrentDurableJourney } from "@/infrastructure/persistence/current-durable-journey";
import { loadScenarioComparison } from "@/infrastructure/persistence/local-scenario-store";
import { createDurableConsultation } from "@/infrastructure/persistence/durable-journey-client";

const urgencyLabels = {
  within_30_days: "Within 30 days",
  one_to_three_months: "Within 1-3 months",
  three_to_six_months: "Within 3-6 months",
  exploring: "Exploring options",
} as const;

type FormState = {
  name: string;
  businessName: string;
  email: string;
  phone: string;
  urgency: keyof typeof urgencyLabels | "";
  consent: boolean;
  website: string;
};
type FieldErrors = Partial<Record<keyof FormState, string>>;

const errorOrder: (keyof FormState)[] = ["name", "businessName", "email", "phone", "urgency", "consent"];
const fieldIds: Record<Exclude<keyof FormState, "website">, string> = {
  name: "consultation-name",
  businessName: "consultation-business-name",
  email: "consultation-email",
  phone: "consultation-phone",
  urgency: "consultation-urgency",
  consent: "consultation-consent",
};

const reportReference = (id: string) => `MP-${id.slice(-8).toUpperCase()}`;

function JourneyRail() {
  return (
    <nav className="journey-rail consultation-journey" aria-label="Growth Twin journey">
      <ol>
        {["Discover", "Diagnose", "Compare", "Blueprint"].map((label) => (
          <li className="done" key={label}>
            <span aria-hidden="true">✓</span>
            <em>{label}</em>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const score = (value: number | null) => (value === null ? "Not available" : value.toFixed(1));

type ConsultationJourney = {
  draft: AssessmentDraft;
  twin: BusinessTwin;
  diagnostic: DiagnosticResult;
  recommendations: RecommendationResult;
  comparison: ScenarioComparison;
  blueprint: Blueprint;
};

type ConsultationReceipt = LeadReceiptV2 | LeadReceipt;

function Success({ blueprint, receipt, onNew }: { blueprint: Blueprint; receipt: ConsultationReceipt; onNew: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  const durable = "receiptId" in receipt;

  return (
    <main id="main-content" className="consultation-shell success-shell" data-consultation-state={receipt.replayed ? "idempotent-replay" : "success"}>
      <section className="consultation-success-hero" aria-labelledby="receipt-title">
        <span className="success-check" aria-hidden="true">✓</span>
        <div>
          <p className="eyebrow">Consultation request</p>
          <h1 id="receipt-title" ref={headingRef} tabIndex={-1}>Request recorded.</h1>
          <p>Your consultation request, consent record, and exact canonical Blueprint report are securely recorded for handoff.</p>
        </div>
      </section>

      <section className="receipt-card" aria-labelledby="receipt-details-title">
        <div className="receipt-card-heading">
          <div><p className="eyebrow">Safe receipt</p><h2 id="receipt-details-title">Your recorded request</h2></div>
          {receipt.replayed ? <p className="receipt-replay">Same request, same receipt</p> : null}
        </div>
        <dl>
          <div><dt>Receipt reference</dt><dd>{durable ? receipt.receiptId : receipt.leadReference}</dd></div>
          <div><dt>Submitted business</dt><dd>{blueprint.snapshot.twin.identity.businessName}</dd></div>
          <div><dt>Consultation focus</dt><dd>{blueprint.snapshot.selectedScenario.title}</dd></div>
          <div><dt>Report reference</dt><dd>{reportReference(blueprint.id)}</dd></div>
          <div><dt>Recorded time</dt><dd>{durable ? "Recorded securely" : new Date(receipt.submittedAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}</dd></div>
          <div><dt>Assignment</dt><dd>{durable && receipt.assignmentState === "assigned" ? "Assigned for follow-up" : "Queued for assignment"}</dd></div>
        </dl>
        <details className="consultation-technical"><summary>Technical receipt details</summary><dl><div><dt>Lead reference</dt><dd>{durable ? receipt.leadId : receipt.leadReference}</dd></div><div><dt>Blueprint ID</dt><dd>{blueprint.id}</dd></div></dl></details>
      </section>

      <section className="receipt-boundary" aria-labelledby="receipt-boundary-title">
        <div><h2 id="receipt-boundary-title">What this receipt proves</h2><p>The consented request, immutable report identity, assignment decision, and delivery work were committed together.</p></div>
        <p>Delivery is retried by MajuPilot&apos;s signed outbox worker. A human response time is not guaranteed by this receipt.</p>
      </section>

      <div className="success-actions" aria-label="Receipt actions">
        <Link className="button primary" href="/blueprint">Return to Blueprint</Link>
        <button className="button secondary" type="button" onClick={onNew}>Start a new assessment</button>
      </div>
    </main>
  );
}

export function ConsultationView({ journey, blueprint: suppliedBlueprint, initialReceipt }: { journey?: ConsultationJourney; blueprint?: Blueprint; initialReceipt?: ConsultationReceipt }) {
  const blueprint = journey?.blueprint ?? suppliedBlueprint!;
  const router = useRouter();
  const submissionId = useRef(crypto.randomUUID());
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const [receipt, setReceipt] = useState(initialReceipt);
  const [form, setForm] = useState<FormState>({ name: "", businessName: blueprint.snapshot.twin.identity.businessName, email: "", phone: "", urgency: "", consent: false, website: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const selected = blueprint.snapshot.selectedScenario;
  const diagnostic = blueprint.snapshot.diagnostic;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setStatus(undefined);
  };

  const validate = () => {
    const next: FieldErrors = {};
    const contact = contactSchema.safeParse({ name: form.name, businessName: form.businessName, email: form.email, ...(form.phone.trim() ? { phone: form.phone } : {}), urgency: form.urgency });
    if (!contact.success) {
      for (const issue of contact.error.issues) {
        const key = issue.path[0] as keyof FormState;
        if (!next[key]) next[key] = issue.path[0] === "urgency" ? "Choose when you would like to explore the consultation." : `Enter a valid ${issue.path[0] === "name" ? "contact name" : String(issue.path[0]).replace(/([A-Z])/g, " $1").toLowerCase()}.`;
      }
    }
    if (!form.consent) next.consent = "Consent is required before a request can be recorded.";
    setErrors(next);
    return { valid: Object.keys(next).length === 0, contact: contact.success ? contact.data : undefined };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const checked = validate();
    if (!checked.valid || !checked.contact) {
      requestAnimationFrame(() => errorSummaryRef.current?.focus());
      return;
    }
    setBusy(true);
    setStatus("Recording the request. Keep this page open.");
    try {
      if (journey) {
        const durable = await createDurableConsultation(localStorage, journey, checked.contact);
        if (!durable.lead) throw new Error("lead_unavailable");
        setReceipt(durable.lead);
      } else {
        const response = await fetch("/api/leads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ submissionId: submissionId.current, contact: checked.contact, consent: { accepted: form.consent, wordingVersion: EXABYTES_CONSULTATION_POLICY.consentWordingVersion }, honeypot: form.website, blueprint }) });
        if (!response.ok) throw new Error("lead_unavailable");
        setReceipt(leadReceiptSchema.parse(await response.json()));
      }
      return;
    } catch {
      setStatus("The request could not be recorded safely. Your entries are still here so you can retry.");
    } finally {
      setBusy(false);
    }
  };

  const startNew = () => {
    resetDemoWorkspace(localStorage, sessionStorage);
    if (activeAccountCase(localStorage)) { router.push("/cases"); return; }
    clearKnownProjectStorage(localStorage, sessionStorage);
    router.push("/assessment?new=1");
  };

  if (receipt) return <Success blueprint={blueprint} receipt={receipt} onNew={startNew} />;
  const visibleErrors = errorOrder.filter((key) => errors[key]);

  return (
    <main id="main-content" className="consultation-shell" data-consultation-state={busy ? "submitting" : status || visibleErrors.length ? "failure" : "idle"}>
      <header className="consultation-hero">
        <p className="eyebrow">Blueprint handoff</p>
        <h1>Request an evidence-ready consultation.</h1>
        <p>Verify the Blueprint, add the contact details needed for this request, and choose whether to consent.</p>
      </header>

      <section className="consultation-context" aria-label="Blueprint handoff target">
        <div><span>Business</span><strong>{blueprint.snapshot.twin.identity.businessName}</strong></div>
        <div><span>Selected path</span><strong>{selected.title}</strong></div>
        <div><span>Digital maturity</span><strong>{score(diagnostic.digitalMaturity.value)} /100</strong></div>
        <div><span>AI readiness</span><strong>{score(diagnostic.aiReadiness.value)} /100</strong></div>
        <div><span>Report reference</span><strong>{reportReference(blueprint.id)}</strong></div>
      </section>
      <details className="consultation-technical consultation-source-identity"><summary>Technical Blueprint identity</summary><dl><div><dt>Blueprint ID</dt><dd>{blueprint.id}</dd></div></dl></details>

      <div className="consultation-grid">
        <form className="consultation-form" onSubmit={submit} noValidate aria-busy={busy}>
          {visibleErrors.length ? (
            <div className="consultation-error-summary" ref={errorSummaryRef} role="alert" tabIndex={-1} aria-labelledby="consultation-error-title">
              <h2 id="consultation-error-title">Check the highlighted fields</h2>
              <p>Your entries are still here. Correct each item before trying again.</p>
              <ul>{visibleErrors.map((key) => <li key={key}><a href={`#${fieldIds[key as Exclude<keyof FormState, "website">]}`}>{errors[key]}</a></li>)}</ul>
            </div>
          ) : null}

          <section>
            <div className="consultation-section-heading">
              <div><h2>Contact details</h2><p>Fields marked required must be completed. Phone is optional.</p></div>
              <span>Required fields are marked in text</span>
            </div>
            <div className="consultation-fields">
              <label htmlFor={fieldIds.name}><span>Contact name <b>(required)</b></span><input id={fieldIds.name} name="name" autoComplete="name" maxLength={100} value={form.name} onChange={(event) => update("name", event.target.value)} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "name-error" : undefined} />{errors.name ? <small className="field-error" id="name-error">{errors.name}</small> : null}</label>
              <label htmlFor={fieldIds.businessName}><span>Business name <b>(required)</b></span><input id={fieldIds.businessName} name="businessName" autoComplete="organization" maxLength={140} value={form.businessName} onChange={(event) => update("businessName", event.target.value)} aria-invalid={Boolean(errors.businessName)} aria-describedby={errors.businessName ? "business-error" : undefined} />{errors.businessName ? <small className="field-error" id="business-error">{errors.businessName}</small> : null}</label>
              <label htmlFor={fieldIds.email}><span>Email address <b>(required)</b></span><input id={fieldIds.email} name="email" type="email" autoComplete="email" inputMode="email" maxLength={254} value={form.email} onChange={(event) => update("email", event.target.value)} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "email-error email-hint" : "email-hint"} /><small id="email-hint">Used only for this consultation request.</small>{errors.email ? <small className="field-error" id="email-error">{errors.email}</small> : null}</label>
              <label htmlFor={fieldIds.phone}><span>Phone number (optional)</span><input id={fieldIds.phone} name="phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={32} value={form.phone} onChange={(event) => update("phone", event.target.value)} aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? "phone-error" : undefined} />{errors.phone ? <small className="field-error" id="phone-error">{errors.phone}</small> : null}</label>
              <label className="full" htmlFor={fieldIds.urgency}><span>Consultation urgency <b>(required)</b></span><select id={fieldIds.urgency} name="urgency" value={form.urgency} onChange={(event) => update("urgency", event.target.value as FormState["urgency"])} aria-invalid={Boolean(errors.urgency)} aria-describedby={errors.urgency ? "urgency-error urgency-hint" : "urgency-hint"}><option value="">Select an urgency</option>{Object.entries(urgencyLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select><small id="urgency-hint">This helps a future handoff prioritise your request.</small>{errors.urgency ? <small className="field-error" id="urgency-error">{errors.urgency}</small> : null}</label>
              <label className="honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(event) => update("website", event.target.value)} /></label>
            </div>
          </section>

          <section className="share-disclosure"><h2>What will be shared and recorded</h2><p>The lead contains these categories from the current Blueprint:</p><ul><li>Contact details and requested urgency</li><li>Business profile bands and score summary</li><li>Top five pain points and supporting evidence</li><li>Selected scenario, ROI assumptions, capabilities, and mapped offerings</li><li>Advisor findings, Blueprint identity, evidence, and limitations</li></ul><p><strong>Contact details are not sent to the model</strong> and are not used to calculate scores, recommendations, ROI, or the Blueprint.</p></section>

          <section className={`consent-card ${errors.consent ? "invalid" : ""}`}><label htmlFor={fieldIds.consent}><input id={fieldIds.consent} type="checkbox" name="consent" checked={form.consent} onChange={(event) => update("consent", event.target.checked)} aria-invalid={Boolean(errors.consent)} aria-describedby={errors.consent ? "consent-error consent-copy" : "consent-copy"} /><span><strong>I consent to this consultation request (required)</strong><small id="consent-copy">{EXABYTES_CONSULTATION_POLICY.consentWording}</small></span></label>{errors.consent ? <small className="field-error" id="consent-error">{errors.consent}</small> : null}</section>

          {status ? <p className={busy ? "submission-status" : "submission-error"} role={busy ? "status" : "alert"} aria-live={busy ? "polite" : "assertive"}>{status}</p> : null}
          <button className="button primary consultation-submit" type="submit" disabled={busy}>{busy ? "Recording request..." : "Record consultation request"}</button>
        </form>

        <aside className="consultation-aside"><p className="eyebrow">Privacy and handoff</p><h2>Your evidence stays inspectable.</h2><ul><li><strong>Exact Blueprint</strong><span>A canonical PDF and SHA-256 identity bind the request to this report.</span></li><li><strong>Explicit choice</strong><span>Consent starts unchecked and is enforced before any lead is created.</span></li><li><strong>Durable receipt</strong><span>The lead, assignment, consent snapshot, and delivery event are persisted together.</span></li><li><strong>Signed delivery</strong><span>The outbox worker signs the minimized webhook payload and retries safely.</span></li></ul><Link href="/blueprint">Return to the same Blueprint</Link></aside>
      </div>
    </main>
  );
}

export function ConsultationClient() {
  const router = useRouter();
  const [loaded, setLoaded] = useState<{ journey: ConsultationJourney; receipt?: LeadReceiptV2 }>();

  useEffect(() => {
    let active = true;
    const assessment = loadAssessmentDraft(localStorage);
    if (assessment.status !== "ok" || assessment.draft.status !== "ready_for_review") { router.replace("/blueprint"); return; }
    try {
      const twin = rebuildCurrentTwin(assessment.draft);
      const diagnostic = loadDiagnosticResult(localStorage, twin);
      if (diagnostic.status !== "ok") { router.replace("/blueprint"); return; }
      const recommendations = loadRecommendationResult(localStorage, twin, diagnostic.result);
      if (recommendations.status !== "ok") { router.replace("/blueprint"); return; }
      const comparison = loadScenarioComparison(localStorage, twin, diagnostic.result, recommendations.result);
      if (comparison.status !== "ok") { router.replace("/blueprint"); return; }
      const blueprint = loadBlueprint(localStorage, twin, diagnostic.result, recommendations.result, comparison.result);
      if (blueprint.status !== "ok") { router.replace("/blueprint"); return; }
      const journey = { draft: assessment.draft, twin, diagnostic: diagnostic.result, recommendations: recommendations.result, comparison: comparison.result, blueprint: blueprint.result };
      void loadCurrentDurableJourney(localStorage).then((durable) => {
        if (active) setLoaded({ journey, receipt: durable?.lead });
      });
    } catch { router.replace("/blueprint"); }
    return () => { active = false; };
  }, [router]);

  if (!loaded) return <><ProductHeader current="consultation" /><main id="main-content" className="consultation-loading" aria-live="polite"><div className="consultation-loading-shape" aria-hidden="true"><span /><span /><span /></div><p className="eyebrow">Blueprint handoff</p><h1>Validating your current Blueprint.</h1><p>Checking the saved source chain before contact details are requested.</p></main></>;

  return <><ProductHeader current="consultation" /><JourneyRail /><ConsultationView journey={loaded.journey} initialReceipt={loaded.receipt} /></>;
}
