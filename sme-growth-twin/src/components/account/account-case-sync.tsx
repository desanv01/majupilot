"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ACCOUNT_CASE_LOCAL_CHANGE_EVENT } from "@/infrastructure/persistence/account-case-events";
import { ACCOUNT_CASE_LAST_STAGE_KEY, activeAccountCase, saveActiveAccountCase } from "@/infrastructure/persistence/account-case-client";
import { createBrowserSupabaseClient } from "@/infrastructure/supabase/browser";
import { loadDemoSession } from "@/infrastructure/persistence/project-storage";

const workPaths = ["/assessment", "/assessment/review", "/assessment/analysis", "/results", "/recommendations", "/scenarios", "/blueprint", "/copilot", "/evidence", "/consultation"];

export function AccountCaseSync() {
  const pathname = usePathname();
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!workPaths.includes(pathname) || activeAccountCase(localStorage) || loadDemoSession(localStorage)) return;
    let cancelled = false;
    void Promise.resolve().then(() => createBrowserSupabaseClient().auth.getUser()).then(({ data }) => {
      if (!cancelled && data.user && !activeAccountCase(localStorage) && !loadDemoSession(localStorage)) router.replace("/cases");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [pathname, router]);

  useEffect(() => {
    if (!activeAccountCase(localStorage)) return;
    if (!workPaths.includes(pathname)) return;
    if (localStorage.getItem(ACCOUNT_CASE_LAST_STAGE_KEY) === pathname) return;
    localStorage.setItem(ACCOUNT_CASE_LAST_STAGE_KEY, pathname);
    window.dispatchEvent(new Event(ACCOUNT_CASE_LOCAL_CHANGE_EVENT));
  }, [pathname]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      if (!activeAccountCase(localStorage)) return;
      void saveActiveAccountCase().then(() => setError("")).catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message === "IDEMPOTENCY_CONFLICT"
          ? "This case changed on another device. Your edits remain in this browser."
          : "Your latest edits are in this browser, but could not be saved to your account.");
      });
    };
    const onChange = () => { if (timer) clearTimeout(timer); timer = setTimeout(save, 800); };
    const onVisibility = () => { if (document.visibilityState === "hidden") { if (timer) clearTimeout(timer); save(); } };
    window.addEventListener(ACCOUNT_CASE_LOCAL_CHANGE_EVENT, onChange);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { if (timer) clearTimeout(timer); window.removeEventListener(ACCOUNT_CASE_LOCAL_CHANGE_EVENT, onChange); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  return error ? <aside className="account-save-warning" role="alert">{error} <Link href="/cases">Open Saved cases to resolve this</Link>.</aside> : null;
}
