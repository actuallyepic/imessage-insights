import { NextResponse } from "next/server";
import { autoDetectAndSave, getDbPathStatus, saveDbPath } from "@/lib/imessage/db-path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getDbPathStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let payload: { dbPath?: string; action?: string } = {};

  try {
    payload = (await request.json()) as { dbPath?: string; action?: string };
  } catch {
    payload = {};
  }

  if (payload.action === "auto") {
    const result = autoDetectAndSave();
    return NextResponse.json({
      ...getDbPathStatus(),
      detected: result.detected,
    });
  }

  if (payload.action === "clear") {
    saveDbPath(null);
    return NextResponse.json({
      ...getDbPathStatus(),
      cleared: true,
    });
  }

  if (typeof payload.dbPath === "string") {
    saveDbPath(payload.dbPath);
  }

  return NextResponse.json(getDbPathStatus());
}
