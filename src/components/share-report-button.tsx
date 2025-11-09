'use client';

import { useCallback, useMemo, useState } from "react";
import { toPng } from "html-to-image";

type ShareReportButtonProps = {
  targetId: string;
  fileName?: string;
};

const ensurePngExtension = (name: string) => {
  if (name.toLowerCase().endsWith(".png")) {
    return name;
  }
  return `${name}.png`;
};

export function ShareReportButton({ targetId, fileName = "group-report.png" }: ShareReportButtonProps) {
  const [status, setStatus] = useState<"idle" | "saving" | "error" | "done">("idle");

  const resolvedFileName = useMemo(() => ensurePngExtension(fileName.trim() || "group-report"), [fileName]);

  const handleShare = useCallback(async () => {
    if (typeof window === "undefined") return;

    const target = document.getElementById(targetId);
    if (!target) {
      setStatus("error");
      return;
    }

    setStatus("saving");
    try {
      const targetBackground = getComputedStyle(target).backgroundColor || "#030712";

      const dataUrl = await toPng(target, {
        cacheBust: true,
        pixelRatio: Math.min(3, window.devicePixelRatio ?? 2),
        backgroundColor: targetBackground,
        filter: (node) => {
          if (!(node instanceof HTMLElement)) return true;
          return node.dataset.shareIgnore !== "true";
        },
        style: {
          margin: "0",
        },
      });

      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = resolvedFileName;
      link.click();

      setStatus("done");
      setTimeout(() => setStatus("idle"), 3000);
    } catch (error) {
      console.error("Failed to export report", error);
      setStatus("error");
      setTimeout(() => setStatus("idle"), 4000);
    }
  }, [resolvedFileName, targetId]);

  const label = status === "saving" ? "Preparing…" : status === "done" ? "Saved" : "Share report";

  return (
    <div className="flex flex-col items-end gap-1 text-xs text-neutral-400" data-share-ignore="true">
      <button
        type="button"
        onClick={handleShare}
        disabled={status === "saving"}
        className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm font-semibold text-white transition hover:border-emerald-400/60 hover:text-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 3a1 1 0 0 1 1 1v8.586l1.293-1.293a1 1 0 0 1 1.414 1.414l-3.004 3.004a1 1 0 0 1-1.414 0L8.285 12.707a1 1 0 0 1 1.414-1.414L11 12.586V4a1 1 0 0 1 1-1m-7 10a1 1 0 0 1 1 1v4h12v-4a1 1 0 0 1 2 0v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1"
          />
        </svg>
        {label}
      </button>
      {status === "error" && <span className="text-red-300">Unable to export. Try again.</span>}
    </div>
  );
}
