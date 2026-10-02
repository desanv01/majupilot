import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import HomePage from "../../src/app/page";
import { ConsultationView } from "../../src/components/consultation/consultation-client";
import { stage05CaseA } from "./stage05-fixtures";

describe("Phase 07 consultation, demo, and release UI", () => {
  const blueprint = stage05CaseA().blueprint;

  it("keeps standard assessment primary and labels all fictional cases", () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html.indexOf("Start assessment")).toBeLessThan(html.indexOf("Fictional demonstration cases"));
    for (const value of ["case-a", "case-b", "case-c"]) expect(html).toContain(`data-fixture-id="${value}"`);
    for (const text of ["Kopi Kita Café Group", "Precision Parts Manufacturing", "Northstar Digital Studio", "Recommended", "Reset demo data", "Reset known records", "Cancel"]) expect(html).toContain(text);
    for (const text of ["Shows a broad foundation-first path", "Shows workflow and data foundations", "Shows a selective path"]) expect(html).toContain(text);
    expect(html).not.toMatch(/[—–]/);
  });

  it("renders required and optional labels, disclosure, unchecked consent, and safe actions", () => {
    const html = renderToStaticMarkup(<ConsultationView blueprint={blueprint} />);
    for (const text of ["Contact name", "Business name", "Email address", "Phone number (optional)", "Consultation urgency", "(required)", "What will be shared and recorded", "Contact details are not sent to the model", "Record consultation request", "Return to the same Blueprint"]) expect(html).toContain(text);
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('type="checkbox" checked');
    expect(html).toContain('data-consultation-state="idle"');
    for (const id of ["consultation-name", "consultation-business-name", "consultation-email", "consultation-phone", "consultation-urgency", "consultation-consent"]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/[—–]/);
  });

  it("renders a complete safe receipt and distinguishes an idempotent replay", () => {
    const receipt = { leadReference: "lead_phase070000000000000001", submittedAt: "2026-09-19T09:30:00+08:00", blueprintId: blueprint.id, status: "new" as const, replayed: true };
    const html = renderToStaticMarkup(<ConsultationView blueprint={blueprint} initialReceipt={receipt} />);
    for (const text of ["Request recorded.", "Safe receipt", "Submitted business", "Consultation focus", "Recorded time", "Report reference", "Technical receipt details", "Same request, same receipt", "A human response time is not guaranteed by this receipt", "Return to Blueprint", "Start a new assessment"]) expect(html).toContain(text);
    expect(html).toContain('data-consultation-state="idempotent-replay"');
    expect(html).not.toMatch(/example\.test|\+60 12/);
  });

  it("includes linked validation, focus transfer, scoped reset, and reduced-motion treatment", async () => {
    const consultation = await readFile(path.join(process.cwd(), "src/components/consultation/consultation-client.tsx"), "utf8");
    const reset = await readFile(path.join(process.cwd(), "src/components/demo/demo-reset-control.tsx"), "utf8");
    const home = await readFile(path.join(process.cwd(), "src/components/assessment/home-actions.tsx"), "utf8");
    const css = await readFile(path.join(process.cwd(), "src/app/styles.css"), "utf8");
    expect(consultation).toContain("errorSummaryRef.current?.focus()");
    expect(consultation).toContain("Your entries are still here");
    expect(consultation).toContain('aria-busy={busy}');
    expect(reset).toContain("showModal()");
    expect(reset).toContain("Reset known records");
    expect(home).toContain("resetDemoWorkspace(localStorage, sessionStorage)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".demo-reset-dialog::backdrop");
    expect(css).toContain("min-height: 50px");
    expect(css).toContain("outline: 3px solid var(--color-focus)");
  });
});
