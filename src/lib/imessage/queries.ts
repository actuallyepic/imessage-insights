import type { Database as BetterSqliteDatabase, Statement } from "better-sqlite3";
import { Unarchiver } from "node-typedstream";
import {
  getContactInfoForHandle,
  getContactNameForHandle,
  getHandleIdentifiersForContactRecord,
  normalizeHandleIdentifier,
} from "../contacts";
import { REPLY_WINDOW_SECONDS, SESSION_GAP_SECONDS } from "./constants";
import { getDatabase } from "./db";
import { fromAppleTimestamp } from "./dates";
import {
  type AttachmentStats,
  REACTION_TYPES,
  type ChatParticipantStats,
  type ChatReactionParticipantStats,
  type ChatSummary,
  type ConversationStats,
  type DoubleTextStats,
  type DailyCount,
  type HourlyCount,
  type MessageSearchMode,
  type ReactionCountSummary,
  type ReactionTotals,
  type ReactionType,
  type ResponseStats,
  type ResponseDirectionStats,
  type SearchOptions,
  type SearchResultMessage,
  type SessionStarterStats,
  type UnansweredStarterStats,
  type WeekdayCount,
} from "./types";

let cachedFtsSupport: boolean | null = null;
let cachedHandleDisplayName: boolean | null = null;
let cachedMessageDeletionFlag: boolean | null = null;
type ReactionColumnSupport = {
  hasAssociatedGuid: boolean;
  hasAssociatedType: boolean;
} | null;
let cachedReactionColumnSupport: ReactionColumnSupport = null;
let cachedAttachmentSupport: boolean | null = null;
let cachedMessageDateScale: number | null = null;
let cachedAttributedBodySupport: boolean | null = null;

function detectMessageDateScale(db: BetterSqliteDatabase): number {
  if (cachedMessageDateScale !== null) {
    return cachedMessageDateScale;
  }

  try {
    const row = db
      .prepare("SELECT date FROM message WHERE date IS NOT NULL ORDER BY date DESC LIMIT 1")
      .get() as { date?: number | null } | undefined;
    const sample = typeof row?.date === "number" ? row.date : 0;
    const abs = Math.abs(sample);

    // Most modern macOS versions store nanoseconds since 2001; older stores use seconds.
    // Some intermediate builds may store microseconds.
    cachedMessageDateScale = abs > 1e15 ? 1_000_000_000 : abs > 1e12 ? 1_000_000 : 1;
  } catch (error) {
    console.warn("Unable to detect message timestamp scale:", error);
    cachedMessageDateScale = 1_000_000_000;
  }

  return cachedMessageDateScale;
}

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

function detectAttachmentSupport(db: BetterSqliteDatabase): boolean {
  if (cachedAttachmentSupport !== null) {
    return cachedAttachmentSupport;
  }

  try {
    const stmt: Statement = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('attachment', 'message_attachment_join')",
    );
    const rows = stmt.all() as { name: string }[];
    const tableNames = rows.map((row) => row.name);
    cachedAttachmentSupport = tableNames.includes("attachment") && tableNames.includes("message_attachment_join");
  } catch (error) {
    console.warn("Unable to detect attachment tables:", error);
    cachedAttachmentSupport = false;
  }

  return cachedAttachmentSupport;
}

function detectAttributedBodySupport(db: BetterSqliteDatabase): boolean {
  if (cachedAttributedBodySupport !== null) {
    return cachedAttributedBodySupport;
  }

  try {
    const stmt: Statement = db.prepare("PRAGMA table_info(message)");
    const rows = stmt.all() as { name: string }[];
    cachedAttributedBodySupport = rows.some((row) => row.name === "attributedBody");
  } catch (error) {
    console.warn("Unable to inspect message table columns for attributedBody:", error);
    cachedAttributedBodySupport = false;
  }

  return cachedAttributedBodySupport;
}

const REACTION_TYPE_CODE_LOOKUP: Record<number, ReactionType> = {
  2000: "love",
  2001: "like",
  2002: "dislike",
  2003: "laugh",
  2004: "emphasize",
  2005: "question",
};

type ReactionCountsRow = {
  reactionCount: number | null;
  sentCount: number | null;
  receivedCount: number | null;
};

type AttachmentCountRow = {
  isFromMe: number;
  handleId: string | null;
  handleDisplayName: string | null;
  attachmentCount: number | null;
};

function createReactionCountSummary(): ReactionCountSummary {
  return {
    reactionCount: 0,
    sentCount: 0,
    receivedCount: 0,
  };
}

function createReactionBreakdown(): Record<ReactionType, ReactionCountSummary> {
  const breakdown = {} as Record<ReactionType, ReactionCountSummary>;
  for (const type of REACTION_TYPES) {
    breakdown[type] = createReactionCountSummary();
  }
  return breakdown;
}

function createEmptyReactionTotals(): ReactionTotals {
  return {
    ...createReactionCountSummary(),
    byType: createReactionBreakdown(),
  };
}

function accumulateReactionCounts(target: ReactionCountSummary, row: ReactionCountsRow) {
  target.reactionCount += row.reactionCount ?? 0;
  target.sentCount += row.sentCount ?? 0;
  target.receivedCount += row.receivedCount ?? 0;
}

function mapReactionTypeCode(code: number | null | undefined): ReactionType | null {
  if (code === null || code === undefined) {
    return null;
  }
  return REACTION_TYPE_CODE_LOOKUP[Math.abs(code)] ?? null;
}

function buildFtsQuery(input: string, mode: MessageSearchMode): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  if (mode === "phrase") {
    return `"${trimmed.replace(/\"/g, "\"\"")}"`;
  }

  // If the user provides explicit operators or quotes, pass through.
  if (/[\"'()]/.test(trimmed) || /\b(AND|OR|NOT|NEAR)\b/i.test(trimmed)) {
    return trimmed;
  }

  const joiner = mode === "fuzzy" ? " OR " : " AND ";
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
    .join(joiner);
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
    query = "",
    mode = "smart",
    sender,
    chatId,
    limit = 50,
    offset = 0,
    includeFromMe = true,
    includeFromOthers = true,
    dateRange,
  } = options;

  const trimmedQuery = query.trim();
  const trimmedSender = sender?.trim() ?? "";

  if (!trimmedQuery && !trimmedSender && typeof chatId !== "number") {
    return [];
  }

  const ftsSupported = detectFtsSupport(db);
  const hasDisplayName = detectHandleDisplayName(db);
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const reactionColumnSupport = detectReactionColumns(db);
  const reactionsSupported =
    reactionColumnSupport.hasAssociatedGuid && reactionColumnSupport.hasAssociatedType;

  const params: Record<string, unknown> = {
    limit,
    offset,
    dateScale: detectMessageDateScale(db),
  };

  const whereClauses: string[] = [];
  if (hasDeletionFlag) {
    whereClauses.push("m.is_deleted = 0");
  }

  if (reactionsSupported) {
    whereClauses.push(
      "(m.associated_message_guid IS NULL OR ABS(m.associated_message_type) NOT BETWEEN 2000 AND 2005)",
    );
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

  if (trimmedSender) {
    params.senderLike = `%${trimmedSender.toLowerCase()}%`;
    whereClauses.push("m.is_from_me = 0");
    whereClauses.push(
      hasDisplayName
        ? "LOWER(COALESCE(sh.display_name, sh.id)) LIKE @senderLike"
        : "LOWER(sh.id) LIKE @senderLike",
    );
  }

  const isAdvancedFtsQuery = /[\"'()]/.test(trimmedQuery) || /\b(AND|OR|NOT|NEAR)\b/i.test(trimmedQuery);
  let ftsQuery = "";

  if (trimmedQuery) {
    if (mode === "exact") {
      whereClauses.push("m.text IS NOT NULL");
      params.exactQuery = trimmedQuery;
      whereClauses.push("m.text = @exactQuery");
    } else if (mode === "contains" || (mode === "phrase" && !ftsSupported)) {
      whereClauses.push("m.text IS NOT NULL");
      params.queryLower = trimmedQuery.toLowerCase();
      whereClauses.push("instr(LOWER(m.text), @queryLower) > 0");
    } else {
      const desiredFtsQuery = buildFtsQuery(trimmedQuery, mode);
      if (ftsSupported && desiredFtsQuery) {
        ftsQuery = desiredFtsQuery;
        whereClauses.push("fts MATCH @ftsQuery");
        params.ftsQuery = ftsQuery;
      } else {
        whereClauses.push("m.text IS NOT NULL");
        if (isAdvancedFtsQuery) {
          params.queryLower = trimmedQuery.toLowerCase();
          whereClauses.push("instr(LOWER(m.text), @queryLower) > 0");
        } else {
          const tokens = trimmedQuery
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean)
            .map((token) => token.toLowerCase());
          if (tokens.length === 0) {
            params.queryLower = trimmedQuery.toLowerCase();
            whereClauses.push("instr(LOWER(m.text), @queryLower) > 0");
          } else if (mode === "fuzzy") {
            const tokenClauses: string[] = [];
            tokens.forEach((token, index) => {
              const key = `token${index}`;
              params[key] = token;
              tokenClauses.push(`instr(LOWER(m.text), @${key}) > 0`);
            });
            whereClauses.push(`(${tokenClauses.join(" OR ")})`);
          } else {
            tokens.forEach((token, index) => {
              const key = `token${index}`;
              params[key] = token;
              whereClauses.push(`instr(LOWER(m.text), @${key}) > 0`);
            });
          }
        }
      }
    }
  }

  if (dateRange?.start) {
    params.startSeconds = Math.floor(dateRange.start.getTime() / 1000);
    whereClauses.push("m.date >= ((@startSeconds - 978307200) * @dateScale)");
  }

  if (dateRange?.end) {
    params.endSeconds = Math.ceil(dateRange.end.getTime() / 1000);
    whereClauses.push("m.date <= ((@endSeconds - 978307200) * @dateScale)");
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const senderDisplayColumn = hasDisplayName ? "sh.display_name" : "NULL";

  const baseSql = `
    SELECT
      m.ROWID AS messageId,
      c.ROWID AS chatId,
      c.display_name AS chatDisplayName,
      GROUP_CONCAT(DISTINCT h.id) AS participants,
      MAX(sh.id) AS senderHandleId,
      MAX(${senderDisplayColumn}) AS senderHandleDisplayName,
      m.text AS text,
      m.is_from_me AS isFromMe,
      m.date AS sentDate
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle sh ON sh.ROWID = m.handle_id
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
      senderHandleId: string | null;
      senderHandleDisplayName: string | null;
      text: string | null;
      isFromMe: number;
      sentDate: number | null;
    }[];

    return rows.map((row) => {
      const participantNames = collectParticipants(row.participants);
      const derivedName =
        row.chatDisplayName ?? (participantNames.length === 1 ? participantNames[0] : null);

      const isFromMe = row.isFromMe === 1;
      const senderHandleId = row.senderHandleId;
      const senderContactInfo = !isFromMe && senderHandleId ? getContactInfoForHandle(senderHandleId) : null;
      const normalizedSenderHandle = senderHandleId ? normalizeHandleIdentifier(senderHandleId) ?? senderHandleId : null;
      const senderId = isFromMe
        ? "me"
        : senderContactInfo?.recordId !== null && senderContactInfo?.recordId !== undefined
          ? `contact-${senderContactInfo.recordId}`
          : normalizedSenderHandle;
      const senderDisplayName = isFromMe
        ? "You"
        : senderContactInfo?.name ??
          (row.senderHandleDisplayName && row.senderHandleDisplayName !== senderHandleId
            ? row.senderHandleDisplayName
            : null) ??
          senderHandleId;

      return {
        messageId: row.messageId,
        chatId: row.chatId,
        chatDisplayName: derivedName,
        participants: participantNames,
        senderId: senderId ?? null,
        senderDisplayName: senderDisplayName ?? null,
        senderHandle: senderHandleId ?? null,
        text: row.text,
        isFromMe,
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

export type PersonTimelineBucket = "hour" | "day" | "week" | "month";

export interface PersonMessageTimelinePoint {
  bucket: string;
  fromMeCount: number;
  fromThemCount: number;
  totalCount: number;
}

export interface PersonMessageTimeline {
  bucket: PersonTimelineBucket;
  points: PersonMessageTimelinePoint[];
}

export interface PersonMessageTimelineOptions {
  personKey: string;
  bucket?: PersonTimelineBucket;
  dateRange?: { start?: Date; end?: Date };
}

export interface StatsOptions {
  limit?: number;
  dateRange?: { start?: Date; end?: Date };
}

export interface ChatSummaryOptions {
  dateRange?: { start?: Date; end?: Date };
}

export interface ChatToneBucket {
  positive: number;
  neutral: number;
  negative: number;
  averageScore: number | null;
}

export interface ChatTextStyleSideStats {
  messageCount: number;
  avgChars: number | null;
  medianChars: number | null;
  p90Chars: number | null;
  avgWords: number | null;
  medianWords: number | null;
  emojiPerMessage: number | null;
  multiLineRate: number | null;
  avgLines: number | null;
  capsRatio: number | null;
  allCapsRate: number | null;
  affirmativeRate: number | null;
  negativeRate: number | null;
  avgRunLength: number | null;
  multiMessageRunRate: number | null;
  tone: ChatToneBucket;
}

export interface ChatTextStyleSummary {
  chatId: number;
  totalMessagesAnalyzed: number;
  me: ChatTextStyleSideStats;
  others: ChatTextStyleSideStats;
}

export interface ChatTextStyleOptions {
  dateRange?: { start?: Date; end?: Date };
}

const DAY_BUCKET_EXPR = `date((m.date / @dateScale) + 978307200, 'unixepoch', 'localtime')`;
const MESSAGE_SECONDS_EXPR = `(m.date / @dateScale) + 978307200`;

const EMOJI_REGEX = /[\p{Extended_Pictographic}]/gu;
const LETTER_REGEX = /\p{L}/gu;
const UPPER_LETTER_REGEX = /\p{Lu}/gu;
const WORD_REGEX = /[\p{L}']+/gu;

const POSITIVE_WORDS = new Set([
  "love",
  "loved",
  "like",
  "liked",
  "great",
  "awesome",
  "amazing",
  "good",
  "nice",
  "thanks",
  "thank",
  "thx",
  "yay",
  "lol",
  "haha",
  "perfect",
  "cool",
  "sweet",
  "excited",
  "fun",
  "beautiful",
  "wonderful",
  "best",
  "congrats",
  "congratulations",
  "proud",
  "happy",
]);

const NEGATIVE_WORDS = new Set([
  "hate",
  "hated",
  "bad",
  "terrible",
  "awful",
  "sad",
  "sorry",
  "angry",
  "annoyed",
  "upset",
  "worst",
  "sucks",
  "sucked",
  "ugh",
  "wtf",
  "no",
  "nope",
  "nah",
  "cant",
  "can't",
  "cannot",
  "wont",
  "won't",
  "never",
]);

const POSITIVE_EMOJI_REGEX = /(?:❤️|❤|😍|😊|😄|😁|😂|🤣|🙂|🙌|👍|🎉|😎|🥰|😇|☺️)/gu;
const NEGATIVE_EMOJI_REGEX = /(?:😢|😭|😡|😠|☹️|🙁|😞|😩|😫|👎|😒|😓|😤|😔)/gu;

const AFFIRMATIVE_PREFIXES = ["sounds good", "sound good", "for sure", "of course"];

const AFFIRMATIVE_WORDS = new Set([
  "yes",
  "yeah",
  "yep",
  "yup",
  "ya",
  "ok",
  "okay",
  "k",
  "kk",
  "sure",
  "cool",
  "great",
  "awesome",
  "perfect",
  "done",
  "deal",
  "totally",
  "absolutely",
  "definitely",
]);

const NEGATIVE_FIRST_WORDS = new Set([
  "no",
  "nope",
  "nah",
  "never",
  "cant",
  "can't",
  "cannot",
  "wont",
  "won't",
]);

function countMatches(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text)) {
    count += 1;
  }
  return count;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (sorted.length - 1) * clamped;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base] === undefined) return null;
  const next = sorted[base + 1];
  if (next === undefined) return sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

function hasAllCapsWord(text: string): boolean {
  const parts = text.split(/\s+/);
  for (const part of parts) {
    const cleaned = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (cleaned.length < 3) continue;
    const upper = cleaned.toUpperCase();
    const lower = cleaned.toLowerCase();
    if (cleaned === upper && cleaned !== lower) return true;
  }
  return false;
}

function classifyAffirmation(text: string): "affirmative" | "negative" | "neutral" {
  const normalized = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "")
    .toLowerCase();

  if (!normalized) return "neutral";

  for (const prefix of AFFIRMATIVE_PREFIXES) {
    if (normalized.startsWith(prefix)) return "affirmative";
  }

  const firstMatch = normalized.match(WORD_REGEX);
  const first = firstMatch?.[0] ?? "";
  if (!first) return "neutral";
  if (AFFIRMATIVE_WORDS.has(first)) return "affirmative";
  if (NEGATIVE_FIRST_WORDS.has(first)) return "negative";
  return "neutral";
}

function scoreSentiment(text: string): { score: number; bucket: "positive" | "neutral" | "negative" } {
  let posWords = 0;
  let negWords = 0;
  WORD_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_REGEX.exec(text))) {
    const token = match[0]?.toLowerCase();
    if (!token) continue;
    if (POSITIVE_WORDS.has(token)) posWords += 1;
    if (NEGATIVE_WORDS.has(token)) negWords += 1;
  }

  const posEmoji = countMatches(POSITIVE_EMOJI_REGEX, text);
  const negEmoji = countMatches(NEGATIVE_EMOJI_REGEX, text);

  const score = posWords + posEmoji - negWords - negEmoji;
  const bucket = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { score, bucket };
}

function normalizeAnalyzedText(text: string): string | null {
  const cleaned = text
    .replace(/\u0000/g, "")
    .replace(/\uFFFC/g, "")
    .replace(/\u2028/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function extractTextFromAttributedBody(blob: Buffer): string | null {
  if (!blob || blob.length === 0) return null;

  try {
    const unarchiver = Unarchiver.open(blob, Unarchiver.BinaryDecoding.none);
    const decoded = unarchiver.decodeAll();

    const stack: unknown[] = [decoded];
    let best: string | null = null;

    while (stack.length > 0) {
      const value = stack.pop();
      if (!value) continue;

      if (typeof value === "string") {
        const normalized = normalizeAnalyzedText(value);
        if (normalized && (!best || normalized.length > best.length)) {
          best = normalized;
        }
        continue;
      }

      if (Array.isArray(value)) {
        stack.push(...value);
        continue;
      }

      if (typeof value !== "object") {
        continue;
      }

      const asRecord = value as Record<string, unknown>;
      const directString = asRecord.string;
      if (typeof directString === "string") {
        const normalized = normalizeAnalyzedText(directString);
        if (normalized && (!best || normalized.length > best.length)) {
          best = normalized;
        }
      }

      const maybeValues = asRecord.values;
      if (Array.isArray(maybeValues)) {
        stack.push(...maybeValues);
      }

      const maybeContents = asRecord.contents;
      if (Array.isArray(maybeContents)) {
        stack.push(...maybeContents);
      } else if (maybeContents instanceof Map) {
        stack.push(...maybeContents.keys(), ...maybeContents.values());
      }

      const maybeElements = asRecord.elements;
      if (Array.isArray(maybeElements)) {
        stack.push(...maybeElements);
      }
    }

    return best;
  } catch {
    // Some attributedBody values can be corrupt/unsupported; ignore them for analytics.
    return null;
  }
}

function chooseTimelineBucket(options: { bucket?: PersonTimelineBucket; start?: Date; end?: Date }): PersonTimelineBucket {
  if (options.bucket) return options.bucket;

  const start = options.start;
  const end = options.end;
  if (!start || !end) return "month";

  const diffSeconds = (end.getTime() - start.getTime()) / 1000;
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) return "day";

  if (diffSeconds <= 48 * 60 * 60) return "hour";
  if (diffSeconds <= 90 * 24 * 60 * 60) return "day";
  if (diffSeconds <= 365 * 24 * 60 * 60) return "week";
  return "month";
}

function resolvePersonHandles(personKey: string): string[] {
  const trimmed = personKey.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("contact-")) {
    const recordId = Number(trimmed.slice("contact-".length));
    if (!Number.isFinite(recordId)) return [];
    return getHandleIdentifiersForContactRecord(recordId);
  }

  const normalized = normalizeHandleIdentifier(trimmed) ?? trimmed;
  return normalized ? [normalized] : [];
}

export function getPersonMessageTimeline(options: PersonMessageTimelineOptions): PersonMessageTimeline {
  const db = getDatabase();
  const dateScale = detectMessageDateScale(db);
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const reactionColumnSupport = detectReactionColumns(db);
  const reactionsSupported = reactionColumnSupport.hasAssociatedGuid && reactionColumnSupport.hasAssociatedType;

  const handles = resolvePersonHandles(options.personKey);
  if (handles.length === 0) {
    return { bucket: options.bucket ?? "day", points: [] };
  }

  const start = options.dateRange?.start;
  const end = options.dateRange?.end;
  const bucket = chooseTimelineBucket({ bucket: options.bucket, start, end });

  const params: Record<string, unknown> = {
    dateScale,
  };

  handles.forEach((handle, index) => {
    params[`handle${index}`] = handle;
  });
  const handlePlaceholders = handles.map((_, index) => `@handle${index}`).join(", ");

  const whereClauses: string[] = ["m.date IS NOT NULL"];
  if (hasDeletionFlag) {
    whereClauses.push("m.is_deleted = 0");
  }
  if (reactionsSupported) {
    whereClauses.push(
      "(m.associated_message_guid IS NULL OR ABS(m.associated_message_type) NOT BETWEEN 2000 AND 2005)",
    );
  }

  if (start) {
    params.startSeconds = Math.floor(start.getTime() / 1000);
    whereClauses.push("m.date >= ((@startSeconds - 978307200) * @dateScale)");
  }

  if (end) {
    params.endSeconds = Math.ceil(end.getTime() / 1000);
    whereClauses.push("m.date <= ((@endSeconds - 978307200) * @dateScale)");
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const bucketExpr =
    bucket === "hour"
      ? `strftime('%Y-%m-%d %H:00', datetime(${MESSAGE_SECONDS_EXPR}, 'unixepoch', 'localtime'))`
      : bucket === "week"
        ? `date(datetime(${MESSAGE_SECONDS_EXPR}, 'unixepoch', 'localtime'), 'weekday 0', '-6 days')`
        : bucket === "month"
          ? `strftime('%Y-%m', datetime(${MESSAGE_SECONDS_EXPR}, 'unixepoch', 'localtime'))`
          : DAY_BUCKET_EXPR;

  const sql = `
    WITH relevant_chats AS (
      SELECT DISTINCT chj.chat_id AS chatId
      FROM chat_handle_join chj
      JOIN handle h ON h.ROWID = chj.handle_id
      WHERE h.id IN (${handlePlaceholders})
      UNION
      SELECT DISTINCT cmj.chat_id AS chatId
      FROM chat_message_join cmj
      JOIN message m2 ON m2.ROWID = cmj.message_id
      JOIN handle h2 ON h2.ROWID = m2.handle_id
      WHERE h2.id IN (${handlePlaceholders})
    )
    SELECT
      ${bucketExpr} AS bucket,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS fromMeCount,
      SUM(CASE WHEN m.is_from_me = 0 AND sender.id IN (${handlePlaceholders}) THEN 1 ELSE 0 END) AS fromThemCount
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN relevant_chats rc ON rc.chatId = cmj.chat_id
    LEFT JOIN handle sender ON sender.ROWID = m.handle_id
    ${whereSql}
      AND (m.is_from_me = 1 OR sender.id IN (${handlePlaceholders}))
    GROUP BY bucket
    HAVING bucket IS NOT NULL
    ORDER BY bucket ASC
  `;

  const stmt = db.prepare(sql);
  const rows = stmt.all(params) as Array<{
    bucket: string | null;
    fromMeCount: number | null;
    fromThemCount: number | null;
  }>;

  const points: PersonMessageTimelinePoint[] = rows
    .filter((row) => Boolean(row.bucket))
    .map((row) => {
      const fromMeCount = row.fromMeCount ?? 0;
      const fromThemCount = row.fromThemCount ?? 0;
      return {
        bucket: row.bucket as string,
        fromMeCount,
        fromThemCount,
        totalCount: fromMeCount + fromThemCount,
      };
    });

  return { bucket, points };
}

function createEmptyResponseDirectionStats(): ResponseDirectionStats {
  return {
    averageSeconds: null,
    medianSeconds: null,
    p90Seconds: null,
    minSeconds: null,
    maxSeconds: null,
    sampleCount: 0,
  };
}

function createEmptyResponseStats(): ResponseStats {
  return {
    meResponding: createEmptyResponseDirectionStats(),
    themResponding: createEmptyResponseDirectionStats(),
  };
}

export function getConversationStats(options: StatsOptions = {}): ConversationStats {
  const db = getDatabase();
  const { limit = 15, dateRange } = options;
  const dateScale = detectMessageDateScale(db);
  const hasDisplayName = detectHandleDisplayName(db);
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const reactionColumnSupport = detectReactionColumns(db);
  const reactionsSupported =
    reactionColumnSupport.hasAssociatedGuid && reactionColumnSupport.hasAssociatedType;
  const attachmentsSupported = detectAttachmentSupport(db);
  const participantLimit = Math.max(limit * 3, limit);

  const analysisStartSeconds = dateRange?.start ? Math.floor(dateRange.start.getTime() / 1000) : null;
  const analysisEndSeconds = Math.floor((dateRange?.end ?? new Date()).getTime() / 1000);
  const lookbackStartSeconds =
    analysisStartSeconds !== null ? analysisStartSeconds - SESSION_GAP_SECONDS : null;
  const replyCutoffSeconds = analysisEndSeconds - REPLY_WINDOW_SECONDS;

  const params: Record<string, unknown> = {
    limit,
    participantLimit,
    sessionGap: SESSION_GAP_SECONDS,
    replyWindow: REPLY_WINDOW_SECONDS,
    analysisStartSeconds,
    analysisEndSeconds,
    lookbackStartSeconds,
    replyCutoffSeconds,
    dateScale,
  };
  const messageWhere: string[] = [];
  if (hasDeletionFlag) {
    messageWhere.push("m.is_deleted = 0");
  }

  if (dateRange?.start) {
    params.startSeconds = analysisStartSeconds;
    messageWhere.push("m.date >= ((@startSeconds - 978307200) * @dateScale)");
  }

  if (dateRange?.end) {
    params.endSeconds = analysisEndSeconds;
    messageWhere.push("m.date <= ((@endSeconds - 978307200) * @dateScale)");
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
        MIN(m.date) AS firstMessageDate,
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
      ms.firstMessageDate,
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

  const earliestSql = `
    SELECT
      MIN(m.date) AS earliestMessageDate
    FROM message m
    ${messageWhereSql}
  `;

  const reactionTotalsSql = reactionsSupported
    ? `
    SELECT
      ABS(m.associated_message_type) AS reactionType,
      COUNT(m.ROWID) AS reactionCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    ${buildWhereClause(...reactionFilterClauses)}
    GROUP BY reactionType
  `
    : null;
  const attachmentsSql = attachmentsSupported
    ? `
    SELECT
      m.is_from_me AS isFromMe,
      h.id AS handleId,
      ${participantDisplayColumn} AS handleDisplayName,
      COUNT(maj.attachment_id) AS attachmentCount
    FROM message m
    JOIN message_attachment_join maj ON maj.message_id = m.ROWID
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    ${buildWhereClause()}
    GROUP BY m.is_from_me, h.id
    HAVING attachmentCount > 0
    ORDER BY attachmentCount DESC
  `
    : null;
  const sessionFilters: string[] = [];
  if (hasDeletionFlag) {
    sessionFilters.push("m.is_deleted = 0");
  }
  sessionFilters.push("m.date IS NOT NULL");
  sessionFilters.push("m.date <= ((@analysisEndSeconds - 978307200) * @dateScale)");
  sessionFilters.push(
    "(@lookbackStartSeconds IS NULL OR m.date >= ((@lookbackStartSeconds - 978307200) * @dateScale))",
  );
  if (reactionsSupported) {
    sessionFilters.push(
      "(m.associated_message_guid IS NULL OR ABS(m.associated_message_type) NOT BETWEEN 2000 AND 2005)",
    );
  }
  const sessionMessageWhereSql = sessionFilters.length ? `WHERE ${sessionFilters.join(" AND ")}` : "";

  const sessionMetricsSql = `
    WITH messages AS (
      SELECT
        cmj.chat_id AS chatId,
        m.ROWID AS messageId,
        m.is_from_me AS isFromMe,
        ${MESSAGE_SECONDS_EXPR} AS messageSeconds
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${sessionMessageWhereSql}
    ),
    ordered AS (
      SELECT
        chatId,
        messageId,
        isFromMe,
        messageSeconds,
        LAG(messageSeconds) OVER (PARTITION BY chatId ORDER BY messageSeconds, messageId) AS prevSeconds,
        MIN(CASE WHEN isFromMe = 1 THEN messageSeconds END) OVER (
          PARTITION BY chatId
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextMeSeconds,
        MIN(CASE WHEN isFromMe = 0 THEN messageSeconds END) OVER (
          PARTITION BY chatId
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextThemSeconds
      FROM messages
    ),
    session_starts AS (
      SELECT
        chatId,
        messageSeconds AS sessionStart,
        isFromMe AS starterIsMe,
        CASE
          WHEN prevSeconds IS NULL OR messageSeconds - prevSeconds > @sessionGap THEN 1
          ELSE 0
        END AS isSessionStart,
        nextMeSeconds,
        nextThemSeconds
      FROM ordered
    ),
    starts_in_range AS (
      SELECT
        chatId,
        sessionStart,
        starterIsMe,
        CASE WHEN starterIsMe = 1 THEN nextThemSeconds ELSE nextMeSeconds END AS replyAt,
        CASE WHEN starterIsMe = 1 THEN nextMeSeconds ELSE nextThemSeconds END AS nextFromStarter
      FROM session_starts
      WHERE isSessionStart = 1
        AND (@analysisStartSeconds IS NULL OR sessionStart >= @analysisStartSeconds)
        AND sessionStart <= @analysisEndSeconds
    ),
    evaluated AS (
      SELECT
        chatId,
        sessionStart,
        starterIsMe,
        CASE
          WHEN replyAt IS NOT NULL AND replyAt - sessionStart <= @replyWindow THEN replyAt
          ELSE NULL
        END AS replyAtWithinWindow,
        nextFromStarter,
        CASE
          WHEN sessionStart <= @replyCutoffSeconds THEN 1
          ELSE 0
        END AS isEvaluable
      FROM starts_in_range
    )
    SELECT
      chatId,
      SUM(CASE WHEN starterIsMe = 1 THEN 1 ELSE 0 END) AS startedByMe,
      SUM(CASE WHEN starterIsMe = 0 THEN 1 ELSE 0 END) AS startedByOthers,
      SUM(
        CASE
          WHEN isEvaluable = 1 AND starterIsMe = 1 AND replyAtWithinWindow IS NULL THEN 1
          ELSE 0
        END
      ) AS theyLeftYouHanging,
      SUM(
        CASE
          WHEN isEvaluable = 1 AND starterIsMe = 0 AND replyAtWithinWindow IS NULL THEN 1
          ELSE 0
        END
      ) AS youLeftThemHanging,
      SUM(
        CASE
          WHEN isEvaluable = 1
            AND starterIsMe = 1
            AND nextFromStarter IS NOT NULL
            AND nextFromStarter - sessionStart <= @replyWindow
            AND (replyAtWithinWindow IS NULL OR nextFromStarter < replyAtWithinWindow)
          THEN 1
          ELSE 0
        END
      ) AS youDoubleTexted,
      SUM(
        CASE
          WHEN isEvaluable = 1
            AND starterIsMe = 0
            AND nextFromStarter IS NOT NULL
            AND nextFromStarter - sessionStart <= @replyWindow
            AND (replyAtWithinWindow IS NULL OR nextFromStarter < replyAtWithinWindow)
          THEN 1
          ELSE 0
        END
      ) AS theyDoubleTexted
    FROM evaluated
    GROUP BY chatId
  `;

  const firstReplyStatsSql = `
    WITH messages AS (
      SELECT
        cmj.chat_id AS chatId,
        m.ROWID AS messageId,
        m.is_from_me AS isFromMe,
        ${MESSAGE_SECONDS_EXPR} AS messageSeconds
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${sessionMessageWhereSql}
    ),
    ordered AS (
      SELECT
        chatId,
        messageId,
        isFromMe,
        messageSeconds,
        LAG(messageSeconds) OVER (PARTITION BY chatId ORDER BY messageSeconds, messageId) AS prevSeconds,
        MIN(CASE WHEN isFromMe = 1 THEN messageSeconds END) OVER (
          PARTITION BY chatId
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextMeSeconds,
        MIN(CASE WHEN isFromMe = 0 THEN messageSeconds END) OVER (
          PARTITION BY chatId
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextThemSeconds
      FROM messages
    ),
    session_starts AS (
      SELECT
        chatId,
        messageSeconds AS sessionStart,
        isFromMe AS starterIsMe,
        CASE
          WHEN prevSeconds IS NULL OR messageSeconds - prevSeconds > @sessionGap THEN 1
          ELSE 0
        END AS isSessionStart,
        nextMeSeconds,
        nextThemSeconds
      FROM ordered
    ),
    starts_in_range AS (
      SELECT
        chatId,
        sessionStart,
        starterIsMe,
        CASE WHEN starterIsMe = 1 THEN nextThemSeconds ELSE nextMeSeconds END AS replyAt
      FROM session_starts
      WHERE isSessionStart = 1
        AND (@analysisStartSeconds IS NULL OR sessionStart >= @analysisStartSeconds)
        AND sessionStart <= @replyCutoffSeconds
    ),
    replies AS (
      SELECT
        chatId,
        CASE WHEN starterIsMe = 0 THEN 1 ELSE 0 END AS responderIsMe,
        replyAt - sessionStart AS responseSeconds
      FROM starts_in_range
      WHERE replyAt IS NOT NULL
        AND replyAt - sessionStart > 0
        AND replyAt - sessionStart <= @replyWindow
    ),
    ranked AS (
      SELECT
        chatId,
        responderIsMe,
        responseSeconds,
        ROW_NUMBER() OVER (PARTITION BY chatId, responderIsMe ORDER BY responseSeconds) AS rn,
        COUNT(*) OVER (PARTITION BY chatId, responderIsMe) AS cnt
      FROM replies
      UNION ALL
      SELECT
        NULL AS chatId,
        responderIsMe,
        responseSeconds,
        ROW_NUMBER() OVER (PARTITION BY responderIsMe ORDER BY responseSeconds) AS rn,
        COUNT(*) OVER (PARTITION BY responderIsMe) AS cnt
      FROM replies
    )
    SELECT
      chatId,
      responderIsMe,
      MAX(cnt) AS sampleCount,
      AVG(responseSeconds) AS averageSeconds,
      MIN(responseSeconds) AS minSeconds,
      MAX(responseSeconds) AS maxSeconds,
      SUM(
        CASE
          WHEN cnt % 2 = 1 AND rn = (cnt + 1) / 2 THEN responseSeconds
          WHEN cnt % 2 = 0 AND rn IN (cnt / 2, cnt / 2 + 1) THEN responseSeconds / 2.0
          ELSE 0
        END
      ) AS medianSeconds,
      MIN(
        CASE
          WHEN rn = ((cnt * 9 + 9) / 10) THEN responseSeconds
        END
      ) AS p90Seconds
    FROM ranked
    GROUP BY chatId, responderIsMe
  `;

  const inThreadReplyStatsSql = `
    WITH messages AS (
      SELECT
        cmj.chat_id AS chatId,
        m.ROWID AS messageId,
        m.is_from_me AS isFromMe,
        ${MESSAGE_SECONDS_EXPR} AS messageSeconds
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${sessionMessageWhereSql}
    ),
    ordered AS (
      SELECT
        chatId,
        messageId,
        isFromMe,
        messageSeconds,
        LAG(messageSeconds) OVER (PARTITION BY chatId ORDER BY messageSeconds, messageId) AS prevSeconds,
        LAG(isFromMe) OVER (PARTITION BY chatId ORDER BY messageSeconds, messageId) AS prevIsFromMe
      FROM messages
    ),
    replies AS (
      SELECT
        chatId,
        isFromMe AS responderIsMe,
        messageSeconds - prevSeconds AS responseSeconds
      FROM ordered
      WHERE prevSeconds IS NOT NULL
        AND prevIsFromMe IS NOT NULL
        AND prevIsFromMe != isFromMe
        AND messageSeconds - prevSeconds > 0
        AND messageSeconds - prevSeconds <= @sessionGap
        AND (@analysisStartSeconds IS NULL OR messageSeconds >= @analysisStartSeconds)
        AND messageSeconds <= @analysisEndSeconds
    ),
    ranked AS (
      SELECT
        chatId,
        responderIsMe,
        responseSeconds,
        ROW_NUMBER() OVER (PARTITION BY chatId, responderIsMe ORDER BY responseSeconds) AS rn,
        COUNT(*) OVER (PARTITION BY chatId, responderIsMe) AS cnt
      FROM replies
      UNION ALL
      SELECT
        NULL AS chatId,
        responderIsMe,
        responseSeconds,
        ROW_NUMBER() OVER (PARTITION BY responderIsMe ORDER BY responseSeconds) AS rn,
        COUNT(*) OVER (PARTITION BY responderIsMe) AS cnt
      FROM replies
    )
    SELECT
      chatId,
      responderIsMe,
      MAX(cnt) AS sampleCount,
      AVG(responseSeconds) AS averageSeconds,
      MIN(responseSeconds) AS minSeconds,
      MAX(responseSeconds) AS maxSeconds,
      SUM(
        CASE
          WHEN cnt % 2 = 1 AND rn = (cnt + 1) / 2 THEN responseSeconds
          WHEN cnt % 2 = 0 AND rn IN (cnt / 2, cnt / 2 + 1) THEN responseSeconds / 2.0
          ELSE 0
        END
      ) AS medianSeconds,
      MIN(
        CASE
          WHEN rn = ((cnt * 9 + 9) / 10) THEN responseSeconds
        END
      ) AS p90Seconds
    FROM ranked
    GROUP BY chatId, responderIsMe
  `;

  const topChatsStmt = db.prepare(topChatsSql);
  const participantStmt = db.prepare(participantSql);
  const dailyStmt = db.prepare(dailySql);
  const hourlyStmt = db.prepare(hourlySql);
  const weekdayStmt = db.prepare(weekdaySql);
  const totalsStmt = db.prepare(totalsSql);
  const earliestStmt = db.prepare(earliestSql);
  const reactionTotalsStmt = reactionTotalsSql ? db.prepare(reactionTotalsSql) : null;
  const attachmentStmt = attachmentsSql ? db.prepare(attachmentsSql) : null;
  const sessionMetricsStmt = db.prepare(sessionMetricsSql);
  const firstReplyStatsStmt = db.prepare(firstReplyStatsSql);
  const inThreadReplyStatsStmt = db.prepare(inThreadReplyStatsSql);

  const topChatsRows = topChatsStmt.all(params) as {
    chatId: number;
    chatDisplayName: string | null;
    participantCount: number;
    participants: string | null;
    messageCount: number;
    sentCount: number;
    receivedCount: number;
    firstMessageDate: number | null;
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
  const earliestRow = earliestStmt.get(params) as {
    earliestMessageDate: number | null;
  } | undefined;
  const sessionMetricsRows = sessionMetricsStmt.all(params) as Array<{
    chatId: number;
    startedByMe: number | null;
    startedByOthers: number | null;
    theyLeftYouHanging: number | null;
    youLeftThemHanging: number | null;
    youDoubleTexted: number | null;
    theyDoubleTexted: number | null;
  }>;
  const firstReplyStatsRows = firstReplyStatsStmt.all(params) as Array<{
    chatId: number | null;
    responderIsMe: number;
    sampleCount: number | null;
    averageSeconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  }>;
  const inThreadReplyStatsRows = inThreadReplyStatsStmt.all(params) as Array<{
    chatId: number | null;
    responderIsMe: number;
    sampleCount: number | null;
    averageSeconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  }>;
  const totals = {
    messageCount: totalsRow?.messageCount ?? 0,
    sentCount: totalsRow?.sentCount ?? 0,
    receivedCount: totalsRow?.receivedCount ?? 0,
  };
  const reactionTotals: ReactionTotals = createEmptyReactionTotals();
  if (reactionTotalsStmt) {
    const reactionTotalsRows = reactionTotalsStmt.all(params) as Array<
      ReactionCountsRow & { reactionType: number | null }
    >;
    for (const row of reactionTotalsRows) {
      accumulateReactionCounts(reactionTotals, row);
      const mappedType = mapReactionTypeCode(row.reactionType);
      if (mappedType) {
        accumulateReactionCounts(reactionTotals.byType[mappedType], row);
      }
    }
  }
  const attachmentStats: AttachmentStats = {
    totalCount: 0,
    sentCount: 0,
    receivedCount: 0,
    topSender: null,
  };
  if (attachmentStmt) {
    const attachmentRows = attachmentStmt.all(params) as AttachmentCountRow[];
    attachmentRows.forEach((row, index) => {
      const count = row.attachmentCount ?? 0;
      if (count <= 0) {
        return;
      }
      const isFromMe = row.isFromMe === 1;
      attachmentStats.totalCount += count;
      if (isFromMe) {
        attachmentStats.sentCount += count;
      } else {
        attachmentStats.receivedCount += count;
      }

      const contactInfo = row.handleId ? getContactInfoForHandle(row.handleId) : null;
      const contactName = row.handleId ? getContactNameForHandle(row.handleId) : null;
      const normalizedHandle = row.handleId ? normalizeHandleIdentifier(row.handleId) : null;

      const preferredName = isFromMe
        ? (() => {
            const inferred = contactInfo?.name ?? contactName;
            return inferred && inferred.toLowerCase() !== "me" ? inferred : "You";
          })()
        : contactInfo?.name ??
          contactName ??
          (row.handleDisplayName && row.handleDisplayName !== row.handleId ? row.handleDisplayName : null) ??
          row.handleId ??
          "Unknown";

      const participantId = isFromMe
        ? "me"
        : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact-${contactInfo.recordId}`
          : normalizedHandle ?? row.handleId ?? `attachment-participant-${index}`;

      if (!attachmentStats.topSender || count > attachmentStats.topSender.count) {
        attachmentStats.topSender = {
          id: participantId,
          displayName: preferredName,
          count,
          isMe: isFromMe,
        };
      }
    });
  }
  const earliestMessageAt = fromAppleTimestamp(earliestRow?.earliestMessageDate ?? null);
  const latestMessageAt = fromAppleTimestamp(totalsRow?.latestMessageDate ?? null);
  const sessionStarters: SessionStarterStats = { startedByMe: 0, startedByOthers: 0 };
  const unansweredStarters: UnansweredStarterStats = { youLeftThemHanging: 0, theyLeftYouHanging: 0 };
  const doubleTexts: DoubleTextStats = { youDoubleTexted: 0, theyDoubleTexted: 0 };
  const sessionMetricsByChat = new Map<
    number,
    {
      sessionStarters: SessionStarterStats;
      unansweredStarters: UnansweredStarterStats;
      doubleTexts: DoubleTextStats;
    }
  >();

  for (const row of sessionMetricsRows) {
    const starters = {
      startedByMe: row.startedByMe ?? 0,
      startedByOthers: row.startedByOthers ?? 0,
    };
    const unanswered = {
      youLeftThemHanging: row.youLeftThemHanging ?? 0,
      theyLeftYouHanging: row.theyLeftYouHanging ?? 0,
    };
    const doubles = {
      youDoubleTexted: row.youDoubleTexted ?? 0,
      theyDoubleTexted: row.theyDoubleTexted ?? 0,
    };

    sessionStarters.startedByMe += starters.startedByMe;
    sessionStarters.startedByOthers += starters.startedByOthers;
    unansweredStarters.youLeftThemHanging += unanswered.youLeftThemHanging;
    unansweredStarters.theyLeftYouHanging += unanswered.theyLeftYouHanging;
    doubleTexts.youDoubleTexted += doubles.youDoubleTexted;
    doubleTexts.theyDoubleTexted += doubles.theyDoubleTexted;

    sessionMetricsByChat.set(row.chatId, {
      sessionStarters: starters,
      unansweredStarters: unanswered,
      doubleTexts: doubles,
    });
  }

  const firstReplyTimesByChat = new Map<number, ResponseStats>();
  const overallFirstReplyTimes = createEmptyResponseStats();
  for (const row of firstReplyStatsRows) {
    const responderKey = row.responderIsMe === 1 ? "meResponding" : "themResponding";
    const directionStats: ResponseDirectionStats = {
      averageSeconds: row.averageSeconds ?? null,
      medianSeconds: row.medianSeconds ?? null,
      p90Seconds: row.p90Seconds ?? null,
      minSeconds: row.minSeconds ?? null,
      maxSeconds: row.maxSeconds ?? null,
      sampleCount: row.sampleCount ?? 0,
    };
    if (row.chatId === null) {
      overallFirstReplyTimes[responderKey] = directionStats;
      continue;
    }
    const existing = firstReplyTimesByChat.get(row.chatId) ?? createEmptyResponseStats();
    existing[responderKey] = directionStats;
    firstReplyTimesByChat.set(row.chatId, existing);
  }

  const inThreadReplyTimesByChat = new Map<number, ResponseStats>();
  const overallInThreadReplyTimes = createEmptyResponseStats();
  for (const row of inThreadReplyStatsRows) {
    const responderKey = row.responderIsMe === 1 ? "meResponding" : "themResponding";
    const directionStats: ResponseDirectionStats = {
      averageSeconds: row.averageSeconds ?? null,
      medianSeconds: row.medianSeconds ?? null,
      p90Seconds: row.p90Seconds ?? null,
      minSeconds: row.minSeconds ?? null,
      maxSeconds: row.maxSeconds ?? null,
      sampleCount: row.sampleCount ?? 0,
    };
    if (row.chatId === null) {
      overallInThreadReplyTimes[responderKey] = directionStats;
      continue;
    }
    const existing = inThreadReplyTimesByChat.get(row.chatId) ?? createEmptyResponseStats();
    existing[responderKey] = directionStats;
    inThreadReplyTimesByChat.set(row.chatId, existing);
  }
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
        ABS(m.associated_message_type) AS reactionType,
        COUNT(m.ROWID) AS reactionCount,
        SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
        SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${buildWhereClause(...reactionFilterClauses, chatFilterClause)}
      GROUP BY cmj.chat_id, reactionType
    `;

    const perChatStmt = db.prepare(perChatSql);
    const perChatRows = perChatStmt.all({ ...params, ...chatIdParams }) as Array<
      ReactionCountsRow & {
        chatId: number;
        reactionType: number | null;
      }
    >;

    for (const row of perChatRows) {
      const existing = reactionTotalsByChat.get(row.chatId);
      const perChatTotals = existing ?? createEmptyReactionTotals();
      if (!existing) {
        reactionTotalsByChat.set(row.chatId, perChatTotals);
      }
      accumulateReactionCounts(perChatTotals, row);
      const mappedType = mapReactionTypeCode(row.reactionType);
      if (mappedType) {
        accumulateReactionCounts(perChatTotals.byType[mappedType], row);
      }
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

    const chatReactions: ReactionTotals = reactionTotalsByChat.get(row.chatId) ?? createEmptyReactionTotals();
    const chatReactionParticipants = reactionParticipantsByChat.get(row.chatId) ?? [];

    const chatMetrics = sessionMetricsByChat.get(row.chatId);
    const chatSessionStarters = chatMetrics?.sessionStarters ?? { startedByMe: 0, startedByOthers: 0 };
    const chatUnansweredStarters = chatMetrics?.unansweredStarters ?? {
      youLeftThemHanging: 0,
      theyLeftYouHanging: 0,
    };
    const chatDoubleTexts = chatMetrics?.doubleTexts ?? { youDoubleTexted: 0, theyDoubleTexted: 0 };
    const chatFirstReplyTimes = firstReplyTimesByChat.get(row.chatId) ?? createEmptyResponseStats();
    const chatInThreadReplyTimes = inThreadReplyTimesByChat.get(row.chatId) ?? createEmptyResponseStats();

    return {
      chatId: row.chatId,
      chatDisplayName: derivedName,
      isGroup,
      participants: participantNames,
      messageCount: row.messageCount,
      sentCount: row.sentCount,
      receivedCount: row.receivedCount,
      firstMessageAt: fromAppleTimestamp(row.firstMessageDate),
      lastMessageAt: fromAppleTimestamp(row.lastMessageDate),
      sessionStarters: chatSessionStarters,
      unansweredStarters: chatUnansweredStarters,
      doubleTexts: chatDoubleTexts,
      firstReplyTimes: chatFirstReplyTimes,
      inThreadReplyTimes: chatInThreadReplyTimes,
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
    attachmentStats,
    earliestMessageAt,
    latestMessageAt,
    sessionStarters,
    unansweredStarters,
    doubleTexts,
    firstReplyTimes: overallFirstReplyTimes,
    inThreadReplyTimes: overallInThreadReplyTimes,
  };
}

export function getChatSummaryById(chatId: number, options: ChatSummaryOptions = {}): ChatSummary | null {
  if (!Number.isInteger(chatId) || chatId <= 0) {
    return null;
  }

  const db = getDatabase();
  const { dateRange } = options;
  const dateScale = detectMessageDateScale(db);
  const hasDisplayName = detectHandleDisplayName(db);
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const reactionColumnSupport = detectReactionColumns(db);
  const reactionsSupported =
    reactionColumnSupport.hasAssociatedGuid && reactionColumnSupport.hasAssociatedType;

  const analysisStartSeconds = dateRange?.start ? Math.floor(dateRange.start.getTime() / 1000) : null;
  const analysisEndSeconds = Math.floor((dateRange?.end ?? new Date()).getTime() / 1000);
  const lookbackStartSeconds =
    analysisStartSeconds !== null ? analysisStartSeconds - SESSION_GAP_SECONDS : null;
  const replyCutoffSeconds = analysisEndSeconds - REPLY_WINDOW_SECONDS;

  const params: Record<string, unknown> = {
    chatId,
    sessionGap: SESSION_GAP_SECONDS,
    replyWindow: REPLY_WINDOW_SECONDS,
    analysisStartSeconds,
    analysisEndSeconds,
    lookbackStartSeconds,
    replyCutoffSeconds,
    dateScale,
  };
  const messageFilters: string[] = [];
  if (hasDeletionFlag) {
    messageFilters.push("m.is_deleted = 0");
  }
  if (dateRange?.start) {
    params.startSeconds = analysisStartSeconds;
    messageFilters.push("m.date >= ((@startSeconds - 978307200) * @dateScale)");
  }
  if (dateRange?.end) {
    params.endSeconds = analysisEndSeconds;
    messageFilters.push("m.date <= ((@endSeconds - 978307200) * @dateScale)");
  }

  const buildWhereClause = (...additional: string[]) => {
    const filters = ["cmj.chat_id = @chatId", ...messageFilters, ...additional.filter(Boolean)];
    return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  };

  const statsSql = `
    SELECT
      c.ROWID AS chatId,
      c.display_name AS chatDisplayName,
      COUNT(m.ROWID) AS messageCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount,
      MIN(m.date) AS firstMessageDate,
      MAX(m.date) AS lastMessageDate
    FROM chat c
    JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    JOIN message m ON m.ROWID = cmj.message_id
    ${buildWhereClause()}
    GROUP BY c.ROWID
  `;

  const participantsSql = `
    WITH combined AS (
      SELECT
        chj.chat_id AS chatId,
        h.ROWID AS handleRowId,
        h.id AS handleId
      FROM chat_handle_join chj
      LEFT JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = @chatId
      UNION ALL
      SELECT
        cmj.chat_id AS chatId,
        h.ROWID AS handleRowId,
        h.id AS handleId
      FROM chat_message_join cmj
      JOIN message m ON m.ROWID = cmj.message_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      ${buildWhereClause()}
    )
    SELECT
      COUNT(DISTINCT handleRowId) AS participantCount,
      GROUP_CONCAT(DISTINCT handleId) AS participants
    FROM combined
    WHERE chatId = @chatId
  `;

  const participantDisplayColumn = hasDisplayName ? "h.display_name" : "NULL";

  const messageParticipantsSql = `
    SELECT
      h.id AS handleId,
      ${participantDisplayColumn} AS handleDisplayName,
      m.is_from_me AS isFromMe,
      COUNT(m.ROWID) AS messageCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    ${buildWhereClause()}
    GROUP BY h.id, m.is_from_me
    HAVING messageCount > 0
  `;

  const reactionFilterClauses = reactionsSupported
    ? ["m.associated_message_guid IS NOT NULL", "ABS(m.associated_message_type) BETWEEN 2000 AND 2005"]
    : [];

  const reactionTotalsSql = reactionsSupported
    ? `
    SELECT
      ABS(m.associated_message_type) AS reactionType,
      COUNT(m.ROWID) AS reactionCount,
      SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) AS sentCount,
      SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) AS receivedCount
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    ${buildWhereClause(...reactionFilterClauses)}
    GROUP BY reactionType
  `
    : null;

  const reactionParticipantsSql = reactionsSupported
    ? `
    SELECT
      h.id AS handleId,
      ${participantDisplayColumn} AS handleDisplayName,
      m.is_from_me AS isFromMe,
      COUNT(m.ROWID) AS reactionCount
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    ${buildWhereClause(...reactionFilterClauses)}
    GROUP BY h.id, m.is_from_me
    HAVING reactionCount > 0
  `
    : null;

  const sessionFilters: string[] = ["cmj.chat_id = @chatId"];
  if (hasDeletionFlag) {
    sessionFilters.push("m.is_deleted = 0");
  }
  sessionFilters.push("m.date IS NOT NULL");
  sessionFilters.push("m.date <= ((@analysisEndSeconds - 978307200) * @dateScale)");
  sessionFilters.push(
    "(@lookbackStartSeconds IS NULL OR m.date >= ((@lookbackStartSeconds - 978307200) * @dateScale))",
  );
  if (reactionsSupported) {
    sessionFilters.push(
      "(m.associated_message_guid IS NULL OR ABS(m.associated_message_type) NOT BETWEEN 2000 AND 2005)",
    );
  }
  const sessionMessageWhereSql = sessionFilters.length ? `WHERE ${sessionFilters.join(" AND ")}` : "";

  const sessionMetricsSql = `
    WITH messages AS (
      SELECT
        m.ROWID AS messageId,
        m.is_from_me AS isFromMe,
        ${MESSAGE_SECONDS_EXPR} AS messageSeconds
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${sessionMessageWhereSql}
    ),
    ordered AS (
      SELECT
        messageId,
        isFromMe,
        messageSeconds,
        LAG(messageSeconds) OVER (ORDER BY messageSeconds, messageId) AS prevSeconds,
        MIN(CASE WHEN isFromMe = 1 THEN messageSeconds END) OVER (
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextMeSeconds,
        MIN(CASE WHEN isFromMe = 0 THEN messageSeconds END) OVER (
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextThemSeconds
      FROM messages
    ),
    session_starts AS (
      SELECT
        messageSeconds AS sessionStart,
        isFromMe AS starterIsMe,
        CASE
          WHEN prevSeconds IS NULL OR messageSeconds - prevSeconds > @sessionGap THEN 1
          ELSE 0
        END AS isSessionStart,
        nextMeSeconds,
        nextThemSeconds
      FROM ordered
    ),
    starts_in_range AS (
      SELECT
        sessionStart,
        starterIsMe,
        CASE WHEN starterIsMe = 1 THEN nextThemSeconds ELSE nextMeSeconds END AS replyAt,
        CASE WHEN starterIsMe = 1 THEN nextMeSeconds ELSE nextThemSeconds END AS nextFromStarter
      FROM session_starts
      WHERE isSessionStart = 1
        AND (@analysisStartSeconds IS NULL OR sessionStart >= @analysisStartSeconds)
        AND sessionStart <= @analysisEndSeconds
    ),
    evaluated AS (
      SELECT
        sessionStart,
        starterIsMe,
        CASE
          WHEN replyAt IS NOT NULL AND replyAt - sessionStart <= @replyWindow THEN replyAt
          ELSE NULL
        END AS replyAtWithinWindow,
        nextFromStarter,
        CASE
          WHEN sessionStart <= @replyCutoffSeconds THEN 1
          ELSE 0
        END AS isEvaluable
      FROM starts_in_range
    )
    SELECT
      SUM(CASE WHEN starterIsMe = 1 THEN 1 ELSE 0 END) AS startedByMe,
      SUM(CASE WHEN starterIsMe = 0 THEN 1 ELSE 0 END) AS startedByOthers,
      SUM(
        CASE
          WHEN isEvaluable = 1 AND starterIsMe = 1 AND replyAtWithinWindow IS NULL THEN 1
          ELSE 0
        END
      ) AS theyLeftYouHanging,
      SUM(
        CASE
          WHEN isEvaluable = 1 AND starterIsMe = 0 AND replyAtWithinWindow IS NULL THEN 1
          ELSE 0
        END
      ) AS youLeftThemHanging,
      SUM(
        CASE
          WHEN isEvaluable = 1
            AND starterIsMe = 1
            AND nextFromStarter IS NOT NULL
            AND nextFromStarter - sessionStart <= @replyWindow
            AND (replyAtWithinWindow IS NULL OR nextFromStarter < replyAtWithinWindow)
          THEN 1
          ELSE 0
        END
      ) AS youDoubleTexted,
      SUM(
        CASE
          WHEN isEvaluable = 1
            AND starterIsMe = 0
            AND nextFromStarter IS NOT NULL
            AND nextFromStarter - sessionStart <= @replyWindow
            AND (replyAtWithinWindow IS NULL OR nextFromStarter < replyAtWithinWindow)
          THEN 1
          ELSE 0
        END
      ) AS theyDoubleTexted
    FROM evaluated
  `;

  const firstReplyStatsSql = `
    WITH messages AS (
      SELECT
        m.ROWID AS messageId,
        m.is_from_me AS isFromMe,
        ${MESSAGE_SECONDS_EXPR} AS messageSeconds
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${sessionMessageWhereSql}
    ),
    ordered AS (
      SELECT
        messageId,
        isFromMe,
        messageSeconds,
        LAG(messageSeconds) OVER (ORDER BY messageSeconds, messageId) AS prevSeconds,
        MIN(CASE WHEN isFromMe = 1 THEN messageSeconds END) OVER (
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextMeSeconds,
        MIN(CASE WHEN isFromMe = 0 THEN messageSeconds END) OVER (
          ORDER BY messageSeconds, messageId
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS nextThemSeconds
      FROM messages
    ),
    session_starts AS (
      SELECT
        messageSeconds AS sessionStart,
        isFromMe AS starterIsMe,
        CASE
          WHEN prevSeconds IS NULL OR messageSeconds - prevSeconds > @sessionGap THEN 1
          ELSE 0
        END AS isSessionStart,
        nextMeSeconds,
        nextThemSeconds
      FROM ordered
    ),
    starts_in_range AS (
      SELECT
        sessionStart,
        starterIsMe,
        CASE WHEN starterIsMe = 1 THEN nextThemSeconds ELSE nextMeSeconds END AS replyAt
      FROM session_starts
      WHERE isSessionStart = 1
        AND (@analysisStartSeconds IS NULL OR sessionStart >= @analysisStartSeconds)
        AND sessionStart <= @replyCutoffSeconds
    ),
    replies AS (
      SELECT
        CASE WHEN starterIsMe = 0 THEN 1 ELSE 0 END AS responderIsMe,
        replyAt - sessionStart AS responseSeconds
      FROM starts_in_range
      WHERE replyAt IS NOT NULL
        AND replyAt - sessionStart > 0
        AND replyAt - sessionStart <= @replyWindow
    ),
    ranked AS (
      SELECT
        responderIsMe,
        responseSeconds,
        ROW_NUMBER() OVER (PARTITION BY responderIsMe ORDER BY responseSeconds) AS rn,
        COUNT(*) OVER (PARTITION BY responderIsMe) AS cnt
      FROM replies
    )
    SELECT
      responderIsMe,
      MAX(cnt) AS sampleCount,
      AVG(responseSeconds) AS averageSeconds,
      MIN(responseSeconds) AS minSeconds,
      MAX(responseSeconds) AS maxSeconds,
      SUM(
        CASE
          WHEN cnt % 2 = 1 AND rn = (cnt + 1) / 2 THEN responseSeconds
          WHEN cnt % 2 = 0 AND rn IN (cnt / 2, cnt / 2 + 1) THEN responseSeconds / 2.0
          ELSE 0
        END
      ) AS medianSeconds,
      MIN(
        CASE
          WHEN rn = ((cnt * 9 + 9) / 10) THEN responseSeconds
        END
      ) AS p90Seconds
    FROM ranked
    GROUP BY responderIsMe
  `;

  const inThreadReplyStatsSql = `
    WITH messages AS (
      SELECT
        m.ROWID AS messageId,
        m.is_from_me AS isFromMe,
        ${MESSAGE_SECONDS_EXPR} AS messageSeconds
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      ${sessionMessageWhereSql}
    ),
    ordered AS (
      SELECT
        messageId,
        isFromMe,
        messageSeconds,
        LAG(messageSeconds) OVER (ORDER BY messageSeconds, messageId) AS prevSeconds,
        LAG(isFromMe) OVER (ORDER BY messageSeconds, messageId) AS prevIsFromMe
      FROM messages
    ),
    replies AS (
      SELECT
        isFromMe AS responderIsMe,
        messageSeconds - prevSeconds AS responseSeconds
      FROM ordered
      WHERE prevSeconds IS NOT NULL
        AND prevIsFromMe IS NOT NULL
        AND prevIsFromMe != isFromMe
        AND messageSeconds - prevSeconds > 0
        AND messageSeconds - prevSeconds <= @sessionGap
        AND (@analysisStartSeconds IS NULL OR messageSeconds >= @analysisStartSeconds)
        AND messageSeconds <= @analysisEndSeconds
    ),
    ranked AS (
      SELECT
        responderIsMe,
        responseSeconds,
        ROW_NUMBER() OVER (PARTITION BY responderIsMe ORDER BY responseSeconds) AS rn,
        COUNT(*) OVER (PARTITION BY responderIsMe) AS cnt
      FROM replies
    )
    SELECT
      responderIsMe,
      MAX(cnt) AS sampleCount,
      AVG(responseSeconds) AS averageSeconds,
      MIN(responseSeconds) AS minSeconds,
      MAX(responseSeconds) AS maxSeconds,
      SUM(
        CASE
          WHEN cnt % 2 = 1 AND rn = (cnt + 1) / 2 THEN responseSeconds
          WHEN cnt % 2 = 0 AND rn IN (cnt / 2, cnt / 2 + 1) THEN responseSeconds / 2.0
          ELSE 0
        END
      ) AS medianSeconds,
      MIN(
        CASE
          WHEN rn = ((cnt * 9 + 9) / 10) THEN responseSeconds
        END
      ) AS p90Seconds
    FROM ranked
    GROUP BY responderIsMe
  `;

  const statsStmt = db.prepare(statsSql);
  const participantsStmt = db.prepare(participantsSql);
  const messageParticipantsStmt = db.prepare(messageParticipantsSql);
  const reactionTotalsStmt = reactionTotalsSql ? db.prepare(reactionTotalsSql) : null;
  const reactionParticipantsStmt = reactionParticipantsSql ? db.prepare(reactionParticipantsSql) : null;
  const sessionMetricsStmt = db.prepare(sessionMetricsSql);
  const firstReplyStatsStmt = db.prepare(firstReplyStatsSql);
  const inThreadReplyStatsStmt = db.prepare(inThreadReplyStatsSql);

  let fallbackChatDisplayName: string | null = null;

  const statsRow = statsStmt.get(params) as {
    chatId: number;
    chatDisplayName: string | null;
    messageCount: number | null;
    sentCount: number | null;
    receivedCount: number | null;
    firstMessageDate: number | null;
    lastMessageDate: number | null;
  } | undefined;

  if (!statsRow) {
    const chatExists = db
      .prepare("SELECT c.ROWID AS chatId, c.display_name AS chatDisplayName FROM chat c WHERE c.ROWID = @chatId")
      .get({ chatId }) as { chatId: number; chatDisplayName: string | null } | undefined;
    if (!chatExists) {
      return null;
    }
    fallbackChatDisplayName = chatExists.chatDisplayName ?? null;
  }

  const participantsRow = participantsStmt.get(params) as {
    participantCount: number | null;
    participants: string | null;
  } | undefined;

  const participantNames = collectParticipants(participantsRow?.participants ?? null);
  const participantCount = participantsRow?.participantCount ?? participantNames.length;
  const derivedName =
    participantNames.length === 1
      ? participantNames[0]
      : statsRow?.chatDisplayName ??
          fallbackChatDisplayName ??
          (participantNames.length > 0 ? participantNames.join(", ") : null);
  const isGroup = participantNames.length > 1 ? true : participantCount > 1;

  const totals = {
    messageCount: statsRow?.messageCount ?? 0,
    sentCount: statsRow?.sentCount ?? 0,
    receivedCount: statsRow?.receivedCount ?? 0,
  };
  const firstMessageAt = fromAppleTimestamp(statsRow?.firstMessageDate ?? null);
  const lastMessageAt = fromAppleTimestamp(statsRow?.lastMessageDate ?? null);
  const sessionStarters: SessionStarterStats = { startedByMe: 0, startedByOthers: 0 };
  const unansweredStarters: UnansweredStarterStats = { youLeftThemHanging: 0, theyLeftYouHanging: 0 };
  const doubleTexts: DoubleTextStats = { youDoubleTexted: 0, theyDoubleTexted: 0 };
  const firstReplyTimes = createEmptyResponseStats();
  const inThreadReplyTimes = createEmptyResponseStats();

  const sessionMetricsRow = sessionMetricsStmt.get(params) as
    | {
        startedByMe: number | null;
        startedByOthers: number | null;
        theyLeftYouHanging: number | null;
        youLeftThemHanging: number | null;
        youDoubleTexted: number | null;
        theyDoubleTexted: number | null;
      }
    | undefined;

  if (sessionMetricsRow) {
    sessionStarters.startedByMe = sessionMetricsRow.startedByMe ?? 0;
    sessionStarters.startedByOthers = sessionMetricsRow.startedByOthers ?? 0;
    unansweredStarters.youLeftThemHanging = sessionMetricsRow.youLeftThemHanging ?? 0;
    unansweredStarters.theyLeftYouHanging = sessionMetricsRow.theyLeftYouHanging ?? 0;
    doubleTexts.youDoubleTexted = sessionMetricsRow.youDoubleTexted ?? 0;
    doubleTexts.theyDoubleTexted = sessionMetricsRow.theyDoubleTexted ?? 0;
  }

  const firstReplyStatsRows = firstReplyStatsStmt.all(params) as Array<{
    responderIsMe: number;
    sampleCount: number | null;
    averageSeconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  }>;

  for (const row of firstReplyStatsRows) {
    const responderKey = row.responderIsMe === 1 ? "meResponding" : "themResponding";
    firstReplyTimes[responderKey] = {
      averageSeconds: row.averageSeconds ?? null,
      medianSeconds: row.medianSeconds ?? null,
      p90Seconds: row.p90Seconds ?? null,
      minSeconds: row.minSeconds ?? null,
      maxSeconds: row.maxSeconds ?? null,
      sampleCount: row.sampleCount ?? 0,
    };
  }

  const inThreadReplyStatsRows = inThreadReplyStatsStmt.all(params) as Array<{
    responderIsMe: number;
    sampleCount: number | null;
    averageSeconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  }>;

  for (const row of inThreadReplyStatsRows) {
    const responderKey = row.responderIsMe === 1 ? "meResponding" : "themResponding";
    inThreadReplyTimes[responderKey] = {
      averageSeconds: row.averageSeconds ?? null,
      medianSeconds: row.medianSeconds ?? null,
      p90Seconds: row.p90Seconds ?? null,
      minSeconds: row.minSeconds ?? null,
      maxSeconds: row.maxSeconds ?? null,
      sampleCount: row.sampleCount ?? 0,
    };
  }

  const messageParticipantRows = messageParticipantsStmt.all(params) as {
    handleId: string | null;
    handleDisplayName: string | null;
    isFromMe: number;
    messageCount: number;
    sentCount: number;
    receivedCount: number;
  }[];

  const messageParticipantsAggregate = new Map<string, ChatParticipantStats>();
  for (const row of messageParticipantRows) {
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
            : `unknown:${chatId}`;

    const participantId = isFromMe
      ? "me"
      : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
        ? `contact-${contactInfo.recordId}`
        : normalizedHandle ?? row.handleId ?? `chat-${chatId}-unknown`;

    const selfPreferredName =
      contactInfo?.name && contactInfo.name.toLowerCase() !== "me" ? contactInfo.name : "You";
    const preferredName = isFromMe
      ? selfPreferredName
      : contactInfo?.name ??
        (row.handleDisplayName && row.handleDisplayName !== row.handleId ? row.handleDisplayName : null) ??
        row.handleId ??
        "Unknown";

    const existing = messageParticipantsAggregate.get(aggregateKey);
    if (existing) {
      existing.messageCount += row.messageCount;
      existing.sentCount += row.sentCount;
      existing.receivedCount += row.receivedCount;
      if (isFromMe) {
        existing.isMe = true;
      }
      if (!existing.displayName && preferredName) {
        existing.displayName = preferredName;
      }
      continue;
    }

    messageParticipantsAggregate.set(aggregateKey, {
      id: participantId,
      displayName: preferredName,
      messageCount: row.messageCount,
      sentCount: row.sentCount,
      receivedCount: row.receivedCount,
      isMe: isFromMe,
    });
  }

  const messageParticipants = Array.from(messageParticipantsAggregate.values()).sort(
    (a, b) => b.messageCount - a.messageCount || (a.displayName ?? "").localeCompare(b.displayName ?? ""),
  );

  const reactionTotals: ReactionTotals = createEmptyReactionTotals();
  if (reactionTotalsStmt) {
    const reactionTotalsRows = reactionTotalsStmt.all(params) as Array<
      ReactionCountsRow & { reactionType: number | null }
    >;
    for (const row of reactionTotalsRows) {
      accumulateReactionCounts(reactionTotals, row);
      const mappedType = mapReactionTypeCode(row.reactionType);
      if (mappedType) {
        accumulateReactionCounts(reactionTotals.byType[mappedType], row);
      }
    }
  }

  const reactionParticipants: ChatReactionParticipantStats[] = [];
  if (reactionParticipantsStmt) {
    const rows = reactionParticipantsStmt.all(params) as {
      handleId: string | null;
      handleDisplayName: string | null;
      isFromMe: number;
      reactionCount: number;
    }[];

    const aggregate = new Map<string, ChatReactionParticipantStats>();
    for (const row of rows) {
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
              : `unknown:${chatId}`;

      const participantId = isFromMe
        ? "me"
        : contactInfo?.recordId !== null && contactInfo?.recordId !== undefined
          ? `contact-${contactInfo.recordId}`
          : normalizedHandle ?? row.handleId ?? `chat-${chatId}-unknown-reactor`;

      const selfPreferredName =
        contactInfo?.name && contactInfo.name.toLowerCase() !== "me" ? contactInfo.name : "You";
      const preferredName = isFromMe
        ? selfPreferredName
        : contactInfo?.name ??
          (row.handleDisplayName && row.handleDisplayName !== row.handleId ? row.handleDisplayName : null) ??
          row.handleId ??
          "Unknown";

      const existing = aggregate.get(aggregateKey);
      if (existing) {
        existing.reactionCount += row.reactionCount;
        if (!existing.displayName && preferredName) {
          existing.displayName = preferredName;
        }
        continue;
      }

      aggregate.set(aggregateKey, {
        id: participantId,
        displayName: preferredName,
        reactionCount: row.reactionCount,
        isMe: isFromMe,
      });
    }

    reactionParticipants.push(
      ...Array.from(aggregate.values()).sort(
        (a, b) => b.reactionCount - a.reactionCount || (a.displayName ?? "").localeCompare(b.displayName ?? ""),
      ),
    );
  }

  return {
    chatId,
    chatDisplayName: derivedName,
    isGroup,
    participants: participantNames,
    messageCount: totals.messageCount,
    sentCount: totals.sentCount,
    receivedCount: totals.receivedCount,
    firstMessageAt,
    lastMessageAt,
    sessionStarters,
    unansweredStarters,
    doubleTexts,
    firstReplyTimes,
    inThreadReplyTimes,
    reactions: reactionTotals,
    reactionParticipants,
    messageParticipants,
  };
}

type ChatTextSideKey = "me" | "others";

type MutableTone = {
  positive: number;
  neutral: number;
  negative: number;
  totalScore: number;
};

type MutableTextSide = {
  messageCount: number;
  totalChars: number;
  charLengths: number[];
  totalWords: number;
  wordCounts: number[];
  totalEmojis: number;
  multiLineCount: number;
  totalLines: number;
  upperLetters: number;
  letters: number;
  allCapsMessages: number;
  affirmativeCount: number;
  negativeCount: number;
  runLengths: number[];
  tone: MutableTone;
};

function createEmptyTone(): MutableTone {
  return { positive: 0, neutral: 0, negative: 0, totalScore: 0 };
}

function createEmptyTextSide(): MutableTextSide {
  return {
    messageCount: 0,
    totalChars: 0,
    charLengths: [],
    totalWords: 0,
    wordCounts: [],
    totalEmojis: 0,
    multiLineCount: 0,
    totalLines: 0,
    upperLetters: 0,
    letters: 0,
    allCapsMessages: 0,
    affirmativeCount: 0,
    negativeCount: 0,
    runLengths: [],
    tone: createEmptyTone(),
  };
}

function finalizeTextSide(side: MutableTextSide): ChatTextStyleSideStats {
  const messageCount = side.messageCount;
  if (messageCount <= 0) {
    return {
      messageCount: 0,
      avgChars: null,
      medianChars: null,
      p90Chars: null,
      avgWords: null,
      medianWords: null,
      emojiPerMessage: null,
      multiLineRate: null,
      avgLines: null,
      capsRatio: null,
      allCapsRate: null,
      affirmativeRate: null,
      negativeRate: null,
      avgRunLength: null,
      multiMessageRunRate: null,
      tone: {
        positive: 0,
        neutral: 0,
        negative: 0,
        averageScore: null,
      },
    };
  }

  side.charLengths.sort((a, b) => a - b);
  side.wordCounts.sort((a, b) => a - b);
  side.runLengths.sort((a, b) => a - b);

  const avgChars = side.totalChars / messageCount;
  const medianChars = quantile(side.charLengths, 0.5);
  const p90Chars = quantile(side.charLengths, 0.9);
  const avgWords = side.totalWords / messageCount;
  const medianWords = quantile(side.wordCounts, 0.5);
  const emojiPerMessage = side.totalEmojis / messageCount;
  const multiLineRate = side.multiLineCount / messageCount;
  const avgLines = side.totalLines / messageCount;
  const capsRatio = side.letters > 0 ? side.upperLetters / side.letters : null;
  const allCapsRate = side.allCapsMessages / messageCount;
  const affirmativeRate = side.affirmativeCount / messageCount;
  const negativeRate = side.negativeCount / messageCount;

  const runCount = side.runLengths.length;
  const avgRunLength =
    runCount > 0 ? side.runLengths.reduce((sum, value) => sum + value, 0) / runCount : null;
  const multiMessageRunRate =
    runCount > 0 ? side.runLengths.filter((value) => value >= 2).length / runCount : null;

  const averageScore = side.tone.totalScore / messageCount;

  return {
    messageCount,
    avgChars,
    medianChars,
    p90Chars,
    avgWords,
    medianWords,
    emojiPerMessage,
    multiLineRate,
    avgLines,
    capsRatio,
    allCapsRate,
    affirmativeRate,
    negativeRate,
    avgRunLength,
    multiMessageRunRate,
    tone: {
      positive: side.tone.positive,
      neutral: side.tone.neutral,
      negative: side.tone.negative,
      averageScore,
    },
  };
}

export function getChatTextStyleSummary(
  chatId: number,
  options: ChatTextStyleOptions = {},
): ChatTextStyleSummary | null {
  if (!Number.isInteger(chatId) || chatId <= 0) {
    return null;
  }

  const db = getDatabase();
  const dateScale = detectMessageDateScale(db);
  const hasDeletionFlag = detectMessageDeletionColumn(db);
  const reactionColumnSupport = detectReactionColumns(db);
  const reactionsSupported = reactionColumnSupport.hasAssociatedGuid && reactionColumnSupport.hasAssociatedType;
  const attributedBodySupported = detectAttributedBodySupport(db);

  const params: Record<string, unknown> = {
    chatId,
    dateScale,
  };

  const whereClauses: string[] = ["cmj.chat_id = @chatId", "m.date IS NOT NULL"];

  if (attributedBodySupported) {
    whereClauses.push("((m.text IS NOT NULL AND length(trim(m.text)) > 0) OR m.attributedBody IS NOT NULL)");
  } else {
    whereClauses.push("m.text IS NOT NULL", "length(trim(m.text)) > 0");
  }

  if (hasDeletionFlag) {
    whereClauses.push("m.is_deleted = 0");
  }

  if (reactionsSupported) {
    whereClauses.push("(m.associated_message_guid IS NULL OR ABS(m.associated_message_type) NOT BETWEEN 2000 AND 2005)");
  }

  const start = options.dateRange?.start;
  const end = options.dateRange?.end;
  if (start) {
    params.startSeconds = Math.floor(start.getTime() / 1000);
    whereClauses.push("m.date >= ((@startSeconds - 978307200) * @dateScale)");
  }
  if (end) {
    params.endSeconds = Math.ceil(end.getTime() / 1000);
    whereClauses.push("m.date <= ((@endSeconds - 978307200) * @dateScale)");
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const attributedBodySelect = attributedBodySupported ? "m.attributedBody AS attributedBody" : "NULL AS attributedBody";

  const sql = `
    SELECT
      m.ROWID AS messageId,
      m.is_from_me AS isFromMe,
      m.text AS text,
      ${attributedBodySelect},
      ${MESSAGE_SECONDS_EXPR} AS messageSeconds
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    ${whereSql}
    ORDER BY messageSeconds ASC, m.ROWID ASC
  `;

  const stmt = db.prepare(sql);
  const iterator = stmt.iterate(params) as IterableIterator<{
    messageId: number;
    isFromMe: number;
    text: string | null;
    attributedBody: Buffer | null;
    messageSeconds: number | null;
  }>;

  const bySide: Record<ChatTextSideKey, MutableTextSide> = {
    me: createEmptyTextSide(),
    others: createEmptyTextSide(),
  };

  let currentRunSide: ChatTextSideKey | null = null;
  let currentRunLength = 0;
  const flushRun = () => {
    if (!currentRunSide) return;
    bySide[currentRunSide].runLengths.push(currentRunLength);
  };

  for (const row of iterator) {
    const rawText = typeof row.text === "string" ? row.text : "";
    let text = normalizeAnalyzedText(rawText);

    if (!text && row.attributedBody instanceof Buffer) {
      text = extractTextFromAttributedBody(row.attributedBody);
    }

    if (!text) continue;

    const sideKey: ChatTextSideKey = row.isFromMe === 1 ? "me" : "others";
    const side = bySide[sideKey];

    if (currentRunSide === null) {
      currentRunSide = sideKey;
      currentRunLength = 1;
    } else if (currentRunSide === sideKey) {
      currentRunLength += 1;
    } else {
      flushRun();
      currentRunSide = sideKey;
      currentRunLength = 1;
    }

    side.messageCount += 1;

    const chars = text.length;
    side.totalChars += chars;
    side.charLengths.push(chars);

    const words = text.split(/\s+/).filter(Boolean).length;
    side.totalWords += words;
    side.wordCounts.push(words);

    const lineCount = text.split(/\r\n|\r|\n/).length;
    side.totalLines += lineCount;
    if (lineCount > 1) side.multiLineCount += 1;

    side.totalEmojis += countMatches(EMOJI_REGEX, text);
    side.letters += countMatches(LETTER_REGEX, text);
    side.upperLetters += countMatches(UPPER_LETTER_REGEX, text);

    if (hasAllCapsWord(text)) side.allCapsMessages += 1;

    const affirmation = classifyAffirmation(text);
    if (affirmation === "affirmative") side.affirmativeCount += 1;
    if (affirmation === "negative") side.negativeCount += 1;

    const tone = scoreSentiment(text);
    side.tone.totalScore += tone.score;
    if (tone.bucket === "positive") side.tone.positive += 1;
    else if (tone.bucket === "negative") side.tone.negative += 1;
    else side.tone.neutral += 1;
  }

  flushRun();

  const meStats = finalizeTextSide(bySide.me);
  const otherStats = finalizeTextSide(bySide.others);
  const totalMessagesAnalyzed = meStats.messageCount + otherStats.messageCount;

  return {
    chatId,
    totalMessagesAnalyzed,
    me: meStats,
    others: otherStats,
  };
}
