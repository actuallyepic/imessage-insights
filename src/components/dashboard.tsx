"use client";

import Link from "next/link";
import { TRPCClientError } from "@trpc/client";
import { useMemo, useState } from "react";

import { PageHeader, PRESET_LABELS, RangeControl } from "@/components/app-shell";
import { MessageSearchPanel } from "@/components/message-search-panel";
import {
  AreaChart,
  AxisLabels,
  Avatar,
  Donut,
  EmptyNote,
  ErrorBanner,
  LegendItem,
  MeterBar,
  Panel,
  PanelSubtitle,
  PanelTitle,
  Segmented,
  SkeletonPanel,
  Sparkline,
  SplitBar,
  StatBadge,
  StatCard,
} from "@/components/ui/primitives";
import { useGlobalRange } from "@/hooks/use-global-range";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import {
  chatLabel,
  displayLabel,
  formatCount,
  formatDayShort,
  formatHourLabel,
  formatHourRange,
  formatPercent,
  formatShortDuration,
  formatWeekday,
  share,
  toDate,
} from "@/lib/format";
import type { ReactionType, SerializableConversationStats } from "@/lib/imessage/types";
import type { AppRouter } from "@/server/app-router";

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

const STATS_LIMIT = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_ROW_COUNT = 6;

const REACTION_LABELS: Record<ReactionType, string> = {
  love: "Loved",
  like: "Liked",
  dislike: "Disliked",
  laugh: "Laughed",
  emphasize: "Emphasized",
  question: "Questioned",
};

type RankMode = "people" | "chats" | "groups";
type ActivityView = "hourly" | "weekday";

/** A row in the "Top people" list — people, chats and groups all collapse to this. */
type RankRow = {
  key: string;
  name: string;
  identityKey: string;
  total: number;
  fromMe: number;
  fromThem: number;
  /**
   * Whether fromMe/fromThem are real. Chats carry a true split; `participantBreakdown`
   * counts only what each person sent (sentCount is always 0 for anyone but you), so
   * a people row has no from-you figure to show.
   */
  hasSplit: boolean;
  href: string;
};

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length > 0 ? sum(values) / values.length : 0;
}

/**
 * Honest in-range trend: mean of the range's second half vs its first half.
 * NOT a period-over-period delta — the API exposes no prior period — so every
 * caller must label it as a within-range comparison.
 */
function halfOverHalfTrend(values: number[]): number | null {
  if (values.length < 4) return null;
  const mid = Math.floor(values.length / 2);
  const first = mean(values.slice(0, mid));
  const second = mean(values.slice(mid));
  if (first <= 0) return null;
  return (second - first) / first;
}

function statsQueryError(error: unknown): { message: string; httpStatus?: number } | null {
  if (!error) return null;
  if (error instanceof TRPCClientError) {
    const trpcError = error as TRPCClientError<AppRouter>;
    return { message: trpcError.message, httpStatus: trpcError.data?.httpStatus };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: "Unable to load message stats." };
}


/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export default function Dashboard() {
  const { range, searchParams } = useGlobalRange();
  const [rankMode, setRankMode] = useState<RankMode>("people");
  const [activityView, setActivityView] = useState<ActivityView>("hourly");

  const statsQueryInput = useMemo(
    () => ({ limit: STATS_LIMIT, start: range.startIso, end: range.endIso }),
    [range.endIso, range.startIso],
  );

  const { data, isPending, error } = useStatsSummary(statsQueryInput);
  const stats = (data as SerializableConversationStats | undefined) ?? null;

  const errorDetails = statsQueryError(error);
  const isAccessError = errorDetails?.httpStatus === 403;

  const preservedQuery = searchParams.toString();

  /* --- derived -------------------------------------------------- */

  const totals = stats?.totals ?? { messageCount: 0, sentCount: 0, receivedCount: 0 };
  const dailyCounts = useMemo(() => stats?.dailyCounts ?? [], [stats]);

  const dailyTotals = useMemo(
    () => dailyCounts.map((day) => day.sentCount + day.receivedCount),
    [dailyCounts],
  );
  const dailySent = useMemo(() => dailyCounts.map((day) => day.sentCount), [dailyCounts]);
  const dailyReceived = useMemo(() => dailyCounts.map((day) => day.receivedCount), [dailyCounts]);

  /** Prefer the selected range's length; for "all time" fall back to the observed span. */
  const rangeDayCount = useMemo(() => {
    if (range.dayCount !== null) return range.dayCount;
    const earliest = toDate(stats?.earliestMessageAt);
    const latest = toDate(stats?.latestMessageAt);
    if (earliest && latest) {
      return Math.max(1, Math.round((latest.getTime() - earliest.getTime()) / DAY_MS) + 1);
    }
    return dailyCounts.length > 0 ? dailyCounts.length : null;
  }, [dailyCounts.length, range.dayCount, stats?.earliestMessageAt, stats?.latestMessageAt]);

  const rangeStart = range.startDate ?? toDate(stats?.earliestMessageAt);
  const rangeEnd = range.endDate ?? toDate(stats?.latestMessageAt);

  const rangeLabel =
    range.mode === "preset"
      ? PRESET_LABELS[range.preset]
      : range.mode === "day"
        ? "Single day"
        : "Custom range";

  const subtitle = useMemo(() => {
    const parts: string[] = [rangeLabel];
    if (rangeStart && rangeEnd) parts.push(`${formatDayShort(rangeStart)} – ${formatDayShort(rangeEnd)}`);
    if (stats) {
      parts.push(
        rangeDayCount !== null
          ? `${formatCount(totals.messageCount)} messages across ${formatCount(rangeDayCount)} days`
          : `${formatCount(totals.messageCount)} messages`,
      );
    }
    return parts.join(" · ");
  }, [rangeDayCount, rangeEnd, rangeLabel, rangeStart, stats, totals.messageCount]);

  const totalTrend = useMemo(() => halfOverHalfTrend(dailyTotals), [dailyTotals]);

  const dailyAverage = rangeDayCount && rangeDayCount > 0 ? totals.messageCount / rangeDayCount : null;
  const dailyAverageSent = rangeDayCount && rangeDayCount > 0 ? totals.sentCount / rangeDayCount : null;
  const dailyAverageReceived =
    rangeDayCount && rangeDayCount > 0 ? totals.receivedCount / rangeDayCount : null;

  const dateAxis = useMemo(() => {
    if (dailyCounts.length === 0) return [];
    const last = dailyCounts.length - 1;
    const indices = Array.from(new Set([0, Math.round(last / 3), Math.round((2 * last) / 3), last]));
    return indices.map((index) => formatDayShort(dailyCounts[index].date));
  }, [dailyCounts]);

  /* --- activity (hour / weekday) -------------------------------- */

  const activityBars = useMemo(() => {
    if (!stats) return [];
    if (activityView === "weekday") {
      return [...stats.weekdayCounts]
        .sort((a, b) => a.weekday - b.weekday)
        .map((entry) => ({
          key: `weekday-${entry.weekday}`,
          label: formatWeekday(entry.weekday, true),
          sent: entry.sentCount,
          received: entry.receivedCount,
        }));
    }
    return [...stats.hourlyCounts]
      .sort((a, b) => a.hour - b.hour)
      .map((entry) => ({
        key: `hour-${entry.hour}`,
        label: formatHourRange(entry.hour),
        sent: entry.sentCount,
        received: entry.receivedCount,
      }));
  }, [activityView, stats]);

  const activityPeak = useMemo(
    () => Math.max(0, ...activityBars.map((bar) => bar.sent + bar.received)),
    [activityBars],
  );

  const activityAxis = useMemo(() => {
    if (activityView === "weekday") return activityBars.map((bar) => bar.label);
    return [0, 6, 12, 18, 23].map((hour) => formatHourLabel(hour));
  }, [activityBars, activityView]);

  /* --- ranked rows ---------------------------------------------- */

  const personHref = (key: string, label: string) => {
    const params = new URLSearchParams(preservedQuery);
    params.set("key", key);
    params.set("label", label);
    return `/people?${params.toString()}`;
  };

  const chatHref = (chatId: number) => {
    const params = new URLSearchParams();
    if (range.startIso) params.set("start", range.startIso);
    if (range.endIso) params.set("end", range.endIso);
    const query = params.toString();
    return `/reports/${chatId}${query ? `?${query}` : ""}`;
  };

  const rankRows: RankRow[] = useMemo(() => {
    if (!stats) return [];

    if (rankMode === "people") {
      return stats.participantBreakdown
        .filter((person) => person.isMe !== true && person.id !== null)
        .slice()
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, TOP_ROW_COUNT)
        .map((person) => {
          const key = person.id as string;
          const name = displayLabel(person.displayName, key);
          return {
            key: `person-${key}`,
            name,
            identityKey: key,
            total: person.messageCount,
            fromMe: person.sentCount,
            fromThem: person.receivedCount,
            hasSplit: false,
            href: personHref(key, name),
          };
        });
    }

    const wantGroup = rankMode === "groups";
    return stats.topChats
      .filter((chat) => chat.isGroup === wantGroup)
      .slice()
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, TOP_ROW_COUNT)
      .map((chat) => ({
        key: `chat-${chat.chatId}`,
        name: chatLabel(chat),
        identityKey: `chat-${chat.chatId}`,
        total: chat.messageCount,
        fromMe: chat.sentCount,
        fromThem: chat.receivedCount,
        hasSplit: true,
        href: chatHref(chat.chatId),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preservedQuery, range.endIso, range.startIso, rankMode, stats]);

  /** Leader's volume — people rows are metered against it, since they have no split. */
  const rankPeak = useMemo(
    () => rankRows.reduce((max, row) => Math.max(max, row.total), 0),
    [rankRows],
  );

  /* --- highlights ------------------------------------------------ */

  const mostActiveChat = useMemo(() => {
    if (!stats || stats.topChats.length === 0) return null;
    return stats.topChats.reduce((best, chat) => (chat.messageCount > best.messageCount ? chat : best));
  }, [stats]);

  const peakHour = useMemo(() => {
    if (!stats || stats.hourlyCounts.length === 0) return null;
    const best = stats.hourlyCounts.reduce((top, entry) =>
      entry.sentCount + entry.receivedCount > top.sentCount + top.receivedCount ? entry : top,
    );
    const count = best.sentCount + best.receivedCount;
    return count > 0 ? { hour: best.hour, count } : null;
  }, [stats]);

  const topReaction = useMemo(() => {
    if (!stats) return null;
    const entries = Object.entries(stats.reactionTotals.byType) as Array<
      [ReactionType, { reactionCount: number }]
    >;
    const best = entries.reduce<{ type: ReactionType; count: number } | null>((top, [type, value]) => {
      if (!top || value.reactionCount > top.count) return { type, count: value.reactionCount };
      return top;
    }, null);
    return best && best.count > 0 ? best : null;
  }, [stats]);

  const busiestDay = useMemo(() => {
    if (dailyCounts.length === 0) return null;
    const best = dailyCounts.reduce((top, day) =>
      day.sentCount + day.receivedCount > top.sentCount + top.receivedCount ? day : top,
    );
    const count = best.sentCount + best.receivedCount;
    return count > 0 ? { date: best.date, count } : null;
  }, [dailyCounts]);

  const hasHighlights = Boolean(mostActiveChat || peakHour || topReaction || busiestDay);

  /* --- conversation dynamics ------------------------------------ */

  const dynamics = useMemo(() => {
    if (!stats) return null;
    const { startedByMe, startedByOthers } = stats.sessionStarters;
    const totalStarts = startedByMe + startedByOthers;
    const { youDoubleTexted, theyDoubleTexted } = stats.doubleTexts;
    const totalDoubles = youDoubleTexted + theyDoubleTexted;
    if (totalStarts === 0 && totalDoubles === 0) return null;
    return {
      totalStarts,
      startShare: totalStarts > 0 ? share(startedByMe, totalStarts) : null,
      totalDoubles,
      theyDoubleShare: totalDoubles > 0 ? share(theyDoubleTexted, totalDoubles) : null,
      youDoubleShare: totalDoubles > 0 ? share(youDoubleTexted, totalDoubles) : null,
    };
  }, [stats]);

  /* --- states ---------------------------------------------------- */

  const header = <PageHeader title="Messages" subtitle={subtitle} actions={<RangeControl />} />;

  if (errorDetails) {
    return (
      <>
        {header}
        <ErrorBanner
          title={isAccessError ? "Full Disk Access required" : "Couldn’t load message stats"}
          detail={
            isAccessError
              ? "macOS denied access to the Messages database. Open System Settings → Privacy & Security → Full Disk Access, enable Terminal (or the host app), then refresh."
              : errorDetails.message
          }
        />
      </>
    );
  }

  if (isPending) {
    return (
      <>
        {header}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonPanel key={`stat-skel-${index}`} height={130} />
          ))}
        </div>
        <div className="grid gap-3.5 lg:grid-cols-[1.85fr_1fr]">
          <SkeletonPanel height={286} />
          <SkeletonPanel height={286} />
        </div>
        <SkeletonPanel height={200} />
      </>
    );
  }

  const isEmpty = !stats || totals.messageCount === 0;

  if (isEmpty) {
    return (
      <>
        {header}
        <Panel className="rounded-[20px] px-[22px] py-5">
          <PanelTitle>No messages in this range</PanelTitle>
          <PanelSubtitle>Widen the date range to see activity.</PanelSubtitle>
        </Panel>
        <MessageSearchPanel
          rangeStart={statsQueryInput.start}
          rangeEnd={statsQueryInput.end}
          topChats={stats?.topChats ?? []}
        />
      </>
    );
  }

  const sentShare = share(totals.sentCount, totals.messageCount);
  const receivedShare = share(totals.receivedCount, totals.messageCount);
  const myReply = stats.firstReplyTimes.meResponding;
  const theirReply = stats.firstReplyTimes.themResponding;

  return (
    <>
      {header}

      {/* Stat cards ------------------------------------------------ */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="All messages"
          value={formatCount(totals.messageCount)}
          delay={0.02}
          badge={
            totalTrend !== null ? (
              <span title="Daily average across the second half of this range vs the first half">
                <StatBadge tint={totalTrend >= 0 ? "accent" : "rose"}>
                  {`2nd half ${totalTrend >= 0 ? "▲" : "▼"} ${formatPercent(Math.abs(totalTrend), 1)}`}
                </StatBadge>
              </span>
            ) : undefined
          }
          footer={<Sparkline values={dailyTotals} color="var(--ink-secondary)" />}
        />
        <StatCard
          label="Sent"
          tint="accent"
          value={formatCount(totals.sentCount)}
          delay={0.06}
          badge={<StatBadge tint="accent">{formatPercent(sentShare)}</StatBadge>}
          footer={<Sparkline values={dailySent} color="var(--accent)" delay={0.1} />}
        />
        <StatCard
          label="Received"
          tint="sky"
          value={formatCount(totals.receivedCount)}
          delay={0.1}
          badge={<StatBadge tint="sky">{formatPercent(receivedShare)}</StatBadge>}
          footer={<Sparkline values={dailyReceived} color="var(--sky)" delay={0.16} />}
        />
        <StatCard
          label="Daily average"
          value={dailyAverage !== null ? formatCount(dailyAverage) : "—"}
          delay={0.14}
          badge={<StatBadge>/ day</StatBadge>}
          footer={
            dailyAverage !== null ? (
              <div className="flex gap-1.5 font-mono text-[10px]">
                <span className="text-accent">{formatCount(dailyAverageSent)} sent</span>
                <span className="text-ink-ghost">·</span>
                <span className="text-sky">{formatCount(dailyAverageReceived)} recv</span>
              </div>
            ) : null
          }
        />
        <StatCard
          label="Reactions"
          tint="violet"
          value={formatCount(stats.reactionTotals.reactionCount)}
          delay={0.18}
          footer={
            <div className="flex gap-1.5 font-mono text-[10px]">
              <span className="text-violet">{formatCount(stats.reactionTotals.sentCount)} sent</span>
              <span className="text-ink-ghost">·</span>
              <span className="text-ink-dim">{formatCount(stats.reactionTotals.receivedCount)} recv</span>
            </div>
          }
        />
        <StatCard
          label="Attachments"
          tint="pink"
          value={formatCount(stats.attachmentStats.totalCount)}
          delay={0.22}
          footer={
            stats.attachmentStats.topSender ? (
              <p className="truncate font-mono text-[10px] text-ink-dim">
                {`Top · ${
                  stats.attachmentStats.topSender.isMe
                    ? "You"
                    : displayLabel(stats.attachmentStats.topSender.displayName, stats.attachmentStats.topSender.id)
                } · ${formatCount(stats.attachmentStats.topSender.count)}`}
              </p>
            ) : (
              <p className="font-mono text-[10px] text-ink-ghost">
                {`${formatCount(stats.attachmentStats.sentCount)} sent · ${formatCount(
                  stats.attachmentStats.receivedCount,
                )} recv`}
              </p>
            )
          }
        />
      </div>

      {/* Over time + balance / reply time -------------------------- */}
      <div className="grid gap-3.5 lg:grid-cols-[1.85fr_1fr]">
        <Panel delay={0.24} className="rounded-[20px] px-[22px] py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <PanelTitle>Messages over time</PanelTitle>
              <PanelSubtitle>Sent vs received, daily</PanelSubtitle>
            </div>
            <div className="flex gap-3.5">
              <LegendItem color="var(--accent)">Sent</LegendItem>
              <LegendItem color="var(--sky)">Received</LegendItem>
            </div>
          </div>
          {dailyCounts.length >= 2 ? (
            <>
              <AreaChart
                className="mt-3.5"
                sharedDomain
                series={[
                  { id: "msg-received-fill", values: dailyReceived, color: "var(--sky)", fillOpacity: 0.22 },
                  { id: "msg-sent-fill", values: dailySent, color: "var(--accent)", strokeWidth: 2.4 },
                ]}
              />
              <AxisLabels labels={dateAxis} />
            </>
          ) : (
            <EmptyNote className="mt-4">Not enough days in this range to plot a trend.</EmptyNote>
          )}
        </Panel>

        <div className="flex flex-col gap-3.5">
          <Panel delay={0.28} className="rounded-[20px] px-5 py-[18px]">
            <PanelTitle>Send / receive balance</PanelTitle>
            <div className="mt-3.5 flex items-center gap-[18px]">
              <Donut
                ratio={receivedShare}
                primary="var(--sky)"
                secondary="var(--accent)"
                value={
                  totals.receivedCount > 0 ? (totals.sentCount / totals.receivedCount).toFixed(2) : "—"
                }
                caption="sent : recv"
              />
              <div className="flex flex-col gap-2.5 text-xs">
                <div>
                  <div className="flex items-center gap-[7px] text-ink-tertiary">
                    <span className="h-2 w-2 rounded-[2px] bg-sky" />
                    Received
                  </div>
                  <p className="ml-[15px] mt-0.5 font-mono text-xs text-ink-faint">
                    {formatCount(totals.receivedCount)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center gap-[7px] text-ink-tertiary">
                    <span className="h-2 w-2 rounded-[2px] bg-accent" />
                    Sent
                  </div>
                  <p className="ml-[15px] mt-0.5 font-mono text-xs text-ink-faint">
                    {formatCount(totals.sentCount)}
                  </p>
                </div>
              </div>
            </div>
          </Panel>

          <Panel delay={0.32} className="flex-1 rounded-[20px] px-5 py-[18px]">
            <PanelTitle>First reply time</PanelTitle>
            {myReply.sampleCount > 0 || theirReply.sampleCount > 0 ? (
              <div className="mt-3.5 flex gap-[22px]">
                <ReplyStat label="You" stat={myReply} color="text-accent" />
                <div className="w-px bg-line" />
                <ReplyStat label="Them" stat={theirReply} color="text-sky" />
              </div>
            ) : (
              <EmptyNote className="mt-3">No replies detected in this range.</EmptyNote>
            )}
          </Panel>
        </div>
      </div>

      {/* When you message ------------------------------------------ */}
      <Panel delay={0.34} className="rounded-[20px] px-[22px] py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <PanelTitle>When you message</PanelTitle>
            <PanelSubtitle>
              {activityView === "hourly" ? "Sent + received by hour" : "Sent + received by weekday"}
            </PanelSubtitle>
          </div>
          <Segmented
            ariaLabel="Activity breakdown"
            value={activityView}
            onChange={setActivityView}
            options={[
              { value: "hourly", label: "Hour" },
              { value: "weekday", label: "Weekday" },
            ]}
          />
        </div>
        {activityPeak > 0 ? (
          <>
            <div className="mt-4 flex h-[100px] items-end gap-1">
              {activityBars.map((bar, index) => {
                const sentPct = bar.sent > 0 ? Math.max(1.5, (bar.sent / activityPeak) * 100) : 0;
                const receivedPct =
                  bar.received > 0 ? Math.max(1.5, (bar.received / activityPeak) * 100) : 0;
                return (
                  <div
                    key={bar.key}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-0.5"
                    title={`${bar.label} · ${formatCount(bar.sent)} sent · ${formatCount(bar.received)} received`}
                  >
                    <div
                      className="w-full origin-bottom rounded-t-[3px] animate-bar"
                      style={{
                        height: `${sentPct}%`,
                        background: "var(--accent)",
                        animationDelay: `${(index * 0.02).toFixed(2)}s`,
                      }}
                    />
                    <div
                      className="w-full origin-bottom rounded-b-[3px] animate-bar"
                      style={{
                        height: `${receivedPct}%`,
                        background: "var(--sky)",
                        animationDelay: `${(index * 0.02).toFixed(2)}s`,
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <AxisLabels labels={activityAxis} className="mt-2.5" />
          </>
        ) : (
          <EmptyNote className="mt-4">No activity in this range.</EmptyNote>
        )}
      </Panel>

      {/* Top people + highlights ----------------------------------- */}
      <div className="grid gap-3.5 lg:grid-cols-[1.6fr_1fr]">
        <Panel delay={0.36} className="rounded-[20px] px-[22px] py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PanelTitle>
              {rankMode === "people" ? "Top people" : rankMode === "chats" ? "Top chats" : "Top groups"}
            </PanelTitle>
            <Segmented
              ariaLabel="Ranking mode"
              value={rankMode}
              onChange={setRankMode}
              options={[
                { value: "people", label: "People" },
                { value: "chats", label: "Chats" },
                { value: "groups", label: "Groups" },
              ]}
            />
          </div>

          {rankRows.length > 0 ? (
            <>
              <div className="mt-3 flex flex-col gap-0.5">
                {rankRows.map((row, index) => (
                  <Link
                    key={row.key}
                    href={row.href}
                    className="flex items-center gap-[13px] rounded-xl px-2 py-[9px] transition-colors hover:bg-surface"
                  >
                    <span className="w-4 flex-none font-mono text-[11px] text-ink-ghost">{index + 1}</span>
                    <Avatar label={row.name} identityKey={row.identityKey} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2.5">
                        <span className="truncate text-[13px] font-semibold text-ink-primary">{row.name}</span>
                        <span className="flex-none font-mono text-[11px] text-ink-faint">
                          {formatCount(row.total)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        {row.hasSplit ? (
                          <SplitBar
                            className="flex-1"
                            segments={[
                              { value: row.fromMe, color: "var(--accent)" },
                              { value: row.fromThem, color: "var(--sky)" },
                            ]}
                          />
                        ) : (
                          <div className="flex-1">
                            <MeterBar ratio={share(row.total, rankPeak)} color="var(--sky)" />
                          </div>
                        )}
                        <span className="flex-none whitespace-nowrap font-mono text-[10px] text-ink-ghost">
                          {row.hasSplit
                            ? `${formatCount(row.fromMe)} · ${formatCount(row.fromThem)}`
                            : `${formatCount(row.fromThem)} from them`}
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
              <div className="mt-3 flex gap-4 border-t border-line-hairline pt-3">
                {rankMode === "people" ? (
                  <LegendItem color="var(--sky)">
                    Messages they sent you — a per-person “from you” split isn’t available
                  </LegendItem>
                ) : (
                  <>
                    <LegendItem color="var(--accent)">From you</LegendItem>
                    <LegendItem color="var(--sky)">From them</LegendItem>
                  </>
                )}
              </div>
            </>
          ) : (
            <EmptyNote className="mt-4">
              {rankMode === "groups" ? "No group chats in this range." : "Nothing to rank in this range."}
            </EmptyNote>
          )}
        </Panel>

        <div className="flex flex-col gap-3.5">
          <Panel delay={0.4} className="rounded-[20px] px-5 py-[18px]">
            <PanelTitle className="mb-3">Highlights</PanelTitle>
            {hasHighlights ? (
              <div className="flex flex-col gap-3">
                {mostActiveChat ? (
                  <Highlight
                    label="Most active chat"
                    value={chatLabel(mostActiveChat)}
                    meta={`${formatCount(mostActiveChat.messageCount)} · ${formatPercent(
                      share(mostActiveChat.messageCount, totals.messageCount),
                    )}`}
                  />
                ) : null}
                {peakHour ? (
                  <Highlight
                    label="Peak hour"
                    value={formatHourRange(peakHour.hour)}
                    meta={`${formatCount(peakHour.count)} msgs`}
                  />
                ) : null}
                {topReaction ? (
                  <Highlight
                    label="Most used reaction"
                    value={REACTION_LABELS[topReaction.type]}
                    meta={formatCount(topReaction.count)}
                  />
                ) : null}
                {busiestDay ? (
                  <Highlight
                    label="Busiest day"
                    value={formatDayShort(busiestDay.date)}
                    meta={`${formatCount(busiestDay.count)} msgs`}
                  />
                ) : null}
              </div>
            ) : (
              <EmptyNote>Nothing to highlight in this range.</EmptyNote>
            )}
          </Panel>

          <Panel tint="accent" delay={0.44} className="rounded-[20px] px-5 py-[18px]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-accent">
              Conversation dynamics
            </p>
            {dynamics ? (
              <p className="mt-2 text-[13px] leading-[1.5] text-ink-secondary">
                {dynamics.startShare !== null ? (
                  <>
                    You start <strong className="font-semibold text-ink">{formatPercent(dynamics.startShare)}</strong>{" "}
                    of sessions
                  </>
                ) : (
                  <>No sessions detected</>
                )}
                {dynamics.theyDoubleShare !== null && dynamics.youDoubleShare !== null ? (
                  dynamics.theyDoubleShare > dynamics.youDoubleShare ? (
                    <>
                      , but others double-text more often (
                      <strong className="font-semibold text-ink">{formatPercent(dynamics.theyDoubleShare)}</strong>).
                    </>
                  ) : dynamics.youDoubleShare > dynamics.theyDoubleShare ? (
                    <>
                      , and you double-text more often (
                      <strong className="font-semibold text-ink">{formatPercent(dynamics.youDoubleShare)}</strong>).
                    </>
                  ) : (
                    <>, and double texts are evenly split.</>
                  )
                ) : (
                  <>.</>
                )}
              </p>
            ) : (
              <p className="mt-2 text-[13px] leading-[1.5] text-ink-muted">
                Not enough conversation activity in this range.
              </p>
            )}
          </Panel>
        </div>
      </div>

      {/* Search ---------------------------------------------------- */}
      <MessageSearchPanel
        rangeStart={statsQueryInput.start}
        rangeEnd={statsQueryInput.end}
        topChats={stats.topChats}
      />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Local pieces
 * ------------------------------------------------------------------ */

function ReplyStat({
  label,
  stat,
  color,
}: {
  label: string;
  stat: {
    medianSeconds: number | null;
    p90Seconds: number | null;
    minSeconds: number | null;
    sampleCount: number;
  };
  color: string;
}) {
  const hasSamples = stat.sampleCount > 0;
  return (
    <div>
      <p className="text-[11px] text-ink-dim">{label}</p>
      <p className={`mt-1 text-[22px] font-semibold ${color}`}>
        {hasSamples ? formatShortDuration(stat.medianSeconds) : "—"}
      </p>
      <p className="mt-0.5 font-mono text-[10px] text-ink-ghost">
        {hasSamples
          ? `p90 ${formatShortDuration(stat.p90Seconds)} · fast ${formatShortDuration(stat.minSeconds)}`
          : "no replies"}
      </p>
    </div>
  );
}

function Highlight({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div>
      <p className="text-[11px] text-ink-dim">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-ink-primary">
        {value} <span className="font-mono text-[11px] font-normal text-ink-faint">· {meta}</span>
      </p>
    </div>
  );
}
