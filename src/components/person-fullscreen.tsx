'use client';

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { GlobalRangeBar } from "@/components/global-range-bar";
import {
  CallsTimelineChart,
  MessagesTimelineChart,
  bucketLabel,
  parseBucketDate,
  type PersonCallTimeline,
  type PersonMessageTimeline,
  type PersonTimelineBucket,
} from "@/components/person-timeline";
import { useGlobalRange } from "@/hooks/use-global-range";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import { fetchAllCalls, type CallApiRecord } from "@/lib/callhistory/client";
import type { SerializableChatSummary, SerializableConversationStats } from "@/lib/imessage/types";

type TimelineBucketMode = "auto" | PersonTimelineBucket;

type PersonChatSummary = {
  chatId: number;
  label: string;
  isGroup: boolean;
  fromMeMessages: number;
  fromThemMessages: number;
  totalMessages: number;
  lastMessageAt: Date | null;
  participants: string[];
};

type NormalizedCall = {
  callId: number;
  startedAt: Date | null;
  durationSeconds: number;
  answered: boolean;
  direction: string;
  provider: string;
  media: string;
};

type CalendarEntry = {
  messageTotal: number;
  fromMe: number;
  fromThem: number;
  callCount: number;
  callSeconds: number;
};

type CalendarDay = {
  date: Date;
  messageTotal: number;
  fromMe: number;
  fromThem: number;
  callCount: number;
  callSeconds: number;
  answeredCalls: number;
  missedCalls: number;
};

const compactFormatter = Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatNumber(value: number) {
  return value.toLocaleString();
}

function formatCompactNumber(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN) || (value ?? 0) <= 0) return "—";
  try {
    return compactFormatter.format(value as number);
  } catch {
    return formatNumber(value as number);
  }
}

function formatDuration(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? NaN) || (seconds ?? 0) <= 0) return "0s";
  const wholeSeconds = Math.floor(seconds as number);
  const mins = Math.floor(wholeSeconds / 60);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  const remSecs = wholeSeconds % 60;
  if (hrs > 0) return `${hrs}h ${remMins}m`;
  if (mins > 0) return `${mins}m ${remSecs}s`;
  return `${remSecs}s`;
}

function formatHours(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? NaN) || (seconds ?? 0) <= 0) return "0h";
  const hours = (seconds as number) / 3600;
  if (hours >= 10) return `${Math.round(hours)}h`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(2)}h`;
}

function formatActivityScore(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? formatNumber(value) : value.toFixed(1);
}

function parseDateTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTime(value: Date | null | undefined) {
  if (!value) return "—";
  try {
    return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return value.toISOString();
  }
}

function formatDate(value: Date | null | undefined) {
  if (!value) return "—";
  try {
    return value.toLocaleDateString(undefined, { dateStyle: "medium" });
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

function formatShortDate(value: Date | null | undefined) {
  if (!value) return "—";
  try {
    return value.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return value.toISOString().slice(5, 10);
  }
}

function formatMonthLabel(year: number, monthIndex: number) {
  try {
    return new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } catch {
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  }
}

function formatDateTimeLocalInput(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function parseDateTimeLocalInput(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatDayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function chooseAutoBucket(options: {
  start: Date | null;
  end: Date | null;
  fallback?: PersonTimelineBucket;
}): PersonTimelineBucket {
  const start = options.start;
  const end = options.end;
  if (!start || !end) return options.fallback ?? "month";

  const diffSeconds = (end.getTime() - start.getTime()) / 1000;
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) return "day";

  if (diffSeconds <= 48 * 60 * 60) return "hour";
  if (diffSeconds <= 90 * 24 * 60 * 60) return "day";
  if (diffSeconds <= 365 * 24 * 60 * 60) return "week";
  return "month";
}

function buildChatLabel(chat: SerializableChatSummary) {
  const label =
    chat.chatDisplayName ??
    (chat.participants.length > 0 ? chat.participants.join(", ") : null) ??
    `Chat ${chat.chatId}`;
  return chat.isGroup ? `${label} (group)` : label;
}

function computePersonChatsFromStats(
  stats: SerializableConversationStats | null,
  personKey: string,
): PersonChatSummary[] {
  if (!stats || !personKey) return [];
  const chats: PersonChatSummary[] = [];
  for (const chat of stats.topChats ?? []) {
    const participant = (chat.messageParticipants ?? []).find((p) => {
      const isSelf = Boolean(p.isMe || p.id === "me");
      if (isSelf) return false;
      const key = p.id ?? p.displayName ?? `unknown-${chat.chatId}`;
      return key === personKey;
    });
    if (!participant) continue;
    const fromMeMessages = Math.max(0, chat.sentCount ?? 0);
    const fromThemMessages = Math.max(0, participant.messageCount ?? 0);
    const totalMessages = fromMeMessages + fromThemMessages;
    chats.push({
      chatId: chat.chatId,
      label: buildChatLabel(chat),
      isGroup: Boolean(chat.isGroup),
      fromMeMessages,
      fromThemMessages,
      totalMessages,
      lastMessageAt: parseDateTime(chat.lastMessageAt),
      participants: chat.participants,
    });
  }
  return chats.sort(
    (a, b) =>
      b.totalMessages - a.totalMessages ||
      (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0) ||
      a.label.localeCompare(b.label),
  );
}

function aggregateMessageStats(chats: PersonChatSummary[]) {
  if (!chats.length) {
    return { totalMessages: 0, fromMeMessages: 0, fromThemMessages: 0, chatCount: 0, lastMessageAt: null as Date | null };
  }
  let totalMessages = 0;
  let fromMeMessages = 0;
  let fromThemMessages = 0;
  let lastMessageAt: Date | null = null;
  for (const chat of chats) {
    totalMessages += chat.totalMessages;
    fromMeMessages += chat.fromMeMessages;
    fromThemMessages += chat.fromThemMessages;
    if (chat.lastMessageAt && (!lastMessageAt || chat.lastMessageAt > lastMessageAt)) {
      lastMessageAt = chat.lastMessageAt;
    }
  }
  return { totalMessages, fromMeMessages, fromThemMessages, chatCount: chats.length, lastMessageAt };
}

function getCallParticipants(call: CallApiRecord) {
  if (call.participants.length > 0) return call.participants;
  if (call.address) {
    return [{ id: call.address, handle: call.address, displayName: call.name }];
  }
  return [];
}

function computeCallStatsForPerson(options: {
  personKey: string;
  allCalls: CallApiRecord[];
  rangeStart: Date | null;
  rangeEnd: Date | null;
}) {
  const { personKey, allCalls, rangeStart, rangeEnd } = options;
  if (!personKey) return null;
  let totalCalls = 0;
  let incomingCalls = 0;
  let outgoingCalls = 0;
  let answeredCalls = 0;
  let missedIncomingCalls = 0;
  let talkSeconds = 0;
  let lastCallAt: Date | null = null;
  const normalized: NormalizedCall[] = [];

  for (const call of allCalls) {
    const startedAt = parseDateTime(call.startedAt);
    if (!startedAt) continue;
    if (rangeStart && startedAt < rangeStart) continue;
    if (rangeEnd && startedAt > rangeEnd) continue;

    const participants = getCallParticipants(call);
    const keys = new Set(participants.map((participant) => participant.id ?? participant.handle).filter(Boolean));
    if (!keys.has(personKey)) continue;

    totalCalls += 1;
    if (call.direction === "incoming") incomingCalls += 1;
    if (call.direction === "outgoing") outgoingCalls += 1;
    if (call.answered) answeredCalls += 1;
    if (call.direction === "incoming" && !call.answered) missedIncomingCalls += 1;

    const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
    talkSeconds += duration;

    if (!lastCallAt || startedAt > lastCallAt) {
      lastCallAt = startedAt;
    }

    normalized.push({
      callId: call.callId,
      startedAt,
      durationSeconds: duration,
      answered: call.answered,
      direction: call.direction,
      provider: call.provider,
      media: call.media,
    });
  }

  normalized.sort(
    (a, b) =>
      (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0) ||
      b.callId - a.callId,
  );

  return {
    totalCalls,
    incomingCalls,
    outgoingCalls,
    answeredCalls,
    missedIncomingCalls,
    talkSeconds,
    lastCallAt,
    recentCalls: normalized.slice(0, 6),
    callsInRange: normalized,
  };
}

type CallStats = ReturnType<typeof computeCallStatsForPerson>;

function buildCallTimelineFromStats(callStats: CallStats | null): PersonCallTimeline | null {
  if (!callStats?.callsInRange || callStats.callsInRange.length === 0) return null;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const call of callStats.callsInRange) {
    const startedAt = call.startedAt;
    if (!startedAt) continue;
    if (!earliest || startedAt < earliest) earliest = startedAt;
    if (!latest || startedAt > latest) latest = startedAt;
  }
  const bucket = chooseAutoBucket({ start: earliest, end: latest, fallback: "month" });
  const map = new Map<
    string,
    { bucket: string; answeredCount: number; missedCount: number; totalCount: number; talkSeconds: number }
  >();

  for (const call of callStats.callsInRange) {
    const startedAt = call.startedAt;
    if (!startedAt) continue;
    const bucketDate = new Date(startedAt.getTime());
    if (bucket === "hour") bucketDate.setMinutes(0, 0, 0);
    if (bucket === "day") bucketDate.setHours(0, 0, 0, 0);
    if (bucket === "week") {
      bucketDate.setHours(0, 0, 0, 0);
      const weekday = bucketDate.getDay();
      const diff = (weekday + 6) % 7;
      bucketDate.setDate(bucketDate.getDate() - diff);
    }
    if (bucket === "month") {
      bucketDate.setHours(0, 0, 0, 0);
      bucketDate.setDate(1);
    }

    const key =
      bucket === "month"
        ? `${bucketDate.getFullYear()}-${String(bucketDate.getMonth() + 1).padStart(2, "0")}`
        : bucket === "hour"
          ? `${bucketDate.getFullYear()}-${String(bucketDate.getMonth() + 1).padStart(2, "0")}-${String(bucketDate.getDate()).padStart(2, "0")} ${String(bucketDate.getHours()).padStart(2, "0")}:00`
          : `${bucketDate.getFullYear()}-${String(bucketDate.getMonth() + 1).padStart(2, "0")}-${String(bucketDate.getDate()).padStart(2, "0")}`;

    const existing =
      map.get(key) ?? {
        bucket: key,
        answeredCount: 0,
        missedCount: 0,
        totalCount: 0,
        talkSeconds: 0,
      };

    if (call.answered) existing.answeredCount += 1;
    else existing.missedCount += 1;
    existing.totalCount += 1;
    existing.talkSeconds += Math.max(0, call.durationSeconds ?? 0);
    map.set(key, existing);
  }

  const points = Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
  return { bucket, points };
}

async function fetchPersonTimeline(params: {
  personKey: string;
  bucket?: PersonTimelineBucket;
  start?: string;
  end?: string;
  chatIds?: number[];
}): Promise<PersonMessageTimeline> {
  const search = new URLSearchParams();
  search.set("key", params.personKey);
  if (params.bucket) search.set("bucket", params.bucket);
  if (params.start) search.set("start", params.start);
  if (params.end) search.set("end", params.end);
  if (params.chatIds && params.chatIds.length > 0) {
    search.set("chatIds", params.chatIds.join(","));
  }
  const res = await fetch(`/api/person-timeline?${search.toString()}`);
  const json = (await res.json().catch(() => null)) as { data?: PersonMessageTimeline; error?: unknown } | null;
  if (!res.ok) {
    const direct = typeof json?.error === "string" ? json.error : null;
    const formErrors =
      json?.error && typeof json.error === "object" && "formErrors" in json.error
        ? (json.error as { formErrors?: unknown }).formErrors
        : null;
    const flattened = Array.isArray(formErrors) && typeof formErrors[0] === "string" ? formErrors[0] : null;
    const fieldErrors =
      json?.error && typeof json.error === "object" && "fieldErrors" in json.error
        ? (json.error as { fieldErrors?: unknown }).fieldErrors
        : null;
    const firstFieldError =
      fieldErrors && typeof fieldErrors === "object"
        ? Object.values(fieldErrors as Record<string, unknown>)
            .flat()
            .find((value: unknown) => typeof value === "string")
        : null;
    const message =
      direct ||
      (typeof flattened === "string" ? flattened : null) ||
      (typeof firstFieldError === "string" ? firstFieldError : null) ||
      "Unable to load timeline.";
    throw new Error(message);
  }
  return (json?.data ?? { bucket: params.bucket ?? "day", points: [] }) as PersonMessageTimeline;
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const calendarHeaderLabels = [...weekdayLabels, "Week"];
const calendarGridTemplate = "grid-cols-8";
const EMPTY_IDS: number[] = [];

function quantile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function computeMaxDailyValue(days: CalendarDay[], showMessages: boolean, showCalls: boolean) {
  return days.reduce((max, day) => {
    let value = 0;
    if (showMessages) value += day.messageTotal;
    if (showCalls) value += day.callSeconds / 3600;
    return value > max ? value : max;
  }, 0);
}

function computeCalendarSummary(days: CalendarDay[], showMessages: boolean, showCalls: boolean) {
  if (days.length === 0) return null;
  const totals = days.map((day) => {
    let value = 0;
    if (showMessages) value += day.messageTotal;
    if (showCalls) value += day.callSeconds / 3600;
    return value;
  });
  const nonZero = totals.filter((value) => value > 0);
  const max = totals.length ? Math.max(...totals) : 0;
  const lowThreshold = Math.max(1, Math.round(quantile(nonZero, 0.25)));
  const highThreshold = Math.max(lowThreshold + 1, Math.round(quantile(nonZero, 0.9)));
  const zeroDays = totals.filter((value) => value === 0).length;
  const quietDays = totals.filter((value) => value > 0 && value <= lowThreshold).length;
  const busyDays = totals.filter((value) => value >= highThreshold).length;
  return { max, lowThreshold, highThreshold, zeroDays, quietDays, busyDays };
}

function computeMonthlyStats(days: CalendarDay[], showMessages: boolean, showCalls: boolean) {
  if (days.length === 0) return null;
  let messageTotal = 0;
  let callSeconds = 0;
  let callCount = 0;
  let activeDays = 0;
  let busiestDay: Date | null = null;
  let busiestScore = -1;
  for (const day of days) {
    messageTotal += day.messageTotal;
    callSeconds += day.callSeconds;
    callCount += day.callCount;
    let score = 0;
    if (showMessages) score += day.messageTotal;
    if (showCalls) score += day.callSeconds / 3600;
    if (score > 0) activeDays += 1;
    if (score > busiestScore) {
      busiestScore = score;
      busiestDay = day.date;
    }
  }
  const totalDays = days.length;
  const noContactDays = Math.max(0, totalDays - activeDays);
  return {
    messageTotal,
    callSeconds,
    callCount,
    activeDays,
    noContactDays,
    busiestDay,
    busiestScore: Math.max(0, busiestScore),
  };
}

function buildDailyPoints(options: {
  startIso?: string;
  endIso?: string;
  timelinePoints?: PersonMessageTimeline["points"];
}) {
  const { startIso, endIso, timelinePoints } = options;
  if (!startIso || !endIso) return [];
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const timelineMap = new Map<string, PersonMessageTimeline["points"][number]>();
  for (const point of timelinePoints ?? []) {
    timelineMap.set(point.bucket, point);
  }

  const filled: Array<PersonMessageTimeline["points"][number]> = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endCursor = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let guard = 0;
  while (cursor <= endCursor && guard < 5000) {
    guard += 1;
    const key = formatDayKey(cursor);
    const existing = timelineMap.get(key);
    filled.push(
      existing ?? {
        bucket: key,
        fromMeCount: 0,
        fromThemCount: 0,
        totalCount: 0,
      },
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

export default function PersonFullscreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();
  const { range } = useGlobalRange();

  const urlCompareEnabled = useMemo(() => {
    const compareValue = searchParams.get("compare");
    return compareValue === "1" || compareValue === "true";
  }, [searchParams, searchParamsString]);

  const urlCompareKey = useMemo(() => searchParams.get("compareKey") ?? "", [searchParams, searchParamsString]);

  const personKey = useMemo(() => searchParams.get("key")?.trim() ?? "", [searchParams]);
  const labelFromQuery = useMemo(() => searchParams.get("label")?.trim() ?? "", [searchParams]);
  const backHref = useMemo(() => searchParams.get("from") ?? "", [searchParams]);

  const [bucketMode, setBucketMode] = useState<TimelineBucketMode>("auto");
  const [chatSearch, setChatSearch] = useState("");
  const [chatFilter, setChatFilter] = useState<"all" | "direct" | "group">("all");
  const [compareChatSearch, setCompareChatSearch] = useState("");
  const [compareChatFilter, setCompareChatFilter] = useState<"all" | "direct" | "group">("all");
  const [selectedChatByPerson, setSelectedChatByPerson] = useState<Record<string, number[]>>({});
  const [monthCursor, setMonthCursor] = useState(0);
  const [showCalendarMessages, setShowCalendarMessages] = useState(true);
  const [showCalendarCalls, setShowCalendarCalls] = useState(true);
  const [calendarOverrideEnabled, setCalendarOverrideEnabled] = useState(false);
  const [calendarOverrideStartIso, setCalendarOverrideStartIso] = useState<string | null>(null);
  const [calendarOverrideEndIso, setCalendarOverrideEndIso] = useState<string | null>(null);
  const [compareEnabled, setCompareEnabled] = useState(() => {
    const compareValue = searchParams.get("compare");
    return compareValue === "1" || compareValue === "true";
  });
  const [comparePersonKey, setComparePersonKey] = useState(() => searchParams.get("compareKey") ?? "");

  useEffect(() => {
    setCompareEnabled(urlCompareEnabled);
    setComparePersonKey(urlCompareEnabled ? urlCompareKey : "");
  }, [searchParamsString, urlCompareEnabled, urlCompareKey]);

  const statsLimit = 50;
  const statsQuery = useStatsSummary(
    {
      limit: statsLimit,
      start: range.startIso,
      end: range.endIso,
    },
    { enabled: Boolean(personKey) },
  );

  const stats = (statsQuery.data as SerializableConversationStats | undefined) ?? null;

  const calendarRange = useMemo(() => {
    if (!calendarOverrideEnabled) {
      return {
        startIso: range.startIso,
        endIso: range.endIso,
        startDate: range.startDate,
        endDate: range.endDate,
      };
    }

    const globalStart = range.startIso ? new Date(range.startIso) : null;
    const globalEnd = range.endIso ? new Date(range.endIso) : null;

    let start = calendarOverrideStartIso ? new Date(calendarOverrideStartIso) : globalStart;
    let end = calendarOverrideEndIso ? new Date(calendarOverrideEndIso) : globalEnd;

    if (start && Number.isNaN(start.getTime())) start = globalStart;
    if (end && Number.isNaN(end.getTime())) end = globalEnd;

    if (globalStart && start && start < globalStart) start = globalStart;
    if (globalStart && end && end < globalStart) end = globalStart;
    if (globalEnd && start && start > globalEnd) start = globalEnd;
    if (globalEnd && end && end > globalEnd) end = globalEnd;

    if (start && end && start > end) {
      const temp = start;
      start = end;
      end = temp;
    }

    return {
      startIso: start ? start.toISOString() : undefined,
      endIso: end ? end.toISOString() : undefined,
      startDate: start ?? null,
      endDate: end ?? null,
    };
  }, [
    calendarOverrideEnabled,
    calendarOverrideEndIso,
    calendarOverrideStartIso,
    range.endIso,
    range.endDate,
    range.startIso,
    range.startDate,
  ]);

  const personChats = useMemo<PersonChatSummary[]>(
    () => computePersonChatsFromStats(stats, personKey),
    [personKey, stats],
  );

  const selectedChatIds = selectedChatByPerson[personKey] ?? EMPTY_IDS;
  const setSelectedChatIds = useCallback(
    (updater: number[] | ((value: number[]) => number[])) => {
      setSelectedChatByPerson((current) => {
        const existing = current[personKey] ?? [];
        const next = typeof updater === "function" ? updater(existing) : updater;
        if (existing.length === next.length && existing.every((value, index) => value === next[index])) {
          return current;
        }
        return { ...current, [personKey]: next };
      });
    },
    [personKey],
  );

  const resolvedLabel = useMemo(() => {
    if (labelFromQuery) return labelFromQuery;
    const candidate = personChats.find((chat) => chat.label && !chat.label.includes("Chat "));
    return candidate?.label ?? personKey ?? "Unknown";
  }, [labelFromQuery, personChats, personKey]);

  const totalMessageStats = useMemo(() => aggregateMessageStats(personChats), [personChats]);

  const filterChats = useCallback(
    (chats: PersonChatSummary[], filterMode: "all" | "direct" | "group", searchTerm: string) => {
      const term = searchTerm.trim().toLowerCase();
      return chats.filter((chat) => {
        if (filterMode === "direct" && chat.isGroup) return false;
        if (filterMode === "group" && !chat.isGroup) return false;
        if (!term) return true;
        return (
          chat.label.toLowerCase().includes(term) ||
          chat.participants.join(" ").toLowerCase().includes(term)
        );
      });
    },
    [],
  );

  const selectedChatSet = useMemo(() => new Set(selectedChatIds), [selectedChatIds]);
  const filteredChats = useMemo(
    () => filterChats(personChats, chatFilter, chatSearch),
    [chatFilter, chatSearch, filterChats, personChats],
  );

  const contactOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const participant of stats?.participantBreakdown ?? []) {
      if (participant.isMe) continue;
      const id = participant.id ?? participant.displayName;
      if (!id) continue;
      const label = participant.displayName ?? id;
      const existing = map.get(id);
      if (!existing || existing === id) map.set(id, label);
    }
    if (personKey && !map.has(personKey)) {
      map.set(personKey, resolvedLabel || personKey);
    }
    return Array.from(map.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [personKey, resolvedLabel, stats?.participantBreakdown]);

  const compareOptions = useMemo(
    () => contactOptions.filter((option) => option.id !== personKey),
    [contactOptions, personKey],
  );
  const effectiveCompareKey =
    comparePersonKey && comparePersonKey !== personKey ? comparePersonKey : compareOptions[0]?.id ?? "";

  const compareSelectedChatIds = selectedChatByPerson[effectiveCompareKey] ?? EMPTY_IDS;
  const setCompareSelectedChatIds = useCallback(
    (updater: number[] | ((value: number[]) => number[])) => {
      if (!effectiveCompareKey) return;
      setSelectedChatByPerson((current) => {
        const existing = current[effectiveCompareKey] ?? [];
        const next = typeof updater === "function" ? updater(existing) : updater;
        if (existing.length === next.length && existing.every((value, index) => value === next[index])) {
          return current;
        }
        return { ...current, [effectiveCompareKey]: next };
      });
    },
    [effectiveCompareKey],
  );

  const updateCompareParams = useCallback(
    (enabled: boolean, nextKey: string) => {
      const currentSearch =
        typeof window !== "undefined" ? window.location.search.replace(/^\?/, "") : searchParamsString;
      const params = new URLSearchParams(currentSearch);
      if (enabled) {
        params.set("compare", "1");
        if (nextKey) params.set("compareKey", nextKey);
        else params.delete("compareKey");
      } else {
        params.delete("compare");
        params.delete("compareKey");
      }
      const nextQuery = params.toString();
      if (typeof window !== "undefined") {
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
        if (nextUrl !== `${window.location.pathname}${window.location.search}`) {
          window.history.replaceState({}, "", nextUrl);
        }
      } else if (nextQuery !== searchParamsString) {
        router.replace(`/person?${nextQuery}`);
      }
    },
    [router, searchParamsString],
  );

  const compareChats = useMemo<PersonChatSummary[]>(
    () => (effectiveCompareKey ? computePersonChatsFromStats(stats, effectiveCompareKey) : []),
    [effectiveCompareKey, stats],
  );
  const compareMessageStats = useMemo(() => aggregateMessageStats(compareChats), [compareChats]);

  const compareSelectedChatSet = useMemo(() => new Set(compareSelectedChatIds), [compareSelectedChatIds]);
  const compareFilteredChats = useMemo(
    () => filterChats(compareChats, compareChatFilter, compareChatSearch),
    [compareChatFilter, compareChatSearch, compareChats, filterChats],
  );

  const handlePersonChange = useCallback(
    (nextKey: string) => {
      if (!nextKey || nextKey === personKey) return;
      const option = contactOptions.find((item) => item.id === nextKey);
      const currentSearch =
        typeof window !== "undefined" ? window.location.search.replace(/^\?/, "") : searchParamsString;
      const params = new URLSearchParams(currentSearch);
      params.set("key", nextKey);
      if (option?.label) params.set("label", option.label);
      else params.delete("label");
      router.push(`/person?${params.toString()}`);
      if (comparePersonKey === nextKey) {
        setComparePersonKey("");
        updateCompareParams(true, "");
      }
    },
    [comparePersonKey, contactOptions, personKey, router, searchParamsString, updateCompareParams],
  );

  const compareLabel = useMemo(
    () => compareOptions.find((option) => option.id === effectiveCompareKey)?.label ?? effectiveCompareKey,
    [compareOptions, effectiveCompareKey],
  );

  useEffect(() => {
    if (!compareEnabled) return;
    if (!effectiveCompareKey) return;
    if (effectiveCompareKey === comparePersonKey) return;
    setComparePersonKey(effectiveCompareKey);
    updateCompareParams(true, effectiveCompareKey);
  }, [compareEnabled, comparePersonKey, effectiveCompareKey, updateCompareParams]);

  const toggleChat = (chatId: number) => {
    setSelectedChatIds((current) =>
      current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId],
    );
  };

  const clearSelectedChats = () => setSelectedChatIds([]);

  const toggleCompareChat = (chatId: number) => {
    setCompareSelectedChatIds((current) =>
      current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId],
    );
  };

  const clearCompareSelectedChats = () => setCompareSelectedChatIds([]);

  const timelineQuery = useQuery({
    queryKey: ["person-timeline", personKey, range.startIso, range.endIso, bucketMode, selectedChatIds],
    enabled: Boolean(personKey),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      fetchPersonTimeline({
        personKey,
        bucket: bucketMode === "auto" ? undefined : bucketMode,
        start: range.startIso,
        end: range.endIso,
        chatIds: selectedChatIds.length > 0 ? selectedChatIds : undefined,
      }),
  });

  const compareTimelineQuery = useQuery({
    queryKey: [
      "person-timeline",
      "compare",
      effectiveCompareKey,
      range.startIso,
      range.endIso,
      bucketMode,
      compareSelectedChatIds,
    ],
    enabled: compareEnabled && Boolean(effectiveCompareKey),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      fetchPersonTimeline({
        personKey: effectiveCompareKey,
        bucket: bucketMode === "auto" ? undefined : bucketMode,
        start: range.startIso,
        end: range.endIso,
        chatIds: compareSelectedChatIds.length > 0 ? compareSelectedChatIds : undefined,
      }),
  });

  const dailyTimelineQuery = useQuery({
    queryKey: [
      "person-timeline",
      "daily",
      personKey,
      calendarRange.startIso,
      calendarRange.endIso,
      selectedChatIds,
    ],
    enabled: Boolean(personKey),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      fetchPersonTimeline({
        personKey,
        bucket: "day",
        start: calendarRange.startIso,
        end: calendarRange.endIso,
        chatIds: selectedChatIds.length > 0 ? selectedChatIds : undefined,
      }),
  });

  const compareDailyTimelineQuery = useQuery({
    queryKey: [
      "person-timeline",
      "daily-compare",
      effectiveCompareKey,
      calendarRange.startIso,
      calendarRange.endIso,
      compareSelectedChatIds,
    ],
    enabled: compareEnabled && Boolean(effectiveCompareKey),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      fetchPersonTimeline({
        personKey: effectiveCompareKey,
        bucket: "day",
        start: calendarRange.startIso,
        end: calendarRange.endIso,
        chatIds: compareSelectedChatIds.length > 0 ? compareSelectedChatIds : undefined,
      }),
  });

  const callsQuery = useQuery({
    queryKey: ["calls", "all", personKey],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    enabled: Boolean(personKey),
    retry: 1,
  });

  const allCalls = useMemo(() => callsQuery.data ?? [], [callsQuery.data]);
  const callHistoryEarliest = useMemo(() => {
    let earliest: Date | null = null;
    for (const call of allCalls) {
      const startedAt = parseDateTime(call.startedAt);
      if (!startedAt) continue;
      if (!earliest || startedAt < earliest) {
        earliest = startedAt;
      }
    }
    return earliest;
  }, [allCalls]);

  const callStats = useMemo(
    () =>
      computeCallStatsForPerson({
        personKey,
        allCalls,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
      }),
    [allCalls, personKey, range.endDate, range.startDate],
  );

  const compareCallStats = useMemo(
    () =>
      effectiveCompareKey
        ? computeCallStatsForPerson({
            personKey: effectiveCompareKey,
            allCalls,
            rangeStart: range.startDate,
            rangeEnd: range.endDate,
          })
        : null,
    [allCalls, effectiveCompareKey, range.endDate, range.startDate],
  );

  const callTimeline = useMemo(() => buildCallTimelineFromStats(callStats), [callStats]);
  const compareCallTimeline = useMemo(
    () => buildCallTimelineFromStats(compareCallStats),
    [compareCallStats],
  );

  const callHistoryNote = useMemo(() => {
    if (!callHistoryEarliest) return null;
    const rangeStart = range.startIso ? new Date(range.startIso) : null;
    const hasRangeStart = Boolean(rangeStart && !Number.isNaN(rangeStart?.getTime() ?? NaN));
    if (hasRangeStart && rangeStart && rangeStart >= callHistoryEarliest) {
      return null;
    }
    return `Call history on this Mac starts ${formatDate(callHistoryEarliest)}.`;
  }, [callHistoryEarliest, range.startIso]);

  const timelineError = timelineQuery.error instanceof Error ? timelineQuery.error.message : null;
  const dailyError = dailyTimelineQuery.error instanceof Error ? dailyTimelineQuery.error.message : null;
  const callsError =
    callsQuery.error instanceof Error ? callsQuery.error.message : callsQuery.error ? "Unable to load calls." : null;
  const compareTimelineError =
    compareTimelineQuery.error instanceof Error ? compareTimelineQuery.error.message : null;
  const compareDailyError =
    compareDailyTimelineQuery.error instanceof Error ? compareDailyTimelineQuery.error.message : null;

  const dailyPoints = useMemo(
    () =>
      buildDailyPoints({
        startIso: calendarRange.startIso,
        endIso: calendarRange.endIso,
        timelinePoints: dailyTimelineQuery.data?.points,
      }),
    [calendarRange.endIso, calendarRange.startIso, dailyTimelineQuery.data?.points],
  );

  const callDailyMap = useMemo(() => {
    const map = new Map<
      string,
      { callCount: number; talkSeconds: number; answeredCount: number; missedCount: number }
    >();
    for (const call of callStats?.callsInRange ?? []) {
      const startedAt = call.startedAt;
      if (!startedAt) continue;
      if (calendarRange.startDate && startedAt < calendarRange.startDate) continue;
      if (calendarRange.endDate && startedAt > calendarRange.endDate) continue;
      const key = formatDayKey(startedAt);
      const existing =
        map.get(key) ?? {
          callCount: 0,
          talkSeconds: 0,
          answeredCount: 0,
          missedCount: 0,
        };
      existing.callCount += 1;
      existing.talkSeconds += Math.max(0, call.durationSeconds ?? 0);
      if (call.answered) existing.answeredCount += 1;
      else existing.missedCount += 1;
      map.set(key, existing);
    }
    return map;
  }, [calendarRange.endDate, calendarRange.startDate, callStats?.callsInRange]);

  const calendarDays = useMemo(() => {
    return dailyPoints
      .map((point) => {
        const date = parseBucketDate("day", point.bucket);
        if (!date) return null;
        const callData = callDailyMap.get(point.bucket) ?? {
          callCount: 0,
          talkSeconds: 0,
          answeredCount: 0,
          missedCount: 0,
        };
        return {
          date,
          messageTotal: point.totalCount,
          fromMe: point.fromMeCount,
          fromThem: point.fromThemCount,
          callCount: callData.callCount,
          callSeconds: callData.talkSeconds,
          answeredCalls: callData.answeredCount,
          missedCalls: callData.missedCount,
        };
      })
      .filter(Boolean) as CalendarDay[];
  }, [callDailyMap, dailyPoints]);

  const compareDailyPoints = useMemo(
    () =>
      buildDailyPoints({
        startIso: calendarRange.startIso,
        endIso: calendarRange.endIso,
        timelinePoints: compareDailyTimelineQuery.data?.points,
      }),
    [calendarRange.endIso, calendarRange.startIso, compareDailyTimelineQuery.data?.points],
  );

  const compareCallDailyMap = useMemo(() => {
    const map = new Map<
      string,
      { callCount: number; talkSeconds: number; answeredCount: number; missedCount: number }
    >();
    for (const call of compareCallStats?.callsInRange ?? []) {
      const startedAt = call.startedAt;
      if (!startedAt) continue;
      if (calendarRange.startDate && startedAt < calendarRange.startDate) continue;
      if (calendarRange.endDate && startedAt > calendarRange.endDate) continue;
      const key = formatDayKey(startedAt);
      const existing =
        map.get(key) ?? {
          callCount: 0,
          talkSeconds: 0,
          answeredCount: 0,
          missedCount: 0,
        };
      existing.callCount += 1;
      existing.talkSeconds += Math.max(0, call.durationSeconds ?? 0);
      if (call.answered) existing.answeredCount += 1;
      else existing.missedCount += 1;
      map.set(key, existing);
    }
    return map;
  }, [calendarRange.endDate, calendarRange.startDate, compareCallStats?.callsInRange]);

  const compareCalendarDays = useMemo(() => {
    return compareDailyPoints
      .map((point) => {
        const date = parseBucketDate("day", point.bucket);
        if (!date) return null;
        const callData = compareCallDailyMap.get(point.bucket) ?? {
          callCount: 0,
          talkSeconds: 0,
          answeredCount: 0,
          missedCount: 0,
        };
        return {
          date,
          messageTotal: point.totalCount,
          fromMe: point.fromMeCount,
          fromThem: point.fromThemCount,
          callCount: callData.callCount,
          callSeconds: callData.talkSeconds,
          answeredCalls: callData.answeredCount,
          missedCalls: callData.missedCount,
        };
      })
      .filter(Boolean) as CalendarDay[];
  }, [compareCallDailyMap, compareDailyPoints]);

  const compareCalendarEntryMap = useMemo(() => {
    const map = new Map<
      string,
      {
        messageTotal: number;
        fromMe: number;
        fromThem: number;
        callCount: number;
        callSeconds: number;
      }
    >();
    for (const day of compareCalendarDays) {
      map.set(formatDayKey(day.date), {
        messageTotal: day.messageTotal,
        fromMe: day.fromMe,
        fromThem: day.fromThem,
        callCount: day.callCount,
        callSeconds: day.callSeconds,
      });
    }
    return map;
  }, [compareCalendarDays]);

  const calendarEntryMap = useMemo(() => {
    const map = new Map<
      string,
      {
        messageTotal: number;
        fromMe: number;
        fromThem: number;
        callCount: number;
        callSeconds: number;
      }
    >();
    for (const day of calendarDays) {
      map.set(formatDayKey(day.date), {
        messageTotal: day.messageTotal,
        fromMe: day.fromMe,
        fromThem: day.fromThem,
        callCount: day.callCount,
        callSeconds: day.callSeconds,
      });
    }
    return map;
  }, [calendarDays]);

  const calendarMonths = useMemo(() => {
    if (calendarDays.length === 0) return [];
    const map = new Map<
      string,
      {
        year: number;
        monthIndex: number;
        label: string;
        days: Array<{
          date: Date;
          messageTotal: number;
          fromMe: number;
          fromThem: number;
          callCount: number;
          callSeconds: number;
          answeredCalls: number;
          missedCalls: number;
        }>;
      }
    >();
    for (const entry of calendarDays) {
      const year = entry.date.getFullYear();
      const monthIndex = entry.date.getMonth();
      const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
      const existing =
        map.get(key) ??
        {
          year,
          monthIndex,
          label: formatMonthLabel(year, monthIndex),
          days: [],
        };
      existing.days.push(entry);
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
  }, [calendarDays]);

  const maxMonthCursor = Math.max(0, calendarMonths.length - 1);
  const clampedMonthCursor = Math.min(monthCursor, maxMonthCursor);
  const activeMonthIndex = calendarMonths.length > 0 ? calendarMonths.length - 1 - clampedMonthCursor : 0;
  const activeMonth = calendarMonths[activeMonthIndex] ?? null;
  const isRangeView = calendarOverrideEnabled && Boolean(calendarRange.startDate && calendarRange.endDate);
  const calendarScopeDays = useMemo(
    () => (calendarOverrideEnabled ? calendarDays : activeMonth?.days ?? []),
    [activeMonth?.days, calendarDays, calendarOverrideEnabled],
  );
  const calendarRangeLabel =
    isRangeView && calendarRange.startDate && calendarRange.endDate
      ? `${formatDateTime(calendarRange.startDate)} – ${formatDateTime(calendarRange.endDate)}`
      : null;
  const calendarStartDate = isRangeView
    ? calendarRange.startDate
    : activeMonth
      ? new Date(activeMonth.year, activeMonth.monthIndex, 1)
      : null;
  const calendarEndDate = isRangeView
    ? calendarRange.endDate
    : activeMonth
      ? new Date(activeMonth.year, activeMonth.monthIndex + 1, 0)
      : null;
  const calendarStartDay = calendarStartDate
    ? new Date(calendarStartDate.getFullYear(), calendarStartDate.getMonth(), calendarStartDate.getDate())
    : null;
  const calendarEndDay = calendarEndDate
    ? new Date(calendarEndDate.getFullYear(), calendarEndDate.getMonth(), calendarEndDate.getDate())
    : null;

  const renderCalendarSlots = (
    startDate: Date,
    endDate: Date,
    entryMap: Map<string, CalendarEntry>,
    maxDailyValue: number,
  ) => {
    const slots: Array<JSX.Element> = [];
    const rangeStart = new Date(startDate.getTime());
    const rangeEnd = new Date(endDate.getTime());
    rangeStart.setHours(0, 0, 0, 0);
    rangeEnd.setHours(0, 0, 0, 0);
    const useViolet = showCalendarCalls && !showCalendarMessages;
    const weekCursor = new Date(rangeStart.getTime());
    weekCursor.setDate(weekCursor.getDate() - weekCursor.getDay());
    const lastWeekStart = new Date(rangeEnd.getTime());
    lastWeekStart.setDate(lastWeekStart.getDate() - lastWeekStart.getDay());
    let guard = 0;
    while (weekCursor <= lastWeekStart && guard < 2000) {
      guard += 1;
      let weekMessageTotal = 0;
      let weekCallSeconds = 0;
      let weekActiveDays = 0;
      let weekScore = 0;
      for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
        const day = new Date(weekCursor.getTime());
        day.setDate(weekCursor.getDate() + dayOffset);
        const key = formatDayKey(day);
        if (day < rangeStart || day > rangeEnd) {
          slots.push(<div key={`empty-${key}`} />);
          continue;
        }
        const entry =
          entryMap.get(key) ?? {
            messageTotal: 0,
            fromMe: 0,
            fromThem: 0,
            callCount: 0,
            callSeconds: 0,
          };
        weekMessageTotal += entry.messageTotal;
        weekCallSeconds += entry.callSeconds;
        const intensityValue =
          (showCalendarMessages ? entry.messageTotal : 0) +
          (showCalendarCalls ? entry.callSeconds / 3600 : 0);
        if (intensityValue > 0) weekActiveDays += 1;
        weekScore += intensityValue;
        const ratio = maxDailyValue > 0 ? intensityValue / maxDailyValue : 0;
        const intensityClass =
          intensityValue === 0
            ? "bg-neutral-900/60 border-neutral-800/70 text-neutral-500"
            : ratio > 0.75
              ? useViolet
                ? "bg-violet-400/40 border-violet-400/50 text-violet-100"
                : "bg-emerald-400/40 border-emerald-400/50 text-emerald-100"
              : ratio > 0.45
                ? useViolet
                  ? "bg-violet-400/25 border-violet-400/30 text-violet-200"
                  : "bg-emerald-400/25 border-emerald-400/30 text-emerald-200"
                : useViolet
                  ? "bg-violet-400/10 border-violet-400/20 text-violet-200"
                  : "bg-emerald-400/10 border-emerald-400/20 text-emerald-200";
        const displayValue =
          showCalendarCalls && !showCalendarMessages
            ? formatHours(entry.callSeconds)
            : showCalendarMessages && !showCalendarCalls
              ? formatCompactNumber(entry.messageTotal)
              : formatActivityScore(intensityValue);
        slots.push(
          <div
            key={key}
            className={`group relative h-[72px] min-w-0 rounded-xl border px-2 py-2 text-[11px] font-semibold ${intensityClass}`}
            title={`${formatDate(day)} · ${formatNumber(entry.messageTotal)} messages · ${formatHours(entry.callSeconds)} call time`}
          >
            <div className="flex items-start justify-between">
              <span>{day.getDate()}</span>
              {intensityValue > 0 ? (
                <span className="text-[10px] text-neutral-200">{displayValue}</span>
              ) : null}
            </div>
            {(showCalendarMessages && entry.messageTotal > 0) || (showCalendarCalls && entry.callSeconds > 0) ? (
              <div className="mt-2 flex flex-wrap items-center gap-1 text-[9px] leading-none text-neutral-400">
                {showCalendarMessages && entry.messageTotal > 0 ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
                    {formatCompactNumber(entry.fromMe)}
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400/70" />
                    {formatCompactNumber(entry.fromThem)}
                  </>
                ) : null}
                {showCalendarCalls && entry.callSeconds > 0 ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-400/70" />
                    {formatHours(entry.callSeconds)}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>,
        );
      }
      const weekSummaryTitle = `Week of ${formatDate(weekCursor)}`;
      const showWeekMessage = showCalendarMessages && weekMessageTotal > 0;
      const showWeekCall = showCalendarCalls && weekCallSeconds > 0;
      const weekMessageLabel = showWeekMessage ? formatCompactNumber(weekMessageTotal) : null;
      const weekCallLabel = showWeekCall ? formatHours(weekCallSeconds) : null;
      const weekSummaryPrimary = [weekMessageLabel, weekCallLabel].filter(Boolean).join(" · ") || "—";
      const weekSummaryDetail =
        weekScore > 0
          ? `${weekActiveDays} active day${weekActiveDays === 1 ? "" : "s"} · ${formatActivityScore(weekScore)} activity`
          : "No activity";
      const summaryClass =
        weekScore === 0
          ? "border-neutral-800/70 bg-neutral-950/40 text-neutral-500"
          : useViolet
            ? "border-violet-400/30 bg-violet-400/10 text-violet-100"
            : "border-emerald-400/30 bg-emerald-400/10 text-emerald-100";
      const summaryLabelClass = weekScore === 0 ? "text-neutral-500" : "text-neutral-400";
      const summaryPrimaryClass = weekScore === 0 ? "text-neutral-500" : "text-neutral-100";
      const summaryPillClass =
        weekScore === 0
          ? "border-neutral-800/70 text-neutral-500"
          : useViolet
            ? "border-violet-400/40 text-violet-100"
            : "border-emerald-400/40 text-emerald-100";
      slots.push(
        <div
          key={`week-${formatDayKey(weekCursor)}`}
          className={`flex h-[72px] min-w-0 flex-col justify-between overflow-hidden rounded-xl border border-dashed px-2 py-2 text-[10px] leading-tight ${summaryClass}`}
          title={`${weekSummaryTitle} · ${formatNumber(weekMessageTotal)} messages · ${formatHours(weekCallSeconds)} call time · ${weekSummaryDetail}`}
        >
          <div className="flex min-w-0 items-center justify-between gap-1">
            <span className={`min-w-0 truncate text-[9px] font-semibold uppercase tracking-wide ${summaryLabelClass}`}>
              Wk {formatShortDate(weekCursor)}
            </span>
            {weekScore > 0 ? (
              <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${summaryPillClass}`}>
                {weekActiveDays}d
              </span>
            ) : null}
          </div>
          <span className={`truncate text-[10px] font-semibold ${summaryPrimaryClass}`}>
            {weekSummaryPrimary}
          </span>
        </div>,
      );
      weekCursor.setDate(weekCursor.getDate() + 7);
    }
    return slots;
  };

  const compareCalendarScopeDays = useMemo(() => {
    if (!calendarStartDay || !calendarEndDay) return [];
    return compareCalendarDays.filter(
      (day) => day.date >= calendarStartDay && day.date <= calendarEndDay,
    );
  }, [calendarEndDay, calendarStartDay, compareCalendarDays]);

  const calendarSummary = useMemo(
    () => computeCalendarSummary(calendarScopeDays, showCalendarMessages, showCalendarCalls),
    [calendarScopeDays, showCalendarCalls, showCalendarMessages],
  );

  const maxDaily = useMemo(
    () => computeMaxDailyValue(calendarScopeDays, showCalendarMessages, showCalendarCalls),
    [calendarScopeDays, showCalendarCalls, showCalendarMessages],
  );

  const compareCalendarSummary = useMemo(
    () => computeCalendarSummary(compareCalendarScopeDays, showCalendarMessages, showCalendarCalls),
    [compareCalendarScopeDays, showCalendarCalls, showCalendarMessages],
  );

  const compareMaxDaily = useMemo(
    () => computeMaxDailyValue(compareCalendarScopeDays, showCalendarMessages, showCalendarCalls),
    [compareCalendarScopeDays, showCalendarCalls, showCalendarMessages],
  );

  const monthlyStats = useMemo(
    () => computeMonthlyStats(calendarScopeDays, showCalendarMessages, showCalendarCalls),
    [calendarScopeDays, showCalendarCalls, showCalendarMessages],
  );

  const compareMonthlyStats = useMemo(
    () => computeMonthlyStats(compareCalendarScopeDays, showCalendarMessages, showCalendarCalls),
    [compareCalendarScopeDays, showCalendarCalls, showCalendarMessages],
  );

  const calendarUsesCallsOnly = showCalendarCalls && !showCalendarMessages;
  const globalStartInput = formatDateTimeLocalInput(range.startIso);
  const globalEndInput = formatDateTimeLocalInput(range.endIso);
  const overrideStartInput = formatDateTimeLocalInput(calendarOverrideStartIso ?? calendarRange.startIso ?? null);
  const overrideEndInput = formatDateTimeLocalInput(calendarOverrideEndIso ?? calendarRange.endIso ?? null);
  const isCompareMode = compareEnabled;

  const buildReportUrl = useCallback(
    (chatId: number) => {
      const params = new URLSearchParams();
      if (range.startIso) params.set("start", range.startIso);
      if (range.endIso) params.set("end", range.endIso);
      const query = params.toString();
      return `/reports/${chatId}${query ? `?${query}` : ""}`;
    },
    [range.endIso, range.startIso],
  );

  const statsLoading = statsQuery.isFetching;
  const callsLoading = callsQuery.isFetching;

  const renderStatsGrid = (messageStats: ReturnType<typeof aggregateMessageStats>, callStatsValue: CallStats | null, compact: boolean) => (
    <div className={`grid gap-4 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4"}`}>
      <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Messages</p>
        <p className={`mt-2 ${compact ? "text-xl" : "text-2xl"} font-semibold text-white`}>
          {statsLoading ? "…" : formatCompactNumber(messageStats.totalMessages)}
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          {formatNumber(messageStats.fromMeMessages)} from you · {formatNumber(messageStats.fromThemMessages)} from them
        </p>
      </div>
      <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Chats</p>
        <p className={`mt-2 ${compact ? "text-xl" : "text-2xl"} font-semibold text-white`}>
          {statsLoading ? "…" : formatCompactNumber(messageStats.chatCount)}
        </p>
        <p className="mt-1 text-xs text-neutral-400">Active threads with this person</p>
      </div>
      <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Calls</p>
        <p className={`mt-2 ${compact ? "text-xl" : "text-2xl"} font-semibold text-white`}>
          {callsLoading ? "…" : formatCompactNumber(callStatsValue?.totalCalls ?? 0)}
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          {formatNumber(callStatsValue?.answeredCalls ?? 0)} answered ·{" "}
          {formatNumber(callStatsValue?.missedIncomingCalls ?? 0)} missed (in)
        </p>
      </div>
      <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/60 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Talk time</p>
        <p className={`mt-2 ${compact ? "text-xl" : "text-2xl"} font-semibold text-white`}>
          {callsLoading ? "…" : formatDuration(callStatsValue?.talkSeconds ?? 0)}
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          Across {formatNumber(callStatsValue?.totalCalls ?? 0)} calls
        </p>
      </div>
    </div>
  );

  const renderCalendarSection = (options: {
    title: string;
    subtitle: string;
    entryMap: Map<string, CalendarEntry>;
    maxDailyValue: number;
    summary: ReturnType<typeof computeCalendarSummary> | null;
    monthly: ReturnType<typeof computeMonthlyStats> | null;
    isLoading: boolean;
    error?: string | null;
  }) => (
    <section className="rounded-3xl border border-neutral-800/70 bg-neutral-950/50 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{options.title}</p>
          <p className="mt-1 text-sm text-neutral-500">{options.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setShowCalendarMessages((prev) => {
                if (prev && !showCalendarCalls) return true;
                return !prev;
              })
            }
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              showCalendarMessages
                ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-100"
                : "border-neutral-800/80 bg-neutral-950/40 text-neutral-400"
            }`}
          >
            Messages
          </button>
          <button
            type="button"
            onClick={() =>
              setShowCalendarCalls((prev) => {
                if (prev && !showCalendarMessages) return true;
                return !prev;
              })
            }
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              showCalendarCalls
                ? "border-violet-400/60 bg-violet-400/10 text-violet-100"
                : "border-neutral-800/80 bg-neutral-950/40 text-neutral-400"
            }`}
          >
            Call hours
          </button>
          {!isRangeView ? (
            <>
              <button
                type="button"
                onClick={() => setMonthCursor((prev) => Math.min(maxMonthCursor, prev + 1))}
                disabled={!activeMonth || clampedMonthCursor >= maxMonthCursor}
                className="rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setMonthCursor((prev) => Math.max(0, prev - 1))}
                disabled={!activeMonth || clampedMonthCursor === 0}
                className="rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs text-neutral-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
        <button
          type="button"
          onClick={() => setCalendarOverrideEnabled((prev) => !prev)}
          className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
            calendarOverrideEnabled
              ? "border-sky-400/60 bg-sky-400/10 text-sky-100"
              : "border-neutral-800/80 bg-neutral-950/40 text-neutral-400"
          }`}
        >
          Focus range
        </button>
        <span className="text-[11px] text-neutral-500">Capped to the global range above.</span>
      </div>

      {calendarOverrideEnabled ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
          <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1">
            <span className="text-neutral-500">Start</span>
            <input
              type="datetime-local"
              value={overrideStartInput}
              min={globalStartInput || undefined}
              max={globalEndInput || undefined}
              onChange={(event) => setCalendarOverrideStartIso(parseDateTimeLocalInput(event.target.value))}
              className="bg-transparent text-neutral-200 outline-none [color-scheme:dark]"
            />
          </label>
          <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1">
            <span className="text-neutral-500">End</span>
            <input
              type="datetime-local"
              value={overrideEndInput}
              min={globalStartInput || undefined}
              max={globalEndInput || undefined}
              onChange={(event) => setCalendarOverrideEndIso(parseDateTimeLocalInput(event.target.value))}
              className="bg-transparent text-neutral-200 outline-none [color-scheme:dark]"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setCalendarOverrideStartIso(null);
              setCalendarOverrideEndIso(null);
              setCalendarOverrideEnabled(false);
            }}
            className="rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs text-neutral-300"
          >
            Clear
          </button>
        </div>
      ) : null}

      {options.isLoading ? (
        <div className="mt-6 h-72 animate-pulse rounded-2xl border border-neutral-800/70 bg-neutral-900/40" />
      ) : options.error ? (
        <p className="mt-4 text-sm text-amber-200">{options.error}</p>
      ) : (!isRangeView && !activeMonth) || (isRangeView && !calendarRange.startDate) ? (
        <p className="mt-4 text-sm text-neutral-500">No calendar data available.</p>
      ) : (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-neutral-100">
              {isRangeView ? calendarRangeLabel : activeMonth?.label}
            </h3>
            {options.summary ? (
              <p className="text-xs text-neutral-400">
                {options.summary.zeroDays} no-contact days · {options.summary.quietDays} quiet days ·{" "}
                {options.summary.busyDays} busy days
              </p>
            ) : null}
          </div>
          {options.monthly ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Total messages</p>
                <p className="mt-2 text-lg font-semibold text-white">{formatNumber(options.monthly.messageTotal)}</p>
              </div>
              <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Total call time</p>
                <p className="mt-2 text-lg font-semibold text-white">{formatHours(options.monthly.callSeconds)}</p>
                <p className="mt-1 text-[11px] text-neutral-500">{formatNumber(options.monthly.callCount)} calls</p>
              </div>
              <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Active days</p>
                <p className="mt-2 text-lg font-semibold text-white">{formatNumber(options.monthly.activeDays)}</p>
                <p className="mt-1 text-[11px] text-neutral-500">
                  {formatNumber(options.monthly.noContactDays)} no-contact days
                </p>
              </div>
              <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Busiest day</p>
                <p className="mt-2 text-lg font-semibold text-white">
                  {options.monthly.busiestDay ? formatDate(options.monthly.busiestDay) : "—"}
                </p>
                <p className="mt-1 text-[11px] text-neutral-500">
                  {options.monthly.busiestScore > 0
                    ? `${formatActivityScore(options.monthly.busiestScore)} activity`
                    : "No activity"}
                </p>
              </div>
            </div>
          ) : null}
          <div className="mt-4 overflow-hidden">
            <div className={`grid ${calendarGridTemplate} gap-2 text-xs text-neutral-500`}>
              {calendarHeaderLabels.map((label) => (
                <div key={label} className="text-center uppercase tracking-wide">
                  {label}
                </div>
              ))}
            </div>
            <div
              className={`mt-2 grid ${calendarGridTemplate} gap-2 ${
                isRangeView ? "max-h-[420px] overflow-y-auto pr-1" : ""
              }`}
            >
              {calendarStartDay && calendarEndDay
                ? renderCalendarSlots(calendarStartDay, calendarEndDay, options.entryMap, options.maxDailyValue)
                : null}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-4 text-[11px] text-neutral-500">
            <span className="flex items-center gap-2">
              <span className="h-2 w-6 rounded bg-neutral-800/80" />
              No contact
            </span>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-6 rounded ${
                  calendarUsesCallsOnly ? "bg-violet-400/15" : "bg-emerald-400/15"
                }`}
              />
              Quiet
            </span>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-6 rounded ${
                  calendarUsesCallsOnly ? "bg-violet-400/30" : "bg-emerald-400/30"
                }`}
              />
              Busy
            </span>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-6 rounded ${
                  calendarUsesCallsOnly ? "bg-violet-400/50" : "bg-emerald-400/50"
                }`}
              />
              Peak
            </span>
            {showCalendarCalls ? (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-violet-400/70" />
                Call hours
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );

  const renderCallsSection = (options: {
    callTimeline: PersonCallTimeline | null;
    callStatsValue: CallStats | null;
    note?: string | null;
  }) => (
    <section className="rounded-3xl border border-neutral-800/70 bg-neutral-950/50 p-6 shadow-lg shadow-black/30">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Calls over time</p>
          <p className="mt-1 text-sm text-neutral-500">
            {options.callTimeline ? bucketLabel(options.callTimeline.bucket) : "Timeline"}
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[2.2fr,1fr]">
        <div>
          {callsQuery.isPending || callsQuery.isFetching ? (
            <div className="h-40 animate-pulse rounded-2xl border border-neutral-800/70 bg-neutral-900/40" />
          ) : options.callTimeline ? (
            <CallsTimelineChart
              timeline={options.callTimeline}
              rangeStartIso={range.startIso}
              rangeEndIso={range.endIso}
              height={160}
              width={820}
              className="h-40 w-full"
            />
          ) : (
            <p className="mt-4 text-sm text-neutral-500">No calls in view.</p>
          )}
          {options.note ? <p className="mt-3 text-xs text-neutral-500">{options.note}</p> : null}
        </div>
        <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Recent calls</p>
          {options.callStatsValue?.recentCalls && options.callStatsValue.recentCalls.length > 0 ? (
            <div className="mt-3 space-y-2">
              {options.callStatsValue.recentCalls.map((call) => (
                <div
                  key={call.callId}
                  className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3 text-xs text-neutral-300"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-100">{call.answered ? "Answered" : "Missed"}</span>
                    <span className="text-neutral-500">{formatDuration(call.durationSeconds)}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-neutral-500">
                    {formatDateTime(call.startedAt)} · {call.direction} · {call.provider}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">No recent calls.</p>
          )}
        </div>
      </div>
    </section>
  );

  const renderMessagesSection = (options: {
    timeline: PersonMessageTimeline | undefined;
    loading: boolean;
    error: string | null;
    selectedCount: number;
  }) => (
    <section className="rounded-3xl border border-neutral-800/70 bg-neutral-950/50 p-6 shadow-lg shadow-black/30">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Messages over time</p>
          <p className="mt-1 text-sm text-neutral-500">
            {options.timeline ? bucketLabel(options.timeline.bucket) : "Timeline"}
            {options.selectedCount > 0 ? ` · ${options.selectedCount} chat${options.selectedCount === 1 ? "" : "s"} selected` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1">
            <span className="text-neutral-500">Bucket</span>
            <select
              value={bucketMode}
              onChange={(event) => setBucketMode(event.target.value as TimelineBucketMode)}
              className="bg-transparent text-neutral-200 outline-none"
            >
              <option value="auto">Auto</option>
              <option value="hour">Hourly</option>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="month">Monthly</option>
            </select>
          </label>
        </div>
      </div>

      {options.loading ? (
        <div className="mt-6 h-56 animate-pulse rounded-2xl border border-neutral-800/70 bg-neutral-900/40" />
      ) : options.error ? (
        <p className="mt-4 text-sm text-amber-200">{options.error}</p>
      ) : options.timeline ? (
        <MessagesTimelineChart
          timeline={options.timeline}
          rangeStartIso={range.startIso}
          rangeEndIso={range.endIso}
          height={180}
          width={900}
          className="h-56 w-full"
        />
      ) : (
        <p className="mt-4 text-sm text-neutral-500">No timeline available.</p>
      )}
    </section>
  );

  const renderChatFocusSection = (options: {
    title: string;
    description: string;
    filterValue: "all" | "direct" | "group";
    onFilterChange: (value: "all" | "direct" | "group") => void;
    searchValue: string;
    onSearchChange: (value: string) => void;
    chats: PersonChatSummary[];
    selectedSet: Set<number>;
    onToggle: (chatId: number) => void;
    onClear: () => void;
  }) => (
    <section className="rounded-3xl border border-neutral-800/70 bg-neutral-950/50 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{options.title}</p>
          <p className="mt-1 text-sm text-neutral-500">{options.description}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <button
            type="button"
            onClick={options.onClear}
            className="rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs text-neutral-300"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1">
          <span className="text-neutral-500">View</span>
          <select
            value={options.filterValue}
            onChange={(event) => options.onFilterChange(event.target.value as "all" | "direct" | "group")}
            className="bg-transparent text-neutral-200 outline-none"
          >
            <option value="all">All</option>
            <option value="direct">Direct</option>
            <option value="group">Group</option>
          </select>
        </label>
        <input
          value={options.searchValue}
          onChange={(event) => options.onSearchChange(event.target.value)}
          placeholder="Search chats"
          className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-100 outline-none ring-emerald-500/30 transition focus:ring-2"
        />
      </div>

      <div className="mt-4 max-h-[420px] space-y-2 overflow-y-auto pr-1">
        {statsQuery.isPending && (
          <div className="h-24 animate-pulse rounded-xl border border-neutral-800/70 bg-neutral-900/40" />
        )}
        {!statsQuery.isPending && options.chats.length === 0 && (
          <p className="text-sm text-neutral-500">No chats found.</p>
        )}
        {options.chats.map((chat) => {
          const isSelected = options.selectedSet.has(chat.chatId);
          return (
            <button
              key={chat.chatId}
              type="button"
              onClick={() => options.onToggle(chat.chatId)}
              className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                isSelected
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-neutral-800/70 bg-neutral-950/40 hover:border-neutral-700"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-neutral-100">{chat.label}</p>
                  <p className="mt-1 text-xs text-neutral-400">
                    {formatNumber(chat.totalMessages)} msgs · last {formatDateTime(chat.lastMessageAt)}
                  </p>
                </div>
                <span className="rounded-full border border-neutral-700/80 px-2 py-1 text-[10px] text-neutral-400">
                  {chat.isGroup ? "Group" : "Direct"}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-neutral-400">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80" />
                  {formatNumber(chat.fromMeMessages)}
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full bg-sky-400/80" />
                  {formatNumber(chat.fromThemMessages)}
                </span>
                <Link href={buildReportUrl(chat.chatId)} className="text-emerald-200/80 hover:text-emerald-200">
                  Open report →
                </Link>
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-neutral-500">Showing the top {statsLimit} chats in this range.</p>
    </section>
  );

  const renderColumnHeader = (options: {
    label: string;
    keyLabel: string;
    lastMessage: Date | null;
    lastCall: Date | null;
    selectLabel: string;
    selectValue: string;
    selectOptions: Array<{ id: string; label: string }>;
    onSelect: (value: string) => void;
    helperText?: string;
  }) => (
    <section className="rounded-3xl border border-neutral-800/70 bg-neutral-950/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{options.helperText}</p>
          <h2 className="mt-2 text-2xl font-semibold text-white">{options.label}</h2>
          <p className="mt-1 text-xs text-neutral-500">{options.keyLabel}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
            <span>Last message · {formatDateTime(options.lastMessage)}</span>
            <span className="text-neutral-700">•</span>
            <span>Last call · {formatDateTime(options.lastCall)}</span>
          </div>
        </div>
        <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs text-neutral-300">
          <span className="text-neutral-500">{options.selectLabel}</span>
          <select
            value={options.selectValue}
            onChange={(event) => options.onSelect(event.target.value)}
            className="max-w-[220px] bg-transparent text-neutral-100 outline-none"
          >
            {options.selectOptions.length > 0 ? (
              options.selectOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))
            ) : (
              <option value="">No other contacts</option>
            )}
          </select>
        </label>
      </div>
      <div className="mt-4">
        <GlobalRangeBar compact />
      </div>
    </section>
  );

  if (!personKey) {
    return (
      <div className="min-h-screen bg-neutral-950 px-6 py-12 text-neutral-100">
        <div className="mx-auto max-w-3xl rounded-2xl border border-neutral-800/70 bg-neutral-900/40 p-8">
          <h1 className="text-2xl font-semibold text-white">Pick a person to explore</h1>
          <p className="mt-3 text-sm text-neutral-400">
            Open a person from the dashboard and choose “Go fullscreen” to load this view.
          </p>
          <button
            type="button"
            onClick={() => router.back()}
            className="mt-6 rounded-full border border-neutral-700/80 bg-neutral-950 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="relative isolate overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.15),_rgba(10,10,10,0)_55%)]" />
        <div
          className={`relative mx-auto flex ${
            isCompareMode ? "max-w-screen-2xl" : "max-w-7xl"
          } flex-col gap-6 px-6 pb-16 pt-10`}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-400/70">
                {isCompareMode ? "Compare view" : "Person focus"}
              </p>
              <h1 className="mt-3 truncate text-3xl font-semibold text-white">
                {isCompareMode ? "Side-by-side contact comparison" : resolvedLabel || "Unknown"}
              </h1>
              <p className="mt-2 text-sm text-neutral-400">
                {isCompareMode ? "Pinned to the same global range." : personKey}
              </p>
              {!isCompareMode ? (
                <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                  <span>Last message · {formatDateTime(totalMessageStats.lastMessageAt)}</span>
                  <span className="text-neutral-700">•</span>
                  <span>Last call · {formatDateTime(callStats?.lastCallAt ?? null)}</span>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!isCompareMode ? (
                <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1 text-xs text-neutral-300">
                  <span className="text-neutral-500">Contact</span>
                  <select
                    value={personKey}
                    onChange={(event) => handlePersonChange(event.target.value)}
                    className="max-w-[220px] bg-transparent text-neutral-100 outline-none"
                  >
                    {(contactOptions.length > 0
                      ? contactOptions
                      : [{ id: personKey, label: resolvedLabel || personKey || "Unknown" }]
                    ).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  const nextEnabled = !compareEnabled;
                  const nextKey = nextEnabled ? (comparePersonKey || effectiveCompareKey) : "";
                  setCompareEnabled(nextEnabled);
                  if (nextEnabled && nextKey && nextKey !== comparePersonKey) {
                    setComparePersonKey(nextKey);
                  }
                  updateCompareParams(nextEnabled, nextKey);
                }}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  compareEnabled
                    ? "border-sky-400/60 bg-sky-400/10 text-sky-100"
                    : "border-neutral-800/80 bg-neutral-950/40 text-neutral-300"
                }`}
              >
                {compareEnabled ? "Exit compare" : "Compare"}
              </button>
              {backHref ? (
                <Link
                  href={backHref}
                  className="rounded-full border border-neutral-700/80 bg-neutral-950 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white"
                >
                  Back to dashboard
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="rounded-full border border-neutral-700/80 bg-neutral-950 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-500 hover:text-white"
                >
                  Go back
                </button>
              )}
            </div>
          </div>

          {!isCompareMode ? <GlobalRangeBar /> : null}

          {(statsQuery.error ||
            callsError ||
            timelineError ||
            (isCompareMode && (compareTimelineError || compareDailyError))) && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <p className="font-semibold text-amber-200">Some data couldn’t load</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-100/90">
                {statsQuery.error ? <li>Messages: {(statsQuery.error as Error).message}</li> : null}
                {timelineError ? <li>Timeline: {timelineError}</li> : null}
                {dailyError ? <li>Calendar: {dailyError}</li> : null}
                {callsError ? <li>Calls: {callsError}</li> : null}
                {isCompareMode && compareTimelineError ? <li>Compare timeline: {compareTimelineError}</li> : null}
                {isCompareMode && compareDailyError ? <li>Compare calendar: {compareDailyError}</li> : null}
              </ul>
            </div>
          )}

          {isCompareMode ? (
            <div className="grid gap-6 lg:grid-cols-2">
              {renderColumnHeader({
                label: resolvedLabel || "Unknown",
                keyLabel: personKey,
                lastMessage: totalMessageStats.lastMessageAt,
                lastCall: callStats?.lastCallAt ?? null,
                selectLabel: "Contact",
                selectValue: personKey,
                selectOptions:
                  contactOptions.length > 0
                    ? contactOptions
                    : [{ id: personKey, label: resolvedLabel || personKey || "Unknown" }],
                onSelect: handlePersonChange,
                helperText: "Primary",
              })}
              {renderColumnHeader({
                label: compareLabel || "Select a contact",
                keyLabel: effectiveCompareKey || "—",
                lastMessage: compareMessageStats.lastMessageAt,
                lastCall: compareCallStats?.lastCallAt ?? null,
                selectLabel: "With",
                selectValue: effectiveCompareKey,
                selectOptions: compareOptions,
                onSelect: (value) => {
                  setComparePersonKey(value);
                  updateCompareParams(true, value);
                },
                helperText: "Compare",
              })}
              {renderStatsGrid(totalMessageStats, callStats, true)}
              {renderStatsGrid(compareMessageStats, compareCallStats, true)}
              {renderCalendarSection({
                title: "Connection calendar",
                subtitle: "Day-by-day intensity for this range.",
                entryMap: calendarEntryMap,
                maxDailyValue: maxDaily,
                summary: calendarSummary,
                monthly: monthlyStats,
                isLoading: dailyTimelineQuery.isPending || dailyTimelineQuery.isFetching,
                error: dailyError,
              })}
              {renderCalendarSection({
                title: "Connection calendar",
                subtitle: "Day-by-day intensity for this range.",
                entryMap: compareCalendarEntryMap,
                maxDailyValue: compareMaxDaily,
                summary: compareCalendarSummary,
                monthly: compareMonthlyStats,
                isLoading: compareDailyTimelineQuery.isPending || compareDailyTimelineQuery.isFetching,
                error: compareDailyError,
              })}
              {renderCallsSection({ callTimeline, callStatsValue: callStats, note: callHistoryNote })}
              {renderCallsSection({
                callTimeline: compareCallTimeline,
                callStatsValue: compareCallStats,
              })}
              {renderMessagesSection({
                timeline: timelineQuery.data,
                loading: timelineQuery.isPending || timelineQuery.isFetching,
                error: timelineError,
                selectedCount: selectedChatIds.length,
              })}
              {renderMessagesSection({
                timeline: compareTimelineQuery.data,
                loading: compareTimelineQuery.isPending || compareTimelineQuery.isFetching,
                error: compareTimelineError,
                selectedCount: compareSelectedChatIds.length,
              })}
              {renderChatFocusSection({
                title: "Chat focus",
                description: "Filter charts by selecting chats.",
                filterValue: chatFilter,
                onFilterChange: setChatFilter,
                searchValue: chatSearch,
                onSearchChange: setChatSearch,
                chats: filteredChats,
                selectedSet: selectedChatSet,
                onToggle: toggleChat,
                onClear: clearSelectedChats,
              })}
              {renderChatFocusSection({
                title: "Chat focus",
                description: "Filter charts by selecting chats.",
                filterValue: compareChatFilter,
                onFilterChange: setCompareChatFilter,
                searchValue: compareChatSearch,
                onSearchChange: setCompareChatSearch,
                chats: compareFilteredChats,
                selectedSet: compareSelectedChatSet,
                onToggle: toggleCompareChat,
                onClear: clearCompareSelectedChats,
              })}
            </div>
          ) : (
            <>
              <div className="grid gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  {renderCalendarSection({
                    title: "Connection calendar",
                    subtitle: "Day-by-day intensity for this range.",
                    entryMap: calendarEntryMap,
                    maxDailyValue: maxDaily,
                    summary: calendarSummary,
                    monthly: monthlyStats,
                    isLoading: dailyTimelineQuery.isPending || dailyTimelineQuery.isFetching,
                    error: dailyError,
                  })}
                </div>
                <div className="space-y-6">
                  {renderChatFocusSection({
                    title: "Chat focus",
                    description: "Filter charts by selecting chats.",
                    filterValue: chatFilter,
                    onFilterChange: setChatFilter,
                    searchValue: chatSearch,
                    onSearchChange: setChatSearch,
                    chats: filteredChats,
                    selectedSet: selectedChatSet,
                    onToggle: toggleChat,
                    onClear: clearSelectedChats,
                  })}
                </div>
              </div>
              {renderStatsGrid(totalMessageStats, callStats, false)}
              {renderCallsSection({ callTimeline, callStatsValue: callStats, note: callHistoryNote })}
              {renderMessagesSection({
                timeline: timelineQuery.data,
                loading: timelineQuery.isPending || timelineQuery.isFetching,
                error: timelineError,
                selectedCount: selectedChatIds.length,
              })}
            </>
          )}

        </div>
      </div>
    </div>
  );
}
