'use client';

import { useEffect, useMemo, useState } from "react";

interface ChatSummary {
  chatId: number;
  chatDisplayName: string | null;
  isGroup: boolean;
  participants: string[];
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  lastMessageAt: string | null;
}

interface ParticipantStats {
  id: string | null;
  displayName: string | null;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
}

interface DailyCount {
  date: string;
  sentCount: number;
  receivedCount: number;
}

interface HourlyCount {
  hour: number;
  sentCount: number;
  receivedCount: number;
}

interface WeekdayCount {
  weekday: number;
  sentCount: number;
  receivedCount: number;
}

interface MessageTotals {
  messageCount: number;
  sentCount: number;
  receivedCount: number;
}

interface ConversationStats {
  topChats: ChatSummary[];
  participantBreakdown: ParticipantStats[];
  dailyCounts: DailyCount[];
  hourlyCounts: HourlyCount[];
  weekdayCounts: WeekdayCount[];
  totals: MessageTotals;
  latestMessageAt: string | null;
}

type StatsRange = "1h" | "6h" | "12h" | "1d" | "3d" | "5d" | "7d" | "30d" | "90d" | "all";

function formatDateTime(value: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function formatParticipants(chat: ChatSummary) {
  if (chat.participants.length > 0) {
    return chat.participants.join(", ");
  }
  if (chat.chatDisplayName) {
    return chat.chatDisplayName;
  }
  return "(unknown)";
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function formatPercent(part: number, total: number) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) {
    return "0%";
  }
  const percentage = (part / total) * 100;
  return `${Math.round(percentage)}%`;
}

function computeTotals(stats: ConversationStats | null) {
  if (!stats) return { sent: 0, received: 0, total: 0 };
  const { sentCount, receivedCount, messageCount } = stats.totals;
  return { sent: sentCount, received: receivedCount, total: messageCount };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const rangeDurations: Record<Exclude<StatsRange, "all">, number> = {
  "1h": 1 * HOUR_MS,
  "6h": 6 * HOUR_MS,
  "12h": 12 * HOUR_MS,
  "1d": 1 * DAY_MS,
  "3d": 3 * DAY_MS,
  "5d": 5 * DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};

const statsRangeOptions: StatsRange[] = ["1h", "6h", "12h", "1d", "3d", "5d", "7d", "30d", "90d", "all"];
const DEFAULT_STATS_LIMIT = 40;
const CHAT_COUNT_OPTIONS = [5, 10, 20, 30];
const ACCESS_TIP_STORAGE_KEY = "imessage-insights:fda-tip-dismissed";

function getRangeDates(range: StatsRange) {
  if (range === "all") return {};
  const now = new Date();
  const duration = rangeDurations[range];
  const start = new Date(now.getTime() - duration);
  return { start: start.toISOString(), end: now.toISOString() };
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type IconProps = {
  className?: string;
};

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-transparent ${className ?? ""}`}
      aria-hidden="true"
    />
  );
}

function DirectChatIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 448 512"
      aria-hidden="true"
      focusable="false"
      className={className}
      role="img"
    >
      <path
        fill="currentColor"
        d="M224 256A128 128 0 1 0 224 0a128 128 0 1 0 0 256zm-90.7 32C59.9 288 0 347.9 0 421.3 0 456.2 27.8 484 62.7 484H385.3c34.9 0 62.7-27.8 62.7-62.7 0-73.4-59.9-133.3-133.3-133.3H133.3z"
      />
    </svg>
  );
}

function GroupChatIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 640 512"
      aria-hidden="true"
      focusable="false"
      className={className}
      role="img"
    >
      <path
        fill="currentColor"
        d="M96 128a64 64 0 1 1 128 0A64 64 0 1 1 96 128zm224 0a64 64 0 1 1 128 0A64 64 0 1 1 320 128zM0 416c0-88.4 71.6-160 160-160h64c88.4 0 160 71.6 160 160 0 17.7-14.3 32-32 32H32c-17.7 0-32-14.3-32-32zm416-160h-8.6c51.1 23.3 87.1 74.4 87.1 133.3 0 21.2-17.2 38.7-38.7 38.7H480c88.4 0 160-71.6 160-160 0-70.7-57.3-128-128-128h-32c-13 0-25.6-2.6-37.1-7.5 2.7 7.7 4.1 15.9 4.1 24.5v32c0 35.3-28.7 64-64 64z"
      />
    </svg>
  );
}

type ChatFilterMode = "all" | "direct" | "group";

const chatFilterOptions: { value: ChatFilterMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "direct", label: "Chats" },
  { value: "group", label: "Groups" },
];

export default function Dashboard() {
  const [statsRange, setStatsRange] = useState<StatsRange>("all");
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [chatFilterMode, setChatFilterMode] = useState<ChatFilterMode>("all");
  const [visibleChatCount, setVisibleChatCount] = useState(5);
  const [statsRefreshToken, setStatsRefreshToken] = useState(0);
  const [activityView, setActivityView] = useState<"hourly" | "weekday">("hourly");
  const [accessError, setAccessError] = useState(false);
  const [accessTipDismissed, setAccessTipDismissed] = useState(false);

  const totals = useMemo(() => computeTotals(stats), [stats]);
  const sampledDayCount = stats?.dailyCounts.length ?? 0;
  const averagePerDay = useMemo(() => {
    if (!stats || sampledDayCount === 0) return null;
    return Math.max(1, Math.round(totals.total / sampledDayCount));
  }, [sampledDayCount, stats, totals.total]);

  const filteredTopChats = useMemo(() => {
    const chats = stats?.topChats ?? [];
    switch (chatFilterMode) {
      case "direct":
        return chats.filter((chat) => !chat.isGroup);
      case "group":
        return chats.filter((chat) => chat.isGroup);
      default:
        return chats;
    }
  }, [chatFilterMode, stats]);
  const topChatPreview = filteredTopChats.slice(0, visibleChatCount);
  const summaryCards = useMemo(
    () => [
      {
        key: "total",
        label: "All messages",
        value: totals.total ? formatNumber(totals.total) : "—",
      },
      {
        key: "sent",
        label: "Sent",
        value: totals.sent ? formatNumber(totals.sent) : "—",
        footnote: totals.total ? formatPercent(totals.sent, totals.total) : undefined,
      },
      {
        key: "received",
        label: "Received",
        value: totals.received ? formatNumber(totals.received) : "—",
        footnote: totals.total ? formatPercent(totals.received, totals.total) : undefined,
      },
      {
        key: "pace",
        label: "Daily average",
        value: averagePerDay ? formatNumber(averagePerDay) : "—",
      },
    ],
    [averagePerDay, totals.received, totals.sent, totals.total],
  );

  const summaryCardStyles: Record<
    string,
    { wrapper: string; valueClass: string; badgeClass: string }
  > = {
    total: {
      wrapper: "border-neutral-800/70 bg-neutral-950/50",
      valueClass: "text-white",
      badgeClass: "text-neutral-400",
    },
    sent: {
      wrapper: "border-emerald-500/30 bg-emerald-500/5",
      valueClass: "text-emerald-300",
      badgeClass: "text-emerald-300",
    },
    received: {
      wrapper: "border-sky-500/30 bg-sky-500/5",
      valueClass: "text-sky-300",
      badgeClass: "text-sky-300",
    },
    pace: {
      wrapper: "border-amber-400/30 bg-amber-500/5",
      valueClass: "text-amber-200",
      badgeClass: "text-amber-200",
    },
  };
  const handleStatsRefresh = () => setStatsRefreshToken((token) => token + 1);

  const hourlyMax = useMemo(() => {
    if (!stats || stats.hourlyCounts.length === 0) return 0;
    return stats.hourlyCounts.reduce((max, bucket) => {
      const total = bucket.sentCount + bucket.receivedCount;
      return total > max ? total : max;
    }, 0);
  }, [stats]);

  const weekdayMax = useMemo(() => {
    if (!stats || stats.weekdayCounts.length === 0) return 0;
    return stats.weekdayCounts.reduce((max, bucket) => {
      const total = bucket.sentCount + bucket.receivedCount;
      return total > max ? total : max;
    }, 0);
  }, [stats]);

  const isHourlyView = activityView === "hourly";
  const activityCounts: Array<HourlyCount | WeekdayCount> = !stats
    ? []
    : isHourlyView
      ? stats.hourlyCounts
      : stats.weekdayCounts;
  const activityMax = isHourlyView ? hourlyMax : weekdayMax;
  const activityEmptyMessage = isHourlyView
    ? "No hourly activity recorded."
    : "No weekday activity recorded.";
  const mostActiveChat = stats?.topChats.length ? stats.topChats[0] : null;
  const latestActivitySource = stats?.latestMessageAt ?? mostActiveChat?.lastMessageAt ?? null;
  const latestActivityLabel = stats ? formatDateTime(latestActivitySource) : "Waiting for data";
  const shouldShowDailyAverage = !["1h", "6h", "12h", "1d"].includes(statsRange);
  const topConversationsTitle =
    chatFilterMode === "group" ? "Top Groups" : chatFilterMode === "direct" ? "Top Chats" : "Top Conversations";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(ACCESS_TIP_STORAGE_KEY);
    setAccessTipDismissed(stored === "true");
  }, []);

  const handleDismissAccessTip = () => {
    setAccessTipDismissed(true);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACCESS_TIP_STORAGE_KEY, "true");
      }
    } catch {
      // Ignore storage errors (e.g., private mode)
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: DEFAULT_STATS_LIMIT.toString() });
    const rangeDates = getRangeDates(statsRange);
    if (rangeDates.start) params.set("start", rangeDates.start);
    if (rangeDates.end) params.set("end", rangeDates.end);

    async function fetchStats() {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const response = await fetch(`/api/stats?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const error = new Error(payload.error ?? `Request failed with ${response.status}`) as Error & {
            status?: number;
          };
          error.status = response.status;
          throw error;
        }
        const json = (await response.json()) as { data: ConversationStats };
        setStats(json.data);
        setAccessError(false);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const errorMessage = error instanceof Error ? error.message : "Unable to load stats.";
        setStatsError(errorMessage);
        const status = error && typeof error === "object" ? (error as { status?: number }).status : undefined;
        setAccessError(status === 403);
      } finally {
        setStatsLoading(false);
      }
    }

    fetchStats();
    return () => controller.abort();
  }, [statsRange, statsRefreshToken]);

  const shouldShowAccessTip = accessError && !accessTipDismissed;

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-neutral-100">
      <header className="relative overflow-hidden border-b border-neutral-800/70 bg-gradient-to-b from-neutral-950 via-neutral-950 to-black py-12">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/10 via-transparent to-transparent" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-sky-500/20 via-transparent to-transparent blur-3xl opacity-60" />
        </div>
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3 text-[0.7rem] font-semibold uppercase tracking-wide text-emerald-200">
                <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1">Beta</span>
              </div>
              <div>
                <h1 className="text-4xl font-semibold tracking-tight text-white">Messages Analytics</h1>
                <p className="mt-2 max-w-2xl text-base text-neutral-400">
                  Run private analytics against your Messages database to uncover trends, busiest chats, and daily habits.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-400">
                <div className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-900/80 px-3 py-1">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                  <span>{stats ? `Latest activity ${latestActivityLabel}` : "Awaiting first sync…"}</span>
                </div>
                <button
                  type="button"
                  onClick={handleStatsRefresh}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-200 transition hover:border-emerald-400/80 hover:bg-emerald-400/20 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
                >
                  <span className="sr-only">Refresh stats</span>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                    <path
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4.5 12a7.5 7.5 0 0113.5-4.472M19.5 5.25v4.5m0-4.5h-4.5M19.5 12a7.5 7.5 0 01-13.5 4.472M4.5 18.75v-4.5m0 4.5h4.5"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-10 flex w-full max-w-6xl flex-col gap-10 px-6">
        <section className="space-y-6">
          <div className="space-y-4 rounded-2xl border border-neutral-800/70 bg-neutral-900/40 p-6 shadow-lg shadow-black/30">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">Statistics</h2>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                {statsRangeOptions.map((rangeOption) => (
                  <button
                    key={rangeOption}
                    type="button"
                    onClick={() => setStatsRange(rangeOption)}
                    aria-pressed={statsRange === rangeOption}
                    className={`rounded-full border px-3 py-1 font-semibold transition ${
                      statsRange === rangeOption
                        ? "border-emerald-400/70 bg-emerald-400/90 text-emerald-950 shadow shadow-emerald-500/30"
                        : "border-neutral-800/80 text-neutral-300 hover:border-neutral-600 hover:text-white"
                    }`}
                  >
                    {rangeOption === "all" ? "All Time" : rangeOption}
                  </button>
                ))}
              </div>
            </div>
            {statsError && <p className="text-sm text-red-400">{statsError}</p>}
            {statsLoading && (
              <div className="flex items-center gap-2 text-sm text-neutral-400">
                <Spinner /> Refreshing stats…
              </div>
            )}
            {!stats && !statsLoading && !statsError && (
              <p className="text-sm text-neutral-500">
                Choose a range to load your messaging insights.
              </p>
            )}

            {stats && (
              <div
                className={`space-y-5 transition-opacity duration-300 ${
                  statsLoading ? "opacity-60" : "opacity-100"
                }`}
              >
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {summaryCards.map((card) => (
                    <div
                      key={card.key}
                      className={`rounded-xl border p-4 shadow shadow-black/10 ${
                        (summaryCardStyles[card.key] ?? summaryCardStyles.total).wrapper
                      }`}
                    >
                      <p className="text-xs uppercase tracking-wide text-neutral-400">{card.label}</p>
                      <p
                        className={`mt-2 text-2xl font-semibold ${
                          (summaryCardStyles[card.key] ?? summaryCardStyles.total).valueClass
                        }`}
                      >
                        {card.value}
                        {card.footnote && (
                          <span
                            className={`ml-2 text-sm font-semibold ${
                              (summaryCardStyles[card.key] ?? summaryCardStyles.total).badgeClass
                            }`}
                          >
                            {card.footnote}
                          </span>
                        )}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/50 p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                        {topConversationsTitle}
                      </h3>
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        {chatFilterOptions.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setChatFilterMode(option.value)}
                            aria-pressed={chatFilterMode === option.value}
                            className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${
                              chatFilterMode === option.value
                                ? "border-emerald-400/80 bg-emerald-500/10 text-emerald-200"
                                : "border-neutral-800/80 text-neutral-400 hover:text-white"
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                      <label className="flex items-center gap-2">
                        Show
                        <select
                          value={visibleChatCount}
                          onChange={(event) => setVisibleChatCount(Number(event.target.value))}
                          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 focus:outline-none focus:ring-1 focus:ring-emerald-400/60"
                        >
                          {CHAT_COUNT_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              Top {option}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="mt-3 space-y-3">
                      {topChatPreview.length === 0 ? (
                        <p className="text-sm text-neutral-500">
                          {filteredTopChats.length === 0
                            ? "No conversations match this filter."
                            : "No conversations in this range yet."}
                        </p>
                      ) : (
                        topChatPreview.map((chat, index) => {
                          const totalMessages = chat.messageCount;
                          const percentShare = formatPercent(totalMessages, totals.total);
                          const Icon = chat.isGroup ? GroupChatIcon : DirectChatIcon;
                          const iconColor = chat.isGroup ? "text-rose-300" : "text-indigo-300";
                          const isTopEntry = index === 0;
                          const cardClasses = isTopEntry
                            ? "border-emerald-500/60 bg-gradient-to-r from-emerald-500/15 via-neutral-950/70 to-neutral-950/40 shadow shadow-emerald-500/20"
                            : "border-neutral-800 bg-neutral-950/70";
                          return (
                            <div
                              key={chat.chatId}
                              className={`rounded-lg border p-4 ${cardClasses}`}
                            >
                              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
                                <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
                                <span>{chat.isGroup ? "Group" : "Chat"}</span>
                                <span className="text-neutral-700">•</span>
                                <span>{formatDateTime(chat.lastMessageAt)}</span>
                              </div>
                              <div className="mt-2 flex items-center justify-between gap-3">
                                <p className="text-sm font-medium text-neutral-100">
                                  {chat.chatDisplayName ?? formatParticipants(chat)}
                                </p>
                                <span className="text-xs text-neutral-400">{percentShare}</span>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                                <span className="font-semibold text-neutral-100">
                                  {formatNumber(totalMessages)} messages
                                </span>
                                <span className="text-emerald-300">↑ {formatNumber(chat.sentCount)}</span>
                                <span className="text-sky-300">↓ {formatNumber(chat.receivedCount)}</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                        {isHourlyView ? "Hourly cadence" : "Weekday cadence"}
                      </h3>
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        {(["hourly", "weekday"] as const).map((view) => (
                          <button
                            key={view}
                            type="button"
                            onClick={() => setActivityView(view)}
                            aria-pressed={activityView === view}
                            className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${
                              activityView === view
                                ? "border-sky-400/80 bg-sky-500/10 text-sky-200"
                                : "border-neutral-800/80 text-neutral-400 hover:text-white"
                            }`}
                          >
                            {view === "hourly" ? "Hourly" : "Weekday"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 space-y-2">
                      {activityCounts.length === 0 && (
                        <p className="text-sm text-neutral-500">{activityEmptyMessage}</p>
                      )}
                      {activityCounts.map((bucket, index) => {
                        const total = bucket.sentCount + bucket.receivedCount;
                        const width = activityMax
                          ? Math.min(100, Math.max(2, (total / activityMax) * 100))
                          : 0;
                        const label =
                          "hour" in bucket
                            ? `${bucket.hour.toString().padStart(2, "0")}h`
                            : weekdayLabels[bucket.weekday];
                        return (
                          <div key={`${activityView}-${index}`} className="flex items-center gap-3 text-sm">
                            <span className="w-10 text-xs text-neutral-500">{label}</span>
                            <div className="h-2 flex-1 rounded bg-neutral-800">
                              <div
                                className="h-2 rounded bg-gradient-to-r from-emerald-400 to-sky-400"
                                style={{
                                  width: `${width}%`,
                                  transition: "width 500ms cubic-bezier(0.32, 0.72, 0, 1)",
                                }}
                              />
                            </div>
                            <span className="w-12 text-right text-xs text-neutral-400">
                              {formatNumber(total)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-3 text-xs text-neutral-500">All times are shown in your system's time zone.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {shouldShowAccessTip && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="access-tip-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-10 backdrop-blur"
        >
          <div className="relative w-full max-w-md rounded-2xl border border-sky-500/40 bg-neutral-950/95 p-5 text-sky-50 shadow-2xl shadow-black/60">
            <button
              type="button"
              onClick={handleDismissAccessTip}
              className="absolute right-4 top-4 rounded-full border border-sky-300/40 p-1 text-sky-200 transition hover:border-sky-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
              aria-label="Dismiss Full Disk Access dialog"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M6.225 4.811a1 1 0 0 0-1.414 1.414L10.586 12l-5.775 5.775a1 1 0 0 0 1.414 1.414L12 13.414l5.775 5.775a1 1 0 0 0 1.414-1.414L13.414 12l5.775-5.775a1 1 0 0 0-1.414-1.414L12 10.586 6.225 4.811Z"
                />
              </svg>
            </button>
            <div className="flex items-start gap-3 pr-6">
              <div className="flex h-12 min-w-[3rem] items-center justify-center rounded-xl bg-sky-500/20 px-3 text-sky-50">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
                  <path fill="currentColor" d="M11 10h2v7h-2zm0-4h2v2h-2z" />
                  <path
                    fill="currentColor"
                    d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2m0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8"
                  />
                </svg>
              </div>
              <div>
                <h2 id="access-tip-title" className="text-lg font-semibold text-white">
                  Grant Full Disk Access
                </h2>
                <p className="mt-2 text-sm text-sky-100/80">
                  macOS denied access to the Messages database. Open System Settings → Privacy & Security → Full Disk Access and enable Terminal (or the host app), then refresh.
                </p>
                <p className="mt-3 text-xs text-sky-100/70">Analysis always stays on-device—no data leaves your Mac.</p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={handleStatsRefresh}
                    className="rounded-full border border-sky-400/60 bg-sky-500/20 px-4 py-1.5 text-sm font-semibold text-sky-50 transition hover:border-sky-300 hover:bg-sky-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
                  >
                    Retry now
                  </button>
                  <button
                    type="button"
                    onClick={handleDismissAccessTip}
                    className="rounded-full border border-sky-300/30 px-4 py-1.5 text-sm font-semibold text-sky-200 transition hover:border-sky-200 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
