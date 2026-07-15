/** Shared formatters for the Signal UI. Keep every screen speaking the same dialect. */

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

/** Compact form for hero numbers: 48214 -> "48.2K". */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return Math.round(value).toLocaleString();
}

/** Talk time / long durations: "62h 14m", "8m 12s", "51s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Reply-time style: "2m 18s", "14m", "8s". */
export function formatShortDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${m}m`;
  }
  return `${total}s`;
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** Safe ratio; returns 0 when the denominator is zero. */
export function share(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return part / total;
}

export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Jul 12, 9:41 PM" */
export function formatDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Jun 13" */
export function formatDayShort(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Jun 13, 2026" */
export function formatDayLong(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "12a" / "6p" for hour axes. */
export function formatHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/** "6–7 PM" for a peak-hour callout. */
export function formatHourRange(hour: number): string {
  const label = (h: number) => {
    const n = ((h % 24) + 24) % 24;
    const suffix = n < 12 ? "AM" : "PM";
    const display = n % 12 === 0 ? 12 : n % 12;
    return { display, suffix };
  };
  const from = label(hour);
  const to = label(hour + 1);
  return from.suffix === to.suffix
    ? `${from.display}–${to.display} ${to.suffix}`
    : `${from.display} ${from.suffix}–${to.display} ${to.suffix}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function formatWeekday(weekday: number, short = false): string {
  const name = WEEKDAYS[((weekday % 7) + 7) % 7] ?? "—";
  return short ? name.slice(0, 3) : name;
}

/** Initials for an avatar: "Alex Rivera" -> "AR". Falls back to a handle's first glyphs. */
export function initialsFor(label: string | null | undefined): string {
  const value = (label ?? "").trim();
  if (!value) return "?";
  const words = value.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  const alnum = value.replace(/[^a-z0-9]/gi, "");
  if (alnum.length >= 2) return alnum.slice(0, 2).toUpperCase();
  if (alnum.length === 1) return alnum.toUpperCase();
  return value.slice(0, 2).toUpperCase();
}

const AVATAR_GRADIENTS = [
  "linear-gradient(140deg,#34d399,#38bdf8)",
  "linear-gradient(140deg,#a78bfa,#f472b6)",
  "linear-gradient(140deg,#fbbf24,#fb7185)",
  "linear-gradient(140deg,#38bdf8,#818cf8)",
  "linear-gradient(140deg,#4ade80,#22d3ee)",
  "linear-gradient(140deg,#f472b6,#c084fc)",
  "linear-gradient(140deg,#fb7185,#fbbf24)",
  "linear-gradient(140deg,#818cf8,#34d399)",
];

/** Stable per-identity avatar gradient, so a person keeps their colour across screens. */
export function avatarGradient(key: string | null | undefined): string {
  const value = key ?? "";
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

/** Display label for a handle/participant that may only have a raw phone or email. */
export function displayLabel(name: string | null | undefined, fallback: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed) return trimmed;
  const raw = (fallback ?? "").trim();
  return raw || "Unknown";
}

type LabelParticipant = { displayName: string | null; isMe?: boolean };

type LabelableChat = {
  chatDisplayName: string | null;
  isGroup: boolean;
  participants: string[];
  messageParticipants?: LabelParticipant[];
};

/**
 * Human-readable name for a chat.
 *
 * `chatDisplayName` is null for 1:1 chats and the query layer falls back to the raw
 * handle, which only resolves to a name when macOS Contacts has a matching record.
 * `messageParticipants[].displayName` has a richer fallback chain (Contacts → the
 * handle's own display_name → the handle), so prefer it for direct chats — otherwise
 * any number not in Contacts renders as "+15555550100".
 */
export function chatLabel(chat: LabelableChat): string {
  const others = (chat.messageParticipants ?? []).filter(
    (p) => p.isMe !== true && p.displayName && p.displayName !== "You",
  );

  if (!chat.isGroup) {
    const other = others.find((p) => p.displayName?.trim());
    if (other?.displayName) return other.displayName.trim();
  }

  const named = chat.chatDisplayName?.trim();
  if (named) return named;

  // Unnamed group: stitch the members together rather than showing raw handles.
  if (others.length > 0) {
    return others
      .map((p) => p.displayName?.trim())
      .filter(Boolean)
      .join(", ");
  }

  const handles = chat.participants.filter(Boolean);
  if (handles.length > 0) return handles.join(", ");
  return chat.isGroup ? "Group chat" : "Direct chat";
}
