import { NextResponse } from "next/server";
import { z } from "zod";

import { getRecentCalls } from "@/lib/callhistory/queries";
import type { CallDirection, CallMedia, CallProvider } from "@/lib/callhistory/types";

const callsSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 50))
    .refine(
      (value) => Number.isInteger(value) && value > 0 && value <= 500,
      "limit must be between 1 and 500",
    ),
  offset: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 0))
    .refine(
      (value) => Number.isInteger(value) && value >= 0,
      "offset must be zero or positive",
    ),
  provider: z
    .string()
    .optional()
    .transform((value) => (value ? value.toLowerCase() : undefined))
    .refine(
      (value) =>
        value === undefined ||
        (["facetime", "telephony", "unknown"] as const).includes(value as CallProvider),
      "provider must be facetime, telephony, or unknown",
    )
    .transform((value) => value as CallProvider | undefined),
  media: z
    .string()
    .optional()
    .transform((value) => (value ? value.toLowerCase() : undefined))
    .refine(
      (value) =>
        value === undefined ||
        (["audio", "video", "unknown"] as const).includes(value as CallMedia),
      "media must be audio, video, or unknown",
    )
    .transform((value) => value as CallMedia | undefined),
  direction: z
    .string()
    .optional()
    .transform((value) => (value ? value.toLowerCase() : undefined))
    .refine(
      (value) =>
        value === undefined ||
        (["incoming", "outgoing", "unknown"] as const).includes(value as CallDirection),
      "direction must be incoming, outgoing, or unknown",
    )
    .transform((value) => value as CallDirection | undefined),
  answered: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const normalized = value.toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
      if (normalized === "false" || normalized === "0") return false;
      return undefined;
    }),
  start: z
    .string()
    .optional()
    .transform((value) => (value ? new Date(value) : undefined))
    .refine((value) => !value || !Number.isNaN(value.getTime()), "Invalid start date"),
  end: z
    .string()
    .optional()
    .transform((value) => (value ? new Date(value) : undefined))
    .refine((value) => !value || !Number.isNaN(value.getTime()), "Invalid end date"),
});

function handleDbError(error: unknown) {
  if (
    error instanceof Error &&
    /(authorization denied|operation not permitted|not authorized)/i.test(error.message)
  ) {
    return NextResponse.json(
      {
        error:
          "macOS denied access to the Call History database. Grant Terminal full disk access and try again.",
      },
      { status: 403 },
    );
  }

  console.error("Calls route error:", error);
  return NextResponse.json({ error: "Unexpected error while retrieving calls." }, { status: 500 });
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());
  const parsed = callsSchema.safeParse(rawParams);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { limit, offset, provider, media, direction, answered, start, end } = parsed.data;

  try {
    const calls = getRecentCalls({
      limit,
      offset,
      provider,
      media,
      direction,
      answered,
      dateRange: {
        start,
        end,
      },
    });

    return NextResponse.json({ data: calls });
  } catch (error) {
    return handleDbError(error);
  }
}

