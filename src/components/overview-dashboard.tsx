'use client';

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { GlobalRangeBar } from "@/components/global-range-bar";
import { PersonDrawer, type PersonCallStats, type PersonMessageStats, type PersonMessageThread, type PersonRecentCall } from "@/components/person-drawer";
import { useGlobalRange } from "@/hooks/use-global-range";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import type { SerializableConversationStats as ConversationStats } from "@/lib/imessage/types";
import { fetchAllCalls, type CallApiRecord } from "@/lib/callhistory/client";

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

function formatPercent(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  return `${Math.round(value * 100)}%`;
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function StatCard({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-3 text-3xl font-semibold text-white">{value}</p>
      {description ? <p className="mt-1 text-sm text-neutral-300">{description}</p> : null}
    </div>
  );
}

type PersonAggregate = {
  key: string;
  label: string;
  calls: number;
  durationSeconds: number;
  answered: number;
  missedIncoming: number;
  outgoing: number;
  lastCallAt: Date | null;
};

function getCallParticipants(call: CallApiRecord) {
  if (call.participants.length > 0) return call.participants;
  if (call.address) return [{ handle: call.address, displayName: call.name }];
  return [];
}

function aggregateCallPeople(calls: CallApiRecord[]) {
  const map = new Map<string, PersonAggregate>();

  for (const call of calls) {
    const participants = getCallParticipants(call);
    const keys = new Set(
      participants
        .map((participant) => participant.id ?? participant.handle)
        .filter(Boolean),
    );
    const startedAt = parseDate(call.startedAt);
    const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
    const missedIncoming = call.direction === "incoming" && !call.answered ? 1 : 0;
    const outgoing = call.direction === "outgoing" ? 1 : 0;

    for (const key of keys) {
      const participant = participants.find((p) => (p.id ?? p.handle) === key);
      const handle = participant?.handle ?? key;
      const label = participant?.displayName?.trim() || handle;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          label,
          calls: 1,
          durationSeconds: duration,
          answered: call.answered ? 1 : 0,
          missedIncoming,
          outgoing,
          lastCallAt: startedAt,
        });
        continue;
      }

      existing.calls += 1;
      existing.durationSeconds += duration;
      existing.answered += call.answered ? 1 : 0;
      existing.missedIncoming += missedIncoming;
      existing.outgoing += outgoing;
      if (startedAt && (!existing.lastCallAt || startedAt > existing.lastCallAt)) {
        existing.lastCallAt = startedAt;
      }
      if (existing.label === existing.key && label !== existing.key) {
        existing.label = label;
      }
    }
  }

  return Array.from(map.values());
}

export default function OverviewDashboard() {
  const { range, searchParams } = useGlobalRange();
  const preservedQuery = searchParams.toString();
  const querySuffix = preservedQuery ? `?${preservedQuery}` : "";
  const overviewHref = `/${querySuffix}`;
  const messagesHref = `/messages${querySuffix}`;
  const callsHref = `/calls${querySuffix}`;
  const [selectedPersonKey, setSelectedPersonKey] = useState<string | null>(null);
  type ContactActivity = {
    key: string;
    label: string;
    messageCount: number;
    fromMeCount: number;
    fromThemCount: number;
    callCount: number;
    talkSeconds: number;
    missedIncoming: number;
    outgoingCalls: number;
    lastActivityAt: Date | null;
  };

  const messagesQueryInput = useMemo(() => {
    if (!range.startIso || !range.endIso) {
      return { limit: 50 } as const;
    }
    return {
      limit: 50,
      start: range.startIso,
      end: range.endIso,
    } as const;
  }, [range.endIso, range.startIso]);
  const {
    data: messagesData,
    isPending: messagesLoading,
    isFetching: messagesFetching,
    error: messagesErrorRaw,
    refetch: refetchMessages,
  } = useStatsSummary(messagesQueryInput);

  const callsQuery = useQuery({
    queryKey: ["calls", "all"],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const messages = (messagesData as ConversationStats | undefined) ?? null;
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

  const filteredCalls = useMemo(() => {
    const start = range.startDate;
    const end = range.endDate;
    if (!start || !end) return allCalls;
    return allCalls.filter((call) => {
      const startedAt = parseDate(call.startedAt);
      if (!startedAt) return false;
      return startedAt >= start && startedAt <= end;
    });
  }, [allCalls, range.endIso, range.startIso, range.endDate, range.startDate]);

  const callTotals = useMemo(() => {
    let totalDuration = 0;
    let answered = 0;
    let missed = 0;
    let latest: Date | null = null;

    for (const call of filteredCalls) {
      totalDuration += Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
      if (call.answered) answered += 1;
      else missed += 1;
      const startedAt = parseDate(call.startedAt);
      if (startedAt && (!latest || startedAt > latest)) latest = startedAt;
    }

    const callCount = filteredCalls.length;
    const connectRate = callCount > 0 ? answered / callCount : 0;
    const avgDuration = answered > 0 ? totalDuration / answered : 0;
    return { callCount, answered, missed, totalDuration, connectRate, avgDuration, latest };
  }, [filteredCalls]);

  const callPeople = useMemo(() => aggregateCallPeople(filteredCalls), [filteredCalls]);

  const topCalledPeople = useMemo(() => {
    return callPeople
      .filter((person) => person.calls > 0)
      .sort(
        (a, b) =>
          b.durationSeconds - a.durationSeconds ||
          b.calls - a.calls ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 6);
  }, [callPeople]);

  const missedCallLeader = useMemo(() => {
    const top = callPeople
      .sort(
        (a, b) =>
          b.missedIncoming - a.missedIncoming ||
          b.calls - a.calls ||
          a.label.localeCompare(b.label),
      )
      .find((person) => person.missedIncoming > 0);
    return top ?? null;
  }, [callPeople]);

  const messagePeople = useMemo(() => {
    if (!messages) return [];

    const aggregate = new Map<
      string,
      {
        key: string;
        label: string;
        messageCount: number;
        fromMeCount: number;
        fromThemCount: number;
        chatIds: Set<number>;
        lastMessageAt: Date | null;
      }
    >();

    for (const chat of messages.topChats ?? []) {
      const mySent = Math.max(0, chat.sentCount ?? 0);
      const chatLastMessageAt = parseDate(chat.lastMessageAt ?? null);

      for (const participant of chat.messageParticipants ?? []) {
        const isSelf = Boolean(participant.isMe || participant.id === "me");
        if (isSelf) continue;

        const key = participant.id ?? participant.displayName ?? `unknown-${chat.chatId}`;
        const label = participant.displayName ?? "Unknown";
        const fromThem = Math.max(0, participant.messageCount ?? 0);

        const existing =
          aggregate.get(key) ??
          {
            key,
            label,
            messageCount: 0,
            fromMeCount: 0,
            fromThemCount: 0,
            chatIds: new Set<number>(),
            lastMessageAt: null,
          };

        existing.messageCount += mySent + fromThem;
        existing.fromMeCount += mySent;
        existing.fromThemCount += fromThem;
        existing.chatIds.add(chat.chatId);

        if (chatLastMessageAt && (!existing.lastMessageAt || chatLastMessageAt > existing.lastMessageAt)) {
          existing.lastMessageAt = chatLastMessageAt;
        }

        if (existing.label === "Unknown" && label !== "Unknown") {
          existing.label = label;
        }

        aggregate.set(key, existing);
      }
    }

    return Array.from(aggregate.values())
      .map((entry) => ({
        key: entry.key,
        label: entry.label,
        messageCount: entry.messageCount,
        fromMeCount: entry.fromMeCount,
        fromThemCount: entry.fromThemCount,
        chatCount: entry.chatIds.size,
        lastMessageAt: entry.lastMessageAt,
      }))
      .sort(
        (a, b) =>
          b.messageCount - a.messageCount ||
          b.fromThemCount - a.fromThemCount ||
          a.label.localeCompare(b.label),
      );
  }, [messages]);

  const mostContacted = useMemo(() => {
    const combined = new Map<string, ContactActivity>();

    for (const person of messagePeople) {
      combined.set(person.key, {
        key: person.key,
        label: person.label,
        messageCount: person.messageCount,
        fromMeCount: person.fromMeCount,
        fromThemCount: person.fromThemCount,
        callCount: 0,
        talkSeconds: 0,
        missedIncoming: 0,
        outgoingCalls: 0,
        lastActivityAt: person.lastMessageAt,
      });
    }

    for (const person of callPeople) {
      const existing =
        combined.get(person.key) ??
        {
          key: person.key,
          label: person.label,
          messageCount: 0,
          fromMeCount: 0,
          fromThemCount: 0,
          callCount: 0,
          talkSeconds: 0,
          missedIncoming: 0,
          outgoingCalls: 0,
          lastActivityAt: null,
        };

      existing.callCount += person.calls;
      existing.talkSeconds += person.durationSeconds;
      existing.missedIncoming += person.missedIncoming;
      existing.outgoingCalls += person.outgoing;

      if (person.lastCallAt && (!existing.lastActivityAt || person.lastCallAt > existing.lastActivityAt)) {
        existing.lastActivityAt = person.lastCallAt;
      }

      if (existing.label === existing.key && person.label !== person.key) {
        existing.label = person.label;
      }

      combined.set(person.key, existing);
    }

    const activityScore = (entry: ContactActivity) => {
      const messageScore = Math.log1p(Math.max(0, entry.messageCount));
      const callScore = Math.log1p(Math.max(0, entry.callCount));
      const talkScore = Math.log1p(Math.max(0, entry.talkSeconds) / 60) * 0.6;
      return messageScore + callScore + talkScore;
    };

    return Array.from(combined.values())
      .filter((entry) => entry.messageCount > 0 || entry.callCount > 0)
      .sort((a, b) => {
        const diff = activityScore(b) - activityScore(a);
        if (diff !== 0) return diff;
        return (
          b.messageCount - a.messageCount ||
          b.callCount - a.callCount ||
          b.talkSeconds - a.talkSeconds ||
          a.label.localeCompare(b.label)
        );
      })
      .slice(0, 10);
  }, [callPeople, messagePeople]);

  const messagesLatest = parseDate(messages?.latestMessageAt ?? null);
  const latestActivity = useMemo(() => {
    if (!messagesLatest && !callTotals.latest) return null;
    if (!messagesLatest) return callTotals.latest;
    if (!callTotals.latest) return messagesLatest;
    return messagesLatest > callTotals.latest ? messagesLatest : callTotals.latest;
  }, [callTotals.latest, messagesLatest]);

  const messageTotals = messages?.totals ?? null;
  const firstReplyTimes = messages?.firstReplyTimes ?? null;
  const myMedian = firstReplyTimes?.meResponding?.medianSeconds ?? null;
  const theirMedian = firstReplyTimes?.themResponding?.medianSeconds ?? null;
  const messagesPerCall =
    messageTotals && callTotals.callCount > 0 ? messageTotals.messageCount / callTotals.callCount : null;

  const topChats = messages?.topChats?.slice(0, 6) ?? [];
  const topPeopleByMessages = messagePeople.slice(0, 6);

  const messagesError =
    messagesErrorRaw instanceof Error ? messagesErrorRaw.message : messagesErrorRaw ? "Unable to load messages." : null;
  const callsError =
    callsQuery.error instanceof Error ? callsQuery.error.message : callsQuery.error ? "Unable to load calls." : null;

  const handleRefresh = async () => {
    await Promise.allSettled([refetchMessages(), callsQuery.refetch()]);
  };

  const isRefreshing = messagesFetching || callsQuery.isFetching;

  const personLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of messagePeople) {
      map.set(person.key, person.label);
    }
    for (const person of callPeople) {
      const existing = map.get(person.key);
      if (!existing || existing === person.key) {
        map.set(person.key, person.label);
      }
    }
    return map;
  }, [callPeople, messagePeople]);

  const selectedPerson = useMemo(() => {
    if (!selectedPersonKey) return null;
    return {
      key: selectedPersonKey,
      label: personLabelMap.get(selectedPersonKey) ?? "Unknown",
    };
  }, [personLabelMap, selectedPersonKey]);

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

  const selectedMessageThreads = useMemo(() => {
    if (!selectedPersonKey || !messages) return [];
    const threads: PersonMessageThread[] = [];
    for (const chat of messages.topChats ?? []) {
      const mySent = Math.max(0, chat.sentCount ?? 0);
      const lastMessageAt = parseDate(chat.lastMessageAt ?? null);
      const participant = (chat.messageParticipants ?? []).find((p) => {
        const isSelf = Boolean(p.isMe || p.id === "me");
        if (isSelf) return false;
        const key = p.id ?? p.displayName ?? `unknown-${chat.chatId}`;
        return key === selectedPersonKey;
      });
      if (!participant) continue;
      const fromThem = Math.max(0, participant.messageCount ?? 0);
      const label =
        chat.chatDisplayName ??
        (chat.participants.length > 0 ? chat.participants.join(", ") : `Chat ${chat.chatId}`);
      threads.push({
        chatId: chat.chatId,
        label,
        isGroup: Boolean(chat.isGroup),
        totalMessages: mySent + fromThem,
        fromMeMessages: mySent,
        fromThemMessages: fromThem,
        lastMessageAt,
        href: buildReportUrl(chat.chatId),
      });
    }
    return threads
      .sort(
        (a, b) =>
          b.totalMessages - a.totalMessages ||
          (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0) ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 8);
  }, [buildReportUrl, messages, selectedPersonKey]);

  const selectedMessageStats = useMemo<PersonMessageStats | null>(() => {
    if (!selectedPersonKey) return null;
    const summary = messagePeople.find((person) => person.key === selectedPersonKey);
    if (!summary) return null;
    return {
      totalMessages: summary.messageCount,
      fromMeMessages: summary.fromMeCount,
      fromThemMessages: summary.fromThemCount,
      chatCount: summary.chatCount,
      lastMessageAt: summary.lastMessageAt,
      threads: selectedMessageThreads,
    };
  }, [messagePeople, selectedMessageThreads, selectedPersonKey]);

  const selectedCallStats = useMemo<PersonCallStats | null>(() => {
    if (!selectedPersonKey) return null;
    let totalCalls = 0;
    let incomingCalls = 0;
    let outgoingCalls = 0;
    let answeredCalls = 0;
    let missedIncomingCalls = 0;
    let talkSeconds = 0;
    let lastCallAt: Date | null = null;
    const recentCalls: PersonRecentCall[] = [];

    for (const call of filteredCalls) {
      const participants = getCallParticipants(call);
      const keys = new Set(
        participants.map((participant) => participant.id ?? participant.handle).filter(Boolean),
      );
      if (!keys.has(selectedPersonKey)) continue;

      totalCalls += 1;
      if (call.direction === "incoming") incomingCalls += 1;
      if (call.direction === "outgoing") outgoingCalls += 1;
      if (call.answered) answeredCalls += 1;
      if (call.direction === "incoming" && !call.answered) missedIncomingCalls += 1;

      const duration = Number.isFinite(call.durationSeconds) ? Math.max(0, call.durationSeconds) : 0;
      talkSeconds += duration;

      const startedAt = parseDate(call.startedAt);
      if (startedAt && (!lastCallAt || startedAt > lastCallAt)) {
        lastCallAt = startedAt;
      }
      recentCalls.push({
        callId: call.callId,
        startedAt,
        durationSeconds: duration,
        answered: call.answered,
        direction: call.direction,
        provider: call.provider,
        media: call.media,
      });
    }

    recentCalls.sort(
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
      recentCalls: recentCalls.slice(0, 8),
      callsInRange: recentCalls,
    };
  }, [filteredCalls, selectedPersonKey]);

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-neutral-100">
      <header className="border-b border-neutral-900/60 bg-neutral-950/95 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={overviewHref}
                className="rounded-full border border-neutral-800/80 bg-white/5 px-3 py-1 text-xs font-semibold text-white"
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
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Calls
              </Link>
              <Link
                href="/settings"
                className="rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white"
              >
                Settings
              </Link>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-3 py-1 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Communication</h1>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-400">
              {latestActivity ? (
                <span className="rounded-full border border-neutral-800/70 bg-neutral-900/40 px-3 py-1">
                  Latest activity ·{" "}
                  {latestActivity.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
              {messagesLatest ? (
                <span className="rounded-full border border-neutral-800/70 bg-neutral-900/40 px-3 py-1">
                  Latest message ·{" "}
                  {messagesLatest.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
              {callTotals.latest ? (
                <span className="rounded-full border border-neutral-800/70 bg-neutral-900/40 px-3 py-1">
                  Latest call ·{" "}
                  {callTotals.latest.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-10 flex w-full max-w-6xl flex-col gap-10 px-6">
        <GlobalRangeBar />
        {(messagesError || callsError) && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-sm text-amber-100">
            <p className="font-semibold text-amber-200">Some data couldn’t load</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {messagesError ? <li>{messagesError}</li> : null}
              {callsError ? <li>{callsError}</li> : null}
            </ul>
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <StatCard
            label="Messages"
            value={messagesLoading ? "—" : formatCompactNumber(messageTotals?.messageCount ?? 0)}
            description={messageTotals ? `${formatNumber(messageTotals.messageCount)} total` : undefined}
          />
          <StatCard
            label="Calls"
            value={callsQuery.isPending ? "—" : formatCompactNumber(callTotals.callCount)}
            description={`${formatNumber(callTotals.callCount)} total`}
          />
          <StatCard
            label="Talk time"
            value={callsQuery.isPending ? "—" : formatDuration(callTotals.totalDuration)}
            description={callTotals.answered > 0 ? `Avg · ${formatDuration(callTotals.avgDuration)}` : "No answered calls"}
          />
          <StatCard
            label="Connect rate"
            value={callsQuery.isPending ? "—" : formatPercent(callTotals.connectRate)}
            description={`${formatNumber(callTotals.answered)} answered · ${formatNumber(callTotals.missed)} not answered`}
          />
          <StatCard
            label="Your first reply"
            value={myMedian ? formatDuration(myMedian) : "—"}
            description="Messages only"
          />
          <StatCard
            label="Their first reply"
            value={theirMedian ? formatDuration(theirMedian) : "—"}
            description="Messages only"
          />
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Most contacted</p>
              <span className="text-xs text-neutral-500">Messages + calls</span>
            </div>
            <ul className="mt-4 space-y-3">
              {messagesLoading || callsQuery.isPending ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <li
                    key={`contact-skel-${index}`}
                    className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3"
                  >
                    <div className="h-3 w-40 animate-pulse rounded bg-neutral-800/60" />
                    <div className="mt-2 h-3 w-28 animate-pulse rounded bg-neutral-800/60" />
                  </li>
                ))
              ) : mostContacted.length === 0 ? (
                <li className="text-sm text-neutral-400">No activity for this range.</li>
              ) : (
                mostContacted.map((person, index) => (
                  <li
                    key={person.key}
                    className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-0 transition hover:border-neutral-700"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPersonKey(person.key)}
                      className="w-full p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <p className="truncate text-sm font-semibold text-neutral-50">
                        <span className="mr-2 text-xs font-semibold text-neutral-500">#{index + 1}</span>
                        {person.label || "Unknown"}
                      </p>
                      <p className="mt-1 text-xs text-neutral-400">
                        {formatNumber(person.messageCount)} messages · {formatNumber(person.callCount)} calls ·{" "}
                        {formatDuration(person.talkSeconds)}
                      </p>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top threads</p>
              <span className="text-xs text-neutral-500">Messages</span>
            </div>
            <ul className="mt-4 space-y-3">
              {messagesLoading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <li key={`chat-skel-${index}`} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                    <div className="h-3 w-40 animate-pulse rounded bg-neutral-800/60" />
                    <div className="mt-2 h-3 w-24 animate-pulse rounded bg-neutral-800/60" />
                  </li>
                ))
              ) : topChats.length === 0 ? (
                <li className="text-sm text-neutral-400">No message data for this range.</li>
              ) : (
                topChats.map((chat, index) => (
                  <li key={chat.chatId} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                    <p className="truncate text-sm font-semibold text-neutral-50">
                      <span className="mr-2 text-xs font-semibold text-neutral-500">#{index + 1}</span>
                      {chat.chatDisplayName ??
                        (chat.participants.length > 0 ? chat.participants.join(", ") : "Unknown")}
                    </p>
                    <p className="mt-1 text-xs text-neutral-400">{formatNumber(chat.messageCount)} messages</p>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top people</p>
              <span className="text-xs text-neutral-500">Messages</span>
            </div>
            <ul className="mt-4 space-y-3">
              {messagesLoading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <li key={`msg-skel-${index}`} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                    <div className="h-3 w-44 animate-pulse rounded bg-neutral-800/60" />
                    <div className="mt-2 h-3 w-28 animate-pulse rounded bg-neutral-800/60" />
                  </li>
                ))
              ) : topPeopleByMessages.length === 0 ? (
                <li className="text-sm text-neutral-400">No people for this range.</li>
              ) : (
                topPeopleByMessages.map((person, index) => (
                  <li
                    key={person.key}
                    className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-0 transition hover:border-neutral-700"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPersonKey(person.key)}
                      className="w-full p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <p className="truncate text-sm font-semibold text-neutral-50">
                        <span className="mr-2 text-xs font-semibold text-neutral-500">#{index + 1}</span>
                        {person.label || "Unknown"}
                      </p>
                      <p className="mt-1 text-xs text-neutral-400">
                        {formatNumber(person.messageCount)} messages · {formatNumber(person.fromMeCount)} from you ·{" "}
                        {formatNumber(person.fromThemCount)} from them
                      </p>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <p className="mt-4 text-xs text-neutral-500">Includes your messages in shared group chats.</p>
          </div>

          <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top calls</p>
              <span className="text-xs text-neutral-500">Talk time</span>
            </div>
            <ul className="mt-4 space-y-3">
              {callsQuery.isPending ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <li key={`call-skel-${index}`} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                    <div className="h-3 w-40 animate-pulse rounded bg-neutral-800/60" />
                    <div className="mt-2 h-3 w-24 animate-pulse rounded bg-neutral-800/60" />
                  </li>
                ))
              ) : topCalledPeople.length === 0 ? (
                <li className="text-sm text-neutral-400">No call data for this range.</li>
              ) : (
                topCalledPeople.map((person, index) => (
                  <li
                    key={person.key}
                    className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-0 transition hover:border-neutral-700"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedPersonKey(person.key)}
                      className="w-full p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <p className="truncate text-sm font-semibold text-neutral-50">
                        <span className="mr-2 text-xs font-semibold text-neutral-500">#{index + 1}</span>
                        {person.label}
                      </p>
                      <p className="mt-1 text-xs text-neutral-400">
                        {formatDuration(person.durationSeconds)} · {formatNumber(person.calls)} calls
                      </p>
                    </button>
                  </li>
                ))
              )}
            </ul>

            <div className="mt-5 rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Quick takes</p>
              <div className="mt-2 space-y-1 text-sm text-neutral-200">
                <p>
                  {messagesPerCall ? (
                    <>
                      ≈ {messagesPerCall.toFixed(1)} messages per call
                    </>
                  ) : (
                    <>—</>
                  )}
                </p>
                <p>
                  {missedCallLeader ? (
                    <>
                      Most missed (incoming): <span className="font-semibold text-neutral-50">{missedCallLeader.label}</span> ·{" "}
                      {formatNumber(missedCallLeader.missedIncoming)}
                    </>
                  ) : (
                    <>No missed incoming calls in view</>
                  )}
                </p>
              </div>
            </div>
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
        isMessagesLoading={messagesLoading || messagesFetching}
        isCallsLoading={callsQuery.isPending || callsQuery.isFetching}
        messagesError={messagesError}
        callsError={callsError}
      />
    </div>
  );
}
