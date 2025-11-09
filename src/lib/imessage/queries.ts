import type { Database as BetterSqliteDatabase, Statement } from "better-sqlite3";
import { getContactInfoForHandle, getContactNameForHandle, normalizeHandleIdentifier } from "../contacts";
import { getDatabase } from "./db";
import { fromAppleTimestamp, toAppleTimestamp } from "./dates";
import type {
  ChatParticipantStats,
  ChatReactionParticipantStats,
  ChatSummary,
  ConversationStats,
  DailyCount,
  HourlyCount,
  ReactionTotals,
  SearchOptions,
  SearchResultMessage,
  WeekdayCount,
} from "./types";

let cachedFtsSupport: boolean | null = null;
let cachedHandleDisplayName: boolean | null = null;
let cachedMessageDeletionFlag: boolean | null = null;
type ReactionColumnSupport = {
  hasAssociatedGuid: boolean;
  hasAssociatedType: boolean;
} | null;
let cachedReactionColumnSupport: ReactionColumnSupport = null;

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

function detectMessageDeletionColumn(db: BetterSqliteDatabase): boolean {
  if (cachedMessageDeletionFlag !== null) {
    return cachedMessageDeletionFlag;
  }

  try {
    const stmt: Statement = db.prepare("PRAGMA table_info(message)");
    const rows = stmt.all() as { name: string }[];
    cachedMessageDeletionFlag = rows.some((row) => row.name === "is_deleted");
  } catch (error) {
    console.warn("Unable to inspect message table columns:", error);
    cachedMessageDeletionFlag = false;
  }

  return cachedMessageDeletionFlag;
}

function detectReactionColumns(db: BetterSqliteDatabase): {
  hasAssociatedGuid: boolean;
  hasAssociatedType: boolean;
} {
  if (cachedReactionColumnSupport !== null) {
    return cachedReactionColumnSupport;
  }

  try {
    const stmt: Statement = db.prepare("PRAGMA table_info(message)");
    const rows = stmt.all() as { name: string }[];
    const hasAssociatedGuid = rows.some((row) => row.name === "associated_message_guid");
    const hasAssociatedType = rows.some((row) => row.name === "associated_message_type");
    cachedReactionColumnSupport = {
      hasAssociatedGuid,
      hasAssociatedType,
    };
  } catch (error) {
    console.warn("Unable to inspect message table columns for reactions:", error);
    cachedReactionColumnSupport = {
      hasAssociatedGuid: false,
      hasAssociatedType: false,
    };
  }

  return cachedReactionColumnSupport;
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

  const rawValues = participantsCsv
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const names: string[] = [];
  const seen = new Set<string>();

  for (const value of rawValues) {
    const contactInfo = getContactInfoForHandle(value);
    const fallbackName = getContactNameForHandle(value) ?? value;
    const normalizedHandle = normalizeHandleIdentifier(value) ?? value;
    const key =
      contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
        ? `contact:${contactInfo.recordId}`
        : `handle:${normalizedHandle}`;

    if (seen.has(key)) {
      continue;
    }

    const name = contactInfo?.name ?? fallbackName;
    if (name.toLowerCase() === "me") {
      seen.add(key);
      continue;
    }

    seen.add(key);
    names.push(name);
  }

  if (names.length === 0) {
    return rawValues;
  }

  return names;
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
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const ftsQuery = buildFtsQuery(query);

  const params: Record<string, unknown> = {
    limit,
    offset,
  };

  const whereClauses: string[] = [];
  if (hasDeletionFlag) {
    whereClauses.push("m.is_deleted = 0");
  }

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

    return rows.map((row) => {
      const participantNames = collectParticipants(row.participants);
      const derivedName =
        row.chatDisplayName ?? (participantNames.length === 1 ? participantNames[0] : null);

      return {
        messageId: row.messageId,
        chatId: row.chatId,
        chatDisplayName: derivedName,
        participants: participantNames,
        text: row.text,
        isFromMe: row.isFromMe === 1,
        sentAt: fromAppleTimestamp(row.sentDate),
      };
    });
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
  WHEN ABS(m.date) > 1000000000000 THEN date(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime')
  WHEN ABS(m.date) > 1000000000 THEN date(m.date / 1000000 + 978307200, 'unixepoch', 'localtime')
  ELSE date(m.date + 978307200, 'unixepoch', 'localtime')
END
`;

export function getConversationStats(options: StatsOptions = {}): ConversationStats {
  const db = getDatabase();
  const { limit = 15, dateRange } = options;
  const hasDisplayName = detectHandleDisplayName(db);
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const reactionColumnSupport = detectReactionColumns(db);
  const reactionsSupported =
    reactionColumnSupport.hasAssociatedGuid && reactionColumnSupport.hasAssociatedType;
  const participantLimit = Math.max(limit * 3, limit);

  const params: Record<string, unknown> = {
    limit,
    participantLimit,
  };
  const messageWhere: string[] = [];
  if (hasDeletionFlag) {
    messageWhere.push("m.is_deleted = 0");
  }

  if (dateRange?.start) {
    params.start = toAppleTimestamp(dateRange.start);
    messageWhere.push("m.date >= @start");
  }

  if (dateRange?.end) {
    params.end = toAppleTimestamp(dateRange.end);
    messageWhere.push("m.date <= @end");
  }

  const buildWhereClause = (...additional: string[]) => {
    const filters = [...messageWhere, ...additional.filter(Boolean)];
    return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  };

  const messageWhereSql = buildWhereClause();
  const reactionFilterClauses = reactionsSupported
    ? ["m.associated_message_guid IS NOT NULL", "ABS(m.associated_message_type) BETWEEN 2000 AND 2005"]
    : [];

  const topChatsSql = `
    WITH message_stats AS (
      SELECT
        c.ROWID AS chatId,
        c.display_name AS chatDisplayName,
        COUNT(m.ROWID) AS messageCount,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount,
        MAX(m.date) AS lastMessageDate
      FROM chat c
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      JOIN message m ON m.ROWID = cmj.message_id
      ${messageWhereSql}
      GROUP BY c.ROWID
    ),
    participants AS (
      SELECT
        combined.chatId,
        COUNT(DISTINCT combined.handleRowId) AS participantCount,
        GROUP_CONCAT(DISTINCT combined.handleId) AS participants
      FROM (
        SELECT
          chj.chat_id AS chatId,
          h.ROWID AS handleRowId,
          h.id AS handleId
        FROM chat_handle_join chj
        LEFT JOIN handle h ON h.ROWID = chj.handle_id
        UNION ALL
        SELECT
          cmj.chat_id AS chatId,
          h.ROWID AS handleRowId,
          h.id AS handleId
        FROM chat_message_join cmj
        JOIN message m ON m.ROWID = cmj.message_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        ${messageWhereSql}
      ) combined
      WHERE combined.handleId IS NOT NULL
      GROUP BY combined.chatId
    )
    SELECT
      ms.chatId,
      ms.chatDisplayName,
      COALESCE(p.participantCount, 0) AS participantCount,
      p.participants,
      ms.messageCount,
      ms.sentCount,
      ms.receivedCount,
      ms.lastMessageDate
    FROM message_stats ms
    LEFT JOIN participants p ON p.chatId = ms.chatId
    ORDER BY ms.messageCount DESC
    LIMIT @limit
  `;

  const participantDisplayColumn = hasDisplayName ? "h.display_name" : "NULL";

  const participantSql = `
    SELECT
      h.id AS handleId,
      ${participantDisplayColumn} AS handleDisplayName,
      COUNT(m.ROWID) AS messageCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    ${messageWhereSql}
    GROUP BY h.id
    HAVING messageCount > 0
    ORDER BY messageCount DESC
    LIMIT @participantLimit
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
        WHEN ABS(m.date) > 1000000000000 THEN strftime('%H', datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime'))
        WHEN ABS(m.date) > 1000000000 THEN strftime('%H', datetime(m.date / 1000000 + 978307200, 'unixepoch', 'localtime'))
        ELSE strftime('%H', datetime(m.date + 978307200, 'unixepoch', 'localtime'))
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
        WHEN ABS(m.date) > 1000000000000 THEN strftime('%w', datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime'))
        WHEN ABS(m.date) > 1000000000 THEN strftime('%w', datetime(m.date / 1000000 + 978307200, 'unixepoch', 'localtime'))
        ELSE strftime('%w', datetime(m.date + 978307200, 'unixepoch', 'localtime'))
      END AS weekdayBucket,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    ${messageWhereSql}
    GROUP BY weekdayBucket
    HAVING weekdayBucket IS NOT NULL
    ORDER BY weekdayBucket
  `;

  const totalsSql = `
    SELECT
      COUNT(m.ROWID) AS messageCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount,
      MAX(m.date) AS latestMessageDate
    FROM message m
    ${messageWhereSql}
  `;

  const reactionTotalsSql = reactionsSupported
    ? `
    SELECT
      COUNT(m.ROWID) AS reactionCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    ${buildWhereClause(...reactionFilterClauses)}
  `
    : null;

  const topChatsStmt = db.prepare(topChatsSql);
  const participantStmt = db.prepare(participantSql);
  const dailyStmt = db.prepare(dailySql);
  const hourlyStmt = db.prepare(hourlySql);
  const weekdayStmt = db.prepare(weekdaySql);
  const totalsStmt = db.prepare(totalsSql);
  const reactionTotalsStmt = reactionTotalsSql ? db.prepare(reactionTotalsSql) : null;

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
    handleDisplayName: string | null;
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

  const totalsRow = totalsStmt.get(params) as {
    messageCount: number | null;
    sentCount: number | null;
    receivedCount: number | null;
    latestMessageDate: number | null;
  } | undefined;
  const reactionTotalsRow = reactionTotalsStmt
    ? (reactionTotalsStmt.get(params) as {
        reactionCount: number | null;
        sentCount: number | null;
        receivedCount: number | null;
      } | undefined)
    : undefined;

  const totals = {
    messageCount: totalsRow?.messageCount ?? 0,
    sentCount: totalsRow?.sentCount ?? 0,
    receivedCount: totalsRow?.receivedCount ?? 0,
  };
  const reactionTotals: ReactionTotals = {
    reactionCount: reactionTotalsRow?.reactionCount ?? 0,
    sentCount: reactionTotalsRow?.sentCount ?? 0,
    receivedCount: reactionTotalsRow?.receivedCount ?? 0,
  };
  const latestMessageAt = fromAppleTimestamp(totalsRow?.latestMessageDate ?? null);
  const reactionTotalsByChat = new Map<number, ReactionTotals>();
  const reactionParticipantsByChat = new Map<number, ChatReactionParticipantStats[]>();
  const messageParticipantsByChat = new Map<number, ChatParticipantStats[]>();

  const chatIdParams: Record<string, number> = {};
  const chatPlaceholders =
    topChatsRows.length > 0
      ? topChatsRows
          .map((row, index) => {
            const key = `chatId${index}`;
            chatIdParams[key] = row.chatId;
            return `@${key}`;
          })
          .join(", ")
      : "";
  const chatFilterClause = chatPlaceholders ? `cmj.chat_id IN (${chatPlaceholders})` : "";
  const groupByColumns = hasDisplayName
    ? "cmj.chat_id, h.id, m.is_from_me, h.display_name"
    : "cmj.chat_id, h.id, m.is_from_me";

  if (chatFilterClause) {
    const messageParticipantsSql = `
      SELECT
        cmj.chat_id AS chatId,
        h.id AS handleId,
        ${participantDisplayColumn} AS handleDisplayName,
        m.is_from_me AS isFromMe,
        COUNT(m.ROWID) AS messageCount,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      ${buildWhereClause(chatFilterClause)}
      GROUP BY ${groupByColumns}
    `;

    const messageParticipantsStmt = db.prepare(messageParticipantsSql);
    const messageParticipantRows = messageParticipantsStmt.all({ ...params, ...chatIdParams }) as {
      chatId: number;
      handleId: string | null;
      handleDisplayName: string | null;
      isFromMe: number;
      messageCount: number;
      sentCount: number;
      receivedCount: number;
    }[];

    const messageParticipantAggregates = new Map<number, Map<string, ChatParticipantStats>>();

    for (const row of messageParticipantRows) {
      const aggregateForChat =
        messageParticipantAggregates.get(row.chatId) ?? new Map<string, ChatParticipantStats>();
      if (!messageParticipantAggregates.has(row.chatId)) {
        messageParticipantAggregates.set(row.chatId, aggregateForChat);
      }

      const isFromMe = row.isFromMe === 1;
      const contactInfo = row.handleId ? getContactInfoForHandle(row.handleId) : null;
      const normalizedHandle = row.handleId ? normalizeHandleIdentifier(row.handleId) : null;

      const aggregateKey = isFromMe
        ? "me"
        : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact:${contactInfo.recordId}`
          : normalizedHandle
            ? `handle:${normalizedHandle}`
            : row.handleId
              ? `raw:${row.handleId}`
              : `unknown:${row.chatId}`;

      const participantId = isFromMe
        ? "me"
        : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact-${contactInfo.recordId}`
          : normalizedHandle ?? row.handleId ?? `chat-${row.chatId}-unknown`;

      const selfPreferredName =
        contactInfo?.name && contactInfo.name.toLowerCase() !== "me" ? contactInfo.name : "You";
      const preferredName = isFromMe
        ? selfPreferredName
        : contactInfo?.name ??
          (row.handleDisplayName && row.handleDisplayName !== row.handleId ? row.handleDisplayName : null) ??
          row.handleId;

      const existing = aggregateForChat.get(aggregateKey);
      if (existing) {
        existing.messageCount += row.messageCount;
        existing.sentCount += row.sentCount;
        existing.receivedCount += row.receivedCount;
        if (isFromMe) {
          existing.isMe = true;
        }
        continue;
      }

      aggregateForChat.set(aggregateKey, {
        id: participantId ?? aggregateKey,
        displayName: preferredName,
        messageCount: row.messageCount,
        sentCount: row.sentCount,
        receivedCount: row.receivedCount,
        isMe: isFromMe,
      });
    }

    for (const [chatId, aggregate] of messageParticipantAggregates.entries()) {
      const sorted = Array.from(aggregate.values()).sort(
        (a, b) => b.messageCount - a.messageCount || (a.displayName ?? "").localeCompare(b.displayName ?? ""),
      );
      messageParticipantsByChat.set(chatId, sorted);
    }
  }

  if (reactionsSupported && chatFilterClause) {
    const perChatSql = `
      SELECT
        cmj.chat_id AS chatId,
        COUNT(m.ROWID) AS reactionCount,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${buildWhereClause(...reactionFilterClauses, chatFilterClause)}
      GROUP BY cmj.chat_id
    `;

    const perChatStmt = db.prepare(perChatSql);
    const perChatRows = perChatStmt.all({ ...params, ...chatIdParams }) as {
      chatId: number;
      reactionCount: number | null;
      sentCount: number | null;
      receivedCount: number | null;
    }[];

    for (const row of perChatRows) {
      reactionTotalsByChat.set(row.chatId, {
        reactionCount: row.reactionCount ?? 0,
        sentCount: row.sentCount ?? 0,
        receivedCount: row.receivedCount ?? 0,
      });
    }

    const reactionParticipantsSql = `
      SELECT
        cmj.chat_id AS chatId,
        h.id AS handleId,
        ${participantDisplayColumn} AS handleDisplayName,
        m.is_from_me AS isFromMe,
        COUNT(m.ROWID) AS reactionCount
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      ${buildWhereClause(...reactionFilterClauses, chatFilterClause)}
      GROUP BY ${groupByColumns}
    `;

    const reactionParticipantsStmt = db.prepare(reactionParticipantsSql);
    const reactionParticipantRows = reactionParticipantsStmt.all({ ...params, ...chatIdParams }) as {
      chatId: number;
      handleId: string | null;
      handleDisplayName: string | null;
      isFromMe: number;
      reactionCount: number;
    }[];

    const reactionParticipantAggregates = new Map<number, Map<string, ChatReactionParticipantStats>>();

    for (const row of reactionParticipantRows) {
      const aggregateForChat =
        reactionParticipantAggregates.get(row.chatId) ?? new Map<string, ChatReactionParticipantStats>();
      if (!reactionParticipantAggregates.has(row.chatId)) {
        reactionParticipantAggregates.set(row.chatId, aggregateForChat);
      }

      const isFromMe = row.isFromMe === 1;
      const contactInfo = row.handleId ? getContactInfoForHandle(row.handleId) : null;
      const normalizedHandle = row.handleId ? normalizeHandleIdentifier(row.handleId) : null;

      const aggregateKey = isFromMe
        ? "me"
        : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact:${contactInfo.recordId}`
          : normalizedHandle
            ? `handle:${normalizedHandle}`
            : row.handleId
              ? `raw:${row.handleId}`
              : `unknown:${row.chatId}`;

      const participantId = isFromMe
        ? "me"
        : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact-${contactInfo.recordId}`
          : normalizedHandle ?? row.handleId ?? `chat-${row.chatId}-unknown`;

      const selfPreferredName =
        contactInfo?.name && contactInfo.name.toLowerCase() !== "me" ? contactInfo.name : "You";
      const preferredName = isFromMe
        ? selfPreferredName
        : contactInfo?.name ??
          (row.handleDisplayName && row.handleDisplayName !== row.handleId ? row.handleDisplayName : null) ??
          row.handleId;

      const existing = aggregateForChat.get(aggregateKey);
      if (existing) {
        existing.reactionCount += row.reactionCount;
        continue;
      }

      aggregateForChat.set(aggregateKey, {
        id: participantId ?? aggregateKey,
        displayName: preferredName,
        reactionCount: row.reactionCount,
        isMe: isFromMe,
      });
    }

    for (const [chatId, aggregate] of reactionParticipantAggregates.entries()) {
      const sorted = Array.from(aggregate.values()).sort(
        (a, b) => b.reactionCount - a.reactionCount || (a.displayName ?? "").localeCompare(b.displayName ?? ""),
      );
      reactionParticipantsByChat.set(chatId, sorted);
    }
  }

  const topChats: ChatSummary[] = topChatsRows.map((row) => {
    const participantNames = collectParticipants(row.participants);
    const derivedName =
      participantNames.length === 1
        ? participantNames[0]
        : row.chatDisplayName ?? (participantNames.length > 0 ? participantNames.join(", ") : null);
    const isGroup =
      participantNames.length > 0 ? participantNames.length > 1 : row.participantCount > 1;

    const chatReactions: ReactionTotals =
      reactionTotalsByChat.get(row.chatId) ?? {
        reactionCount: 0,
        sentCount: 0,
        receivedCount: 0,
      };
    const chatReactionParticipants = reactionParticipantsByChat.get(row.chatId) ?? [];

    return {
      chatId: row.chatId,
      chatDisplayName: derivedName,
      isGroup,
      participants: participantNames,
      messageCount: row.messageCount,
      sentCount: row.sentCount,
      receivedCount: row.receivedCount,
      lastMessageAt: fromAppleTimestamp(row.lastMessageDate),
      reactions: chatReactions,
      reactionParticipants: chatReactionParticipants,
      messageParticipants: messageParticipantsByChat.get(row.chatId) ?? [],
    };
  });

  const participantAggregate = new Map<string, ChatParticipantStats>();
  for (const row of participantsRows) {
    if (!row.handleId) {
      continue;
    }

    const normalizedHandle = normalizeHandleIdentifier(row.handleId);
    const contactInfo = getContactInfoForHandle(row.handleId);
    const preferredName =
      contactInfo?.name ??
      (row.handleDisplayName && row.handleDisplayName !== row.handleId ? row.handleDisplayName : null) ??
      row.handleId;
    const aggregateKey =
      contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
        ? `contact:${contactInfo.recordId}`
        : normalizedHandle
          ? `handle:${normalizedHandle}`
          : `raw:${row.handleId}`;

    const existing = participantAggregate.get(aggregateKey);
    if (existing) {
      existing.messageCount += row.messageCount;
      existing.sentCount += row.sentCount;
      existing.receivedCount += row.receivedCount;
      if (!existing.displayName && preferredName) {
        existing.displayName = preferredName;
      }
      continue;
    }

    participantAggregate.set(aggregateKey, {
      id:
        contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact-${contactInfo.recordId}`
          : normalizedHandle ?? row.handleId,
      displayName: preferredName,
      messageCount: row.messageCount,
      sentCount: row.sentCount,
      receivedCount: row.receivedCount,
    });
  }

  const participantBreakdown: ChatParticipantStats[] = Array.from(participantAggregate.values())
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, limit);

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
    totals,
    reactionTotals,
    latestMessageAt,
  };
}
