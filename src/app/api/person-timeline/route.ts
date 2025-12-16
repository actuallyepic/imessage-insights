import { NextResponse } from "next/server";
import { z } from "zod";

import { getPersonMessageTimeline } from "@/lib/imessage/queries";

const timelineSchema = z.object({
  key: z.string().min(1, "key is required"),
  bucket: z
    .string()
    .optional()
    .transform((value) => (value ? value.toLowerCase() : undefined))
    .refine(
      (value) => value === undefined || (["hour", "day", "week", "month"] as const).includes(value as any),
      "bucket must be hour, day, week, or month",
    )
    .transform((value) => value as "hour" | "day" | "week" | "month" | undefined),
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
  if (error instanceof Error && /authorization denied/i.test(error.message)) {
    return NextResponse.json(
      {
        error:
          "macOS denied access to the Messages database. Grant Terminal full disk access and try again.",
      },
      { status: 403 },
    );
  }

  console.error("Person timeline route error:", error);
  return NextResponse.json({ error: "Unexpected error while retrieving timeline." }, { status: 500 });
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());
  const parsed = timelineSchema.safeParse(rawParams);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { key, bucket, start, end } = parsed.data;

  try {
    const timeline = getPersonMessageTimeline({
      personKey: key,
      bucket,
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

