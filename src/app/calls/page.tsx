import { Suspense } from "react";
import CallsDashboard from "@/components/calls-dashboard";

export default function CallsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-neutral-950 px-6 py-10 text-sm text-neutral-400">Loading…</div>}>
      <CallsDashboard />
    </Suspense>
  );
}
