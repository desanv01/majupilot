import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { getServerSupabaseEnv } from "@/infrastructure/supabase/env";
export const GUEST_COOKIE_NAME="__Host-majupilot_guest";
export const DEMO_GUEST_COOKIE_NAME="__Host-majupilot_demo_guest";
export const guestCookieName=(request:Request)=>request.headers.get("x-majupilot-workspace")==="demo"?DEMO_GUEST_COOKIE_NAME:GUEST_COOKIE_NAME;
export const GUEST_COOKIE_OPTIONS={httpOnly:true,secure:true,sameSite:"lax" as const,path:"/",maxAge:60*60*24};
export const newGuestToken=()=>randomBytes(32).toString("base64url");
export const digestGuestToken=(token:string)=>createHmac("sha256",getServerSupabaseEnv().MAJUPILOT_GUEST_TOKEN_PEPPER).update(token,"utf8").digest("hex");
