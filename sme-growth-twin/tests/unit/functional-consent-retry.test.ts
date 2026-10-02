import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsentAppend, OwnershipContext } from "@/domain/persistence";
const stubs = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminSupabaseClient: () => ({ from: stubs.from }) }));
import { SupabasePersistenceRepository } from "@/infrastructure/persistence/supabase-repository";

beforeEach(() => vi.clearAllMocks());
describe("immutable consultation consent retries", () => {
  it("accepts an exact replay without overwriting consent, and rejects changed contact or owner", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const insert = vi.fn(async (row: Record<string, unknown>) => {
      if (rows.has(String(row.id))) return { error: { code: "23505", message: "duplicate" } };
      rows.set(String(row.id), row); return { error: null };
    });
    stubs.from.mockImplementation((table: string) => {
      let selectedId = "";
      const query = {
        insert,
        select: () => query,
        eq: (key: string, value: string) => { if (key === "id") selectedId = value; return query; },
        maybeSingle: async () => ({ error: null, data: table === "assessment_sessions" ? { id: selectedId } : rows.get(selectedId) }),
      };
      return query;
    });
    const owner: OwnershipContext = { kind: "guest", guestSessionId: crypto.randomUUID() };
    const consent: ConsentAppend = {
      id: crypto.randomUUID(), assessmentSessionId: crypto.randomUUID(), purpose: "consultation_contact", action: "granted",
      consentVersion: "1.0.0", policyVersion: "1.0.0", textHash: "a".repeat(64), locale: "en-MY", presentationSurface: "consultation",
      requestId: crypto.randomUUID(), channel: "web", snapshot: { contact: { email: "synthetic@example.com" }, granted: true },
    };
    const repo = new SupabasePersistenceRepository();
    await repo.appendConsent(owner, consent);
    await expect(repo.appendConsent(owner, consent)).resolves.toBeUndefined();
    await expect(repo.appendConsent(owner, { ...consent, snapshot: { granted: false } })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(repo.appendConsent({ ...owner, guestSessionId: crypto.randomUUID() }, consent)).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(rows.size).toBe(1);
    expect(rows.get(consent.id)?.consent_snapshot).toEqual(consent.snapshot);
    expect(insert).toHaveBeenCalledTimes(4);
  });
});
