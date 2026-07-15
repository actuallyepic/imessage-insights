import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import Dashboard from "@/components/dashboard";
import { SkeletonPanel } from "@/components/ui/primitives";

export default function MessagesPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-page px-6 py-10">
          <SkeletonPanel height={120} />
        </div>
      }
    >
      <AppShell>
        <Dashboard />
      </AppShell>
    </Suspense>
  );
}
