import { NextResponse } from "next/server";
import { z } from "zod";
import { searchMessages } from "@/lib/imessage/queries";

const searchSchema = z.object({
  q: z.string().min(1, "Query is required"),
  chatId: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : undefined))
    .refine(
      (value) => value === undefined || Number.isInteger(value),
      "chatId must be an integer",
    ),
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 50))
    .refine(
      (value) => Number.isInteger(value) && value > 0 && value <= 200,
      "limit must be between 1 and 200",
    ),
  offset: z
    .string()
    .optional()
    .transform((value) => (value ? Number(value) : 0))
    .refine(
      (value) => Number.isInteger(value) && value >= 0,
      "offset must be zero or positive",
    ),
  fromMe: z
    .string()
    .optional()
    .transform((value) => (value ? value === "true" || value === "1" : undefined)),
  fromOthers: z
    .string()
    .optional()
    .transform((value) => (value ? value === "true" || value === "1" : undefined)),
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

  console.error("Search route error:", error);
  return NextResponse.json({ error: "Unexpected error querying messages." }, { status: 500 });
}

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams.entries());

  const parsed = searchSchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { q, chatId, limit, offset, fromMe, fromOthers, start, end } = parsed.data;

  try {
    const results = searchMessages({
      query: q,
      chatId,
      limit,
      offset,
      includeFromMe: fromMe ?? true,
      includeFromOthers: fromOthers ?? true,
      dateRange: {
        start,
        end,
      },
    });

    return NextResponse.json({ data: results });
  } catch (error) {
    return handleDbError(error);
  }
}
