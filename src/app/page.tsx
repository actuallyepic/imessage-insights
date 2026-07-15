import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import OverviewDashboard from "@/components/overview-dashboard";

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-page px-6 py-10 text-sm text-ink-faint">Loading…</div>}>
      <AppShell>
        <OverviewDashboard />
      </AppShell>
    </Suspense>
  );
}
