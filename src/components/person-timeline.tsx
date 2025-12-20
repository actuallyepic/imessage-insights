'use client';

import { useMemo, useState } from "react";

export type PersonTimelineBucket = "hour" | "day" | "week" | "month";

export type PersonMessageTimelinePoint = {
  bucket: string;
  fromMeCount: number;
  fromThemCount: number;
  totalCount: number;
};

export type PersonMessageTimeline = {
  bucket: PersonTimelineBucket;
  points: PersonMessageTimelinePoint[];
};

export type PersonCallTimelinePoint = {
  bucket: string;
  answeredCount: number;
  missedCount: number;
  totalCount: number;
  talkSeconds: number;
};

export type PersonCallTimeline = {
  bucket: PersonTimelineBucket;
  points: PersonCallTimelinePoint[];
};

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

export function parseBucketDate(bucket: PersonTimelineBucket, value: string): Date | null {
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

export function formatBucketKey(bucket: PersonTimelineBucket, date: Date) {
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

export function floorToBucket(bucket: PersonTimelineBucket, date: Date) {
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

export function fillMessageTimelinePoints(options: {
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

export function fillCallTimelinePoints(options: {
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

export function bucketLabel(bucket: PersonTimelineBucket) {
  if (bucket === "hour") return "Hourly";
  if (bucket === "day") return "Daily";
  if (bucket === "week") return "Weekly";
  return "Monthly";
}

export function formatBucketDisplay(bucket: PersonTimelineBucket, bucketValue: string) {
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

function formatNumber(value: number) {
  return value.toLocaleString();
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

export function CallsTimelineChart({
  timeline,
  rangeStartIso,
  rangeEndIso,
  height = 70,
  width = 300,
  className = "h-20 w-full",
}: {
  timeline: PersonCallTimeline;
  rangeStartIso?: string;
  rangeEndIso?: string;
  height?: number;
  width?: number;
  className?: string;
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
      areaTotal,
      pathAnswered,
      pathMissed,
      pathTalk,
      coordsAnswered,
      coordsMissed,
      coordsTalk,
    };
  }, [height, maxTalkSeconds, maxTotal, points, width]);

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
        viewBox={`0 0 ${width} ${height}`}
        className={className}
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
              y2={height - 5}
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

export function MessagesTimelineChart({
  timeline,
  rangeStartIso,
  rangeEndIso,
  height = 70,
  width = 300,
  className = "h-20 w-full",
}: {
  timeline: PersonMessageTimeline;
  rangeStartIso?: string;
  rangeEndIso?: string;
  height?: number;
  width?: number;
  className?: string;
}) {
  const points = useMemo(
    () =>
      fillMessageTimelinePoints({
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
      areaTotal,
      pathSent,
      pathReceived,
      coordsSent,
      coordsReceived,
    };
  }, [height, maxTotal, points, width]);

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
        viewBox={`0 0 ${width} ${height}`}
        className={className}
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
              y2={height - 5}
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
