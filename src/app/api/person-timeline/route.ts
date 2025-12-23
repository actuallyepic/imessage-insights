import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersonMessageTimeline } from "@/lib/imessage/queries";
import { getDbErrorInfo } from "@/lib/imessage/db-errors";

const timelineSchema = z.object({
  key: z.string().min(1, "key is required"),
  bucket: z.preprocess(
    (value) => (typeof value === "string" ? value.toLowerCase() : undefined),
    z.enum(["hour", "day", "week", "month"]).optional(),
  ),
  chatIds: z.preprocess(
    (value) => {
      if (typeof value !== "string") return undefined;
      const entries = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.length === 0) return undefined;
      return entries.map((entry) => Number(entry));
    },
    z.array(z.number().int().positive()).optional(),
  ),
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
  const info = getDbErrorInfo(error);
  if (info.kind !== "unknown") {
    return NextResponse.json({ error: info.message }, { status: info.status });
  }

  console.error("Person timeline route error:", error);
  return NextResponse.json({ error: info.message }, { status: info.status });
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());
  const parsed = timelineSchema.safeParse(rawParams);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { key, bucket, start, end, chatIds } = parsed.data;

  try {
    const timeline = getPersonMessageTimeline({
      personKey: key,
      bucket,
      chatIds,
      dateRange: {
        start,
        end,
      },
    });

    return NextResponse.json({ data: timeline });
  } catch (error) {
    return handleDbError(error);
  }
}
