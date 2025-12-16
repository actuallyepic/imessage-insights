import { getContactInfoForHandle, normalizeHandleIdentifier } from "../contacts";
import { fromAppleTimestamp, isWithinRange } from "../imessage/dates";
import { getCallHistoryDatabase } from "./db";
import type {
  CallDirection,
  CallMedia,
  CallOutcome,
  CallParticipant,
  CallProvider,
  CallQueryOptions,
  CallRecord,
} from "./types";

type CallRow = {
  callId: number;
  date: number | null;
  duration: number | null;
  originated: number | null;
  answered: number | null;
  callCategory: number | null;
  callType: number | null;
  serviceProvider: string | null;
  address: string | null;
  name: string | null;
};

type ParticipantRow = {
  callId: number;
  handle: string | null;
};

function decodeProvider(serviceProvider: string | null): CallProvider {
  if (serviceProvider === "com.apple.FaceTime") return "facetime";
  if (serviceProvider === "com.apple.Telephony") return "telephony";
  return "unknown";
}

function decodeMedia(callCategory: number | null): CallMedia {
  if (callCategory === 1) return "audio";
  if (callCategory === 2) return "video";
  return "unknown";
}

function decodeDirection(originated: number | null): CallDirection {
  if (originated === 1) return "outgoing";
  if (originated === 0) return "incoming";
  return "unknown";
}

function decodeOutcome(direction: CallDirection, answered: boolean): CallOutcome {
  if (answered) return "answered";
  if (direction === "incoming") return "missed";
  if (direction === "outgoing") return "unanswered";
  return "unknown";
}

function normalizeParticipantHandle(value: string | null): string | null {
  if (!value) return null;
  return normalizeHandleIdentifier(value) ?? value.trim();
}

function buildParticipant(handle: string): CallParticipant {
  const contactInfo = getContactInfoForHandle(handle);
  return {
    id:
      contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
        ? `contact-${contactInfo.recordId}`
        : handle,
    handle,
    displayName: contactInfo?.name ?? null,
  };
}

function buildWhereClause(options: CallQueryOptions) {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.answered !== undefined) {
    clauses.push("r.ZANSWERED = @answered");
    params.answered = options.answered ? 1 : 0;
  }

  if (options.provider) {
    if (options.provider === "facetime") {
      clauses.push("r.ZSERVICE_PROVIDER = @serviceProvider");
      params.serviceProvider = "com.apple.FaceTime";
    } else if (options.provider === "telephony") {
      clauses.push("r.ZSERVICE_PROVIDER = @serviceProvider");
      params.serviceProvider = "com.apple.Telephony";
    } else if (options.provider === "unknown") {
      clauses.push("(r.ZSERVICE_PROVIDER IS NULL OR r.ZSERVICE_PROVIDER NOT IN ('com.apple.FaceTime', 'com.apple.Telephony'))");
    }
  }

  if (options.media) {
    if (options.media === "audio") {
      clauses.push("r.ZCALL_CATEGORY = 1");
    } else if (options.media === "video") {
      clauses.push("r.ZCALL_CATEGORY = 2");
    } else if (options.media === "unknown") {
      clauses.push("(r.ZCALL_CATEGORY IS NULL OR r.ZCALL_CATEGORY NOT IN (1, 2))");
    }
  }

  if (options.direction) {
    if (options.direction === "incoming") {
      clauses.push("r.ZORIGINATED = 0");
    } else if (options.direction === "outgoing") {
      clauses.push("r.ZORIGINATED = 1");
    } else if (options.direction === "unknown") {
      clauses.push("(r.ZORIGINATED IS NULL OR r.ZORIGINATED NOT IN (0, 1))");
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

export function getRecentCalls(options: CallQueryOptions = {}): CallRecord[] {
  const db = getCallHistoryDatabase();

  const limit = Math.min(Math.max(1, options.limit ?? 100), 500);
  const offset = Math.max(0, options.offset ?? 0);

  const { where, params } = buildWhereClause(options);

  const callStmt = db.prepare(`
    SELECT
      r.Z_PK AS callId,
      r.ZDATE AS date,
      r.ZDURATION AS duration,
      r.ZORIGINATED AS originated,
      r.ZANSWERED AS answered,
      r.ZCALL_CATEGORY AS callCategory,
      r.ZCALLTYPE AS callType,
      r.ZSERVICE_PROVIDER AS serviceProvider,
      r.ZADDRESS AS address,
      r.ZNAME AS name
    FROM ZCALLRECORD r
    ${where}
    ORDER BY r.ZDATE DESC
    LIMIT @limit
    OFFSET @offset
  `);

  const callRows = callStmt.all({ ...params, limit, offset }) as CallRow[];

  const filteredRows = options.dateRange
    ? callRows.filter((row) => {
        const startedAt = fromAppleTimestamp(row.date);
        return startedAt ? isWithinRange(startedAt, options.dateRange?.start, options.dateRange?.end) : false;
      })
    : callRows;

  const callIds = filteredRows.map((row) => row.callId);
  const participantMap = new Map<number, string[]>();

  if (callIds.length > 0) {
    const placeholders = callIds.map(() => "?").join(", ");
    const participantStmt = db.prepare(`
      SELECT
        j.Z_2REMOTEPARTICIPANTCALLS AS callId,
        h.ZVALUE AS handle
      FROM Z_2REMOTEPARTICIPANTHANDLES j
      JOIN ZHANDLE h ON h.Z_PK = j.Z_4REMOTEPARTICIPANTHANDLES
      WHERE j.Z_2REMOTEPARTICIPANTCALLS IN (${placeholders})
      ORDER BY j.Z_2REMOTEPARTICIPANTCALLS, h.Z_PK
    `);

    const participantRows = participantStmt.all(...callIds) as ParticipantRow[];
    for (const row of participantRows) {
      const normalized = normalizeParticipantHandle(row.handle);
      if (!normalized) continue;
      const list = participantMap.get(row.callId) ?? [];
      if (!list.includes(normalized)) {
        list.push(normalized);
      }
      participantMap.set(row.callId, list);
    }
  }

  return filteredRows.map((row) => {
    const startedAt = fromAppleTimestamp(row.date);
    const outgoing = row.originated === 1;
    const durationSeconds = Number.isFinite(row.duration ?? NaN) ? Math.max(0, Number(row.duration)) : 0;
    const answered = row.answered === 1 || (outgoing && durationSeconds > 0);

    const direction = decodeDirection(row.originated);
    const outcome = decodeOutcome(direction, answered);

    const provider = decodeProvider(row.serviceProvider);
    const media = decodeMedia(row.callCategory);

    let participantHandles = participantMap.get(row.callId) ?? [];
    if (participantHandles.length === 0) {
      const normalizedAddress = normalizeParticipantHandle(row.address);
      if (normalizedAddress) {
        participantHandles = [normalizedAddress];
      }
    }
    const participants = participantHandles.map(buildParticipant);

    return {
      callId: row.callId,
      startedAt,
      durationSeconds,
      provider,
      serviceProvider: row.serviceProvider,
      media,
      direction,
      outcome,
      answered,
      outgoing,
      address: row.address,
      name: row.name,
      participants,
    } satisfies CallRecord;
  });
}
