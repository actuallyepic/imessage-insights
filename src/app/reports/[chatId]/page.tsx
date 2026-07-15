import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { ShareReportButton } from "@/components/share-report-button";
import {
  EmptyNote,
  ErrorBanner,
  MeterBar,
  Panel,
  PanelLabel,
  PanelSubtitle,
  PanelTitle,
  SplitBar,
  StatBadge,
  StatCard,
} from "@/components/ui/primitives";
import { chatLabel, formatCount, formatDateTime, formatDayLong, formatPercent, share } from "@/lib/format";
import {
  getChatSummaryById,
  getChatTextStyleSummary,
  type ChatTextStyleSideStats,
  type ChatTextStyleSummary,
} from "@/lib/imessage/queries";
import { REACTION_TYPES, type ChatSummary, type ReactionType } from "@/lib/imessage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type ReportPageProps = {
  params: Promise<{ chatId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/* ------------------------------------------------------------------ *
 * Hero gradient
 *
 * The one piece of chrome the shared tokens don't cover: a two-layer
 * gradient that has to flip with the colour scheme. globals.css belongs to
 * another owner, so the rule is scoped to this route via a local class.
 * ------------------------------------------------------------------ */

const HERO_CSS = `
.report-hero {
  background:
    radial-gradient(circle at 30% -20%, rgba(52, 211, 153, 0.22), transparent 55%),
    linear-gradient(160deg, #0f1512, #0b0b0d);
}
@media (prefers-color-scheme: light) {
  .report-hero {
    background:
      radial-gradient(circle at 30% -20%, rgba(52, 211, 153, 0.16), transparent 55%),
      linear-gradient(160deg, #eafaf1, #ffffff);
  }
}
`;

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** The design's internal reaction keys mapped to the labels it renders. */
const REACTION_LABELS: Record<ReactionType, string> = {
  love: "Loved",
  like: "Liked",
  laugh: "Laughed",
  emphasize: "Emphasized",
  question: "Questioned",
  dislike: "Disliked",
};

function parseDateParam(value?: string | string[]) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A metric that may legitimately be absent — never invent a zero for it. */
function formatMetric(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return digits === 0 ? Math.round(value).toString() : value.toFixed(digits);
}

function formatRate(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatPercent(value, digits);
}

function formatRangeLabel(start?: Date, end?: Date) {
  if (start && end) return `${formatDayLong(start)} → ${formatDayLong(end)}`;
  if (start) return `Since ${formatDayLong(start)}`;
  if (end) return `Up to ${formatDayLong(end)}`;
  return "All-time overview";
}

function buildShareFileName(title: string) {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${safe || "chat"}-report.png`;
}

/** Calendar days spanned by the chat's own first/last message — the honest
 *  denominator for a per-day rate. Null when the window has no activity. */
function activeSpanDays(summary: ChatSummary): number | null {
  const { firstMessageAt, lastMessageAt } = summary;
  if (!firstMessageAt || !lastMessageAt) return null;
  const ms = lastMessageAt.getTime() - firstMessageAt.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function isAuthorizationError(error: unknown) {
  return error instanceof Error && /authorization denied/i.test(error.message);
}

/* ------------------------------------------------------------------ *
 * Chips
 * ------------------------------------------------------------------ */

function Chip({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[11px] font-medium ${
        muted ? "text-ink-faint" : "text-ink-tertiary"
      }`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Tone & style
 * ------------------------------------------------------------------ */

function ToneSection({ stats }: { stats: ChatTextStyleSideStats }) {
  const { positive, neutral, negative, averageScore } = stats.tone;
  const total = positive + neutral + negative;

  if (total === 0) {
    return (
      <div className="mt-4 border-t border-line-hairline pt-4">
        <PanelLabel>Tone</PanelLabel>
        <EmptyNote className="mt-2">No tone sample in this range.</EmptyNote>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-line-hairline pt-4">
      <PanelLabel>Tone</PanelLabel>
      <SplitBar
        className="mt-2.5"
        height={8}
        segments={[
          { value: positive, color: "var(--accent)" },
          { value: neutral, color: "var(--ink-ghost)" },
          { value: negative, color: "var(--rose)" },
        ]}
      />
      <p className="mt-2.5 font-mono text-[10px] text-ink-faint">
        + {formatRate(positive / total)} · ○ {formatRate(neutral / total)} · − {formatRate(negative / total)} · avg{" "}
        {formatMetric(averageScore, 2)}
      </p>
    </div>
  );
}

function StyleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="text-xs font-semibold text-ink-secondary">{value}</span>
    </div>
  );
}

function StyleCard({ title, stats, delay }: { title: string; stats: ChatTextStyleSideStats; delay: number }) {
  return (
    <div className="rounded-[14px] border border-line-hairline bg-inset p-[17px] animate-rise" style={{ animationDelay: `${delay}s` }}>
      <div className="flex items-baseline justify-between gap-3">
        <PanelTitle>{title}</PanelTitle>
        <span className="text-[11px] text-ink-faint">{formatCount(stats.messageCount)} msgs</span>
      </div>

      <div className="mt-4 grid gap-2.5">
        <StyleRow
          label="Median length"
          value={stats.medianChars === null ? "—" : `${formatMetric(stats.medianChars, 0)} chars`}
        />
        <StyleRow label="P90 length" value={stats.p90Chars === null ? "—" : `${formatMetric(stats.p90Chars, 0)} chars`} />
        <StyleRow
          label="Emoji density"
          value={stats.emojiPerMessage === null ? "—" : `${formatMetric(stats.emojiPerMessage, 2)} / msg`}
        />
        <StyleRow label="Multi-line" value={formatRate(stats.multiLineRate)} />
        <StyleRow label="Affirmative starts" value={formatRate(stats.affirmativeRate)} />
      </div>

      <ToneSection stats={stats} />
    </div>
  );
}

function ToneAndStyle({ style }: { style: ChatTextStyleSummary }) {
  return (
    <Panel delay={0.16} className="rounded-[18px] p-[18px]">
      <PanelLabel>Tone &amp; style</PanelLabel>
      <PanelSubtitle>
        Based on {formatCount(style.totalMessagesAnalyzed)} text messages in this chat.
      </PanelSubtitle>
      <div className="mt-4 grid gap-3.5 lg:grid-cols-2">
        <StyleCard title="You" stats={style.me} delay={0.2} />
        <StyleCard title="Others" stats={style.others} delay={0.24} />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Ranked lists
 * ------------------------------------------------------------------ */

function TopContributors({ summary }: { summary: ChatSummary }) {
  const rows = summary.messageParticipants.slice(0, 10);
  // Bars are indexed to the leader, so the ranking reads as a shape.
  const peak = rows.reduce((max, row) => Math.max(max, row.messageCount), 0);

  return (
    <Panel delay={0.28} className="rounded-[18px] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <PanelLabel>Top contributors</PanelLabel>
        <span className="text-[11px] text-ink-faint">Message volume</span>
      </div>

      {rows.length === 0 ? (
        <EmptyNote className="mt-4">No messages in this range.</EmptyNote>
      ) : (
        <ul className="mt-4 flex flex-col gap-3.5">
          {rows.map((row, index) => (
            <li key={row.id ?? `${index}-${row.displayName}`} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-[10px] text-ink-ghost">{index + 1}</span>
                  <span
                    className={`truncate text-xs ${row.isMe ? "font-semibold text-accent" : "font-medium text-ink-secondary"}`}
                  >
                    {row.displayName ?? "Unknown"}
                  </span>
                </div>
                <span className="flex-none text-xs font-semibold text-ink">{formatCount(row.messageCount)}</span>
              </div>
              <MeterBar
                ratio={peak > 0 ? row.messageCount / peak : 0}
                color="var(--accent)"
                delay={0.3 + index * 0.04}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ReactionTypes({ summary }: { summary: ChatSummary }) {
  // Ranked, so the bars read top-to-bottom longest-to-shortest.
  const rows = REACTION_TYPES.map((type) => ({
    type,
    label: REACTION_LABELS[type],
    reactionCount: summary.reactions.byType[type].reactionCount,
  }))
    .filter((row) => row.reactionCount > 0)
    .sort((a, b) => b.reactionCount - a.reactionCount || a.label.localeCompare(b.label));

  const peak = rows.reduce((max, row) => Math.max(max, row.reactionCount), 0);

  return (
    <Panel delay={0.32} className="rounded-[18px] p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <PanelLabel>Reaction types</PanelLabel>
        <span className="text-[11px] text-ink-faint">Tapbacks</span>
      </div>

      {rows.length === 0 ? (
        <EmptyNote className="mt-4">No tapbacks in this range.</EmptyNote>
      ) : (
        <ul className="mt-4 flex flex-col gap-3.5">
          {rows.map((row, index) => (
            <li key={row.type} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-ink-secondary">{row.label}</span>
                <span className="text-xs font-semibold text-ink">{formatCount(row.reactionCount)}</span>
              </div>
              <MeterBar
                ratio={peak > 0 ? row.reactionCount / peak : 0}
                color="var(--fuchsia)"
                delay={0.34 + index * 0.04}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Quick stats
 * ------------------------------------------------------------------ */

function QuickStat({
  label,
  value,
  footer,
  delay,
}: {
  label: string;
  value: string;
  footer: string;
  delay: number;
}) {
  return (
    <div
      className="rounded-[14px] border border-line-hairline bg-inset p-[17px] animate-rise"
      style={{ animationDelay: `${delay}s` }}
    >
      <PanelLabel>{label}</PanelLabel>
      <p className="mt-2.5 text-[22px] font-semibold tracking-[-0.02em] text-ink">{value}</p>
      <p className="mt-1 text-[11px] text-ink-faint">{footer}</p>
    </div>
  );
}

function QuickStats({ summary }: { summary: ChatSummary }) {
  const contributors = summary.messageParticipants.length;
  const spanDays = activeSpanDays(summary);
  const totalMessages = summary.messageCount;
  const totalReactions = summary.reactions.reactionCount;

  return (
    <Panel delay={0.36} className="rounded-[18px] p-[18px]">
      <PanelLabel>Quick stats</PanelLabel>
      <PanelSubtitle>Derived from this chat&apos;s own activity window.</PanelSubtitle>

      <div className="mt-4 grid gap-3.5 md:grid-cols-3">
        <QuickStat
          label="Avg per member"
          value={contributors > 0 ? formatCount(Math.round(totalMessages / contributors)) : "—"}
          footer={
            contributors > 0
              ? `Across ${formatCount(contributors)} who sent messages`
              : "No senders in this range"
          }
          delay={0.4}
        />
        <QuickStat
          label="Sent per day"
          value={spanDays === null ? "—" : formatMetric(summary.sentCount / spanDays, 1)}
          footer={
            spanDays === null
              ? "No activity in this range"
              : `Over ${formatCount(spanDays)} ${spanDays === 1 ? "day" : "days"} of activity`
          }
          delay={0.44}
        />
        <QuickStat
          label="Reactions per 100 msgs"
          value={totalMessages > 0 ? formatMetric((totalReactions / totalMessages) * 100, 1) : "—"}
          footer="Engagement via tapbacks"
          delay={0.48}
        />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Shell states
 * ------------------------------------------------------------------ */

function ReportShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="flex flex-col gap-[22px]">{children}</div>
    </AppShell>
  );
}

function BackToReports() {
  return (
    <Link
      href="/reports"
      className="inline-flex w-fit items-center gap-2 rounded-full border border-line-control bg-surface px-4 py-1.5 text-xs font-semibold text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
    >
      ← All reports
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export default async function ReportPage({ params, searchParams }: ReportPageProps) {
  const resolvedParams = await params;
  const queryParams = searchParams ? await searchParams : {};

  const chatId = Number.parseInt(resolvedParams.chatId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    notFound();
  }

  // This route keeps its own raw ?start/?end contract — it predates the
  // app-wide rm/r/tz scheme and shared links depend on these exact params.
  const start = parseDateParam(queryParams.start);
  const end = parseDateParam(queryParams.end);

  let summary: ChatSummary | null;
  let style: ChatTextStyleSummary | null;
  try {
    summary = getChatSummaryById(chatId, { dateRange: { start, end } });
    style = getChatTextStyleSummary(chatId, { dateRange: { start, end } });
  } catch (error) {
    if (isAuthorizationError(error)) {
      return (
        <ReportShell>
          <ErrorBanner
            title="macOS denied access to the Messages database"
            detail="Grant Terminal full disk access in System Settings › Privacy & Security, then reload this page."
          />
          <BackToReports />
        </ReportShell>
      );
    }
    throw error;
  }

  if (!summary) {
    return (
      <ReportShell>
        <Panel className="rounded-[18px] p-[18px]">
          <PanelLabel>Report</PanelLabel>
          <p className="mt-2 text-lg font-semibold text-ink">Chat unavailable</p>
          <p className="mt-1.5 text-[13px] text-ink-dim">
            No messages were found for this chat in the selected range. Check the link, or widen the range.
          </p>
          <div className="mt-4">
            <BackToReports />
          </div>
        </Panel>
      </ReportShell>
    );
  }

  const title = chatLabel(summary);
  const eyebrow = summary.isGroup ? "Group report" : "Direct report";
  // `participants` is the roster minus you, but you are a member of your own chat.
  const memberCount = summary.participants.length + 1;
  const totalMessages = summary.messageCount;
  const totalReactions = summary.reactions.reactionCount;

  // Prefer messageParticipants: it carries resolved names, where `participants`
  // is raw handles unless macOS Contacts matched them.
  const otherNames = summary.messageParticipants
    .filter((p) => p.isMe !== true && p.displayName?.trim() && p.displayName !== "You")
    .map((p) => p.displayName!.trim());
  const allNames = ["You", ...(otherNames.length > 0 ? otherNames : summary.participants)];

  const participantChips = allNames.slice(0, 12);
  const remainingParticipants = Math.max(0, allNames.length - participantChips.length);

  return (
    <AppShell>
      <style dangerouslySetInnerHTML={{ __html: HERO_CSS }} />

      {/* Full-bleed inside the shell: cancel main's padding on the capture
          wrapper, then re-pad the sections under the hero. Keeping the
          negative margin on #report-capture (rather than on the header)
          means the exported PNG spans the full width too. */}
      <div id="report-capture" className="-mx-6 -mt-[30px] flex flex-col bg-page lg:-mx-[34px]">
        <header className="report-hero border-b border-line-subtle px-6 pt-[34px] pb-9 lg:px-[34px]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-accent">{eyebrow}</p>
            <ShareReportButton targetId="report-capture" fileName={buildShareFileName(title)} />
          </div>

          <h1 className="mt-3 text-[34px] font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>

          <div className="mt-4 flex flex-wrap gap-2">
            {summary.isGroup && memberCount > 0 ? (
              <Chip>
                {formatCount(memberCount)} {memberCount === 1 ? "member" : "members"}
              </Chip>
            ) : null}
            <Chip>{formatRangeLabel(start, end)}</Chip>
            <Chip muted>
              {summary.lastMessageAt
                ? `Last active · ${formatDateTime(summary.lastMessageAt)}`
                : "No activity in this range"}
            </Chip>
          </div>

          {participantChips.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-2">
              {participantChips.map((name, index) => (
                <Chip key={`${name}-${index}`}>{name}</Chip>
              ))}
              {remainingParticipants > 0 ? <Chip muted>+{remainingParticipants} more</Chip> : null}
            </div>
          ) : null}
        </header>

        <div className="flex flex-col gap-[22px] px-6 pt-[22px] lg:px-[34px]">
          <section className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Messages" value={formatCount(totalMessages)} tint="accent" delay={0} />
            <StatCard
              label="Sent"
              value={formatCount(summary.sentCount)}
              badge={<StatBadge tint="sky">{formatPercent(share(summary.sentCount, totalMessages), 1)}</StatBadge>}
              tint="sky"
              delay={0.04}
            />
            <StatCard
              label="Received"
              value={formatCount(summary.receivedCount)}
              badge={
                <StatBadge tint="violet">{formatPercent(share(summary.receivedCount, totalMessages), 1)}</StatBadge>
              }
              tint="violet"
              delay={0.08}
            />
            <StatCard
              label="Reactions"
              value={formatCount(totalReactions)}
              badge={<StatBadge tint="fuchsia">{formatPercent(share(totalReactions, totalMessages), 1)}</StatBadge>}
              tint="fuchsia"
              delay={0.12}
            />
          </section>

          {style && style.totalMessagesAnalyzed > 0 ? <ToneAndStyle style={style} /> : null}

          <section className="grid gap-3.5 lg:grid-cols-2">
            <TopContributors summary={summary} />
            <ReactionTypes summary={summary} />
          </section>

          <QuickStats summary={summary} />

          <footer className="flex flex-col gap-1 pb-2">
            <p className="text-[11px] text-ink-faint">
              Generated {formatDateTime(new Date())}. Refresh anytime to pull the latest stats.
            </p>
            <p className="text-[11px] text-ink-ghost">
              All analysis happens locally on your Mac — no data leaves your device.
            </p>
          </footer>
        </div>
      </div>
    </AppShell>
  );
}
