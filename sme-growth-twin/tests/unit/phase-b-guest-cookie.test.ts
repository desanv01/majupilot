import { beforeAll,beforeEach,describe,expect,it,vi } from "vitest";

const stubs=vi.hoisted(()=>({
  issueGuest:vi.fn(async()=>({guestSessionId:crypto.randomUUID(),assessmentSessionId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()})),
  revokeGuest:vi.fn(async()=>undefined),
}));
vi.mock("server-only",()=>({}));
vi.mock("@/infrastructure/persistence/api",()=>({
  correlationId:()=>"cookie-contract-request",
  errorResponse:()=>Response.json({error:{code:"INTERNAL_RETRYABLE"}},{status:503}),
  NO_STORE_HEADERS:{"Cache-Control":"no-store"},
  repository:()=>stubs,
}));

import { POST as createGuest } from "@/app/api/v2/guest/session/route";
import { POST as revokeGuest } from "@/app/api/v2/guest/revoke/route";
import { digestGuestToken } from "@/infrastructure/persistence/guest-session-token";
beforeEach(() => vi.clearAllMocks());

beforeAll(()=>{
  process.env.NEXT_PUBLIC_SUPABASE_URL="https://cookie-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="sb_publishable_cookie_test_key";
  process.env.SUPABASE_SECRET_KEY="sb_secret_cookie_test_key";
  process.env.MAJUPILOT_GUEST_TOKEN_PEPPER="phase-b-cookie-test-pepper-32-bytes-minimum";
});

function expectHostCookie(setCookie:string|null,{cleared=false}={}){
  expect(setCookie).toBeTruthy();
  expect(setCookie).toMatch(/^__Host-majupilot_guest=/);
  expect(setCookie).toMatch(/(?:^|;\s*)Path=\/(?:;|$)/i);
  expect(setCookie).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
  expect(setCookie).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
  expect(setCookie).toMatch(/(?:^|;\s*)SameSite=lax(?:;|$)/i);
  expect(setCookie).not.toMatch(/(?:^|;\s*)Domain=/i);
  if(cleared)expect(setCookie).toMatch(/(?:^|;\s*)Max-Age=0(?:;|$)/i);
}

describe("Phase B __Host- guest cookie",()=>{
  it("revokes only the selected demo cookie when a real guest is also present",async()=>{
    const response=await revokeGuest(new Request("https://majupilot.example/api/v2/guest/revoke",{method:"POST",headers:{"x-majupilot-workspace":"demo",cookie:"__Host-majupilot_guest=real-token; __Host-majupilot_demo_guest=demo-token"}}));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-majupilot_demo_guest=/);
    expect(stubs.revokeGuest).toHaveBeenCalledExactlyOnceWith(digestGuestToken("demo-token"));
  });
  it("issues a separate secure demo cookie without replacing the real guest cookie",async()=>{
    const response=await createGuest(new Request("https://majupilot.example/api/v2/guest/session",{method:"POST",headers:{"x-majupilot-workspace":"demo",cookie:"__Host-majupilot_guest=real-token"}}));
    expect(response.status).toBe(201);
    const cookie=response.headers.get("set-cookie");
    expect(cookie).toMatch(/^__Host-majupilot_demo_guest=/);
    expect(cookie).toContain("Secure"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("__Host-majupilot_guest=");
  });
  it("emits a browser-valid host cookie on issue",async()=>{
    const response=await createGuest(new Request("https://majupilot.example/api/v2/guest/session",{method:"POST"}));
    expect(response.status).toBe(201);
    expectHostCookie(response.headers.get("set-cookie"));
  });

  it("revokes the same cookie at the same root path",async()=>{
    const response=await revokeGuest(new Request("https://majupilot.example/api/v2/guest/revoke",{method:"POST",headers:{cookie:"__Host-majupilot_guest=opaque-token"}}));
    expect(response.status).toBe(204);
    expectHostCookie(response.headers.get("set-cookie"),{cleared:true});
    expect(stubs.revokeGuest).toHaveBeenCalledOnce();
  });
});
