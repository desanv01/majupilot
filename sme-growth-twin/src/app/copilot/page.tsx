import type { Metadata } from "next";

import { CopilotClient } from "@/components/copilot/copilot-client";

export const metadata: Metadata = { title: "Transformation Copilot | MajuPilot" };

export default async function CopilotPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  return <CopilotClient
    requestedAssessmentSessionId={typeof query.assessmentSessionId === "string" ? query.assessmentSessionId : undefined}
    requestedBlueprintId={typeof query.blueprintId === "string" ? query.blueprintId : undefined}
  />;
}
