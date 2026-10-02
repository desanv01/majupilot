import { NextResponse } from "next/server";
import { PersistenceError } from "@/domain/persistence";
import { correlationId,errorResponse,NO_STORE_HEADERS,repository } from "@/infrastructure/persistence/api";
import { digestGuestToken,guestCookieName,GUEST_COOKIE_OPTIONS } from "@/infrastructure/persistence/guest-session-token";
export const runtime="nodejs";
export async function POST(request:Request){const id=correlationId(request);try{const cookieName=guestCookieName(request);const token=request.headers.get("cookie")?.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);if(!token)throw new PersistenceError("UNAUTHENTICATED",401);await repository().revokeGuest(digestGuestToken(decodeURIComponent(token)));const r=new NextResponse(null,{status:204,headers:{...NO_STORE_HEADERS,"X-Correlation-ID":id}});r.cookies.set(cookieName,"",{...GUEST_COOKIE_OPTIONS,maxAge:0});return r;}catch(e){return errorResponse(e,id);}}
