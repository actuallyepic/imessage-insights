import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import CallsDashboard from "@/components/calls-dashboard";

export default function CallsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-page" />}>
      <AppShell>
        <CallsDashboard />
      </AppShell>
    </Suspense>
  );
}
