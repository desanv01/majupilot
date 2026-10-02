import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({ resolveGuest: vi.fn(), resolveMembership: vi.fn(), getUser: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/infrastructure/supabase/server", () => ({ createServerSupabaseClient: async () => ({ auth: { getUser: stubs.getUser } }) }));
vi.mock("@/infrastructure/persistence/supabase-repository", () => ({ SupabasePersistenceRepository: class {
  resolveGuest = stubs.resolveGuest;
  resolveMembership = stubs.resolveMembership;
} }));
import { resolveLeadAccess, resolveOwner } from "@/infrastructure/persistence/api";
import { digestGuestToken } from "@/infrastructure/persistence/guest-session-token";
import { PersistenceError } from "@/domain/persistence";
const uuid = () => crypto.randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_synthetic";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_synthetic_test_key";
  process.env.MAJUPILOT_GUEST_TOKEN_PEPPER = "synthetic-test-pepper-with-at-least-32-bytes";
});

describe("demo authorization boundaries", () => {
  it("selects only the matching opaque guest cookie when both real and demo cookies exist", async () => {
    const real = uuid(), demo = uuid();
    stubs.resolveGuest.mockImplementation(async (digest: string) => ({ guestSessionId: digest === digestGuestToken("real-token") ? real : demo }));
    const cookie = "__Host-majupilot_guest=real-token; __Host-majupilot_demo_guest=demo-token";
    await expect(resolveOwner(new Request("https://synthetic.test", { headers: { cookie } }))).resolves.toEqual({ kind: "guest", guestSessionId: real });
    await expect(resolveOwner(new Request("https://synthetic.test", { headers: { cookie, "x-majupilot-workspace": "demo" } }))).resolves.toEqual({ kind: "guest", guestSessionId: demo });
    expect(stubs.resolveGuest.mock.calls.map(([digest]) => digest)).toEqual([digestGuestToken("real-token"), digestGuestToken("demo-token")]);
  });

  it("cannot use a workspace header as authorization or fall back to the real cookie", async () => {
    await expect(resolveOwner(new Request("https://synthetic.test", { headers: { cookie: "__Host-majupilot_guest=real-token", "x-majupilot-workspace": "demo" } }))).rejects.toThrow("UNAUTHENTICATED");
    expect(stubs.resolveGuest).not.toHaveBeenCalled();
  });

  it("keeps account membership checks mandatory even with a demo header", async () => {
    const organizationId = uuid();
    stubs.getUser.mockResolvedValue({ data: { user: { id: uuid() } } });
    stubs.resolveMembership.mockRejectedValue(new PersistenceError("FORBIDDEN", 403));
    await expect(resolveOwner(new Request("https://synthetic.test", { headers: { "x-majupilot-workspace": "demo" } }), organizationId)).rejects.toThrow("FORBIDDEN");
    expect(stubs.resolveMembership).toHaveBeenCalledOnce();
  });

  it("uses demo ownership for lead reads even while the browser is signed in", async () => {
    const guestSessionId = uuid();
    stubs.resolveGuest.mockResolvedValue({ guestSessionId });
    await expect(resolveLeadAccess(new Request("https://synthetic.test", { headers: { cookie: "__Host-majupilot_demo_guest=demo-token", "x-majupilot-workspace": "demo" } }))).resolves.toEqual({ kind: "guest", guestSessionId });
    expect(stubs.getUser).not.toHaveBeenCalled();
  });
});
