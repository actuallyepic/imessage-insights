import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import PeopleDashboard from "@/components/people-dashboard";

export default function PeoplePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-page text-sm text-ink-dim">Loading…</div>
      }
    >
      <AppShell>
        <PeopleDashboard />
      </AppShell>
    </Suspense>
  );
}
