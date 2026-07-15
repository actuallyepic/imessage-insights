"use client";

import { useCallback, useMemo, useState } from "react";
import { toPng } from "html-to-image";

import { ShareIcon, Spinner } from "@/components/ui/icons";

type ShareReportButtonProps = {
  targetId: string;
  fileName?: string;
};

const ensurePngExtension = (name: string) => (name.toLowerCase().endsWith(".png") ? name : `${name}.png`);

export function ShareReportButton({ targetId, fileName = "chat-report.png" }: ShareReportButtonProps) {
  const [status, setStatus] = useState<"idle" | "saving" | "error" | "done">("idle");

  const resolvedFileName = useMemo(() => ensurePngExtension(fileName.trim() || "chat-report"), [fileName]);

  const handleShare = useCallback(async () => {
    if (typeof window === "undefined") return;

    const target = document.getElementById(targetId);
    if (!target) {
      setStatus("error");
      return;
    }

    setStatus("saving");
    try {
      // The capture wrapper carries the page background, so the export never
      // lands on a transparent canvas in either theme.
      const targetBackground = getComputedStyle(target).backgroundColor || "var(--page)";

      const dataUrl = await toPng(target, {
        cacheBust: true,
        pixelRatio: Math.min(3, window.devicePixelRatio ?? 2),
        backgroundColor: targetBackground,
        filter: (node) => {
          if (!(node instanceof HTMLElement)) return true;
          return node.dataset.shareIgnore !== "true";
        },
        style: { margin: "0" },
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
    <div className="flex flex-col items-end gap-1.5" data-share-ignore="true">
      <button
        type="button"
        onClick={handleShare}
        disabled={status === "saving"}
        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-control bg-surface px-4 py-2 text-xs font-semibold text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          {status === "saving" ? <Spinner /> : <ShareIcon />}
        </span>
        {label}
      </button>
      {status === "error" ? <span className="text-[11px] text-rose">Unable to export. Try again.</span> : null}
    </div>
  );
}
