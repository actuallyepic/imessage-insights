import type { AppleTimestamp } from "./types";

const APPLE_EPOCH_OFFSET = 978307200; // Seconds between 1970-01-01 and 2001-01-01

/**
 * Convert the Apple/CoreData timestamp used by iMessage into a JS Date.
 * The column may store seconds or nanoseconds since 2001-01-01, so we normalise.
 */
export function fromAppleTimestamp(value: AppleTimestamp): Date | null {
  if (value === null) {
    return null;
  }

  if (value === 0) {
    return null;
  }

  const absValue = Math.abs(value);

  // macOS Big Sur+ uses nanoseconds, older macOS uses seconds.
  const seconds =
    absValue > 1e12
      ? value / 1_000_000_000 // nanoseconds
      : absValue > 1e9
      ? value / 1_000_000 // microseconds
      : value; // seconds

  const unixSeconds = seconds + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

export function toAppleTimestamp(date: Date): number {
  const secondsSinceUnixEpoch = date.getTime() / 1000;
  const appleSeconds = secondsSinceUnixEpoch - APPLE_EPOCH_OFFSET;
  return Math.round(appleSeconds * 1_000_000_000);
}

export function isWithinRange(date: Date, start?: Date, end?: Date): boolean {
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

