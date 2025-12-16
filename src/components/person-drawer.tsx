'use client';

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type PersonTimelineBucket = "hour" | "day" | "week" | "month";

type PersonMessageTimelinePoint = {
  bucket: string;
  fromMeCount: number;
  fromThemCount: number;
  totalCount: number;
};

type PersonMessageTimeline = {
  bucket: PersonTimelineBucket;
  points: PersonMessageTimelinePoint[];
};

type PersonCallTimelinePoint = {
  bucket: string;
  answeredCount: number;
  missedCount: number;
  totalCount: number;
  talkSeconds: number;
};

type PersonCallTimeline = {
  bucket: PersonTimelineBucket;
  points: PersonCallTimelinePoint[];
};

export type PersonMessageThread = {
  chatId: number;
  label: string;
  isGroup: boolean;
  totalMessages: number;
  fromMeMessages: number;
  fromThemMessages: number;
  lastMessageAt: Date | null;
  href?: string;
};

export type PersonMessageStats = {
  totalMessages: number;
  fromMeMessages: number;
  fromThemMessages: number;
  chatCount: number;
  lastMessageAt: Date | null;
  threads?: PersonMessageThread[];
};

export type PersonRecentCall = {
  callId: number;
  startedAt: Date | null;
  durationSeconds: number;
  answered: boolean;
  direction: string;
  provider: string;
  media: string;
};

export type PersonCallStats = {
  totalCalls: number;
  incomingCalls: number;
  outgoingCalls: number;
  answeredCalls: number;
  missedIncomingCalls: number;
  talkSeconds: number;
  lastCallAt: Date | null;
  recentCalls?: PersonRecentCall[];
  callsInRange?: PersonRecentCall[];
};

export type PersonDrawerPerson = {
  key: string;
  label: string;
};

function formatNumber(value: number) {
  return value.toLocaleString();
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

function pad2(value: number) {
  return value.toString().padStart(2, "0");
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

function parseBucketDate(bucket: PersonTimelineBucket, value: string): Date | null {
  if (!value) return null;

  if (bucket === "month") {
    const match = value.match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
    return new Date(year, month - 1, 1, 0, 0, 0, 0);
  }

  if (bucket === "hour") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):00$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    if (![year, month, day, hour].every(Number.isFinite)) return null;
    return new Date(year, month - 1, day, hour, 0, 0, 0);
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (![year, month, day].every(Number.isFinite)) return null;
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function formatBucketKey(bucket: PersonTimelineBucket, date: Date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  if (bucket === "month") {
    return `${year}-${month}`;
  }
  const day = pad2(date.getDate());
  if (bucket === "hour") {
    return `${year}-${month}-${day} ${pad2(date.getHours())}:00`;
  }
  return `${year}-${month}-${day}`;
}

function floorToBucket(bucket: PersonTimelineBucket, date: Date) {
  const floored = new Date(date.getTime());
  if (bucket === "hour") {
    floored.setMinutes(0, 0, 0);
    return floored;
  }
  if (bucket === "day") {
    floored.setHours(0, 0, 0, 0);
    return floored;
  }
  if (bucket === "week") {
    floored.setHours(0, 0, 0, 0);
    const weekday = floored.getDay(); // 0=Sun, 1=Mon
    const diff = (weekday + 6) % 7; // days since Monday
    floored.setDate(floored.getDate() - diff);
    return floored;
  }

  // month
  floored.setHours(0, 0, 0, 0);
  floored.setDate(1);
  return floored;
}

function addBucket(bucket: PersonTimelineBucket, date: Date) {
  const next = new Date(date.getTime());
  if (bucket === "hour") {
    next.setHours(next.getHours() + 1);
    return next;
  }
  if (bucket === "day") {
    next.setDate(next.getDate() + 1);
    return next;
  }
  if (bucket === "week") {
    next.setDate(next.getDate() + 7);
    return next;
  }

  // month
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  return next;
}

function fillTimelinePoints(options: {
  bucket: PersonTimelineBucket;
  points: PersonMessageTimelinePoint[];
  rangeStartIso?: string;
  rangeEndIso?: string;
}): PersonMessageTimelinePoint[] {
  const { bucket, points, rangeStartIso, rangeEndIso } = options;
  if (points.length === 0) return [];

  const pointMap = new Map(points.map((point) => [point.bucket, point]));

  const parsedStartFromRange = rangeStartIso ? new Date(rangeStartIso) : null;
  const parsedEndFromRange = rangeEndIso ? new Date(rangeEndIso) : null;
  const rangeStart =
    parsedStartFromRange && !Number.isNaN(parsedStartFromRange.getTime()) ? parsedStartFromRange : null;
  const rangeEnd =
    parsedEndFromRange && !Number.isNaN(parsedEndFromRange.getTime()) ? parsedEndFromRange : null;

  const firstPointDate = parseBucketDate(bucket, points[0]?.bucket ?? "");
  const lastPointDate = parseBucketDate(bucket, points[points.length - 1]?.bucket ?? "");

  const startAnchor = rangeStart ?? firstPointDate;
  const endAnchor = rangeEnd ?? lastPointDate;
  if (!startAnchor || !endAnchor) return points;

  let cursor = floorToBucket(bucket, startAnchor);
  const endCursor = floorToBucket(bucket, endAnchor);

  const filled: PersonMessageTimelinePoint[] = [];
  let guard = 0;
  while (cursor <= endCursor && guard < 5_000) {
    guard += 1;
    const key = formatBucketKey(bucket, cursor);
    const existing = pointMap.get(key);
    filled.push(
      existing ?? {
        bucket: key,
        fromMeCount: 0,
        fromThemCount: 0,
        totalCount: 0,
      },
    );
    cursor = addBucket(bucket, cursor);
  }

  return filled;
}

function fillCallTimelinePoints(options: {
  bucket: PersonTimelineBucket;
  points: PersonCallTimelinePoint[];
  rangeStartIso?: string;
  rangeEndIso?: string;
}): PersonCallTimelinePoint[] {
  const { bucket, points, rangeStartIso, rangeEndIso } = options;
  if (points.length === 0) return [];

  const pointMap = new Map(points.map((point) => [point.bucket, point]));

  const parsedStartFromRange = rangeStartIso ? new Date(rangeStartIso) : null;
  const parsedEndFromRange = rangeEndIso ? new Date(rangeEndIso) : null;
  const rangeStart =
    parsedStartFromRange && !Number.isNaN(parsedStartFromRange.getTime()) ? parsedStartFromRange : null;
  const rangeEnd =
    parsedEndFromRange && !Number.isNaN(parsedEndFromRange.getTime()) ? parsedEndFromRange : null;

  const firstPointDate = parseBucketDate(bucket, points[0]?.bucket ?? "");
  const lastPointDate = parseBucketDate(bucket, points[points.length - 1]?.bucket ?? "");

  const startAnchor = rangeStart ?? firstPointDate;
  const endAnchor = rangeEnd ?? lastPointDate;
  if (!startAnchor || !endAnchor) return points;

  let cursor = floorToBucket(bucket, startAnchor);
  const endCursor = floorToBucket(bucket, endAnchor);

  const filled: PersonCallTimelinePoint[] = [];
  let guard = 0;
  while (cursor <= endCursor && guard < 5_000) {
    guard += 1;
    const key = formatBucketKey(bucket, cursor);
    const existing = pointMap.get(key);
    filled.push(
      existing ?? {
        bucket: key,
        answeredCount: 0,
        missedCount: 0,
        totalCount: 0,
        talkSeconds: 0,
      },
    );
    cursor = addBucket(bucket, cursor);
  }

  return filled;
}

function bucketLabel(bucket: PersonTimelineBucket) {
  if (bucket === "hour") return "Hourly";
  if (bucket === "day") return "Daily";
  if (bucket === "week") return "Weekly";
  return "Monthly";
}

function formatBucketDisplay(bucket: PersonTimelineBucket, bucketValue: string) {
  const parsed = parseBucketDate(bucket, bucketValue);
  if (!parsed) return bucketValue;
  try {
    if (bucket === "hour") {
      return parsed.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
    }
    if (bucket === "day") {
      return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    if (bucket === "week") {
      return `Week of ${parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    }
    return parsed.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  } catch {
    return bucketValue;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function CallsTimelineChart({
  timeline,
  rangeStartIso,
  rangeEndIso,
}: {
  timeline: PersonCallTimeline;
  rangeStartIso?: string;
  rangeEndIso?: string;
}) {
  const points = useMemo(
    () =>
      fillCallTimelinePoints({
        bucket: timeline.bucket,
        points: timeline.points,
        rangeStartIso,
        rangeEndIso,
      }),
    [rangeEndIso, rangeStartIso, timeline.bucket, timeline.points],
  );

  const maxTotal = useMemo(() => {
    return points.reduce((max, point) => (point.totalCount > max ? point.totalCount : max), 0);
  }, [points]);

  const maxTalkSeconds = useMemo(() => {
    return points.reduce((max, point) => (point.talkSeconds > max ? point.talkSeconds : max), 0);
  }, [points]);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const activeIndex = hoverIndex !== null ? clamp(hoverIndex, 0, Math.max(0, points.length - 1)) : points.length - 1;
  const active = points[activeIndex] ?? null;

  const chart = useMemo(() => {
    if (points.length === 0 || maxTotal <= 0) return null;
    const width = 300;
    const height = 70;
    const innerHeight = height - 10;
    const maxCount = maxTotal;
    const maxTalk = maxTalkSeconds;

    const makeCoords = (
      valueForPoint: (point: PersonCallTimelinePoint) => number,
      maxValue: number,
    ) =>
      points.map((point, index) => {
        const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
        const ratio = maxValue ? valueForPoint(point) / maxValue : 0;
        const y = innerHeight - ratio * innerHeight + 5;
        return { x, y };
      });

    const coordsTotal = makeCoords((point) => point.totalCount, maxCount);
    const coordsAnswered = makeCoords((point) => point.answeredCount, maxCount);
    const coordsMissed = makeCoords((point) => point.missedCount, maxCount);
    const coordsTalk = maxTalk > 0 ? makeCoords((point) => point.talkSeconds, maxTalk) : null;

    const makePath = (coords: Array<{ x: number; y: number }>) =>
      coords
        .map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(2)},${coord.y.toFixed(2)}`)
        .join(" ");

    const pathTotal = makePath(coordsTotal);
    const pathAnswered = makePath(coordsAnswered);
    const pathMissed = makePath(coordsMissed);
    const pathTalk = coordsTalk ? makePath(coordsTalk) : null;

    const areaTotal = `${pathTotal} L${width.toFixed(2)},${(innerHeight + 5).toFixed(2)} L0,${(innerHeight + 5).toFixed(
      2,
    )} Z`;

    return {
      width,
      height,
      areaTotal,
      pathAnswered,
      pathMissed,
      pathTalk,
      coordsAnswered,
      coordsMissed,
      coordsTalk,
    };
  }, [maxTalkSeconds, maxTotal, points]);

  if (points.length === 0) {
    return <p className="mt-2 text-sm text-neutral-500">No calls in view.</p>;
  }

  if (!chart) {
    return <p className="mt-2 text-sm text-neutral-500">No call activity in this range.</p>;
  }

  const markerAnswered = active ? chart.coordsAnswered[activeIndex] : null;
  const markerMissed = active ? chart.coordsMissed[activeIndex] : null;
  const markerTalk = active && chart.coordsTalk ? chart.coordsTalk[activeIndex] : null;
  const markerX = markerAnswered?.x ?? markerMissed?.x ?? markerTalk?.x ?? 0;

  return (
    <div className="mt-3 rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="h-20 w-full"
        role="img"
        aria-label="Calls over time chart"
        onPointerLeave={() => setHoverIndex(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - bounds.left;
          const ratio = bounds.width > 0 ? x / bounds.width : 0;
          const nextIndex = Math.round(ratio * (points.length - 1));
          setHoverIndex(clamp(nextIndex, 0, points.length - 1));
        }}
      >
        <path d={chart.areaTotal} fill="rgba(255, 255, 255, 0.06)" />
        <path d={chart.pathAnswered} fill="none" stroke="rgba(16, 185, 129, 0.9)" strokeWidth="2" />
        <path d={chart.pathMissed} fill="none" stroke="rgba(251, 191, 36, 0.9)" strokeWidth="2" />
        {chart.pathTalk ? (
          <path d={chart.pathTalk} fill="none" stroke="rgba(139, 92, 246, 0.9)" strokeWidth="2" />
        ) : null}
        {markerAnswered || markerMissed || markerTalk ? (
          <>
            <line
              x1={markerX}
              y1={8}
              x2={markerX}
              y2={chart.height - 5}
              stroke="rgba(255, 255, 255, 0.08)"
            />
            {markerAnswered ? (
              <circle
                cx={markerAnswered.x}
                cy={markerAnswered.y}
                r="3.5"
                fill="rgba(16, 185, 129, 0.95)"
                stroke="rgba(10,10,10,0.6)"
              />
            ) : null}
            {markerMissed ? (
              <circle
                cx={markerMissed.x}
                cy={markerMissed.y}
                r="3.5"
                fill="rgba(251, 191, 36, 0.95)"
                stroke="rgba(10,10,10,0.6)"
              />
            ) : null}
            {markerTalk ? (
              <circle
                cx={markerTalk.x}
                cy={markerTalk.y}
                r="3.5"
                fill="rgba(139, 92, 246, 0.95)"
                stroke="rgba(10,10,10,0.6)"
              />
            ) : null}
          </>
        ) : null}
      </svg>

      {active ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400">
          <span className="font-medium text-neutral-200">{formatBucketDisplay(timeline.bucket, active.bucket)}</span>
          <span className="flex items-center gap-3">
            <span className="text-neutral-500">{formatDuration(active.talkSeconds)}</span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80" />
              {formatNumber(active.answeredCount)}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-300/80" />
              {formatNumber(active.missedCount)}
            </span>
            <span className="text-neutral-200">{formatNumber(active.totalCount)}</span>
          </span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-neutral-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-6 rounded bg-emerald-400/80" />
          Answered
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-6 rounded bg-amber-300/80" />
          Missed
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-6 rounded bg-violet-400/80" />
          Talk time
        </span>
      </div>
    </div>
  );
}

function MessagesTimelineChart({
  timeline,
  rangeStartIso,
  rangeEndIso,
}: {
  timeline: PersonMessageTimeline;
  rangeStartIso?: string;
  rangeEndIso?: string;
}) {
  const points = useMemo(
    () =>
      fillTimelinePoints({
        bucket: timeline.bucket,
        points: timeline.points,
        rangeStartIso,
        rangeEndIso,
      }),
    [rangeEndIso, rangeStartIso, timeline.bucket, timeline.points],
  );

  const maxTotal = useMemo(() => {
    return points.reduce((max, point) => (point.totalCount > max ? point.totalCount : max), 0);
  }, [points]);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const activeIndex = hoverIndex !== null ? clamp(hoverIndex, 0, Math.max(0, points.length - 1)) : points.length - 1;
  const active = points[activeIndex] ?? null;

  const chart = useMemo(() => {
    if (points.length === 0 || maxTotal <= 0) return null;
    const width = 300;
    const height = 70;
    const innerHeight = height - 10;
    const max = maxTotal;

    const makeCoords = (valueForPoint: (point: PersonMessageTimelinePoint) => number) =>
      points.map((point, index) => {
        const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
        const ratio = max ? valueForPoint(point) / max : 0;
        const y = innerHeight - ratio * innerHeight + 5;
        return { x, y };
      });

    const coordsTotal = makeCoords((point) => point.totalCount);
    const coordsSent = makeCoords((point) => point.fromMeCount);
    const coordsReceived = makeCoords((point) => point.fromThemCount);

    const makePath = (coords: Array<{ x: number; y: number }>) =>
      coords
      .map((coord, index) => `${index === 0 ? "M" : "L"}${coord.x.toFixed(2)},${coord.y.toFixed(2)}`)
      .join(" ");

    const pathTotal = makePath(coordsTotal);
    const pathSent = makePath(coordsSent);
    const pathReceived = makePath(coordsReceived);

    const areaTotal = `${pathTotal} L${width.toFixed(2)},${(innerHeight + 5).toFixed(2)} L0,${(innerHeight + 5).toFixed(
      2,
    )} Z`;

    return {
      width,
      height,
      areaTotal,
      pathSent,
      pathReceived,
      coordsSent,
      coordsReceived,
    };
  }, [maxTotal, points]);

  if (points.length === 0) {
    return <p className="mt-2 text-sm text-neutral-500">No messages in view.</p>;
  }

  if (!chart) {
    return <p className="mt-2 text-sm text-neutral-500">No message activity in this range.</p>;
  }

  const markerSent = active ? chart.coordsSent[activeIndex] : null;
  const markerReceived = active ? chart.coordsReceived[activeIndex] : null;
  const markerX = markerSent?.x ?? markerReceived?.x ?? 0;

  return (
    <div className="mt-3 rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="h-20 w-full"
        role="img"
        aria-label="Messages over time chart"
        onPointerLeave={() => setHoverIndex(null)}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - bounds.left;
          const ratio = bounds.width > 0 ? x / bounds.width : 0;
          const nextIndex = Math.round(ratio * (points.length - 1));
          setHoverIndex(clamp(nextIndex, 0, points.length - 1));
        }}
      >
        <path d={chart.areaTotal} fill="rgba(255, 255, 255, 0.06)" />
        <path d={chart.pathSent} fill="none" stroke="rgba(16, 185, 129, 0.9)" strokeWidth="2" />
        <path d={chart.pathReceived} fill="none" stroke="rgba(56, 189, 248, 0.85)" strokeWidth="2" />
        {markerSent || markerReceived ? (
          <>
            <line
              x1={markerX}
              y1={8}
              x2={markerX}
              y2={chart.height - 5}
              stroke="rgba(255, 255, 255, 0.08)"
            />
            {markerSent ? (
              <circle
                cx={markerSent.x}
                cy={markerSent.y}
                r="3.5"
                fill="rgba(16, 185, 129, 0.95)"
                stroke="rgba(10,10,10,0.6)"
              />
            ) : null}
            {markerReceived ? (
              <circle
                cx={markerReceived.x}
                cy={markerReceived.y}
                r="3.5"
                fill="rgba(56, 189, 248, 0.95)"
                stroke="rgba(10,10,10,0.6)"
              />
            ) : null}
          </>
        ) : null}
      </svg>

      {active ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400">
          <span className="font-medium text-neutral-200">{formatBucketDisplay(timeline.bucket, active.bucket)}</span>
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400/80" />
              {formatNumber(active.fromMeCount)}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-sky-400/80" />
              {formatNumber(active.fromThemCount)}
            </span>
            <span className="text-neutral-200">{formatNumber(active.totalCount)}</span>
          </span>
        </div>
      ) : null}

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
    </div>
  );
}

function StatBlock({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-800/70 bg-neutral-950/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {description ? <p className="mt-1 text-xs text-neutral-400">{description}</p> : null}
    </div>
  );
}

export function PersonDrawer({
  open,
  onClose,
  person,
  messages,
  calls,
  rangeStartIso,
  rangeEndIso,
  callHistoryEarliest,
  isMessagesLoading = false,
  isCallsLoading = false,
  messagesError,
  callsError,
}: {
  open: boolean;
  onClose: () => void;
  person: PersonDrawerPerson | null;
  messages?: PersonMessageStats | null;
  calls?: PersonCallStats | null;
  rangeStartIso?: string;
  rangeEndIso?: string;
  callHistoryEarliest?: Date | null;
  isMessagesLoading?: boolean;
  isCallsLoading?: boolean;
  messagesError?: string | null;
  callsError?: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const lastActivity = useMemo(() => {
    const candidates = [messages?.lastMessageAt ?? null, calls?.lastCallAt ?? null].filter(Boolean) as Date[];
    if (candidates.length === 0) return null;
    return candidates.reduce((latest, value) => (value > latest ? value : latest));
  }, [calls?.lastCallAt, messages?.lastMessageAt]);

  const timelineQuery = useQuery({
    queryKey: [
      "person-timeline",
      person?.key ?? null,
      rangeStartIso ?? null,
      rangeEndIso ?? null,
    ] as const,
    enabled: Boolean(open && person?.key),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<PersonMessageTimeline> => {
      const personKey = person?.key;
      if (!personKey) {
        return { bucket: "day", points: [] };
      }

      const params = new URLSearchParams();
      params.set("key", personKey);
      if (rangeStartIso) params.set("start", rangeStartIso);
      if (rangeEndIso) params.set("end", rangeEndIso);
      const response = await fetch(`/api/person-timeline?${params.toString()}`);
      const payload = (await response.json().catch(() => null)) as
        | {
            data?: PersonMessageTimeline;
            error?: unknown;
          }
        | null;

      if (!response.ok) {
        const errorPayload = payload?.error;
        const direct = typeof errorPayload === "string" ? errorPayload : null;

        const formErrors =
          errorPayload && typeof errorPayload === "object" && "formErrors" in errorPayload
            ? (errorPayload as { formErrors?: unknown }).formErrors
            : null;
        const flattened =
          Array.isArray(formErrors) && typeof formErrors[0] === "string" ? formErrors[0] : null;

        const fieldErrors =
          errorPayload && typeof errorPayload === "object" && "fieldErrors" in errorPayload
            ? (errorPayload as { fieldErrors?: unknown }).fieldErrors
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

      return (payload?.data ?? { bucket: "day", points: [] }) as PersonMessageTimeline;
    },
  });

  const title = person?.label?.trim() || "Unknown";
  const timelineError = timelineQuery.error instanceof Error ? timelineQuery.error.message : null;
  const timeline = timelineQuery.data ?? null;

  const callHistoryNote = useMemo(() => {
    if (!callHistoryEarliest) return null;
    const rangeStart = rangeStartIso ? new Date(rangeStartIso) : null;
    const hasRangeStart = Boolean(rangeStart && !Number.isNaN(rangeStart?.getTime() ?? NaN));
    if (hasRangeStart && rangeStart && rangeStart >= callHistoryEarliest) {
      return null;
    }
    return `Call history on this Mac starts ${formatDate(callHistoryEarliest)}.`;
  }, [callHistoryEarliest, rangeStartIso]);

  const callTimeline = useMemo<PersonCallTimeline | null>(() => {
    if (!open || !person) return null;
    const callEvents = calls?.callsInRange ?? calls?.recentCalls ?? [];
    if (callEvents.length === 0) return null;

    const startFromRange = rangeStartIso ? new Date(rangeStartIso) : null;
    const endFromRange = rangeEndIso ? new Date(rangeEndIso) : null;
    const start =
      startFromRange && !Number.isNaN(startFromRange.getTime()) ? startFromRange : null;
    const end = endFromRange && !Number.isNaN(endFromRange.getTime()) ? endFromRange : null;

    const candidates = callEvents.filter((call) => {
      const startedAt = call.startedAt;
      if (!startedAt) return false;
      if (start && startedAt < start) return false;
      if (end && startedAt > end) return false;
      return true;
    });

    if (candidates.length === 0) {
      return { bucket: chooseAutoBucket({ start, end, fallback: "day" }), points: [] };
    }

    let earliest: Date | null = null;
    let latest: Date | null = null;
    for (const call of candidates) {
      const startedAt = call.startedAt;
      if (!startedAt) continue;
      if (!earliest || startedAt < earliest) earliest = startedAt;
      if (!latest || startedAt > latest) latest = startedAt;
    }

    const bucket = chooseAutoBucket({ start: start ?? earliest, end: end ?? latest, fallback: "month" });
    const map = new Map<string, PersonCallTimelinePoint>();

    for (const call of candidates) {
      const startedAt = call.startedAt;
      if (!startedAt) continue;
      const bucketDate = floorToBucket(bucket, startedAt);
      const key = formatBucketKey(bucket, bucketDate);
      const existing =
        map.get(key) ??
        {
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
  }, [calls?.callsInRange, calls?.recentCalls, open, person, rangeEndIso, rangeStartIso]);

  const topDurationCalls = useMemo<PersonRecentCall[]>(() => {
    if (!open || !person) return [];
    const callEvents = calls?.callsInRange ?? calls?.recentCalls ?? [];
    if (callEvents.length === 0) return [];

    const startFromRange = rangeStartIso ? new Date(rangeStartIso) : null;
    const endFromRange = rangeEndIso ? new Date(rangeEndIso) : null;
    const start =
      startFromRange && !Number.isNaN(startFromRange.getTime()) ? startFromRange : null;
    const end = endFromRange && !Number.isNaN(endFromRange.getTime()) ? endFromRange : null;

    return callEvents
      .filter((call) => {
        const startedAt = call.startedAt;
        if (!startedAt) return false;
        if (start && startedAt < start) return false;
        if (end && startedAt > end) return false;
        return (call.durationSeconds ?? 0) > 0;
      })
      .slice()
      .sort((a, b) => {
        const durationDiff = (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
        if (durationDiff !== 0) return durationDiff;
        return (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0) || b.callId - a.callId;
      })
      .slice(0, 6);
  }, [calls?.callsInRange, calls?.recentCalls, open, person, rangeEndIso, rangeStartIso]);

  if (!open || !person) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close person drawer"
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="person-drawer-title"
        className="relative h-full w-full max-w-lg overflow-y-auto border-l border-neutral-800/70 bg-neutral-950/95 p-6 text-neutral-100 shadow-2xl shadow-black/70"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Contact</p>
            <h2 id="person-drawer-title" className="mt-1 truncate text-2xl font-semibold text-white">
              {title}
            </h2>
            <p className="mt-2 text-xs text-neutral-400">
              Last activity · {formatDateTime(lastActivity)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-neutral-700/80 p-1 text-neutral-300 transition hover:border-neutral-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path
                fill="currentColor"
                d="M6.225 4.811a1 1 0 0 0-1.414 1.414L10.586 12l-5.775 5.775a1 1 0 0 0 1.414 1.414L12 13.414l5.775 5.775a1 1 0 0 0 1.414-1.414L13.414 12l5.775-5.775a1 1 0 0 0-1.414-1.414L12 10.586 6.225 4.811Z"
              />
            </svg>
          </button>
        </div>

        {(messagesError || callsError) && (
          <div className="mt-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            <p className="font-semibold text-amber-200">Some data couldn’t load</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-100/90">
              {messagesError ? <li>{messagesError}</li> : null}
              {callsError ? <li>{callsError}</li> : null}
            </ul>
          </div>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <StatBlock
            label="Messages"
            value={isMessagesLoading ? "…" : formatCompactNumber(messages?.totalMessages ?? 0)}
            description={
              messages
                ? `${formatNumber(messages.fromMeMessages)} from you · ${formatNumber(messages.fromThemMessages)} from them`
                : isMessagesLoading
                  ? "Loading…"
                  : "No message stats in view"
            }
          />
          <StatBlock
            label="Calls"
            value={isCallsLoading ? "…" : formatCompactNumber(calls?.totalCalls ?? 0)}
            description={
              calls
                ? `${formatNumber(calls.answeredCalls)} answered · ${formatNumber(calls.missedIncomingCalls)} missed (in)`
                : isCallsLoading
                  ? "Loading…"
                  : "No call stats in view"
            }
          />
          <StatBlock
            label="Talk time"
            value={isCallsLoading ? "…" : formatDuration(calls?.talkSeconds ?? 0)}
            description={calls?.totalCalls ? `Across ${formatNumber(calls.totalCalls)} calls` : undefined}
          />
          <StatBlock
            label="Threads"
            value={isMessagesLoading ? "…" : formatCompactNumber(messages?.chatCount ?? 0)}
            description={messages?.chatCount ? "Distinct chats" : undefined}
          />
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Messages over time</p>
            <span className="text-xs text-neutral-500">
              {timeline ? bucketLabel(timeline.bucket) : "Timeline"}
            </span>
          </div>
          {timelineQuery.isPending || timelineQuery.isFetching ? (
            <div className="mt-3 h-24 animate-pulse rounded-xl border border-neutral-800/70 bg-neutral-950/40" />
          ) : timelineError ? (
            <p className="mt-2 text-sm text-amber-200">{timelineError}</p>
          ) : timeline ? (
            <MessagesTimelineChart timeline={timeline} rangeStartIso={rangeStartIso} rangeEndIso={rangeEndIso} />
          ) : (
            <p className="mt-2 text-sm text-neutral-500">No timeline available.</p>
          )}
        </div>

        {messages?.threads && messages.threads.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top threads</p>
              <span className="text-xs text-neutral-500">Messages</span>
            </div>
            <ul className="mt-3 space-y-2">
              {messages.threads.slice(0, 6).map((thread) => {
                const subtitle = `${formatNumber(thread.totalMessages)} msgs · last ${formatDateTime(thread.lastMessageAt)}`;
                const body = (
                  <div className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                    <p className="truncate text-sm font-semibold text-neutral-50">
                      {thread.label}
                      {thread.isGroup ? <span className="ml-2 text-xs font-semibold text-neutral-500">(group)</span> : null}
                    </p>
                    <p className="mt-1 text-xs text-neutral-400">{subtitle}</p>
                  </div>
                );
                return (
                  <li key={thread.chatId}>
                    {thread.href ? (
                      <Link href={thread.href} className="block transition hover:opacity-90">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="mt-8">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Calls over time</p>
            <span className="text-xs text-neutral-500">
              {callTimeline ? bucketLabel(callTimeline.bucket) : "Timeline"}
            </span>
          </div>
          {isCallsLoading ? (
            <div className="mt-3 h-24 animate-pulse rounded-xl border border-neutral-800/70 bg-neutral-950/40" />
          ) : callTimeline ? (
            <CallsTimelineChart timeline={callTimeline} rangeStartIso={rangeStartIso} rangeEndIso={rangeEndIso} />
          ) : (
            <p className="mt-2 text-sm text-neutral-500">No calls in view.</p>
          )}
          {callHistoryNote ? <p className="mt-3 text-xs text-neutral-500">{callHistoryNote}</p> : null}
        </div>

        {!isCallsLoading && topDurationCalls.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Longest calls</p>
              <span className="text-xs text-neutral-500">Duration</span>
            </div>
            <ul className="mt-3 space-y-2">
              {topDurationCalls.map((call) => (
                <li key={`duration-${call.callId}`} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                  <p className="text-sm font-semibold text-neutral-50">
                    {formatDuration(call.durationSeconds)}
                    <span className="mx-2 text-neutral-700">•</span>
                    <span className="text-neutral-200">{call.provider === "facetime" ? "FaceTime" : call.provider === "telephony" ? "Phone" : call.provider}</span>
                    {call.media !== "unknown" ? (
                      <>
                        <span className="mx-2 text-neutral-700">•</span>
                        <span className="text-neutral-400">{call.media}</span>
                      </>
                    ) : null}
                    <span className="mx-2 text-neutral-700">•</span>
                    <span className="text-neutral-400">{call.direction}</span>
                  </p>
                  <p className="mt-1 text-xs text-neutral-400">{formatDateTime(call.startedAt)}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {calls?.recentCalls && calls.recentCalls.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Recent calls</p>
              <span className="text-xs text-neutral-500">Duration</span>
            </div>
            <ul className="mt-3 space-y-2">
              {calls.recentCalls.slice(0, 6).map((call) => (
                <li key={call.callId} className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3">
                  <p className="text-sm font-semibold text-neutral-50">
                    {call.answered ? (
                      <span className="text-emerald-200">Answered</span>
                    ) : (
                      <span className="text-amber-200">Missed</span>
                    )}
                    <span className="mx-2 text-neutral-700">•</span>
                    <span className="text-neutral-200">{call.direction}</span>
                    <span className="mx-2 text-neutral-700">•</span>
                    <span className="text-neutral-400">{call.provider}</span>
                  </p>
                  <p className="mt-1 text-xs text-neutral-400">
                    {formatDateTime(call.startedAt)} · {formatDuration(call.durationSeconds)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
