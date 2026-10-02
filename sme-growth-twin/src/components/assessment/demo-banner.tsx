"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DemoResetControl } from "@/components/demo/demo-reset-control";

import type { DemoSession } from "@/infrastructure/persistence/project-storage";
import {
  DEMO_SESSION_CHANGED_EVENT,
  loadDemoSession,
  RESET_STATUS_SESSION_KEY,
} from "@/infrastructure/persistence/project-storage";
import { resetDemoWorkspace } from "@/infrastructure/persistence/demo-workspace";

export function DemoBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const [demo, setDemo] = useState<DemoSession>();
  const [resetStatus, setResetStatus] = useState("");

  useEffect(() => {
    const refresh = () => setDemo(loadDemoSession(localStorage));
    refresh();
    window.addEventListener(DEMO_SESSION_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(DEMO_SESSION_CHANGED_EVENT, refresh);
  }, [pathname]);

  const reset = () => {
    const confirmation =
      "MajuPilot demonstration data was reset. Other browser storage was not changed.";
    resetDemoWorkspace(localStorage, sessionStorage);
    sessionStorage.setItem(RESET_STATUS_SESSION_KEY, confirmation);
    window.dispatchEvent(new Event(DEMO_SESSION_CHANGED_EVENT));
    setDemo(undefined);
    setResetStatus(confirmation);
    router.push("/");
  };

  if (!demo) {
    return resetStatus ? (
      <aside className="demo-banner demo-banner-cleared" aria-label="Demonstration reset status">
        <p role="status" aria-live="polite">{resetStatus}</p>
      </aside>
    ) : null;
  }

  return (
    <aside className="demo-banner" aria-label="Fictional demonstration status">
      <p>
        <strong>Fictional demonstration:</strong> {demo.label}. Fixture {demo.fixtureVersion}.
      </p>
      <DemoResetControl compact onConfirm={reset} />
    </aside>
  );
}
