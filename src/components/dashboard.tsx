'use client';

import Link from "next/link";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { GlobalRangeBar } from "@/components/global-range-bar";
import { PersonDrawer, type PersonCallStats, type PersonMessageStats, type PersonMessageThread, type PersonRecentCall } from "@/components/person-drawer";
import { MessageSearchPanel } from "@/components/message-search-panel";
import { useGlobalRange } from "@/hooks/use-global-range";
import { REPLY_WINDOW_SECONDS, SESSION_GAP_SECONDS } from "@/lib/imessage/constants";
import type {
  HourlyCount,
  ReactionCountSummary,
  SerializableChatSummary as ChatSummary,
  SerializableConversationStats as ConversationStats,
  SerializableDailyCount as DailyCount,
  WeekdayCount,
} from "@/lib/imessage/types";
import { useStatsSummary } from "@/hooks/use-stats-summary";
import { fetchAllCalls, type CallApiRecord } from "@/lib/callhistory/client";
import type { AppRouter } from "@/server/app-router";

function formatDateTime(value: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function parseDateTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getCallParticipants(call: CallApiRecord) {
  if (call.participants.length > 0) return call.participants;
  if (call.address) {
    return [{ id: call.address, handle: call.address, displayName: call.name }];
  }
  return [];
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

function formatResponseDuration(seconds: number | null | undefined) {
  if (!Number.isFinite(seconds ?? NaN) || seconds === null || seconds === undefined) return "—";
  const value = Math.max(0, seconds);
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) {
    const minutes = value / 60;
    return minutes >= 10 ? `${Math.round(minutes)}m` : `${minutes.toFixed(1)}m`;
  }
  if (value < 86400) {
    const hours = value / 3600;
    return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
  }
  const days = value / 86400;
  return days >= 10 ? `${Math.round(days)}d` : `${days.toFixed(1)}d`;
}

function formatDurationLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown duration";
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) {
    if (hours % 24 === 0) {
      const days = hours / 24;
      return `${formatNumber(days)} day${days === 1 ? "" : "s"}`;
    }
    return `${formatNumber(hours)} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours.toFixed(1)} hours`;
}

function computeTotals(stats: ConversationStats | null) {
  if (!stats) return { sent: 0, received: 0, total: 0 };
  const { sentCount, receivedCount, messageCount } = stats.totals;
  return { sent: sentCount, received: receivedCount, total: messageCount };
}

function getStatsQueryError(error: unknown) {
  if (error instanceof TRPCClientError) {
    const trpcError = error as TRPCClientError<AppRouter>;
    return {
      message: trpcError.message,
      httpStatus: trpcError.data?.httpStatus,
    };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: "Unable to load stats." };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_STATS_LIMIT = 40;
const CHAT_COUNT_OPTIONS = [5, 10, 20, 30];
const ACCESS_TIP_STORAGE_KEY = "imessage-insights:fda-tip-dismissed";
const ACTIVITY_VIEW_STORAGE_KEY = "imessage-insights:activity-view";
const HOUR_FORMAT_STORAGE_KEY = "imessage-insights:hour-format";
const EMPTY_UNANSWERED_STARTERS = { youLeftThemHanging: 0, theyLeftYouHanging: 0 } as const;
const EMPTY_SESSION_STARTERS = { startedByMe: 0, startedByOthers: 0 } as const;
const EMPTY_DOUBLE_TEXTS = { youDoubleTexted: 0, theyDoubleTexted: 0 } as const;
const EMPTY_RESPONSE_DIRECTION = {
  averageSeconds: null,
  medianSeconds: null,
  p90Seconds: null,
  minSeconds: null,
  maxSeconds: null,
  sampleCount: 0,
} as const;

function createEmptyResponseStatsClient() {
  return {
    meResponding: { ...EMPTY_RESPONSE_DIRECTION },
    themResponding: { ...EMPTY_RESPONSE_DIRECTION },
  };
}

function readStoredValue<T>(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key) as T | null;
  } catch {
    return null;
  }
}

function getStoredActivityView(): "hourly" | "weekday" {
  const stored = readStoredValue<"hourly" | "weekday">(ACTIVITY_VIEW_STORAGE_KEY);
  return stored && (["hourly", "weekday"] as const).includes(stored) ? stored : "hourly";
}

function getStoredHourFormat(): HourClockMode {
  const stored = readStoredValue<HourClockMode>(HOUR_FORMAT_STORAGE_KEY);
  return stored && (["12h", "24h"] as const).includes(stored) ? stored : "24h";
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

const rateFormatter = Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

function formatRate(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN) || value === null || value === undefined) return "—";
  try {
    return rateFormatter.format(value as number);
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

function GhostIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} role="img">
      <path
        fill="currentColor"
        d="M12 2a7 7 0 0 0-7 7v9.5c0 .83.67 1.5 1.5 1.5.5 0 .96-.25 1.24-.64l.76-1.12.76 1.12c.28.39.74.64 1.24.64s.96-.25 1.25-.64L12.5 18l.75 1.36c.29.39.75.64 1.25.64s.96-.25 1.24-.64l.76-1.12.76 1.12c.28.39.74.64 1.24.64.83 0 1.5-.67 1.5-1.5V9a7 7 0 0 0-7-7m-2.25 5A1.25 1.25 0 1 1 9 8.25 1.25 1.25 0 0 1 9.75 7m4.5 0A1.25 1.25 0 1 1 15 8.25 1.25 1.25 0 0 1 14.25 7M14 12a2 2 0 0 1-4 0z"
      />
    </svg>
  );
}

function SparkIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} role="img">
      <path
        fill="currentColor"
        d="M12 2 9.5 8.5 3 11l6.5 2.5L12 20l2.5-6.5L21 11l-6.5-2.5z"
      />
    </svg>
  );
}


type ChatFilterMode = "all" | "direct" | "group";
type HourClockMode = "12h" | "24h";
type ReportStatus = "idle" | "loading" | "error" | "success";

const chatFilterOptions: { value: ChatFilterMode; label: string }[] = [
  { value: "all", label: "People" },
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
  const { range, searchParams } = useGlobalRange();
  const preservedQuery = searchParams.toString();
  const querySuffix = preservedQuery ? `?${preservedQuery}` : "";
  const overviewHref = `/${querySuffix}`;
  const messagesHref = `/messages${querySuffix}`;
  const callsHref = `/calls${querySuffix}`;
  const [chatFilterMode, setChatFilterMode] = useState<ChatFilterMode>("all");
  const [visibleChatCount, setVisibleChatCount] = useState(5);
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [activityView, setActivityView] = useState<"hourly" | "weekday">(() => getStoredActivityView());
  const [hourClockMode, setHourClockMode] = useState<HourClockMode>(() => getStoredHourFormat());
  const [accessTipDismissed, setAccessTipDismissed] = useState(false);
  const [expandedChatSections, setExpandedChatSections] = useState<
    Record<number, { messages: boolean; reactions: boolean }>
  >({});
  const [reportChat, setReportChat] = useState<ChatSummary | null>(null);
  const [reportStatus, setReportStatus] = useState<ReportStatus>("idle");
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const statsQueryInput = useMemo(() => {
    return {
      limit: DEFAULT_STATS_LIMIT,
      start: range.startIso,
      end: range.endIso,
    };
  }, [range.endIso, range.startIso]);

  const {
    data: statsData,
    isPending: statsLoading,
    isFetching: statsFetching,
    error: statsErrorRaw,
    refetch: refetchStats,
  } = useStatsSummary(statsQueryInput);

  const stats = (statsData as ConversationStats | undefined) ?? null;
  const callsQuery = useQuery({
    queryKey: ["calls", "all"],
    queryFn: fetchAllCalls,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    enabled: Boolean(selectedPersonId),
    retry: 1,
  });
  const allCalls = callsQuery.data ?? [];
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
  const firstReplyTimes = stats?.firstReplyTimes ?? null;
  const inThreadReplyTimes = stats?.inThreadReplyTimes ?? null;

  const myFirstReplyStats = firstReplyTimes?.meResponding ?? null;
  const theirFirstReplyStats = firstReplyTimes?.themResponding ?? null;
  const myFirstReplySummary = {
    median: formatResponseDuration(myFirstReplyStats?.medianSeconds),
    p90: formatResponseDuration(myFirstReplyStats?.p90Seconds),
    fastest: formatResponseDuration(myFirstReplyStats?.minSeconds),
    slowest: formatResponseDuration(myFirstReplyStats?.maxSeconds),
    samples: myFirstReplyStats?.sampleCount ?? 0,
  };
  const theirFirstReplySummary = {
    median: formatResponseDuration(theirFirstReplyStats?.medianSeconds),
    p90: formatResponseDuration(theirFirstReplyStats?.p90Seconds),
    fastest: formatResponseDuration(theirFirstReplyStats?.minSeconds),
    slowest: formatResponseDuration(theirFirstReplyStats?.maxSeconds),
    samples: theirFirstReplyStats?.sampleCount ?? 0,
  };
  const myInThreadMedian = formatResponseDuration(inThreadReplyTimes?.meResponding?.medianSeconds);
  const theirInThreadMedian = formatResponseDuration(inThreadReplyTimes?.themResponding?.medianSeconds);

  const unansweredStarters = useMemo(
    () => stats?.unansweredStarters ?? EMPTY_UNANSWERED_STARTERS,
    [stats],
  );
  const sessionStarters = useMemo(() => stats?.sessionStarters ?? EMPTY_SESSION_STARTERS, [stats]);
  const doubleTexts = useMemo(() => stats?.doubleTexts ?? EMPTY_DOUBLE_TEXTS, [stats]);

  const replyWindowLabel = formatDurationLabel(REPLY_WINDOW_SECONDS);
  const sessionGapLabel = formatDurationLabel(SESSION_GAP_SECONDS);

  const unansweredSummary = useMemo(() => {
    const totalEvents = unansweredStarters.youLeftThemHanging + unansweredStarters.theyLeftYouHanging;
    const theyPercent = totalEvents > 0 ? Math.round((unansweredStarters.theyLeftYouHanging / totalEvents) * 100) : null;
    const mePercent = totalEvents > 0 ? 100 - (theyPercent ?? 0) : null;
    const narrative =
      totalEvents === 0
        ? "No unanswered starts in this range."
        : unansweredStarters.theyLeftYouHanging > unansweredStarters.youLeftThemHanging
          ? "Others leave you hanging more often."
          : unansweredStarters.theyLeftYouHanging < unansweredStarters.youLeftThemHanging
            ? "You leave others hanging more often."
            : "Unanswered starts are evenly split.";
    return { totalEvents, theyPercent, mePercent, narrative };
  }, [unansweredStarters]);

  const sessionStarterSummary = useMemo(() => {
    const totalStarts = sessionStarters.startedByMe + sessionStarters.startedByOthers;
    const mePercent = totalStarts > 0 ? Math.round((sessionStarters.startedByMe / totalStarts) * 100) : null;
    const othersPercent = totalStarts > 0 ? 100 - (mePercent ?? 0) : null;
    const narrative =
      totalStarts === 0
        ? "No sessions detected yet."
        : sessionStarters.startedByMe > sessionStarters.startedByOthers
          ? "You usually start sessions."
          : sessionStarters.startedByMe < sessionStarters.startedByOthers
            ? "Others start most sessions."
            : "Session starters are evenly split.";
    return { totalStarts, mePercent, othersPercent, narrative };
  }, [sessionStarters]);

  const doubleTextSummary = useMemo(() => {
    const totalEvents = doubleTexts.youDoubleTexted + doubleTexts.theyDoubleTexted;
    const theyPercent = totalEvents > 0 ? Math.round((doubleTexts.theyDoubleTexted / totalEvents) * 100) : null;
    const mePercent = totalEvents > 0 ? 100 - (theyPercent ?? 0) : null;
    const narrative =
      totalEvents === 0
        ? "No double texts in this range."
        : doubleTexts.theyDoubleTexted > doubleTexts.youDoubleTexted
          ? "Others double text more often."
          : doubleTexts.theyDoubleTexted < doubleTexts.youDoubleTexted
            ? "You double text more often."
            : "Double texting is evenly split.";
    return { totalEvents, theyPercent, mePercent, narrative };
  }, [doubleTexts]);
  const statsErrorDetails = statsErrorRaw ? getStatsQueryError(statsErrorRaw) : null;
  const statsError = statsErrorDetails?.message ?? null;
  const accessError = statsErrorDetails?.httpStatus === 403;

  const totals = useMemo(() => computeTotals(stats), [stats]);
  const rangeDayCount = useMemo(() => {
    if (range.dayCount !== null) return range.dayCount;

    const earliest = stats?.earliestMessageAt;
    const latest = stats?.latestMessageAt;
    if (!earliest || !latest) return null;
    const startMs = new Date(earliest).getTime();
    const endMs = new Date(latest).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    return Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
  }, [range.dayCount, stats?.earliestMessageAt, stats?.latestMessageAt]);

  const averagePerDay = useMemo(() => {
    if (!stats || !rangeDayCount) return null;
    return Math.max(0, totals.total / rangeDayCount);
  }, [rangeDayCount, stats, totals.total]);

  const chatSearchTerm = chatSearchQuery.trim().toLowerCase();
  const isChatSearchActive = chatSearchTerm.length > 0;
  const isPeopleView = chatFilterMode === "all";

  type PersonConversationSummary = {
    id: string;
    displayName: string;
    messageCount: number;
    fromMeCount: number;
    fromThemCount: number;
    chatCount: number;
    lastMessageAt: string | null;
  };

  const peopleConversationSummaries = useMemo<PersonConversationSummary[]>(() => {
    if (!stats) return [];

    const aggregate = new Map<
      string,
      {
        id: string;
        displayName: string;
        messageCount: number;
        fromMeCount: number;
        fromThemCount: number;
        chatIds: Set<number>;
        lastMessageAt: string | null;
      }
    >();

    for (const chat of stats.topChats ?? []) {
      const mySent = Math.max(0, chat.sentCount ?? 0);
      const lastMessageAt = chat.lastMessageAt ?? null;

      for (const participant of chat.messageParticipants ?? []) {
        const isSelf = Boolean(participant.isMe || participant.id === "me");
        if (isSelf) continue;

        const id = participant.id ?? participant.displayName ?? `unknown-${chat.chatId}`;
        const displayName = participant.displayName ?? "Unknown";
        const fromThem = Math.max(0, participant.messageCount ?? 0);

        const existing =
          aggregate.get(id) ??
          {
            id,
            displayName,
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

        if (lastMessageAt) {
          if (!existing.lastMessageAt || new Date(lastMessageAt) > new Date(existing.lastMessageAt)) {
            existing.lastMessageAt = lastMessageAt;
          }
        }

        if (existing.displayName === "Unknown" && displayName !== "Unknown") {
          existing.displayName = displayName;
        }

        aggregate.set(id, existing);
      }
    }

    return Array.from(aggregate.values())
      .map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
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
          a.displayName.localeCompare(b.displayName),
      );
  }, [stats]);

  const selectedPersonSummary = useMemo(() => {
    if (!selectedPersonId) return null;
    return peopleConversationSummaries.find((person) => person.id === selectedPersonId) ?? null;
  }, [peopleConversationSummaries, selectedPersonId]);

  const selectedPerson = useMemo(() => {
    if (!selectedPersonId) return null;
    return {
      key: selectedPersonId,
      label: selectedPersonSummary?.displayName ?? "Unknown",
    };
  }, [selectedPersonId, selectedPersonSummary?.displayName]);

  const filteredPeopleConversations = useMemo(() => {
    if (!chatSearchTerm) return peopleConversationSummaries;
    return peopleConversationSummaries.filter((person) => {
      const name = person.displayName.toLowerCase();
      const id = person.id.toLowerCase();
      return name.includes(chatSearchTerm) || id.includes(chatSearchTerm);
    });
  }, [chatSearchTerm, peopleConversationSummaries]);

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
  const topPeoplePreview = isChatSearchActive
    ? filteredPeopleConversations
    : filteredPeopleConversations.slice(0, visibleChatCount);
  const filteredPeopleCount = filteredPeopleConversations.length;
  const previewedPeopleCount = topPeoplePreview.length;
  const totalPeopleCount = peopleConversationSummaries.length;
  const topListPreviewCount = isPeopleView ? previewedPeopleCount : previewedChatCount;
  const topListFilteredCount = isPeopleView ? filteredPeopleCount : filteredChatCount;
  const topListTotalCount = isPeopleView ? totalPeopleCount : totalChatCount;
  const topListLabel = isPeopleView ? "person" : "conversation";
  const reactionTotalsSummary = stats?.reactionTotals ?? null;
  const attachmentSummary = stats?.attachmentStats ?? null;
  const averageSentPerDay = useMemo(() => {
    if (!stats || !rangeDayCount) return null;
    return Math.max(0, stats.totals.sentCount / rangeDayCount);
  }, [rangeDayCount, stats]);
  const averageReceivedPerDay = useMemo(() => {
    if (!stats || !rangeDayCount) return null;
    return Math.max(0, stats.totals.receivedCount / rangeDayCount);
  }, [rangeDayCount, stats]);
  const earliestMessageDate = useMemo(() => {
    if (stats?.earliestMessageAt) {
      return stats.earliestMessageAt;
    }
    if (!stats || stats.dailyCounts.length === 0) return null;
    // Fallback for older responses that do not include earliestMessageAt.
    return stats.dailyCounts.reduce<string | null>((min, bucket) => {
      if (!bucket.date) return min;
      if (!min) return bucket.date;
      return new Date(bucket.date) < new Date(min) ? bucket.date : min;
    }, null);
  }, [stats]);
  const summaryCards = useMemo<SummaryCard[]>(() => {
    const cards: SummaryCard[] = [
      {
        key: "total",
        label: "All messages",
        value: formatCompactNumber(totals.total),
        description: totals.total ? `${formatNumber(totals.total)} messages` : undefined,
        meta:
          range.mode === "preset" && range.preset === "all" && earliestMessageDate
            ? `Since ${formatDayLabel(earliestMessageDate)}`
            : rangeDayCount
              ? `Across ${formatNumber(rangeDayCount)} day${rangeDayCount === 1 ? "" : "s"}`
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
        value: averagePerDay === null ? "—" : formatRate(averagePerDay),
        description:
          rangeDayCount
            ? `Average across ${formatNumber(rangeDayCount)} day${rangeDayCount === 1 ? "" : "s"}`
            : undefined,
        badges: [
          totals.sent
            ? {
                key: "pace-sent",
                label: "Sent",
                value: `${formatRate(averageSentPerDay)}/day`,
                tone: "emerald",
              }
            : null,
          totals.received
            ? {
                key: "pace-received",
                label: "Received",
                value: `${formatRate(averageReceivedPerDay)}/day`,
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
          ? ([
              {
                key: "attachments-top",
                label: attachmentSummary.topSender.isMe ? "Top sender (you)" : "Top sender",
                value: `${attachmentSummary.topSender.displayName ?? "Unknown"} · ${formatNumber(attachmentSummary.topSender.count)}`,
                tone: "violet",
              },
            ] as SummaryCardBadge[])
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
    rangeDayCount,
    range.mode,
    range.preset,
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

    const allowBusiestDayInsight = range.dayCount === null || range.dayCount > 1;
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

    if (unansweredSummary.totalEvents > 0) {
      const leaningToOthers = unansweredStarters.theyLeftYouHanging >= unansweredStarters.youLeftThemHanging;
      const share = formatPercent(
        leaningToOthers ? unansweredStarters.theyLeftYouHanging : unansweredStarters.youLeftThemHanging,
        unansweredSummary.totalEvents,
      );
      items.push({
        key: "unanswered-starts",
        label: "Unanswered starts",
        primary: unansweredSummary.narrative,
        secondary: `${share} of unanswered starts`,
        icon: <GhostIcon className="h-4 w-4 text-rose-200" />,
      });
    }

    if (doubleTextSummary.totalEvents > 0) {
      const leaningToOthers = doubleTexts.theyDoubleTexted >= doubleTexts.youDoubleTexted;
      const share = formatPercent(
        leaningToOthers ? doubleTexts.theyDoubleTexted : doubleTexts.youDoubleTexted,
        doubleTextSummary.totalEvents,
      );
      items.push({
        key: "double-texts",
        label: "Double texts",
        primary: doubleTextSummary.narrative,
        secondary: `${share} of double texts`,
        icon: <DirectChatIcon className="h-4 w-4 text-indigo-200" />,
      });
    }

    if (sessionStarterSummary.totalStarts > 0) {
      items.push({
        key: "session-starters",
        label: "Session starters",
        primary: sessionStarterSummary.narrative,
        secondary: `${formatPercent(sessionStarters.startedByMe, sessionStarterSummary.totalStarts)} start with you`,
        icon: <SparkIcon className="h-4 w-4 text-amber-200" />,
      });
    }

    return items;
  }, [
    attachmentSummary,
    doubleTexts,
    doubleTextSummary,
    stats,
    range.dayCount,
    totals.total,
    unansweredStarters,
    unansweredSummary,
    sessionStarters,
    sessionStarterSummary,
  ]);
  const insightGridClass = useMemo(() => {
    const count = insightItems.length;
    if (count <= 1) return "grid gap-3 sm:grid-cols-1 max-w-lg mx-auto";
    if (count === 2) return "grid gap-3 sm:grid-cols-2 lg:grid-cols-2 max-w-4xl mx-auto";
    if (count === 3) return "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";
    return "grid gap-3 sm:grid-cols-2 lg:grid-cols-4";
  }, [insightItems.length]);
  const handleStatsRefresh = useCallback(() => {
    void refetchStats();
  }, [refetchStats]);
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
    chatFilterMode === "all" ? "Top People" : chatFilterMode === "group" ? "Top Groups" : "Top Chats";
  const buildReportUrl = useCallback(
    (chat: ChatSummary) => {
      const params = new URLSearchParams();
      if (range.startIso) params.set("start", range.startIso);
      if (range.endIso) params.set("end", range.endIso);
      const query = params.toString();
      return `/reports/${chat.chatId}${query ? `?${query}` : ""}`;
    },
    [range.endIso, range.startIso],
  );

  const selectedMessageThreads = useMemo<PersonMessageThread[]>(() => {
    if (!selectedPersonId || !stats) return [];
    const threads: PersonMessageThread[] = [];
    for (const chat of stats.topChats ?? []) {
      const mySent = Math.max(0, chat.sentCount ?? 0);
      const lastMessageAt = parseDateTime(chat.lastMessageAt ?? null);
      const participant = (chat.messageParticipants ?? []).find((p) => {
        const isSelf = Boolean(p.isMe || p.id === "me");
        if (isSelf) return false;
        const key = p.id ?? p.displayName ?? `unknown-${chat.chatId}`;
        return key === selectedPersonId;
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
        href: buildReportUrl(chat),
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
  }, [buildReportUrl, selectedPersonId, stats]);

  const selectedMessageStats = useMemo<PersonMessageStats | null>(() => {
    if (!selectedPersonSummary) return null;
    return {
      totalMessages: selectedPersonSummary.messageCount,
      fromMeMessages: selectedPersonSummary.fromMeCount,
      fromThemMessages: selectedPersonSummary.fromThemCount,
      chatCount: selectedPersonSummary.chatCount,
      lastMessageAt: parseDateTime(selectedPersonSummary.lastMessageAt),
      threads: selectedMessageThreads,
    };
  }, [selectedMessageThreads, selectedPersonSummary]);

  const selectedCallStats = useMemo<PersonCallStats | null>(() => {
    if (!selectedPersonId) return null;
    let totalCalls = 0;
    let incomingCalls = 0;
    let outgoingCalls = 0;
    let answeredCalls = 0;
    let missedIncomingCalls = 0;
    let talkSeconds = 0;
    let lastCallAt: Date | null = null;
    const recentCalls: PersonRecentCall[] = [];

    const start = range.startDate;
    const end = range.endDate;

    for (const call of allCalls) {
      const startedAt = parseDateTime(call.startedAt);
      if (!startedAt) continue;
      if (start && startedAt < start) continue;
      if (end && startedAt > end) continue;

      const participants = getCallParticipants(call);
      const keys = new Set(
        participants.map((participant) => participant.id ?? participant.handle).filter(Boolean),
      );
      if (!keys.has(selectedPersonId)) continue;

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
  }, [allCalls, range.endDate, range.startDate, selectedPersonId]);

  const callsError =
    callsQuery.error instanceof Error ? callsQuery.error.message : callsQuery.error ? "Unable to load calls." : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(ACCESS_TIP_STORAGE_KEY);
    setAccessTipDismissed(stored === "true");
  }, []);

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

  const shouldShowAccessTip = accessError && !accessTipDismissed;
  const showInitialSkeleton = statsLoading && !stats && !statsError;

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
                className="rounded-full border border-neutral-800/80 bg-white/5 px-3 py-1 text-xs font-semibold text-white"
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

            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
              <div className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-900/60 px-3 py-1">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                <span>{stats ? `Latest ${latestActivityLabel}` : "Waiting for data…"}</span>
              </div>
              <button
                type="button"
                onClick={handleStatsRefresh}
                className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-3 py-1 font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                Refresh
              </button>
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">Messages</h1>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-10 flex w-full max-w-6xl flex-col gap-10 px-6">
        <GlobalRangeBar />
        <section className="space-y-6">
          <div className="space-y-4 rounded-2xl border border-neutral-800/70 bg-neutral-900/40 p-6 shadow-lg shadow-black/30">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">Statistics</h2>
              </div>
            </div>
            {statsError && <p className="text-sm text-red-400">{statsError}</p>}
            {statsFetching && stats && (
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
                  statsFetching ? "opacity-60" : "opacity-100"
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
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-2xl border border-neutral-800/80 bg-neutral-950/70 p-4">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                      <GhostIcon className="h-4 w-4 text-rose-200" />
                      <span>Unanswered starts</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-neutral-400">
                      <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-neutral-500">They left you hanging</p>
                        <p className="mt-1 text-2xl font-semibold text-rose-100">
                          {formatNumber(unansweredStarters.theyLeftYouHanging)}
                        </p>
                        {unansweredSummary.theyPercent !== null && (
                          <p className="text-xs text-neutral-500">{unansweredSummary.theyPercent}% of unanswered starts</p>
                        )}
                      </div>
                      <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-neutral-500">You left them hanging</p>
                        <p className="mt-1 text-2xl font-semibold text-emerald-100">
                          {formatNumber(unansweredStarters.youLeftThemHanging)}
                        </p>
                        {unansweredSummary.mePercent !== null && (
                          <p className="text-xs text-neutral-500">{unansweredSummary.mePercent}% of unanswered starts</p>
                        )}
                      </div>
                    </div>
                    <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-neutral-900">
                      <div
                        className="h-full bg-emerald-400/70"
                        style={{ width: `${unansweredSummary.mePercent ?? 50}%` }}
                      />
                      <div
                        className="h-full bg-rose-400/80"
                        style={{ width: `${unansweredSummary.theyPercent ?? 50}%` }}
                      />
                    </div>
                    <p className="mt-3 text-sm text-neutral-200">{unansweredSummary.narrative}</p>
                    <p className="text-[11px] text-neutral-500">
                      We count an unanswered start when the other side doesn’t reply within {replyWindowLabel}.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-neutral-800/80 bg-neutral-950/70 p-4">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                      <SparkIcon className="h-4 w-4 text-amber-200" />
                      <span>Session starters</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-neutral-400">
                      <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-neutral-500">You start</p>
                        <p className="mt-1 text-2xl font-semibold text-emerald-100">
                          {formatNumber(sessionStarters.startedByMe)}
                        </p>
                        {sessionStarterSummary.mePercent !== null && (
                          <p className="text-xs text-neutral-500">{sessionStarterSummary.mePercent}% of sessions</p>
                        )}
                      </div>
                      <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-neutral-500">They start</p>
                        <p className="mt-1 text-2xl font-semibold text-sky-100">
                          {formatNumber(sessionStarters.startedByOthers)}
                        </p>
                        {sessionStarterSummary.othersPercent !== null && (
                          <p className="text-xs text-neutral-500">{sessionStarterSummary.othersPercent}% of sessions</p>
                        )}
                      </div>
                    </div>
                    <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-neutral-900">
                      <div
                        className="h-full bg-emerald-400/70"
                        style={{ width: `${sessionStarterSummary.mePercent ?? 50}%` }}
                      />
                      <div
                        className="h-full bg-sky-400/80"
                        style={{ width: `${sessionStarterSummary.othersPercent ?? 50}%` }}
                      />
                    </div>
                    <p className="mt-3 text-sm text-neutral-200">{sessionStarterSummary.narrative}</p>
                    <p className="text-[11px] text-neutral-500">
                      A new session begins after {sessionGapLabel} of silence.
                    </p>
                  </div>
                  <div className="rounded-2xl border border-neutral-800/80 bg-neutral-950/70 p-4">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                      <DirectChatIcon className="h-4 w-4 text-indigo-200" />
                      <span>Double texts</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-neutral-400">
                      <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-neutral-500">You</p>
                        <p className="mt-1 text-2xl font-semibold text-emerald-100">
                          {formatNumber(doubleTexts.youDoubleTexted)}
                        </p>
                        {doubleTextSummary.mePercent !== null && (
                          <p className="text-xs text-neutral-500">{doubleTextSummary.mePercent}% of double texts</p>
                        )}
                      </div>
                      <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                        <p className="text-[11px] uppercase tracking-wide text-neutral-500">Them</p>
                        <p className="mt-1 text-2xl font-semibold text-indigo-100">
                          {formatNumber(doubleTexts.theyDoubleTexted)}
                        </p>
                        {doubleTextSummary.theyPercent !== null && (
                          <p className="text-xs text-neutral-500">{doubleTextSummary.theyPercent}% of double texts</p>
                        )}
                      </div>
                    </div>
                    <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-neutral-900">
                      <div
                        className="h-full bg-emerald-400/70"
                        style={{ width: `${doubleTextSummary.mePercent ?? 50}%` }}
                      />
                      <div
                        className="h-full bg-indigo-400/80"
                        style={{ width: `${doubleTextSummary.theyPercent ?? 50}%` }}
                      />
                    </div>
                    <p className="mt-3 text-sm text-neutral-200">{doubleTextSummary.narrative}</p>
                    <p className="text-[11px] text-neutral-500">
                      We count a double text when someone sends 2+ messages before a reply (within {replyWindowLabel}).
                    </p>
                  </div>
                </div>
                {firstReplyTimes && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-neutral-800/80 bg-neutral-950/70 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                        <ClockIcon className="h-4 w-4 text-emerald-200" />
                        <span>Your first reply</span>
                      </div>
                      <p className="mt-3 text-3xl font-semibold text-emerald-100">{myFirstReplySummary.median}</p>
                      <p className="text-xs text-neutral-400">Median first reply</p>
                      <p className="text-xs text-neutral-500">
                        90% within {myFirstReplySummary.p90}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] text-neutral-400">
                        <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2">
                          <p className="text-neutral-500">Fastest</p>
                          <p className="text-neutral-100">{myFirstReplySummary.fastest}</p>
                        </div>
                        <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2">
                          <p className="text-neutral-500">Slowest</p>
                          <p className="text-neutral-100">{myFirstReplySummary.slowest}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-[11px] text-neutral-500">
                        {myFirstReplySummary.samples
                          ? `${formatNumber(myFirstReplySummary.samples)} first replies measured`
                          : "No replies measured yet."}
                      </p>
                      <p className="text-[11px] text-neutral-600">
                        Session start → first reply (within {replyWindowLabel}). In-thread median: {myInThreadMedian}.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-neutral-800/80 bg-neutral-950/70 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                        <ClockIcon className="h-4 w-4 text-sky-200" />
                        <span>Their first reply</span>
                      </div>
                      <p className="mt-3 text-3xl font-semibold text-sky-100">{theirFirstReplySummary.median}</p>
                      <p className="text-xs text-neutral-400">Median first reply</p>
                      <p className="text-xs text-neutral-500">
                        90% within {theirFirstReplySummary.p90}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] text-neutral-400">
                        <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2">
                          <p className="text-neutral-500">Fastest</p>
                          <p className="text-neutral-100">{theirFirstReplySummary.fastest}</p>
                        </div>
                        <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2">
                          <p className="text-neutral-500">Slowest</p>
                          <p className="text-neutral-100">{theirFirstReplySummary.slowest}</p>
                        </div>
                      </div>
                      <p className="mt-3 text-[11px] text-neutral-500">
                        {theirFirstReplySummary.samples
                          ? `${formatNumber(theirFirstReplySummary.samples)} first replies measured`
                          : "No replies measured yet."}
                      </p>
                      <p className="text-[11px] text-neutral-600">
                        Session start → first reply (within {replyWindowLabel}). In-thread median: {theirInThreadMedian}.
                      </p>
                    </div>
                  </div>
                )}
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
                          {isPeopleView ? "Search people" : "Search chats"}
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
                            placeholder={
                              isPeopleView
                                ? "Search people"
                                : chatFilterMode === "group"
                                  ? "Search groups"
                                  : "Search chats"
                            }
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
                      Showing {topListPreviewCount} of {topListFilteredCount}{" "}
                      {topListFilteredCount === 1 ? topListLabel : isPeopleView ? "people" : "conversations"}
                    </span>
                    {topListFilteredCount !== topListTotalCount && topListTotalCount > 0 && (
                      <span className="text-neutral-600">•</span>
                    )}
                    {topListFilteredCount !== topListTotalCount && topListTotalCount > 0 && (
                      <span>{formatNumber(topListTotalCount)} in view</span>
                    )}
                  </div>
                  {isPeopleView && (
                    <p className="mt-2 text-[11px] text-neutral-600">
                      Counts include your messages in shared group chats.
                    </p>
                  )}
                    <div className="mt-3 space-y-3">
                      {isPeopleView ? (
                        topPeoplePreview.length === 0 ? (
                          <div className="rounded-xl border border-dashed border-neutral-800/80 bg-neutral-950/40 p-6 text-center text-sm text-neutral-400">
                            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-neutral-800/80 bg-neutral-900/80">
                              <DirectChatIcon className="h-4 w-4 text-neutral-500" />
                            </div>
                            <p className="mt-3 font-medium text-neutral-200">
                              {isChatSearchActive
                                ? "No people match this search."
                                : filteredPeopleCount === 0
                                  ? "No people in this range yet."
                                  : "No people in this view."}
                            </p>
                            <p className="text-xs text-neutral-500">
                              Try expanding the range or clearing filters to see more people.
                            </p>
                          </div>
                        ) : (
                          topPeoplePreview.map((person, index) => {
                            const latestLabel = formatDateTime(person.lastMessageAt);
                            const isTopEntry = index === 0;
                            const cardClasses = isTopEntry
                              ? "border-emerald-500/60 bg-gradient-to-r from-emerald-500/15 via-neutral-950/70 to-neutral-950/40 shadow shadow-emerald-500/20"
                              : "border-neutral-800 bg-neutral-950/70";
                            return (
                              <button
                                key={person.id}
                                type="button"
                                onClick={() => setSelectedPersonId(person.id)}
                                className={`w-full rounded-lg border p-4 text-left transition-all duration-300 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${cardClasses}`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-wide text-neutral-500">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded-full border border-neutral-800/80 px-2 py-0.5 text-[10px] font-semibold text-neutral-400">
                                      #{index + 1}
                                    </span>
                                    <DirectChatIcon className="h-3.5 w-3.5 text-indigo-300" />
                                    <span>Person</span>
                                    {person.lastMessageAt && (
                                      <>
                                        <span className="text-neutral-700">•</span>
                                        <span>Latest {latestLabel}</span>
                                      </>
                                    )}
                                  </div>
                                  <span className="text-neutral-400">{formatNumber(person.messageCount)} msgs</span>
                                </div>
                                <div className="mt-2 flex items-center justify-between gap-3">
                                  <p className="text-sm font-medium text-neutral-100">{person.displayName}</p>
                                  <span className="text-xs text-neutral-500">{formatNumber(person.chatCount)} chats</span>
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-neutral-400">
                                  <span className="text-emerald-300">↑ You {formatNumber(person.fromMeCount)}</span>
                                  <span className="text-sky-300">↓ Them {formatNumber(person.fromThemCount)}</span>
                                </div>
                              </button>
                            );
                          })
                        )
                      ) : topChatPreview.length === 0 ? (
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
                          const earliestLabel = formatDateTime(chat.firstMessageAt);
                          const latestLabel = formatDateTime(chat.lastMessageAt);
                          const chatFirstReplyTimes =
                            chat.firstReplyTimes ??
                            createEmptyResponseStatsClient();
                          const chatInThreadReplyTimes =
                            chat.inThreadReplyTimes ??
                            createEmptyResponseStatsClient();
                          const chatMyFirstReply = chatFirstReplyTimes.meResponding;
                          const chatTheirFirstReply = chatFirstReplyTimes.themResponding;
                          const chatMyInThreadMedian = formatResponseDuration(
                            chatInThreadReplyTimes.meResponding.medianSeconds,
                          );
                          const chatTheirInThreadMedian = formatResponseDuration(
                            chatInThreadReplyTimes.themResponding.medianSeconds,
                          );
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
                                  <span>Since {earliestLabel}</span>
                                  <span className="text-neutral-700">•</span>
                                  <span>Latest {latestLabel}</span>
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
                              <div className="mt-3 grid gap-2 text-[11px] text-neutral-400 sm:grid-cols-2 lg:grid-cols-3">
                                <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2.5">
                                  <div className="flex items-center gap-1 text-neutral-500">
                                    <GhostIcon className="h-3 w-3 text-rose-200" />
                                    <span>Unanswered starts</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-emerald-200">
                              You {formatNumber(chat.unansweredStarters.youLeftThemHanging)}
                            </span>
                            <span className="text-neutral-600">•</span>
                            <span className="text-rose-200">
                              Them {formatNumber(chat.unansweredStarters.theyLeftYouHanging)}
                            </span>
                          </div>
                        </div>
                        <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2.5">
                          <div className="flex items-center gap-1 text-neutral-500">
                            <SparkIcon className="h-3 w-3 text-amber-200" />
                            <span>Session starters</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-emerald-200">
                              You {formatNumber(chat.sessionStarters.startedByMe)}
                            </span>
                            <span className="text-neutral-600">•</span>
                            <span className="text-sky-200">
                              Them {formatNumber(chat.sessionStarters.startedByOthers)}
                            </span>
                          </div>
                        </div>
                        <div className="rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2.5">
                          <div className="flex items-center gap-1 text-neutral-500">
                            <DirectChatIcon className="h-3 w-3 text-indigo-200" />
                            <span>Double texts</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-emerald-200">
                              You {formatNumber(chat.doubleTexts.youDoubleTexted)}
                            </span>
                            <span className="text-neutral-600">•</span>
                            <span className="text-indigo-200">
                              Them {formatNumber(chat.doubleTexts.theyDoubleTexted)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 rounded-lg border border-neutral-900/70 bg-neutral-900/40 p-2.5">
                        <div className="flex items-center gap-1 text-neutral-500">
                          <ClockIcon className="h-3 w-3 text-sky-200" />
                          <span>First reply</span>
                        </div>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-neutral-500">You</p>
                            <p className="text-sm font-semibold text-emerald-100">
                              {formatResponseDuration(chatMyFirstReply.medianSeconds)}
                            </p>
                            <p className="text-[11px] text-neutral-500">
                              90% within {formatResponseDuration(chatMyFirstReply.p90Seconds)}
                            </p>
                            <p className="text-[11px] text-neutral-600">
                              Fast {formatResponseDuration(chatMyFirstReply.minSeconds)} · Slow{" "}
                              {formatResponseDuration(chatMyFirstReply.maxSeconds)}
                            </p>
                            <p className="text-[11px] text-neutral-600">In-thread median {chatMyInThreadMedian}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-neutral-500">Them</p>
                            <p className="text-sm font-semibold text-sky-100">
                              {formatResponseDuration(chatTheirFirstReply.medianSeconds)}
                            </p>
                            <p className="text-[11px] text-neutral-500">
                              90% within {formatResponseDuration(chatTheirFirstReply.p90Seconds)}
                            </p>
                            <p className="text-[11px] text-neutral-600">
                              Fast {formatResponseDuration(chatTheirFirstReply.minSeconds)} · Slow{" "}
                              {formatResponseDuration(chatTheirFirstReply.maxSeconds)}
                            </p>
                            <p className="text-[11px] text-neutral-600">
                              In-thread median {chatTheirInThreadMedian}
                            </p>
                          </div>
                        </div>
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

          <MessageSearchPanel
            rangeStart={statsQueryInput.start}
            rangeEnd={statsQueryInput.end}
            topChats={stats?.topChats ?? []}
          />
        </section>
      </main>

      <PersonDrawer
        open={Boolean(selectedPersonId)}
        onClose={() => setSelectedPersonId(null)}
        person={selectedPerson}
        messages={selectedMessageStats}
        calls={selectedCallStats}
        rangeStartIso={range.startIso}
        rangeEndIso={range.endIso}
        callHistoryEarliest={callHistoryEarliest}
        isMessagesLoading={statsLoading || statsFetching}
        isCallsLoading={callsQuery.isPending || callsQuery.isFetching}
        messagesError={statsError}
        callsError={callsError}
      />

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
