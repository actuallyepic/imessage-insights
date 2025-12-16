type IsoDateParts = {
  year: number;
  month: number;
  day: number;
};

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const formattersByZone = new Map<string, Intl.DateTimeFormat>();

function getOffsetFormatter(timeZone: string) {
  const cached = formattersByZone.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  formattersByZone.set(timeZone, formatter);
  return formatter;
}

function parseIsoDate(value: string): IsoDateParts | null {
  const match = ISO_DATE_REGEX.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;

  const constructed = new Date(Date.UTC(year, month - 1, day));
  if (
    constructed.getUTCFullYear() !== year ||
    constructed.getUTCMonth() !== month - 1 ||
    constructed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const formatter = getOffsetFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    values[part.type] = part.value;
  }

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return 0;
  }

  const asUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtcMs - date.getTime();
}

function addDaysToIsoDate(parts: IsoDateParts, days: number): IsoDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function zonedDateTimeToUtcMs(
  parts: IsoDateParts & { hour: number; minute: number; second: number; millisecond: number },
  timeZone: string,
) {
  const baseUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  let guess = baseUtcMs;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(guess), timeZone);
    const adjusted = baseUtcMs - offset;
    if (Math.abs(adjusted - guess) < 1) {
      return adjusted;
    }
    guess = adjusted;
  }

  return guess;
}

export function getSystemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  const trimmed = timeZone.trim();
  if (!trimmed) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getSupportedTimeZones(): string[] {
  const intlAny = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof intlAny.supportedValuesOf !== "function") return [];
  try {
    const values = intlAny.supportedValuesOf("timeZone");
    return Array.isArray(values) ? values : [];
  } catch {
    return [];
  }
}

export function getTodayIsoDateInTimeZone(timeZone: string, reference: Date = new Date()): string {
  const tz = isValidTimeZone(timeZone) ? timeZone.trim() : getSystemTimeZone();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(reference);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    values[part.type] = part.value;
  }
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    const fallback = new Date(reference);
    return `${fallback.getFullYear()}-${pad2(fallback.getMonth() + 1)}-${pad2(fallback.getDate())}`;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function countInclusiveDays(startDay: string, endDay: string): number | null {
  const startParts = parseIsoDate(startDay);
  const endParts = parseIsoDate(endDay);
  if (!startParts || !endParts) return null;

  const startUtc = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const endUtc = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  const diff = endUtc - startUtc;

  if (!Number.isFinite(diff)) return null;
  if (diff < 0) return null;

  return Math.floor(diff / DAY_MS) + 1;
}

export function computeZonedDayRangeIso(
  day: string,
  timeZone: string,
  { clampEndToNow = true }: { clampEndToNow?: boolean } = {},
): { start: string; end: string } | null {
  const parts = parseIsoDate(day);
  if (!parts) return null;

  const tz = isValidTimeZone(timeZone) ? timeZone.trim() : getSystemTimeZone();

  const startMs = zonedDateTimeToUtcMs(
    { ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 },
    tz,
  );

  const nextParts = addDaysToIsoDate(parts, 1);
  const nextStartMs = zonedDateTimeToUtcMs(
    { ...nextParts, hour: 0, minute: 0, second: 0, millisecond: 0 },
    tz,
  );

  const rawEndMs = nextStartMs - 1000;
  const endMs = clampEndToNow ? Math.min(rawEndMs, Date.now()) : rawEndMs;

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export function computeZonedInclusiveDateRangeIso(
  startDay: string,
  endDay: string,
  timeZone: string,
  { clampEndToNow = true }: { clampEndToNow?: boolean } = {},
): { start: string; end: string } | null {
  const startParts = parseIsoDate(startDay);
  const endParts = parseIsoDate(endDay);
  if (!startParts || !endParts) return null;

  const inclusiveCount = countInclusiveDays(startDay, endDay);
  if (!inclusiveCount) return null;

  const tz = isValidTimeZone(timeZone) ? timeZone.trim() : getSystemTimeZone();

  const startMs = zonedDateTimeToUtcMs(
    { ...startParts, hour: 0, minute: 0, second: 0, millisecond: 0 },
    tz,
  );

  const dayAfterEnd = addDaysToIsoDate(endParts, 1);
  const nextStartMs = zonedDateTimeToUtcMs(
    { ...dayAfterEnd, hour: 0, minute: 0, second: 0, millisecond: 0 },
    tz,
  );

  const rawEndMs = nextStartMs - 1000;
  const endMs = clampEndToNow ? Math.min(rawEndMs, Date.now()) : rawEndMs;

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

