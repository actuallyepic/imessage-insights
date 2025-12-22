export type CallProvider = "facetime" | "telephony" | "unknown";
export type CallMedia = "audio" | "video" | "unknown";
export type CallDirection = "incoming" | "outgoing" | "unknown";
export type CallOutcome = "answered" | "missed" | "unanswered" | "unknown";

export type CallParticipant = {
  id?: string | null;
  handle: string;
  displayName: string | null;
};

export type CallApiRecord = {
  callId: number;
  startedAt: string | null;
  durationSeconds: number;
  provider: CallProvider;
  serviceProvider: string | null;
  media: CallMedia;
  direction: CallDirection;
  outcome: CallOutcome;
  answered: boolean;
  outgoing: boolean;
  address: string | null;
  name: string | null;
  participants: CallParticipant[];
};

export async function fetchCallsPage(limit: number, offset: number) {
  const url = `/api/calls?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`;
  const res = await fetch(url, { credentials: "same-origin" });
  const json = (await res.json()) as { data?: CallApiRecord[]; error?: unknown };
  if (!res.ok) {
    const message =
      typeof json?.error === "string"
        ? json.error
        : (json?.error as { message?: string } | undefined)?.message ?? "Failed to load calls.";
    throw new Error(message);
  }
  return json.data ?? [];
}

export async function fetchAllCalls() {
  const limit = 500;
  const maxPages = 50;
  const all: CallApiRecord[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const chunk = await fetchCallsPage(limit, offset);
    all.push(...chunk);
    if (chunk.length < limit) break;
  }

  return all;
}
