import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildAdvisorReviewContext } from "../../src/core/blueprint/build-review-context";
import { POST } from "../../src/app/api/advisors/review/route";
import { EXABYTES_ADVISORS_1_0_0 } from "../../src/domain-packs/exabytes/advisor-rules";
import {
  advisorRateLimiter,
  ProcessLocalHashedRateLimiter,
} from "../../src/infrastructure/leads/rate-limit";
import { ADVISOR_MODEL_BUDGET } from "../../src/infrastructure/model-provider/advisor-budget";
import {
  clearKnownProjectStorage,
  DEMO_SESSION_STORAGE_KEY,
  PROJECT_LOCAL_STORAGE_KEYS,
  PROJECT_SESSION_STORAGE_KEYS,
  RESET_STATUS_SESSION_KEY,
} from "../../src/infrastructure/persistence/project-storage";
import { caseAFull } from "./stage04-fixtures";

function request(ip: string) {
  const full = caseAFull();
  const selected = full.comparison.scenarios[1];
  const comparison = { ...full.comparison, selectedScenarioId: selected.id };
  const context = buildAdvisorReviewContext(
    full.twin,
    full.diagnostic,
    full.recommendation,
    comparison,
  );
  return new Request("http://localhost/api/advisors/review", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({
      context,
      advisorIds: EXABYTES_ADVISORS_1_0_0.map((item) => item.id),
    }),
  });
}

describe("Stage 07 advisor security and budgets", () => {
  beforeEach(() => {
    advisorRateLimiter.resetForTests();
    vi.stubEnv("AI_EXECUTION_MODE", "disabled");
    vi.stubEnv("AI_GATEWAY_MODEL", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  });

  it("publishes the frozen ten-attempt and 9,000-output-token request ceiling", () => {
    expect(ADVISOR_MODEL_BUDGET).toEqual({
      rolesPerPanel: 5,
      maxRetriesPerRole: 1,
      maxAttemptsPerRole: 2,
      maxOutputTokensPerAttempt: 900,
      maxRoleDurationMs: 12_000,
      maxPanelAttempts: 10,
      maxPanelOutputTokens: 9_000,
    });
  });

  it("allows three fallback panels, then returns a stable private 429", async () => {
    const rawIp = "198.51.100.73";
    for (let index = 0; index < 3; index += 1) {
      const response = await POST(request(rawIp));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const limited = await POST(request(rawIp));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "AI_BUDGET_EXCEEDED" } });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(advisorRateLimiter.hashedKeysForTests()).toHaveLength(1);
    expect(advisorRateLimiter.hashedKeysForTests()[0]).not.toContain(rawIp);
  });

  it("rejects non-JSON and oversized requests before consuming rate-limit budget", async () => {
    const rawIp = "198.51.100.74";
    const nonJson = await POST(new Request("http://localhost/api/advisors/review", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "x-forwarded-for": rawIp },
      body: "{}",
    }));
    expect(nonJson.status).toBe(400);
    expect(await nonJson.json()).toEqual({ error: "invalid_request" });

    const valid = request(rawIp);
    const oversized = await POST(new Request(valid.url, {
      method: "POST",
      headers: { ...Object.fromEntries(valid.headers), "content-length": String(256 * 1024 + 1) },
      body: await valid.text(),
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });

    for (let index = 0; index < 3; index += 1) expect((await POST(request(rawIp))).status).toBe(200);
    expect((await POST(request(rawIp))).status).toBe(429);
  });

  it("resets an expired window and never retains the raw limiter key", () => {
    const limiter = new ProcessLocalHashedRateLimiter(1, 1_000, 5);
    const rawKey = "private-user-address";
    expect(limiter.check(rawKey, 1_000)).toEqual({ allowed: true });
    expect(limiter.check(rawKey, 1_100)).toMatchObject({ allowed: false });
    expect(limiter.check(rawKey, 2_001)).toEqual({ allowed: true });
    expect(limiter.hashedKeysForTests().join(" ")).not.toContain(rawKey);
  });
});

describe("Stage 07 scoped reset", () => {
  it("removes every known project key while preserving unrelated browser data", () => {
    const local = new Map<string, string>(PROJECT_LOCAL_STORAGE_KEYS.map((key) => [key, "project"]));
    const session = new Map<string, string>(PROJECT_SESSION_STORAGE_KEYS.map((key) => [key, "project"]));
    local.set("unrelated-local", "keep");
    session.set("unrelated-session", "keep");
    const port = (data: Map<string, string>) => ({ removeItem: (key: string) => void data.delete(key) });
    clearKnownProjectStorage(port(local), port(session));
    expect([...local.entries()]).toEqual([["unrelated-local", "keep"]]);
    expect([...session.entries()]).toEqual([["unrelated-session", "keep"]]);
  });

  it("owns the reset-status key and notifies the same tab after the home reset", async () => {
    expect(PROJECT_SESSION_STORAGE_KEYS).toContain(RESET_STATUS_SESSION_KEY);
    const source = await readFile(
      path.resolve(process.cwd(), "src/components/assessment/home-actions.tsx"),
      "utf8",
    );
    const resetStart = source.indexOf("const reset = () =>");
    const resetBody = source.slice(resetStart, source.indexOf("\n  return (", resetStart));
    expect(resetBody).toContain("resetDemoWorkspace(localStorage, sessionStorage)");
    const workspace = await readFile(path.resolve(process.cwd(), "src/infrastructure/persistence/demo-workspace.ts"), "utf8");
    expect(workspace).toContain("window.dispatchEvent(new Event(DEMO_SESSION_CHANGED_EVENT))");
  });

  it("keeps the browser gate local by default and skips local startup for an explicit external URL", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "scripts/stage07-browser-check.mjs"),
      "utf8",
    );
    expect(source).toContain("process.env.STAGE07_BASE_URL?.trim()");
    expect(source).toContain("if (!configuredBaseUrl)");
    expect(source).toContain('mode: configuredBaseUrl ? "external" : "local-production"');
    expect(source).toContain("without embedded credentials");
  });

  it("contains no consent or lead-creation key in fixture state", () => {
    expect(PROJECT_LOCAL_STORAGE_KEYS).toContain(DEMO_SESSION_STORAGE_KEY);
    expect(PROJECT_LOCAL_STORAGE_KEYS.join(" ")).not.toMatch(/consent|lead/i);
  });
});
