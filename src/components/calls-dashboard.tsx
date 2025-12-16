'use client';

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { GlobalRangeBar } from "@/components/global-range-bar";
import { PersonDrawer, type PersonCallStats, type PersonMessageStats, type PersonMessageThread, type PersonRecentCall } from "@/components/person-drawer";
import { useGlobalRange } from "@/hooks/use-global-range";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import type { SerializableConversationStats as ConversationStats } from "@/lib/imessage/types";
import {
  type CallApiRecord,
  type CallDirection,
  type CallMedia,
  type CallParticipant,
  type CallProvider,
  fetchAllCalls,
} from "@/lib/callhistory/client";
type AnsweredFilter = "all" | "answered" | "missed";
type RankingMode = "calls" | "duration" | "outgoing" | "missed";

const rankingModeLabels: Record<RankingMode, string> = {
  duration: "talk time",
  calls: "call count",
  outgoing: "outgoing calls",
  missed: "missed incoming calls",
};

function formatNumber(value: number) {
  return value.toLocaleString();
}

const compactFormatter = Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  try {
    return compactFormatter.format(value);
  } catch {
    return formatNumber(value);
  }
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const wholeSeconds = Math.floor(seconds);
  const mins = Math.floor(wholeSeconds / 60);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  const remSecs = wholeSeconds % 60;
  if (hrs > 0) return `${hrs}h ${remMins}m`;
  if (mins > 0) return `${mins}m ${remSecs}s`;
  return `${remSecs}s`;
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getParticipantLabel(participant: CallParticipant) {
  return participant.displayName?.trim() || participant.handle;
}

function formatCallTargets(call: CallApiRecord) {
  const participants = call.participants.length
    ? call.participants
    : call.address
      ? [{ handle: call.address, displayName: call.name }]
      : [];

  const labels = participants.map(getParticipantLabel).filter(Boolean);
  if (labels.length === 0) return "Unknown";
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} focusable="false">
      <path
        fill="currentColor"
        d="M6.6 10.8c1.5 2.9 3.8 5.2 6.7 6.7l2.2-2.2c.3-.3.8-.4 1.2-.2 1.3.5 2.7.8 4.1.8.7 0 1.2.5 1.2 1.2V21c0 .7-.5 1.2-1.2 1.2C10 22.2 1.8 14 1.8 3.2 1.8 2.5 2.3 2 3 2h3.5c.7 0 1.2.5 1.2 1.2 0 1.4.3 2.8.8 4.1.1.4 0 .9-.3 1.2l-2.6 2.3z"
      />
    </svg>
  );
}

function VideoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} focusable="false">
      <path
        fill="currentColor"
        d="M15 8H5c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-1l4 3V6l-4 3V10c0-1.1-.9-2-2-2z"
      />
    </svg>
  );
}

function StatCard({
  label,
  value,
  description,
  tone = "neutral",
}: {
  label: string;
  value: string;
  description?: string;
  tone?: "neutral" | "emerald" | "sky" | "violet" | "amber";
}) {
  const toneClasses: Record<typeof tone, { wrapper: string; value: string }> = {
    neutral: {
      wrapper: "border-neutral-800/70 bg-gradient-to-br from-neutral-950 via-neutral-950/80 to-neutral-900",
      value: "text-white",
    },
    emerald: {
      wrapper: "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-neutral-950 to-neutral-950",
      value: "text-emerald-200",
    },
    sky: {
      wrapper: "border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-neutral-950 to-neutral-950",
      value: "text-sky-200",
    },
    violet: {
      wrapper: "border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-neutral-950 to-neutral-950",
      value: "text-violet-100",
    },
    amber: {
      wrapper: "border-amber-400/30 bg-gradient-to-br from-amber-400/10 via-neutral-950 to-neutral-950",
      value: "text-amber-100",
    },
  };

  return (
    <div className={`rounded-2xl border p-5 shadow-lg shadow-black/25 ${toneClasses[tone].wrapper}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <p className={`mt-3 text-3xl font-semibold ${toneClasses[tone].value}`}>{value}</p>
      {description ? <p className="mt-1 text-sm text-neutral-300">{description}</p> : null}
    </div>
  );
}

function computeDailyBuckets(calls: CallApiRecord[], { end, days }: { end: Date; days: number }) {
  const bucketEnd = end;
  const start = new Date(bucketEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const buckets = new Map<string, { date: Date; count: number }>();

  for (const call of calls) {
    const startedAt = parseDate(call.startedAt);
    if (!startedAt) continue;
    if (startedAt < start) continue;
    if (startedAt > bucketEnd) continue;
    const key = startedAt.toISOString().slice(0, 10);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const date = new Date(startedAt);
    date.setHours(0, 0, 0, 0);
    buckets.set(key, { date, count: 1 });
  }

  return Array.from(buckets.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
}

export default function CallsDashboard() {
  const { range, searchParams } = useGlobalRange();
  const preservedQuery = searchParams.toString();
  const querySuffix = preservedQuery ? `?${preservedQuery}` : "";
  const overviewHref = `/${querySuffix}`;
  const messagesHref = `/messages${querySuffix}`;
  const callsHref = `/calls${querySuffix}`;
  const [provider, setProvider] = useState<"all" | CallProvider>("all");
  const [media, setMedia] = useState<"all" | CallMedia>("all");
  const [direction, setDirection] = useState<"all" | CallDirection>("all");
  const [answeredFilter, setAnsweredFilter] = useState<AnsweredFilter>("all");
  const [rankingMode, setRankingMode] = useState<RankingMode>("duration");
  const [selectedPersonKey, setSelectedPersonKey] = useState<string | null>(null);

  const recentLimitKey = useMemo(() => {
    return JSON.stringify({
      provider,
      media,
      direction,
      answered: answeredFilter,
      start: range.startIso,
      end: range.endIso,
    });
  }, [answeredFilter, direction, media, provider, range.endIso, range.startIso]);

  const [recentLimitByKey, setRecentLimitByKey] = useState<Record<string, number>>({});
  const recentLimit = recentLimitByKey[recentLimitKey] ?? 50;

  const setRecentLimit = useCallback(
    (updater: number | ((value: number) => number)) => {
      setRecentLimitByKey((current) => {
        const existing = current[recentLimitKey] ?? 50;
        const next = typeof updater === "function" ? updater(existing) : updater;
        if (next === existing) return current;
        return { ...current, [recentLimitKey]: next };
      });
    },
    [recentLimitKey],
  );

  const callsQuery = useQuery({
    queryKey: ["calls", "all"],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const allCalls = callsQuery.data ?? [];
  const callHistoryEarliest = useMemo(() => {
    let earliest: Date | null = null;
    for (const call of allCalls) {
      const startedAt = parseDate(call.startedAt);
      if (!startedAt) continue;
      if (!earliest || startedAt < earliest) {
        earliest = startedAt;
      }
    }
    return earliest;
  }, [allCalls]);

  const messagesQueryInput = useMemo(() => {
    return {
      limit: 50,
      start: range.startIso,
      end: range.endIso,
    } as const;
  }, [range.endIso, range.startIso]);

  const messagesQuery = useStatsSummary(messagesQueryInput, {
    enabled: Boolean(selectedPersonKey),
  });
  const messagesStats = (messagesQuery.data as ConversationStats | undefined) ?? null;

  const rangeBounds = useMemo(() => {
    return { start: range.startDate, end: range.endDate };
  }, [range.endDate, range.startDate]);

  const filteredCalls = useMemo(() => {
    return allCalls.filter((call) => {
      if (provider !== "all" && call.provider !== provider) return false;
      if (media !== "all" && call.media !== media) return false;
      if (direction !== "all" && call.direction !== direction) return false;
      if (answeredFilter === "answered" && !call.answered) return false;
      if (answeredFilter === "missed" && call.answered) return false;

      if (rangeBounds.start || rangeBounds.end) {
        const startedAt = parseDate(call.startedAt);
        if (!startedAt) return false;
        if (rangeBounds.start && startedAt < rangeBounds.start) return false;
        if (rangeBounds.end && startedAt > rangeBounds.end) return false;
      }

      return true;
    });
  }, [allCalls, answeredFilter, direction, media, provider, rangeBounds.end, rangeBounds.start]);

  const totals = useMemo(() => {
    let callCount = 0;
    let answeredCount = 0;
    let missedCount = 0;
    let missedIncomingCount = 0;
    let outgoingCount = 0;
    let incomingCount = 0;
    let facetimeCount = 0;
    let telephonyCount = 0;
    let videoCount = 0;
    let audioCount = 0;
    let totalDuration = 0;
    let latest: Date | null = null;

    for (const call of filteredCalls) {
      callCount += 1;
      if (call.answered) answeredCount += 1;
      else missedCount += 1;
      if (call.direction === "incoming") incomingCount += 1;
      if (call.direction === "outgoing") outgoingCount += 1;
      if (call.direction === "incoming" && !call.answered) missedIncomingCount += 1;
      if (call.provider === "facetime") facetimeCount += 1;
      if (call.provider === "telephony") telephonyCount += 1;
      if (call.media === "video") videoCount += 1;
      if (call.media === "audio") audioCount += 1;
      totalDuration += Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;

      const startedAt = parseDate(call.startedAt);
      if (startedAt && (!latest || startedAt > latest)) latest = startedAt;
    }

    const answeredRate = callCount > 0 ? answeredCount / callCount : 0;
    const avgDuration = answeredCount > 0 ? totalDuration / answeredCount : 0;
    return {
      callCount,
      answeredCount,
      missedCount,
      missedIncomingCount,
      outgoingCount,
      incomingCount,
      facetimeCount,
      telephonyCount,
      videoCount,
      audioCount,
      totalDuration,
      answeredRate,
      avgDuration,
      latest,
    };
  }, [filteredCalls]);

  type PersonStat = {
    key: string;
    label: string;
    calls: number;
    answered: number;
    missed: number;
    missedIncoming: number;
    incoming: number;
    outgoing: number;
    totalDuration: number;
    lastCallAt: Date | null;
  };

  const peopleAggregate = useMemo(() => {
    const map = new Map<string, PersonStat>();

    for (const call of filteredCalls) {
      const participants = call.participants.length
        ? call.participants
        : call.address
          ? [{ handle: call.address, displayName: call.name }]
          : [];

      const participantKeys = new Set(
        participants.map((participant) => participant.id ?? participant.handle).filter(Boolean),
      );
      const startedAt = parseDate(call.startedAt);
      const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
      const missedIncoming = call.direction === "incoming" && !call.answered ? 1 : 0;

      for (const key of participantKeys) {
        const existing = map.get(key);
        const participant = participants.find((p) => (p.id ?? p.handle) === key);
        const handle = participant?.handle ?? key;
        const label = participant ? getParticipantLabel(participant) : handle;
        if (!existing) {
          map.set(key, {
            key,
            label,
            calls: 1,
            answered: call.answered ? 1 : 0,
            missed: call.answered ? 0 : 1,
            missedIncoming,
            incoming: call.direction === "incoming" ? 1 : 0,
            outgoing: call.direction === "outgoing" ? 1 : 0,
            totalDuration: duration,
            lastCallAt: startedAt,
          });
          continue;
        }
        existing.calls += 1;
        existing.answered += call.answered ? 1 : 0;
        existing.missed += call.answered ? 0 : 1;
        existing.missedIncoming += missedIncoming;
        existing.incoming += call.direction === "incoming" ? 1 : 0;
        existing.outgoing += call.direction === "outgoing" ? 1 : 0;
        existing.totalDuration += duration;
        if (startedAt && (!existing.lastCallAt || startedAt > existing.lastCallAt)) {
          existing.lastCallAt = startedAt;
        }
        if (existing.label === handle && participant?.displayName?.trim()) {
          existing.label = participant.displayName.trim();
        } else if (existing.label === existing.key && label !== existing.key) {
          existing.label = label;
        }
      }
    }

    return Array.from(map.values());
  }, [filteredCalls]);

  const rankedPeople = useMemo(() => {
    const list = [...peopleAggregate];
    if (rankingMode === "calls") {
      return list.sort(
        (a, b) =>
          b.calls - a.calls ||
          b.totalDuration - a.totalDuration ||
          a.label.localeCompare(b.label),
      );
    }
    if (rankingMode === "outgoing") {
      return list.sort(
        (a, b) =>
          b.outgoing - a.outgoing ||
          b.calls - a.calls ||
          b.totalDuration - a.totalDuration ||
          a.label.localeCompare(b.label),
      );
    }
    if (rankingMode === "missed") {
      return list.sort(
        (a, b) =>
          b.missedIncoming - a.missedIncoming ||
          b.missed - a.missed ||
          b.calls - a.calls ||
          a.label.localeCompare(b.label),
      );
    }
    return list.sort(
      (a, b) =>
        b.totalDuration - a.totalDuration ||
        b.calls - a.calls ||
        a.label.localeCompare(b.label),
    );
  }, [peopleAggregate, rankingMode]);

  const dailyBucketEnd = useMemo(() => rangeBounds.end ?? new Date(), [rangeBounds.end]);
  const dailyBuckets = useMemo(
    () => computeDailyBuckets(filteredCalls, { end: dailyBucketEnd, days: 30 }),
    [dailyBucketEnd, filteredCalls],
  );
  const dailyMax = useMemo(
    () => dailyBuckets.reduce((max, bucket) => (bucket.count > max ? bucket.count : max), 0),
    [dailyBuckets],
  );

  const highlights = useMemo(() => {
    const longestCall = filteredCalls.reduce<CallApiRecord | null>((best, call) => {
      const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
      if (duration <= 0) return best;
      if (!best) return call;
      return duration > best.durationSeconds ? call : best;
    }, null);

    const busiestDay = dailyBuckets.reduce<{ date: Date; count: number } | null>((best, bucket) => {
      if (!best) return bucket;
      return bucket.count > best.count ? bucket : best;
    }, null);

    const mostOutgoing = [...peopleAggregate]
      .sort((a, b) => b.outgoing - a.outgoing || b.calls - a.calls || a.label.localeCompare(b.label))
      .find((person) => person.outgoing > 0) ?? null;

    const mostMissedIncoming = [...peopleAggregate]
      .sort(
        (a, b) =>
          b.missedIncoming - a.missedIncoming || b.calls - a.calls || a.label.localeCompare(b.label),
      )
      .find((person) => person.missedIncoming > 0) ?? null;

    return {
      longestCall,
      busiestDay,
      mostOutgoing,
      mostMissedIncoming,
    };
  }, [dailyBuckets, filteredCalls, peopleAggregate]);

  const recentCalls = useMemo(() => filteredCalls.slice(0, recentLimit), [filteredCalls, recentLimit]);
  const hasMoreRecent = recentLimit < filteredCalls.length;

  const accessError = callsQuery.error ? (callsQuery.error as Error).message : null;

  const buildReportUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (range.startIso) params.set("start", range.startIso);
    if (range.endIso) params.set("end", range.endIso);
    const query = params.toString();
    return (chatId: number) => `/reports/${chatId}${query ? `?${query}` : ""}`;
  }, [range.endIso, range.startIso]);

  const selectedCallSummary = useMemo(() => {
    if (!selectedPersonKey) return null;
    return peopleAggregate.find((person) => person.key === selectedPersonKey) ?? null;
  }, [peopleAggregate, selectedPersonKey]);

  const selectedPerson = useMemo(() => {
    if (!selectedPersonKey) return null;
    return {
      key: selectedPersonKey,
      label: selectedCallSummary?.label ?? "Unknown",
    };
  }, [selectedCallSummary?.label, selectedPersonKey]);

  const selectedRecentCalls = useMemo<PersonRecentCall[]>(() => {
    if (!selectedPersonKey) return [];
    const matches: PersonRecentCall[] = [];
    for (const call of filteredCalls) {
      const participants = call.participants.length
        ? call.participants
        : call.address
          ? [{ handle: call.address, displayName: call.name }]
          : [];
      const keys = new Set(
        participants.map((participant) => participant.id ?? participant.handle).filter(Boolean),
      );
      if (!keys.has(selectedPersonKey)) continue;
      matches.push({
        callId: call.callId,
        startedAt: parseDate(call.startedAt),
        durationSeconds: Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0,
        answered: call.answered,
        direction: call.direction,
        provider: call.provider,
        media: call.media,
      });
    }
    matches.sort(
      (a, b) =>
        (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0) ||
        b.callId - a.callId,
    );
    return matches;
  }, [filteredCalls, selectedPersonKey]);

  const selectedCallStats = useMemo<PersonCallStats | null>(() => {
    if (!selectedCallSummary) return null;
    return {
      totalCalls: selectedCallSummary.calls,
      incomingCalls: selectedCallSummary.incoming,
      outgoingCalls: selectedCallSummary.outgoing,
      answeredCalls: selectedCallSummary.answered,
      missedIncomingCalls: selectedCallSummary.missedIncoming,
      talkSeconds: selectedCallSummary.totalDuration,
      lastCallAt: selectedCallSummary.lastCallAt,
      recentCalls: selectedRecentCalls.slice(0, 8),
      callsInRange: selectedRecentCalls,
    };
  }, [selectedCallSummary, selectedRecentCalls]);

  const selectedMessageStats = useMemo<PersonMessageStats | null>(() => {
    if (!selectedPersonKey || !messagesStats) return null;
    let totalMessages = 0;
    let fromMeMessages = 0;
    let fromThemMessages = 0;
    let lastMessageAt: Date | null = null;
    const chatIds = new Set<number>();
    const threads: PersonMessageThread[] = [];

    for (const chat of messagesStats.topChats ?? []) {
      const mySent = Math.max(0, chat.sentCount ?? 0);
      const participant = (chat.messageParticipants ?? []).find((p) => {
        const isSelf = Boolean(p.isMe || p.id === "me");
        if (isSelf) return false;
        const key = p.id ?? p.displayName ?? `unknown-${chat.chatId}`;
        return key === selectedPersonKey;
      });
      if (!participant) continue;

      const fromThem = Math.max(0, participant.messageCount ?? 0);
      const total = mySent + fromThem;
      totalMessages += total;
      fromMeMessages += mySent;
      fromThemMessages += fromThem;
      chatIds.add(chat.chatId);

      const chatLast = parseDate(chat.lastMessageAt ?? null);
      if (chatLast && (!lastMessageAt || chatLast > lastMessageAt)) {
        lastMessageAt = chatLast;
      }

      const label =
        chat.chatDisplayName ??
        (chat.participants.length > 0 ? chat.participants.join(", ") : `Chat ${chat.chatId}`);
      threads.push({
        chatId: chat.chatId,
        label,
        isGroup: Boolean(chat.isGroup),
        totalMessages: total,
        fromMeMessages: mySent,
        fromThemMessages: fromThem,
        lastMessageAt: chatLast,
        href: buildReportUrl(chat.chatId),
      });
    }

    threads.sort(
      (a, b) =>
        b.totalMessages - a.totalMessages ||
        (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0) ||
        a.label.localeCompare(b.label),
    );

    return {
      totalMessages,
      fromMeMessages,
      fromThemMessages,
      chatCount: chatIds.size,
      lastMessageAt,
      threads: threads.slice(0, 8),
    };
  }, [buildReportUrl, messagesStats, selectedPersonKey]);

  const messagesError =
    messagesQuery.error instanceof Error
      ? messagesQuery.error.message
      : messagesQuery.error
        ? "Unable to load messages."
        : null;

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-neutral-100">
      <header className="border-b border-neutral-900/60 bg-neutral-950/95 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={overviewHref}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Overview
              </Link>
              <Link
                href={messagesHref}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Messages
              </Link>
              <Link
                href={callsHref}
                className="rounded-full border border-neutral-800/80 bg-white/5 px-3 py-1 text-xs font-semibold text-white"
              >
                Calls
              </Link>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
              <span className="rounded-full border border-neutral-800/70 bg-neutral-900/40 px-3 py-1">
                {callsQuery.isPending ? "Loading…" : `${formatNumber(filteredCalls.length)} calls`}
              </span>
              {totals.latest ? (
                <span className="rounded-full border border-neutral-800/70 bg-neutral-900/40 px-3 py-1">
                  Latest · {totals.latest.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Calls</h1>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-10">
        <GlobalRangeBar />
        <section className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Filters</p>
              <p className="mt-1 text-sm text-neutral-300">Slice by provider, media type, direction, and outcome.</p>
            </div>
            <button
              type="button"
              onClick={() => callsQuery.refetch()}
              className="inline-flex items-center justify-center rounded-full border border-neutral-800/80 bg-neutral-900/70 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              disabled={callsQuery.isFetching}
            >
              {callsQuery.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Provider</span>
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value as typeof provider)}
                className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-400/40 transition focus:ring-2"
              >
                <option value="all">All</option>
                <option value="facetime">FaceTime</option>
                <option value="telephony">Phone</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Media</span>
              <select
                value={media}
                onChange={(event) => setMedia(event.target.value as typeof media)}
                className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-400/40 transition focus:ring-2"
              >
                <option value="all">All</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Direction</span>
              <select
                value={direction}
                onChange={(event) => setDirection(event.target.value as typeof direction)}
                className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-400/40 transition focus:ring-2"
              >
                <option value="all">All</option>
                <option value="incoming">Incoming</option>
                <option value="outgoing">Outgoing</option>
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Outcome</span>
              <select
                value={answeredFilter}
                onChange={(event) => setAnsweredFilter(event.target.value as AnsweredFilter)}
                className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-400/40 transition focus:ring-2"
              >
                <option value="all">All</option>
                <option value="answered">Answered</option>
                <option value="missed">Missed / no answer</option>
              </select>
            </label>
          </div>

          {accessError ? (
            <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <p className="font-semibold text-amber-200">Can’t read Call History</p>
              <p className="mt-1 text-amber-100/90">
                {accessError} Grant your terminal “Full Disk Access” (System Settings → Privacy &amp; Security) and refresh.
              </p>
            </div>
          ) : null}
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <StatCard
            label="Calls"
            value={callsQuery.isPending ? "—" : formatCompactNumber(totals.callCount)}
            description={callsQuery.isPending ? "Loading history" : `${Math.round(totals.answeredRate * 100)}% connected`}
            tone="neutral"
          />
          <StatCard
            label="Talk time"
            value={callsQuery.isPending ? "—" : formatDuration(totals.totalDuration)}
            description={totals.answeredCount > 0 ? `Avg · ${formatDuration(totals.avgDuration)}` : "No answered calls"}
            tone="emerald"
          />
          <StatCard
            label="Missed"
            value={callsQuery.isPending ? "—" : formatCompactNumber(totals.missedIncomingCount)}
            description={`${formatNumber(totals.missedCount)} not answered`}
            tone="amber"
          />
          <StatCard
            label="Outgoing"
            value={callsQuery.isPending ? "—" : formatCompactNumber(totals.outgoingCount)}
            description={`${formatNumber(totals.incomingCount)} incoming`}
            tone="sky"
          />
          <StatCard
            label="FaceTime"
            value={callsQuery.isPending ? "—" : formatCompactNumber(totals.facetimeCount)}
            description={`${formatNumber(totals.telephonyCount)} phone`}
            tone="violet"
          />
          <StatCard
            label="Video"
            value={callsQuery.isPending ? "—" : formatCompactNumber(totals.videoCount)}
            description={`${formatNumber(totals.audioCount)} audio`}
            tone="amber"
          />
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Longest call"
            value={
              highlights.longestCall
                ? formatDuration(highlights.longestCall.durationSeconds)
                : "—"
            }
            description={
              highlights.longestCall
                ? (() => {
                    const startedAt = parseDate(highlights.longestCall.startedAt);
                    const when = startedAt
                      ? startedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                      : "Unknown date";
                    return `${formatCallTargets(highlights.longestCall)} · ${when}`;
                  })()
                : "—"
            }
            tone="neutral"
          />
          <StatCard
            label="Busiest day (30d)"
            value={highlights.busiestDay ? formatNumber(highlights.busiestDay.count) : "—"}
            description={
              highlights.busiestDay
                ? highlights.busiestDay.date.toLocaleDateString(undefined, { dateStyle: "medium" })
                : "—"
            }
            tone="neutral"
          />
          <StatCard
            label="Most outgoing"
            value={highlights.mostOutgoing ? formatNumber(highlights.mostOutgoing.outgoing) : "—"}
            description={highlights.mostOutgoing ? highlights.mostOutgoing.label : "—"}
            tone="neutral"
          />
          <StatCard
            label="Most missed (in)"
            value={
              highlights.mostMissedIncoming ? formatNumber(highlights.mostMissedIncoming.missedIncoming) : "—"
            }
            description={highlights.mostMissedIncoming ? highlights.mostMissedIncoming.label : "—"}
            tone="neutral"
          />
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top people</p>
                <p className="mt-1 text-sm text-neutral-300">
                  Ranked by {rankingModeLabels[rankingMode]}.
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-900/60 p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setRankingMode("duration")}
                  className={`rounded-full px-3 py-1 font-semibold transition ${
                    rankingMode === "duration" ? "bg-white/10 text-white" : "text-neutral-300 hover:text-white"
                  }`}
                >
                  Talk time
                </button>
                <button
                  type="button"
                  onClick={() => setRankingMode("calls")}
                  className={`rounded-full px-3 py-1 font-semibold transition ${
                    rankingMode === "calls" ? "bg-white/10 text-white" : "text-neutral-300 hover:text-white"
                  }`}
                >
                  Calls
                </button>
                <button
                  type="button"
                  onClick={() => setRankingMode("outgoing")}
                  className={`rounded-full px-3 py-1 font-semibold transition ${
                    rankingMode === "outgoing" ? "bg-white/10 text-white" : "text-neutral-300 hover:text-white"
                  }`}
                >
                  Outgoing
                </button>
                <button
                  type="button"
                  onClick={() => setRankingMode("missed")}
                  className={`rounded-full px-3 py-1 font-semibold transition ${
                    rankingMode === "missed" ? "bg-white/10 text-white" : "text-neutral-300 hover:text-white"
                  }`}
                >
                  Missed
                </button>
              </div>
            </div>

            <ul className="mt-4 space-y-3">
              {callsQuery.isPending ? (
                Array.from({ length: 8 }).map((_, index) => (
                  <li key={`person-skel-${index}`} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                    <div className="h-3 w-40 animate-pulse rounded bg-neutral-800/60" />
                    <div className="mt-2 h-3 w-56 animate-pulse rounded bg-neutral-800/60" />
                  </li>
                ))
              ) : rankedPeople.length === 0 ? (
                <li className="text-sm text-neutral-400">No calls match these filters.</li>
              ) : (
                rankedPeople.slice(0, 12).map((person, index) => {
                  const primaryMetric =
                    rankingMode === "duration"
                      ? formatDuration(person.totalDuration)
                      : rankingMode === "calls"
                        ? formatNumber(person.calls)
                        : rankingMode === "outgoing"
                          ? formatNumber(person.outgoing)
                          : formatNumber(person.missedIncoming);
                  const secondary =
                    rankingMode === "duration"
                      ? `${formatNumber(person.calls)} call${person.calls === 1 ? "" : "s"}`
                      : rankingMode === "calls"
                        ? `${formatDuration(person.totalDuration)} talk time`
                        : rankingMode === "outgoing"
                          ? `${formatNumber(person.calls)} total · ${formatNumber(person.incoming)} incoming`
                          : person.incoming > 0
                            ? `${Math.round((person.missedIncoming / person.incoming) * 100)}% missed · ${formatNumber(person.incoming)} incoming`
                            : `${formatNumber(person.calls)} total`;
                  const last = person.lastCallAt
                    ? person.lastCallAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                    : "—";
                  return (
                    <li
                      key={person.key}
                      className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-0 transition hover:border-neutral-700"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedPersonKey(person.key)}
                        className="w-full p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <div className="flex items-center justify-between gap-4">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-neutral-50">
                              <span className="mr-2 text-xs font-semibold text-neutral-500">#{index + 1}</span>
                              {person.label}
                            </p>
                            <p className="mt-1 text-xs text-neutral-400">
                              {secondary} · {formatNumber(person.answered)} answered · {formatNumber(person.missedIncoming)} missed (in) · last {last}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-sm font-semibold text-emerald-200">{primaryMetric}</p>
                            <p className="mt-1 text-xs text-neutral-500">{person.incoming} in · {person.outgoing} out</p>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Daily calls</p>
                <p className="mt-1 text-sm text-neutral-300">Last 30 days (current filters).</p>
              </div>
              <span className="text-xs text-neutral-500">Count</span>
            </div>

            <div className="mt-4 space-y-2">
              {callsQuery.isPending ? (
                Array.from({ length: 10 }).map((_, index) => (
                  <div key={`day-skel-${index}`} className="flex items-center gap-3">
                    <div className="h-3 w-20 animate-pulse rounded bg-neutral-800/60" />
                    <div className="h-2 flex-1 animate-pulse rounded bg-neutral-800/60" />
                    <div className="h-3 w-10 animate-pulse rounded bg-neutral-800/60" />
                  </div>
                ))
              ) : dailyBuckets.length === 0 ? (
                <p className="text-sm text-neutral-400">No calls in the last 30 days for this view.</p>
              ) : (
                dailyBuckets.slice(-14).map((bucket) => {
                  const width = dailyMax ? Math.max(4, (bucket.count / dailyMax) * 100) : 0;
                  const label = bucket.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                  return (
                    <div key={bucket.date.toISOString()} className="flex items-center gap-3">
                      <span className="w-20 text-xs text-neutral-400">{label}</span>
                      <div className="h-2 flex-1 rounded-full bg-neutral-900">
                        <div className="h-full rounded-full bg-sky-400/80" style={{ width: `${width}%` }} />
                      </div>
                      <span className="w-10 text-right text-xs font-semibold text-neutral-200">{bucket.count}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Recent calls</p>
              <p className="mt-1 text-sm text-neutral-300">
                Showing {formatNumber(Math.min(filteredCalls.length, recentLimit))} of {formatNumber(filteredCalls.length)} calls.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasMoreRecent ? (
                <>
                  <button
                    type="button"
                    onClick={() => setRecentLimit((value) => Math.min(filteredCalls.length, value + 50))}
                    className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
                  >
                    Show more
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecentLimit(filteredCalls.length)}
                    className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
                  >
                    Show all
                  </button>
                </>
              ) : null}
              <span className="text-xs text-neutral-500">Duration</span>
            </div>
          </div>

          <div className="mt-4 divide-y divide-neutral-900/60 overflow-hidden rounded-xl border border-neutral-900/60">
            {callsQuery.isPending ? (
              Array.from({ length: 8 }).map((_, index) => (
                <div key={`recent-skel-${index}`} className="flex items-center gap-3 bg-neutral-950/40 px-4 py-3">
                  <div className="h-8 w-8 animate-pulse rounded-full bg-neutral-800/60" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-800/60" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-800/60" />
                  </div>
                  <div className="h-3 w-16 animate-pulse rounded bg-neutral-800/60" />
                </div>
              ))
            ) : recentCalls.length === 0 ? (
              <div className="bg-neutral-950/40 px-4 py-6 text-sm text-neutral-400">No calls found.</div>
            ) : (
              recentCalls.map((call) => {
                const startedAt = parseDate(call.startedAt);
                const when = startedAt
                  ? startedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
                  : "Unknown time";
                const icon =
                  call.provider === "facetime" && call.media === "video" ? (
                    <VideoIcon className="h-4 w-4 text-violet-200" />
                  ) : call.provider === "facetime" ? (
                    <PhoneIcon className="h-4 w-4 text-violet-200" />
                  ) : (
                    <PhoneIcon className="h-4 w-4 text-sky-200" />
                  );

                const participants = call.participants.length
                  ? call.participants.map(getParticipantLabel)
                  : call.name
                    ? [call.name]
                    : call.address
                      ? [call.address]
                      : ["Unknown"];

                const outcomeTone = call.answered ? "text-emerald-200" : "text-amber-200";
                const directionLabel =
                  call.direction === "incoming" ? "Incoming" : call.direction === "outgoing" ? "Outgoing" : "Unknown";

                return (
                  <div key={call.callId} className="flex items-center gap-4 bg-neutral-950/40 px-4 py-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5">
                      {icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <p className="truncate text-sm font-semibold text-neutral-50">
                          {participants.join(", ")}
                        </p>
                        <span className={`text-xs font-semibold ${outcomeTone}`}>
                          {call.answered ? "Answered" : "Missed"}
                        </span>
                        <span className="text-xs text-neutral-500">{directionLabel}</span>
                        <span className="text-xs text-neutral-500">{call.provider === "facetime" ? "FaceTime" : "Phone"}</span>
                        {call.media !== "unknown" ? (
                          <span className="text-xs text-neutral-500">{call.media}</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-neutral-400">{when}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-neutral-100">{formatDuration(call.durationSeconds)}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </main>

      <PersonDrawer
        open={Boolean(selectedPersonKey)}
        onClose={() => setSelectedPersonKey(null)}
        person={selectedPerson}
        messages={selectedMessageStats}
        calls={selectedCallStats}
        rangeStartIso={range.startIso}
        rangeEndIso={range.endIso}
        callHistoryEarliest={callHistoryEarliest}
        isMessagesLoading={messagesQuery.isPending || messagesQuery.isFetching}
        isCallsLoading={callsQuery.isPending || callsQuery.isFetching}
        messagesError={messagesError}
        callsError={accessError}
      />
    </div>
  );
}
