'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

interface ChatSummary {
  chatId: number;
  chatDisplayName: string | null;
  isGroup: boolean;
  participants: string[];
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  lastMessageAt: string | null;
  reactions: ReactionTotals;
  reactionParticipants: ChatReactionParticipant[];
  messageParticipants: ParticipantStats[];
}

interface ParticipantStats {
  id: string | null;
  displayName: string | null;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  isMe?: boolean;
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

interface ReactionCountSummary {
  reactionCount: number;
  sentCount: number;
  receivedCount: number;
}

interface ReactionTotals extends ReactionCountSummary {
  byType: Record<string, ReactionCountSummary>;
}

interface ChatReactionParticipant {
  id: string;
  displayName: string | null;
  reactionCount: number;
  isMe: boolean;
}

interface AttachmentTopSender {
  id: string | null;
  displayName: string | null;
  count: number;
  isMe: boolean;
}

interface AttachmentStats {
  totalCount: number;
  sentCount: number;
  receivedCount: number;
  topSender: AttachmentTopSender | null;
}

interface ConversationStats {
  topChats: ChatSummary[];
  participantBreakdown: ParticipantStats[];
  dailyCounts: DailyCount[];
  hourlyCounts: HourlyCount[];
  weekdayCounts: WeekdayCount[];
  totals: MessageTotals;
  reactionTotals: ReactionTotals;
  attachmentStats: AttachmentStats;
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
const singleDayRangeOptions: StatsRange[] = ["1h", "6h", "12h", "1d"];
const DEFAULT_STATS_LIMIT = 40;
const CHAT_COUNT_OPTIONS = [5, 10, 20, 30];
const ACCESS_TIP_STORAGE_KEY = "imessage-insights:fda-tip-dismissed";
const STATS_RANGE_STORAGE_KEY = "imessage-insights:stats-range";
const ACTIVITY_VIEW_STORAGE_KEY = "imessage-insights:activity-view";
const HOUR_FORMAT_STORAGE_KEY = "imessage-insights:hour-format";

function readStoredValue<T>(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key) as T | null;
  } catch {
    return null;
  }
}

function getStoredStatsRange(): StatsRange {
  const stored = readStoredValue<StatsRange>(STATS_RANGE_STORAGE_KEY);
  return stored && statsRangeOptions.includes(stored) ? stored : "all";
}

function getStoredActivityView(): "hourly" | "weekday" {
  const stored = readStoredValue<"hourly" | "weekday">(ACTIVITY_VIEW_STORAGE_KEY);
  return stored && (["hourly", "weekday"] as const).includes(stored) ? stored : "hourly";
}

function getStoredHourFormat(): HourClockMode {
  const stored = readStoredValue<HourClockMode>(HOUR_FORMAT_STORAGE_KEY);
  return stored && (["12h", "24h"] as const).includes(stored) ? stored : "24h";
}

function getRangeDates(range: StatsRange) {
  if (range === "all") return {};
  const now = new Date();
  const duration = rangeDurations[range];
  const start = new Date(now.getTime() - duration);
  return { start: start.toISOString(), end: now.toISOString() };
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDayLabel(value: string | null) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatHourLabel(hour: number | null | undefined) {
  if (!Number.isFinite(hour) || hour === null || hour === undefined) return "Any time";
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric" });
}

function formatWeekdayLabel(weekday: number | null | undefined) {
  if (!Number.isFinite(weekday) || weekday === null || weekday === undefined) return "Any day";
  return weekdayLabels[weekday] ?? "Any day";
}

function formatHourLabelByMode(hour: number, mode: HourClockMode) {
  if (mode === "24h") {
    return `${hour.toString().padStart(2, "0")}:00`;
  }
  return formatHourLabel(hour);
}

const compactFormatter = Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCompactNumber(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN) || (value ?? 0) <= 0) return "—";
  try {
    return compactFormatter.format(value as number);
  } catch {
    return formatNumber(value as number);
  }
}

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

function ReactionIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} role="img">
      <path
        fill="currentColor"
        d="M12 21C12 21 4 13.22 4 8.5C4 5.42 6.42 3 9.5 3C11.04 3 12.54 3.81 13.25 5.08C13.96 3.81 15.46 3 17 3C20.08 3 22.5 5.42 22.5 8.5C22.5 13.22 14.5 21 14.5 21H12Z"
      />
    </svg>
  );
}

function ShareIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} role="img">
      <path
        fill="currentColor"
        d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.02-4.11A2.97 2.97 0 0 0 18 7.91a3 3 0 1 0-2.83-4h-1.34A3 3 0 1 0 6 7a3 3 0 0 0 .09.7L13.11 11.8a2.99 2.99 0 0 0 0 1.39L6.09 17.3c-.05-.23-.09-.46-.09-.7a3 3 0 1 0-3 3h1.34a3 3 0 1 0 5.83-1.91h1.34A3 3 0 1 0 18 16.08"
      />
    </svg>
  );
}

function CalendarIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} role="img">
      <path
        fill="currentColor"
        d="M19 4h-1V2h-2v2H8V2H6v2H5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3m1 15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10h16zm0-11H4V7a1 1 0 0 1 1-1h1v1h2V6h8v1h2V6h1a1 1 0 0 1 1 1z"
      />
    </svg>
  );
}

function ClockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} role="img">
      <path
        fill="currentColor"
        d="M12 1.75a10.25 10.25 0 1 0 10.25 10.25A10.25 10.25 0 0 0 12 1.75m0 18.5A8.25 8.25 0 1 1 20.25 12 8.26 8.26 0 0 1 12 20.25"
      />
      <path
        fill="currentColor"
        d="M12.75 6.75h-1.5v5.249l4.5 2.7.75-1.23-3.75-2.22z"
      />
    </svg>
  );
}


type ChatFilterMode = "all" | "direct" | "group";
type HourClockMode = "12h" | "24h";
type ReportStatus = "idle" | "loading" | "error" | "success";

const chatFilterOptions: { value: ChatFilterMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "direct", label: "Chats" },
  { value: "group", label: "Groups" },
];

type InsightItem = {
  key: string;
  label: string;
  primary: string;
  secondary?: string;
  icon: ReactNode;
};

type SummaryCardBadge = {
  key: string;
  label?: string;
  value: string;
  tone: "emerald" | "sky" | "violet" | "amber" | "neutral";
};

type SummaryCard = {
  key: string;
  label: string;
  value: string;
  description?: string;
  meta?: string;
  accent?: string;
  badges?: SummaryCardBadge[];
};

function SkeletonPulse({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-neutral-800/60 ${className ?? ""}`} />;
}

function StatsOverviewSkeleton() {
  const summarySkeletons = Array.from({ length: 6 });
  const insightSkeletons = Array.from({ length: 4 });
  const listSkeletons = Array.from({ length: 3 });
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {summarySkeletons.map((_, index) => (
          <div
            key={`summary-skeleton-${index}`}
            className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-4"
          >
            <SkeletonPulse className="mb-3 h-3 w-20" />
            <SkeletonPulse className="mb-2 h-6 w-24" />
            <SkeletonPulse className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {insightSkeletons.map((_, index) => (
          <div
            key={`insight-skeleton-${index}`}
            className="flex items-center gap-4 rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-4"
          >
            <SkeletonPulse className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <SkeletonPulse className="h-3 w-24" />
              <SkeletonPulse className="h-4 w-32" />
              <SkeletonPulse className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-4">
          <SkeletonPulse className="mb-4 h-4 w-32" />
          <div className="space-y-3">
            {listSkeletons.map((_, index) => (
              <div key={`list-skeleton-${index}`} className="space-y-2 rounded-lg border border-neutral-800/60 p-3">
                <SkeletonPulse className="h-3 w-2/3" />
                <SkeletonPulse className="h-3 w-1/2" />
                <SkeletonPulse className="h-3 w-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-4">
          <SkeletonPulse className="mb-4 h-4 w-40" />
          <div className="space-y-3">
            {listSkeletons.map((_, index) => (
              <div key={`bar-skeleton-${index}`} className="flex items-center gap-3">
                <SkeletonPulse className="h-3 w-10" />
                <SkeletonPulse className="h-2 flex-1" />
                <SkeletonPulse className="h-3 w-12" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [statsRange, setStatsRange] = useState<StatsRange>(() => getStoredStatsRange());
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [chatFilterMode, setChatFilterMode] = useState<ChatFilterMode>("all");
  const [visibleChatCount, setVisibleChatCount] = useState(5);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [statsRefreshToken, setStatsRefreshToken] = useState(0);
  const [activityView, setActivityView] = useState<"hourly" | "weekday">(() => getStoredActivityView());
  const [hourClockMode, setHourClockMode] = useState<HourClockMode>(() => getStoredHourFormat());
  const [accessError, setAccessError] = useState(false);
  const [accessTipDismissed, setAccessTipDismissed] = useState(false);
  const [expandedChatSections, setExpandedChatSections] = useState<
    Record<number, { messages: boolean; reactions: boolean }>
  >({});
  const [reportChat, setReportChat] = useState<ChatSummary | null>(null);
  const [reportStatus, setReportStatus] = useState<ReportStatus>("idle");
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);

  const totals = useMemo(() => computeTotals(stats), [stats]);
  const sampledDayCount = stats?.dailyCounts.length ?? 0;
  const averagePerDay = useMemo(() => {
    if (!stats || sampledDayCount === 0) return null;
    return Math.max(1, Math.round(totals.total / sampledDayCount));
  }, [sampledDayCount, stats, totals.total]);

  const chatSearchTerm = chatSearchQuery.trim().toLowerCase();
  const isChatSearchActive = chatSearchTerm.length > 0;

  const filteredTopChats = useMemo(() => {
    const chats = stats?.topChats ?? [];
    const modeFiltered = (() => {
      switch (chatFilterMode) {
        case "direct":
          return chats.filter((chat) => !chat.isGroup);
        case "group":
          return chats.filter((chat) => chat.isGroup);
        default:
          return chats;
      }
    })();
    if (!chatSearchTerm) return modeFiltered;
    return modeFiltered.filter((chat) => {
      const displayName = (chat.chatDisplayName ?? "").toLowerCase();
      const participants = chat.participants.join(" ").toLowerCase();
      return displayName.includes(chatSearchTerm) || participants.includes(chatSearchTerm);
    });
  }, [chatFilterMode, chatSearchTerm, stats]);
  const topChatPreview = isChatSearchActive ? filteredTopChats : filteredTopChats.slice(0, visibleChatCount);
  const filteredChatCount = filteredTopChats.length;
  const previewedChatCount = topChatPreview.length;
  const totalChatCount = stats?.topChats.length ?? 0;
  const reactionTotalsSummary = stats?.reactionTotals ?? null;
  const attachmentSummary = stats?.attachmentStats ?? null;
  const averageSentPerDay = useMemo(() => {
    if (!stats || sampledDayCount === 0) return null;
    return Math.max(0, Math.round(stats.totals.sentCount / sampledDayCount));
  }, [sampledDayCount, stats]);
  const averageReceivedPerDay = useMemo(() => {
    if (!stats || sampledDayCount === 0) return null;
    return Math.max(0, Math.round(stats.totals.receivedCount / sampledDayCount));
  }, [sampledDayCount, stats]);
  const earliestMessageDate = useMemo(() => {
    if (!stats || stats.dailyCounts.length === 0) return null;
    const earliest = stats.dailyCounts.reduce<string | null>((min, bucket) => {
      if (!bucket.date) return min;
      if (!min) return bucket.date;
      return new Date(bucket.date) < new Date(min) ? bucket.date : min;
    }, null);
    return earliest;
  }, [stats]);
  const summaryCards = useMemo<SummaryCard[]>(() => {
    const cards: SummaryCard[] = [
      {
        key: "total",
        label: "All messages",
        value: formatCompactNumber(totals.total),
        description: totals.total ? `${formatNumber(totals.total)} messages` : undefined,
        meta:
          statsRange === "all" && earliestMessageDate
            ? `Since ${formatDayLabel(earliestMessageDate)}`
            : sampledDayCount > 0
              ? `Across ${formatNumber(sampledDayCount)} day${sampledDayCount === 1 ? "" : "s"}`
              : undefined,
      },
      {
        key: "sent",
        label: "Sent",
        value: formatCompactNumber(totals.sent),
        description: totals.sent ? `${formatNumber(totals.sent)} messages` : undefined,
        badges:
          totals.total && totals.sent
            ? [
                {
                  key: "sent-share",
                  value: formatPercent(totals.sent, totals.total),
                  tone: "emerald",
                },
              ]
            : undefined,
      },
      {
        key: "received",
        label: "Received",
        value: formatCompactNumber(totals.received),
        description: totals.received ? `${formatNumber(totals.received)} messages` : undefined,
        badges:
          totals.total && totals.received
            ? [
                {
                  key: "recv-share",
                  value: formatPercent(totals.received, totals.total),
                  tone: "sky",
                },
              ]
            : undefined,
      },
      {
        key: "pace",
        label: "Daily average",
        value: averagePerDay ? formatNumber(averagePerDay) : "—",
        description:
          sampledDayCount > 0 ? `Average across ${formatNumber(sampledDayCount)} day${sampledDayCount === 1 ? "" : "s"}` : undefined,
        badges: [
          averageSentPerDay
            ? {
                key: "pace-sent",
                label: "Sent",
                value: `${formatNumber(averageSentPerDay)}/day`,
                tone: "emerald",
              }
            : null,
          averageReceivedPerDay
            ? {
                key: "pace-received",
                label: "Received",
                value: `${formatNumber(averageReceivedPerDay)}/day`,
                tone: "sky",
              }
            : null,
        ].filter(Boolean) as SummaryCardBadge[],
      },
      {
        key: "reactions",
        label: "Reactions",
        value: reactionTotalsSummary?.reactionCount ? formatCompactNumber(reactionTotalsSummary.reactionCount) : "—",
        description: reactionTotalsSummary?.reactionCount ? `${formatNumber(reactionTotalsSummary.reactionCount)} total` : undefined,
        badges: reactionTotalsSummary?.reactionCount
          ? [
              {
                key: "reactions-sent",
                label: "Sent",
                value: formatNumber(reactionTotalsSummary.sentCount),
                tone: "emerald",
              },
              {
                key: "reactions-received",
                label: "Received",
                value: formatNumber(reactionTotalsSummary.receivedCount),
                tone: "sky",
              },
            ]
          : undefined,
      },
    ];
    const pluralize = (value: number, noun: string) => `${formatNumber(value)} ${noun}${value === 1 ? "" : "s"}`;
    if (attachmentSummary) {
      const attachmentDescription =
        attachmentSummary.sentCount > 0
          ? `You sent ${pluralize(attachmentSummary.sentCount, "attachment")}`
          : attachmentSummary.totalCount > 0
            ? "No attachments sent in this range"
            : "No attachments yet";
      const attachmentBadges =
        attachmentSummary.topSender && attachmentSummary.topSender.count > 0
          ? [
              {
                key: "attachments-top",
                label: attachmentSummary.topSender.isMe ? "Top sender (you)" : "Top sender",
                value: `${attachmentSummary.topSender.displayName ?? "Unknown"} · ${formatNumber(attachmentSummary.topSender.count)}`,
                tone: "violet",
              },
            ]
          : undefined;
      cards.push({
        key: "attachments",
        label: "Attachments",
        value:
          attachmentSummary.sentCount > 0
            ? formatCompactNumber(attachmentSummary.sentCount)
            : "—",
        description: attachmentDescription,
        badges: attachmentBadges,
      });
    }
    return cards;
  }, [
    attachmentSummary,
    averagePerDay,
    averageReceivedPerDay,
    averageSentPerDay,
    earliestMessageDate,
    reactionTotalsSummary,
    sampledDayCount,
    statsRange,
    totals.received,
    totals.sent,
    totals.total,
  ]);

  const summaryCardStyles: Record<
    string,
    { wrapper: string; valueClass: string }
  > = {
    total: {
      wrapper: "border-neutral-800/70 bg-gradient-to-br from-neutral-950 via-neutral-950/80 to-neutral-900",
      valueClass: "text-white",
    },
    sent: {
      wrapper: "border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-neutral-950 to-neutral-950",
      valueClass: "text-emerald-200",
    },
    received: {
      wrapper: "border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-neutral-950 to-neutral-950",
      valueClass: "text-sky-200",
    },
    reactions: {
      wrapper: "border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-neutral-950 to-neutral-950",
      valueClass: "text-violet-100",
    },
    pace: {
      wrapper: "border-amber-400/30 bg-gradient-to-br from-amber-400/10 via-neutral-950 to-neutral-950",
      valueClass: "text-amber-100",
    },
    attachments: {
      wrapper: "border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 via-neutral-950 to-neutral-950",
      valueClass: "text-fuchsia-100",
    },
  };

  const badgeToneClasses: Record<SummaryCardBadge["tone"], string> = {
    emerald: "bg-emerald-400/15 text-emerald-100",
    sky: "bg-sky-400/15 text-sky-100",
    violet: "bg-violet-400/15 text-violet-100",
    amber: "bg-amber-400/15 text-amber-900",
    neutral: "bg-neutral-800 text-neutral-200",
  };
  const insightItems = useMemo<InsightItem[]>(() => {
    if (!stats) return [];
    const items: InsightItem[] = [];
    const topChat = stats.topChats[0] ?? null;
    if (topChat) {
      const icon = topChat.isGroup ? (
        <GroupChatIcon className="h-4 w-4 text-rose-200" />
      ) : (
        <DirectChatIcon className="h-4 w-4 text-indigo-200" />
      );
      const parts = [`${formatNumber(topChat.messageCount)} msgs`];
      if (totals.total > 0) {
        parts.push(formatPercent(topChat.messageCount, totals.total));
      }
      items.push({
        key: "top-chat",
        label: "Most active chat",
        primary: topChat.chatDisplayName ?? formatParticipants(topChat),
        secondary: parts.join(" · "),
        icon,
      });
    }

    if (attachmentSummary?.topSender && attachmentSummary.topSender.count > 0) {
      const topSender = attachmentSummary.topSender;
      const topSenderName = topSender.displayName ?? (topSender.isMe ? "You" : "Unknown");
      const attachmentParts = [`${formatNumber(topSender.count)} attachments`];
      if (topSender.isMe) {
        if (attachmentSummary.receivedCount > 0) {
          attachmentParts.push(`${formatNumber(attachmentSummary.receivedCount)} received`);
        }
      } else if (attachmentSummary.sentCount > 0) {
        attachmentParts.push(`You sent ${formatNumber(attachmentSummary.sentCount)}`);
      }
      items.push({
        key: "top-attachments",
        label: "Attachment leader",
        primary: topSenderName,
        secondary: attachmentParts.join(" · "),
        icon: <ShareIcon className="h-4 w-4 text-fuchsia-200" />,
      });
    }

    const allowBusiestDayInsight = !singleDayRangeOptions.includes(statsRange);
    if (allowBusiestDayInsight) {
      const busiestDayBucket = stats.dailyCounts.reduce<DailyCount | null>((max, bucket) => {
        if (!max) return bucket;
        const bucketTotal = bucket.sentCount + bucket.receivedCount;
        const maxTotal = max.sentCount + max.receivedCount;
        return bucketTotal > maxTotal ? bucket : max;
      }, null);
      if (busiestDayBucket) {
        const bucketTotal = busiestDayBucket.sentCount + busiestDayBucket.receivedCount;
        items.push({
          key: "busiest-day",
          label: "Busiest day",
          primary: formatDayLabel(busiestDayBucket.date),
          secondary: `${formatNumber(bucketTotal)} messages`,
          icon: <CalendarIcon className="h-4 w-4 text-amber-200" />,
        });
      }
    }

    const peakHourBucket = stats.hourlyCounts.reduce<HourlyCount | null>((max, bucket) => {
      if (!max) return bucket;
      const bucketTotal = bucket.sentCount + bucket.receivedCount;
      const maxTotal = max.sentCount + max.receivedCount;
      return bucketTotal > maxTotal ? bucket : max;
    }, null);
    if (peakHourBucket) {
      items.push({
        key: "peak-hour",
        label: "Peak hour",
        primary: formatHourLabel(peakHourBucket.hour),
        secondary: `${formatNumber(peakHourBucket.sentCount)} sent · ${formatNumber(peakHourBucket.receivedCount)} received`,
        icon: <ClockIcon className="h-4 w-4 text-sky-200" />,
      });
    }

    const reactionEntries = Object.entries(stats.reactionTotals?.byType ?? {});
    const topReaction = reactionEntries.reduce<[string, ReactionCountSummary] | null>((max, entry) => {
      if (!max) return entry;
      return entry[1].reactionCount > max[1].reactionCount ? entry : max;
    }, null);
    if (topReaction && topReaction[1].reactionCount > 0) {
      const [reactionType, reactionTotals] = topReaction;
      items.push({
        key: `reaction-${reactionType}`,
        label: "Most used reaction",
        primary: reactionType,
        secondary: `${formatNumber(reactionTotals.reactionCount)} total`,
        icon: <ReactionIcon className="h-4 w-4 text-violet-200" />,
      });
    }

    if (!peakHourBucket && stats.weekdayCounts.length > 0) {
      const busiestWeekdayBucket = stats.weekdayCounts.reduce<WeekdayCount | null>((max, bucket) => {
        if (!max) return bucket;
        const bucketTotal = bucket.sentCount + bucket.receivedCount;
        const maxTotal = max.sentCount + max.receivedCount;
        return bucketTotal > maxTotal ? bucket : max;
      }, null);
      if (busiestWeekdayBucket) {
        const bucketTotal = busiestWeekdayBucket.sentCount + busiestWeekdayBucket.receivedCount;
        items.push({
          key: "busiest-weekday",
          label: "Most talkative day",
          primary: formatWeekdayLabel(busiestWeekdayBucket.weekday),
          secondary: `${formatNumber(bucketTotal)} messages`,
          icon: <CalendarIcon className="h-4 w-4 text-indigo-200" />,
        });
      }
    }

    return items;
  }, [attachmentSummary, stats, statsRange, totals.total]);
  const insightGridClass = useMemo(() => {
    const count = insightItems.length;
    if (count <= 1) return "grid gap-3 sm:grid-cols-1 max-w-lg mx-auto";
    if (count === 2) return "grid gap-3 sm:grid-cols-2 lg:grid-cols-2 max-w-4xl mx-auto";
    if (count === 3) return "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";
    return "grid gap-3 sm:grid-cols-2 lg:grid-cols-4";
  }, [insightItems.length]);
  const handleStatsRefresh = () => setStatsRefreshToken((token) => token + 1);
  const handleOpenReportModal = (chat: ChatSummary) => {
    setReportChat(chat);
    setReportStatus("loading");
    setReportError(null);
    const url = buildReportUrl(chat);
    setReportUrl(url);
    try {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        throw new Error("Pop-up blocked. Allow pop-ups to view the report.");
      }
      setReportStatus("success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open the report window.";
      setReportError(message);
      setReportStatus("error");
    }
  };
  const handleCloseReportModal = () => {
    setReportChat(null);
    setReportStatus("idle");
    setReportError(null);
    setReportUrl(null);
  };
  const toggleChatSection = (chatId: number, section: "messages" | "reactions") => {
    setExpandedChatSections((prev) => {
      const current = prev[chatId] ?? { messages: false, reactions: false };
      return {
        ...prev,
        [chatId]: {
          ...current,
          [section]: !current[section],
        },
      };
    });
  };

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
  const topConversationsTitle =
    chatFilterMode === "group" ? "Top Groups" : chatFilterMode === "direct" ? "Top Chats" : "Top Conversations";
  const buildReportUrl = useCallback(
    (chat: ChatSummary) => {
      const params = new URLSearchParams();
      const rangeDates = getRangeDates(statsRange);
      if (rangeDates.start) params.set("start", rangeDates.start);
      if (rangeDates.end) params.set("end", rangeDates.end);
      const query = params.toString();
      return `/reports/${chat.chatId}${query ? `?${query}` : ""}`;
    },
    [statsRange],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(ACCESS_TIP_STORAGE_KEY);
    setAccessTipDismissed(stored === "true");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STATS_RANGE_STORAGE_KEY, statsRange);
    } catch {
      // ignore
    }
  }, [statsRange]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ACTIVITY_VIEW_STORAGE_KEY, activityView);
    } catch {
      // ignore
    }
  }, [activityView]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(HOUR_FORMAT_STORAGE_KEY, hourClockMode);
    } catch {
      // ignore
    }
  }, [hourClockMode]);

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
  const showInitialSkeleton = statsLoading && !stats && !statsError;

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-neutral-100">
      <header className="relative overflow-hidden border-b border-neutral-900/60 bg-neutral-950/95 py-6">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-b from-emerald-500/10 via-transparent to-transparent" />
          <div className="absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-sky-500/20 via-transparent to-transparent blur-3xl opacity-60" />
        </div>
        <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-6 px-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-[0.65rem] font-semibold uppercase tracking-wide text-emerald-200">
              <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1">Beta</span>
              <span className="text-neutral-500">On-device analytics</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
              <div className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-900/80 px-3 py-1">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                <span>{stats ? `Latest activity ${latestActivityLabel}` : "Awaiting first sync…"}</span>
              </div>
              <button
                type="button"
                onClick={handleStatsRefresh}
                className="rounded-full border border-emerald-500/40 bg-emerald-500/10 p-1.5 text-emerald-200 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-400/80 hover:bg-emerald-400/20 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
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
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-white">Messages Analytics</h1>
              <p className="mt-1 text-sm text-neutral-400">
                Instant insights into your busiest chats, streaks, and reaction habits.
              </p>
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
            {statsLoading && stats && (
              <div className="flex items-center gap-2 text-sm text-neutral-400">
                <Spinner /> Refreshing stats…
              </div>
            )}
            {showInitialSkeleton && <StatsOverviewSkeleton />}
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
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {summaryCards.map((card) => {
                    const style = summaryCardStyles[card.key] ?? summaryCardStyles.total;
                    return (
                      <div
                        key={card.key}
                        className={`flex flex-col justify-between rounded-2xl border p-4 shadow shadow-black/20 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-emerald-500/20 ${style.wrapper}`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{card.label}</p>
                            {card.accent && (
                              <span className="rounded-full bg-neutral-900/60 px-2 py-0.5 text-[11px] font-semibold text-neutral-300">
                                {card.accent}
                              </span>
                            )}
                          </div>
                          <p className={`mt-2 text-3xl font-semibold ${style.valueClass}`}>{card.value}</p>
                          {card.description && (
                            <p className="mt-1 text-sm text-neutral-200">{card.description}</p>
                          )}
                          {card.meta && (
                            <p className="text-xs text-neutral-500">{card.meta}</p>
                          )}
                        </div>
                        {card.badges && card.badges.length > 0 && (
                          <div className="mt-4 flex flex-wrap gap-2">
                            {card.badges.map((badge) => (
                              <span
                                key={badge.key}
                                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${badgeToneClasses[badge.tone]}`}
                              >
                                {badge.label && <span>{badge.label}</span>}
                                <span>{badge.value}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {insightItems.length > 0 && (
                  <div className={insightGridClass}>
                    {insightItems.map((insight) => (
                      <div
                        key={insight.key}
                        className="flex items-center gap-4 rounded-xl border border-neutral-800/70 bg-neutral-950/60 p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-neutral-700"
                      >
                        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/60">
                          {insight.icon}
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                            {insight.label}
                          </p>
                          <p className="text-sm font-semibold text-neutral-50">{insight.primary}</p>
                          {insight.secondary && (
                            <p className="text-xs text-neutral-400">{insight.secondary}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

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
                      <div className="ml-auto flex-1 min-w-[200px]">
                        <label htmlFor="chat-search" className="sr-only">
                          Search chats
                        </label>
                        <div className="relative text-neutral-300">
                          <svg
                            aria-hidden="true"
                            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600"
                            viewBox="0 0 24 24"
                          >
                            <path
                              fill="none"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="1.5"
                              d="m21 21-4.35-4.35m0-6.3a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0"
                            />
                          </svg>
                          <input
                            id="chat-search"
                            type="search"
                            value={chatSearchQuery}
                            onChange={(event) => setChatSearchQuery(event.target.value)}
                            placeholder="Search chats or groups"
                            className="w-full rounded border border-neutral-700 bg-neutral-950 py-1.5 pl-8 pr-8 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-emerald-400/60"
                          />
                          {chatSearchQuery && (
                            <button
                              type="button"
                              onClick={() => setChatSearchQuery("")}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-neutral-500 transition hover:text-neutral-200"
                              aria-label="Clear chat search"
                            >
                              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                                <path
                                  fill="none"
                                  stroke="currentColor"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth="1.5"
                                  d="m7 7 10 10M7 17 17 7"
                                />
                              </svg>
                            </button>
                          )}
                        </div>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
                    <span>
                      Showing {previewedChatCount} of {filteredChatCount}{" "}
                      {filteredChatCount === 1 ? "conversation" : "conversations"}
                    </span>
                    {filteredChatCount !== totalChatCount && totalChatCount > 0 && (
                      <span className="text-neutral-600">•</span>
                    )}
                    {filteredChatCount !== totalChatCount && totalChatCount > 0 && (
                      <span>{formatNumber(totalChatCount)} in range</span>
                    )}
                  </div>
                    <div className="mt-3 space-y-3">
                      {topChatPreview.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-neutral-800/80 bg-neutral-950/40 p-6 text-center text-sm text-neutral-400">
                          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-neutral-800/80 bg-neutral-900/80">
                            <DirectChatIcon className="h-4 w-4 text-neutral-500" />
                          </div>
                          <p className="mt-3 font-medium text-neutral-200">
                            {isChatSearchActive
                              ? "No conversations match this search."
                              : filteredTopChats.length === 0
                                ? "No conversations match this filter."
                                : "No conversations in this range yet."}
                          </p>
                          <p className="text-xs text-neutral-500">
                            Try expanding the range or clearing filters to see more chats.
                          </p>
                        </div>
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
                          const expandedSectionsForChat = expandedChatSections[chat.chatId] ?? {
                            messages: false,
                            reactions: false,
                          };
                          const messagesExpanded = expandedSectionsForChat.messages;
                          const reactionsExpanded = expandedSectionsForChat.reactions;
                          return (
                            <div
                              key={chat.chatId}
                              className={`rounded-lg border p-4 transition-all duration-300 hover:-translate-y-0.5 ${cardClasses}`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-wide text-neutral-500">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full border border-neutral-800/80 px-2 py-0.5 text-[10px] font-semibold text-neutral-400">
                                    #{index + 1}
                                  </span>
                                  <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
                                  <span>{chat.isGroup ? "Group" : "Chat"}</span>
                                  <span className="text-neutral-700">•</span>
                                  <span>{formatDateTime(chat.lastMessageAt)}</span>
                                </div>
                                {chat.isGroup && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenReportModal(chat)}
                                    className="flex items-center gap-1 rounded-full border border-neutral-800/70 px-2 py-0.5 text-[10px] font-semibold text-neutral-300 transition hover:border-emerald-400/60 hover:text-white"
                                  >
                                    <ShareIcon className="h-3 w-3" />
                                    Share report
                                  </button>
                                )}
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
                              {chat.isGroup && chat.participants.length > 0 && (
                                <p className="mt-1 truncate text-[11px] text-neutral-500">
                                  {chat.participants.slice(0, 3).join(", ")}
                                  {chat.participants.length > 3 ? ` +${chat.participants.length - 3}` : ""}
                                </p>
                              )}
                              {chat.reactions.reactionCount > 0 && (
                                <div className="mt-2 rounded-md border border-violet-500/10 bg-violet-500/5 px-3 py-2 text-xs text-violet-100/80">
                                  <div className="flex flex-wrap items-center gap-3">
                                    <span className="flex items-center gap-1 text-violet-200">
                                      <ReactionIcon className="h-3.5 w-3.5" />
                                      {formatNumber(chat.reactions.reactionCount)} reactions
                                    </span>
                                    <span className="text-emerald-300">
                                      ↑ {formatNumber(chat.reactions.sentCount)}
                                    </span>
                                    <span className="text-sky-300">
                                      ↓ {formatNumber(chat.reactions.receivedCount)}
                                    </span>
                                  </div>
                                </div>
                              )}
                              {chat.isGroup && chat.messageParticipants.length > 0 && (
                                <div className="mt-3 rounded-md border border-neutral-800/60 bg-neutral-900/60 px-3 py-2">
                                  <div className="flex items-center justify-between">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                                      Messages by member
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => toggleChatSection(chat.chatId, "messages")}
                                      className="text-[11px] font-semibold text-emerald-200 hover:text-emerald-100"
                                    >
                                      {messagesExpanded ? "Hide" : "Show"}
                                    </button>
                                  </div>
                                  {messagesExpanded && (
                                    <ul className="mt-2 space-y-1.5">
                                      {chat.messageParticipants.map((participant) => {
                                        const isSelf = Boolean(participant.isMe || participant.id === "me");
                                        const nameClasses = isSelf
                                          ? "font-semibold text-emerald-200"
                                          : "text-neutral-200";
                                        return (
                                          <li
                                            key={`${chat.chatId}-${participant.id}`}
                                            className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-200"
                                          >
                                            <span className={`flex items-center gap-2 ${nameClasses}`}>
                                              {participant.displayName ?? "Unknown"}
                                            </span>
                                            <div className="flex items-center gap-3">
                                              <span className="font-semibold text-neutral-100">
                                                {formatNumber(participant.messageCount)} msgs
                                              </span>
                                              {isSelf ? (
                                                participant.sentCount > 0 && (
                                                  <span className="text-emerald-300">
                                                    ↑ {formatNumber(participant.sentCount)}
                                                  </span>
                                                )
                                              ) : (
                                                <span className="text-sky-300">
                                                  ↓ {formatNumber(participant.receivedCount)}
                                                </span>
                                              )}
                                            </div>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </div>
                              )}
                              {chat.isGroup && chat.reactionParticipants.length > 0 && (
                                <div className="mt-3 rounded-md border border-neutral-800/60 bg-neutral-900/60 px-3 py-2">
                                  <div className="flex items-center justify-between">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                                      Reactions by member
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => toggleChatSection(chat.chatId, "reactions")}
                                      className="text-[11px] font-semibold text-emerald-200 hover:text-emerald-100"
                                    >
                                      {reactionsExpanded ? "Hide" : "Show"}
                                    </button>
                                  </div>
                                  {reactionsExpanded && (
                                    <ul className="mt-2 space-y-1.5">
                                      {chat.reactionParticipants.map((participant) => {
                                        const nameClasses = participant.isMe
                                          ? "font-semibold text-emerald-200"
                                          : "text-neutral-200";
                                        return (
                                          <li
                                            key={`${chat.chatId}-${participant.id}`}
                                            className="flex items-center justify-between text-xs text-neutral-200"
                                          >
                                            <span className={`flex items-center gap-2 ${nameClasses}`}>
                                              {participant.displayName ?? "Unknown"}
                                            </span>
                                            <span className="font-semibold text-violet-200">
                                              {formatNumber(participant.reactionCount)}
                                            </span>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/50 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="min-w-[150px] text-sm font-semibold uppercase tracking-wide text-neutral-400">
                        {isHourlyView ? "Hourly cadence" : "Weekday cadence"}
                      </h3>
                      <div className="flex flex-wrap items-center gap-2">
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
                      <div
                        className={`flex items-center gap-1 rounded-full border border-neutral-800/80 bg-neutral-950/70 px-1 py-0.5 transition-opacity duration-200 ${
                          isHourlyView ? "opacity-100" : "opacity-0 invisible"
                        }`}
                      >
                        {(["12h", "24h"] as HourClockMode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setHourClockMode(mode)}
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                              hourClockMode === mode
                                ? "bg-sky-500/20 text-sky-100"
                                : "text-neutral-400 hover:text-white"
                            }`}
                          >
                            {mode.toUpperCase()}
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
                        const sentPortion = total ? (bucket.sentCount / total) * 100 : 0;
                        const receivedPortion = total ? (bucket.receivedCount / total) * 100 : 0;
                        const label =
                          "hour" in bucket
                            ? formatHourLabelByMode(bucket.hour, hourClockMode)
                            : weekdayLabels[bucket.weekday];
                        return (
                          <div key={`${activityView}-${index}`} className="flex items-center gap-3 text-sm">
                            <span className="w-10 text-xs text-neutral-500">{label}</span>
                            <div className="relative h-2 flex-1 overflow-visible rounded bg-neutral-900">
                              <div
                                className="h-full transition-[width] duration-500 ease-out"
                                style={{
                                  width: `${width}%`,
                                }}
                              >
                                <div className="flex h-full overflow-visible rounded">
                                  {bucket.sentCount > 0 && (
                                    <div
                                      className="group relative h-full overflow-visible"
                                      style={{ width: `${sentPortion}%` }}
                                    >
                                      <div
                                        className={`h-full bg-emerald-400/80 ${
                                          bucket.receivedCount > 0 ? "rounded-l-full" : "rounded-full"
                                        }`}
                                      />
                                      <div className="pointer-events-none absolute left-1/2 top-0 z-10 -mt-1 -translate-x-1/2 -translate-y-full rounded bg-neutral-900/90 px-2 py-0.5 text-[10px] text-neutral-200 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                                        {formatNumber(bucket.sentCount)}
                                      </div>
                                    </div>
                                  )}
                                  {bucket.receivedCount > 0 && (
                                    <div
                                      className="group relative h-full overflow-visible"
                                      style={{ width: `${receivedPortion}%` }}
                                    >
                                      <div
                                        className={`h-full bg-sky-400/80 ${
                                          bucket.sentCount > 0 ? "rounded-r-full" : "rounded-full"
                                        }`}
                                      />
                                      <div className="pointer-events-none absolute left-1/2 top-0 z-10 -mt-1 -translate-x-1/2 -translate-y-full rounded bg-neutral-900/90 px-2 py-0.5 text-[10px] text-neutral-200 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                                        {formatNumber(bucket.receivedCount)}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            <span className="w-12 text-right text-xs text-neutral-400">
                              {formatNumber(total)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {activityCounts.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-neutral-500">
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-6 rounded bg-emerald-400/80" />
                          Sent
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="inline-block h-2 w-6 rounded bg-sky-400/80" />
                          Received
                        </span>
                      </div>
                    )}
                    <p className="mt-3 text-xs text-neutral-500">All times are shown in your system&apos;s time zone.</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {reportChat && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-10 backdrop-blur"
        >
          <div className="relative w-full max-w-lg rounded-2xl border border-neutral-800/70 bg-neutral-950/95 p-6 text-neutral-100 shadow-2xl shadow-black/60">
            <button
              type="button"
              onClick={handleCloseReportModal}
              className="absolute right-4 top-4 rounded-full border border-neutral-700/80 p-1 text-neutral-400 transition hover:border-neutral-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
              aria-label="Close report dialog"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M6.225 4.811a1 1 0 0 0-1.414 1.414L10.586 12l-5.775 5.775a1 1 0 0 0 1.414 1.414L12 13.414l5.775 5.775a1 1 0 0 0 1.414-1.414L13.414 12l5.775-5.775a1 1 0 0 0-1.414-1.414L12 10.586 6.225 4.811Z"
                />
              </svg>
            </button>
            <div className="space-y-4 pr-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Group report</p>
                <h2 id="report-modal-title" className="text-xl font-semibold text-white">
                  {reportChat.chatDisplayName ?? formatParticipants(reportChat)}
                </h2>
                <p className="text-sm text-neutral-400">
                  Opening a dedicated report in a new tab. Share the link or refresh that tab anytime for the latest
                  stats.
                </p>
              </div>
              <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/60 p-4 text-sm text-neutral-300">
                <p>
                  Messages captured:{" "}
                  <span className="text-neutral-100">{formatNumber(reportChat.messageCount)}</span>
                </p>
              </div>
              {reportUrl && (
                <div className="rounded-xl border border-neutral-800/80 bg-neutral-900/40 p-4 text-sm text-neutral-200">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Shareable link</p>
                  <a
                    href={reportUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block truncate font-mono text-sm text-emerald-200 hover:text-emerald-100"
                  >
                    {reportUrl}
                  </a>
                  <p className="text-xs text-neutral-500">Refresh that tab to fetch new data.</p>
                </div>
              )}
              {reportError && <p className="text-sm text-rose-300">{reportError}</p>}
              {reportStatus === "loading" && (
                <div className="flex items-center gap-2 text-sm text-neutral-400">
                  <Spinner /> Opening report…
                </div>
              )}
              {reportStatus === "success" && !reportError && (
                <p className="text-sm text-emerald-300">
                  Report opened in a new tab. Close this window whenever you&apos;re ready.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

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
