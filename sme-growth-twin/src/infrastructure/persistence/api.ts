import "server-only";
import { z } from "zod";
import { PersistenceError,persistenceUuidSchema,type OwnershipContext } from "@/domain/persistence";
import { createServerSupabaseClient } from "@/infrastructure/supabase/server";
import { SupabasePersistenceRepository } from "./supabase-repository";
import { digestGuestToken,guestCookieName } from "./guest-session-token";
import type { LeadAccessContext } from "@/infrastructure/leads/durable-lead-repository";
export const repository=()=>new SupabasePersistenceRepository();
export const NO_STORE_HEADERS={"Cache-Control":"no-store"} as const;
export function correlationId(request:Request){const candidate=request.headers.get("x-correlation-id");return candidate&&/^[a-zA-Z0-9_-]{8,80}$/.test(candidate)?candidate:crypto.randomUUID();}
export function response(body:unknown,status:number,requestId:string){return Response.json(body,{status,headers:{...NO_STORE_HEADERS,"X-Correlation-ID":requestId}});}
export function errorResponse(error:unknown,requestId:string){if(error instanceof PersistenceError)return response({error:{code:error.code,requestId}},error.httpStatus,requestId);if(error instanceof z.ZodError)return response({error:{code:"VALIDATION_FAILED",requestId,issues:error.issues.map(i=>({path:i.path.join("."),code:i.code}))}},422,requestId);return response({error:{code:"INTERNAL_RETRYABLE",requestId}},503,requestId);}
export async function readJson(request:Request,maxBytes=128*1024):Promise<unknown>{const declared=Number(request.headers.get("content-length"));if(Number.isFinite(declared)&&declared>maxBytes)throw new PersistenceError("VALIDATION_FAILED",422);if(!(request.headers.get("content-type")??"").toLowerCase().startsWith("application/json"))throw new PersistenceError("VALIDATION_FAILED",422);const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.byteLength>maxBytes)throw new PersistenceError("VALIDATION_FAILED",422);try{return JSON.parse(new TextDecoder().decode(bytes)) as unknown;}catch(cause){throw new PersistenceError("VALIDATION_FAILED",422,{cause});}}
export async function resolveOwner(request:Request,organizationId?:string):Promise<OwnershipContext>{if(organizationId){persistenceUuidSchema.parse(organizationId);const client=await createServerSupabaseClient();const{data,error}=await client.auth.getUser();if(error||!data.user)throw new PersistenceError("UNAUTHENTICATED",401);return repository().resolveMembership(data.user.id,organizationId);}const cookieName=guestCookieName(request);const token=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);if(!token)throw new PersistenceError("UNAUTHENTICATED",401);const resolved=await repository().resolveGuest(digestGuestToken(decodeURIComponent(token)));return{kind:"guest",guestSessionId:resolved.guestSessionId};}
export async function resolveLeadAccess(request:Request,organizationId?:string):Promise<LeadAccessContext>{
  if(organizationId)return resolveOwner(request,organizationId);
  if(request.headers.get("x-majupilot-workspace")==="demo")return resolveOwner(request);
  const client=await createServerSupabaseClient();const{data}=await client.auth.getUser();
  if(data.user)return{kind:"staff",userId:data.user.id};
  return resolveOwner(request);
}
