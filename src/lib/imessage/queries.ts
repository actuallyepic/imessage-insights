import type { Database as BetterSqliteDatabase, Statement } from "better-sqlite3";
import { getDatabase } from "./db";
import { fromAppleTimestamp, toAppleTimestamp } from "./dates";
import type {
  ChatParticipantStats,
  ChatSummary,
  ConversationStats,
  DailyCount,
  HourlyCount,
  SearchOptions,
  SearchResultMessage,
  WeekdayCount,
} from "./types";

let cachedFtsSupport: boolean | null = null;
let cachedHandleDisplayName: boolean | null = null;

function detectFtsSupport(db: BetterSqliteDatabase): boolean {
  if (cachedFtsSupport !== null) {
    return cachedFtsSupport;
  }

  try {
    const stmt = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_fts'",
    );
    cachedFtsSupport = Boolean(stmt.get());
  } catch (error) {
    console.warn("Unable to detect message_fts table:", error);
    cachedFtsSupport = false;
  }

  return cachedFtsSupport;
}

function detectHandleDisplayName(db: BetterSqliteDatabase): boolean {
  if (cachedHandleDisplayName !== null) {
    return cachedHandleDisplayName;
  }

  try {
    const stmt: Statement = db.prepare("PRAGMA table_info(handle)");
    const rows = stmt.all() as { name: string }[];
    cachedHandleDisplayName = rows.some((row) => row.name === "display_name");
  } catch (error) {
    console.warn("Unable to inspect handle table columns:", error);
    cachedHandleDisplayName = false;
  }

  return cachedHandleDisplayName;
}

function buildFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // If the user provides explicit operators or quotes, pass through.
  if (/[\"'()]/.test(trimmed) || /\b(AND|OR|NOT|NEAR)\b/i.test(trimmed)) {
    return trimmed;
  }

  return trimmed
    .split(/\s+/)
    .map((token) => {
      if (token === "*") return "*";
      // Support negation with leading minus.
      if (token.startsWith("-") && token.length > 1) {
        return `NOT ${token.slice(1)}*`;
      }
      return `${token}*`;
    })
    .join(" AND ");
}

function collectParticipants(participantsCsv: string | null): string[] {
  if (!participantsCsv) {
    return [];
  }

  return participantsCsv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function searchMessages(options: SearchOptions): SearchResultMessage[] {
  const db = getDatabase();

  const {
    query,
    chatId,
    limit = 50,
    offset = 0,
    includeFromMe = true,
    includeFromOthers = true,
    dateRange,
  } = options;

  if (!query.trim()) {
    return [];
  }

  const ftsSupported = detectFtsSupport(db);
  const ftsQuery = buildFtsQuery(query);

  const params: Record<string, unknown> = {
    limit,
    offset,
  };

  const whereClauses: string[] = [];

  if (ftsSupported && ftsQuery) {
    whereClauses.push("fts MATCH @ftsQuery");
    params.ftsQuery = ftsQuery;
  } else {
    whereClauses.push("m.text LIKE @likeQuery");
    params.likeQuery = `%${query}%`;
  }

  if (typeof chatId === "number") {
    whereClauses.push("c.ROWID = @chatId");
    params.chatId = chatId;
  }

  if (!includeFromMe && includeFromOthers) {
    whereClauses.push("m.is_from_me = 0");
  } else if (includeFromMe && !includeFromOthers) {
    whereClauses.push("m.is_from_me = 1");
  } else if (!includeFromMe && !includeFromOthers) {
    return [];
  }

  if (dateRange?.start) {
    params.startDate = toAppleTimestamp(dateRange.start);
    whereClauses.push("m.date >= @startDate");
  }

  if (dateRange?.end) {
    params.endDate = toAppleTimestamp(dateRange.end);
    whereClauses.push("m.date <= @endDate");
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const baseSql = `
    SELECT
      m.ROWID AS messageId,
      c.ROWID AS chatId,
      c.display_name AS chatDisplayName,
      GROUP_CONCAT(DISTINCT h.id) AS participants,
      m.text AS text,
      m.is_from_me AS isFromMe,
      m.date AS sentDate
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    LEFT JOIN handle h ON h.ROWID = chj.handle_id
    ${ftsSupported && ftsQuery ? "JOIN message_fts fts ON fts.rowid = m.ROWID" : ""}
    ${whereSql}
    GROUP BY m.ROWID, c.ROWID
    ORDER BY m.date DESC
    LIMIT @limit OFFSET @offset
  `;

  try {
    const stmt = db.prepare(baseSql);
    const rows = stmt.all(params) as {
      messageId: number;
      chatId: number;
      chatDisplayName: string | null;
      participants: string | null;
      text: string | null;
      isFromMe: number;
      sentDate: number | null;
    }[];

    return rows.map((row) => ({
      messageId: row.messageId,
      chatId: row.chatId,
      chatDisplayName: row.chatDisplayName,
      participants: collectParticipants(row.participants),
      text: row.text,
      isFromMe: row.isFromMe === 1,
      sentAt: fromAppleTimestamp(row.sentDate),
    }));
  } catch (error) {
    // Fall back to LIKE if FTS query failed (e.g., the virtual table is corrupt).
    if (ftsSupported) {
      cachedFtsSupport = false;
      return searchMessages({ ...options });
    }
    throw error;
  }
}

export interface StatsOptions {
  limit?: number;
  dateRange?: { start?: Date; end?: Date };
}

const DAY_BUCKET_EXPR = `
CASE
  WHEN ABS(m.date) > 1000000000000 THEN date(m.date / 1000000000 + 978307200, 'unixepoch')
  WHEN ABS(m.date) > 1000000000 THEN date(m.date / 1000000 + 978307200, 'unixepoch')
  ELSE date(m.date + 978307200, 'unixepoch')
END
`;

export function getConversationStats(options: StatsOptions = {}): ConversationStats {
  const db = getDatabase();
  const { limit = 15, dateRange } = options;
  const hasDisplayName = detectHandleDisplayName(db);

  const params: Record<string, unknown> = {
    limit,
  };
  const messageWhere: string[] = [];

  if (dateRange?.start) {
    params.start = toAppleTimestamp(dateRange.start);
    messageWhere.push("m.date >= @start");
  }

  if (dateRange?.end) {
    params.end = toAppleTimestamp(dateRange.end);
    messageWhere.push("m.date <= @end");
  }

  const messageWhereSql = messageWhere.length ? `WHERE ${messageWhere.join(" AND ")}` : "";

  const topChatsSql = `
    SELECT
      c.ROWID AS chatId,
      c.display_name AS chatDisplayName,
      COUNT(DISTINCT h.ROWID) AS participantCount,
      GROUP_CONCAT(DISTINCT h.id) AS participants,
      COUNT(m.ROWID) AS messageCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount,
      MAX(m.date) AS lastMessageDate
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
    LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    LEFT JOIN handle h ON h.ROWID = chj.handle_id
    ${messageWhereSql}
    GROUP BY c.ROWID
    ORDER BY messageCount DESC
    LIMIT @limit
  `;

  const participantSql = `
    SELECT
      h.id AS handleId,
      COALESCE(${hasDisplayName ? "h.display_name" : "NULL"}, h.id) AS displayName,
      COUNT(m.ROWID) AS messageCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    ${messageWhereSql}
    GROUP BY h.id
    HAVING messageCount > 0
    ORDER BY messageCount DESC
    LIMIT @limit
  `;

  const dailySql = `
    SELECT
      ${DAY_BUCKET_EXPR} AS day,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    ${messageWhereSql}
    GROUP BY day
    ORDER BY day DESC
    LIMIT 90
  `;

  const hourlySql = `
    SELECT
      CASE
        WHEN ABS(m.date) > 1000000000000 THEN strftime('%H', datetime(m.date / 1000000000 + 978307200, 'unixepoch'))
        WHEN ABS(m.date) > 1000000000 THEN strftime('%H', datetime(m.date / 1000000 + 978307200, 'unixepoch'))
        ELSE strftime('%H', datetime(m.date + 978307200, 'unixepoch'))
      END AS hourBucket,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    ${messageWhereSql}
    GROUP BY hourBucket
    HAVING hourBucket IS NOT NULL
    ORDER BY hourBucket
  `;

  const weekdaySql = `
    SELECT
      CASE
        WHEN ABS(m.date) > 1000000000000 THEN strftime('%w', datetime(m.date / 1000000000 + 978307200, 'unixepoch'))
        WHEN ABS(m.date) > 1000000000 THEN strftime('%w', datetime(m.date / 1000000 + 978307200, 'unixepoch'))
        ELSE strftime('%w', datetime(m.date + 978307200, 'unixepoch'))
      END AS weekdayBucket,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    ${messageWhereSql}
    GROUP BY weekdayBucket
    HAVING weekdayBucket IS NOT NULL
    ORDER BY weekdayBucket
  `;

  const topChatsStmt = db.prepare(topChatsSql);
  const participantStmt = db.prepare(participantSql);
  const dailyStmt = db.prepare(dailySql);
  const hourlyStmt = db.prepare(hourlySql);
  const weekdayStmt = db.prepare(weekdaySql);

  const topChatsRows = topChatsStmt.all(params) as {
    chatId: number;
    chatDisplayName: string | null;
    participantCount: number;
    participants: string | null;
    messageCount: number;
    sentCount: number;
    receivedCount: number;
    lastMessageDate: number | null;
  }[];

  const participantsRows = participantStmt.all(params) as {
    handleId: string | null;
    displayName: string | null;
    messageCount: number;
    sentCount: number;
    receivedCount: number;
  }[];

  const dailyRows = dailyStmt.all(params) as {
    day: string;
    sentCount: number;
    receivedCount: number;
  }[];

  const hourlyRows = hourlyStmt.all(params) as {
    hourBucket: number;
    sentCount: number;
    receivedCount: number;
  }[];

  const weekdayRows = weekdayStmt.all(params) as {
    weekdayBucket: string;
    sentCount: number;
    receivedCount: number;
  }[];

  const topChats: ChatSummary[] = topChatsRows.map((row) => ({
    chatId: row.chatId,
    chatDisplayName: row.chatDisplayName,
    isGroup: row.participantCount > 1,
    participants: collectParticipants(row.participants),
    messageCount: row.messageCount,
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
    lastMessageAt: fromAppleTimestamp(row.lastMessageDate),
  }));

  const participantBreakdown: ChatParticipantStats[] = participantsRows.map((row) => ({
    id: row.handleId,
    displayName: row.displayName,
    messageCount: row.messageCount,
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
  }));

  const dailyCounts: DailyCount[] = dailyRows.map((row) => ({
    date: new Date(`${row.day}T00:00:00`),
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
  }));

  const hourlyCounts: HourlyCount[] = hourlyRows.map((row) => ({
    hour: Number(row.hourBucket),
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
  }));

  const weekdayCounts: WeekdayCount[] = weekdayRows.map((row) => ({
    weekday: Number(row.weekdayBucket),
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
  }));

  return {
    topChats,
    participantBreakdown,
    dailyCounts,
    hourlyCounts,
    weekdayCounts,
  };
}
