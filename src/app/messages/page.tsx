import { Suspense } from "react";
import Dashboard from "@/components/dashboard";

export default function MessagesPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-neutral-950 px-6 py-10 text-sm text-neutral-400">Loading…</div>}>
      <Dashboard />
    </Suspense>
  );
}
