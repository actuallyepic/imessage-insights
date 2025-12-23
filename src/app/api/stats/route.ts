import { NextResponse } from "next/server";
import { z } from "zod";
import { getConversationStats } from "@/lib/imessage/queries";
import { getDbErrorInfo } from "@/lib/imessage/db-errors";

const statsSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 15))
    .refine(
      (value) => Number.isInteger(value) && value > 0 && value <= 50,
      "limit must be between 1 and 50",
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

  console.error("Stats route error:", error);
  return NextResponse.json({ error: info.message }, { status: info.status });
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());
  const parsed = statsSchema.safeParse(rawParams);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { limit, start, end } = parsed.data;

  try {
    const stats = getConversationStats({
      limit,
      dateRange: {
        start,
        end,
      },
    });

    return NextResponse.json({ data: stats });
  } catch (error) {
    return handleDbError(error);
  }
}
