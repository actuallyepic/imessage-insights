import { Suspense } from "react";

import PersonFullscreen from "@/components/person-fullscreen";

export default function PersonPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-neutral-950 px-6 py-10 text-sm text-neutral-400">Loading…</div>}>
      <PersonFullscreen />
    </Suspense>
  );
}
