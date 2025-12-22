import Link from "next/link";
import { notFound } from "next/navigation";
import { ShareReportButton } from "@/components/share-report-button";
import { getChatSummaryById, getChatTextStyleSummary, type ChatTextStyleSideStats } from "@/lib/imessage/queries";
import { REACTION_TYPES } from "@/lib/imessage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type ReportPageProps = {
  params: Promise<{ chatId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const numberFormatter = new Intl.NumberFormat();
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function parseDateParam(value?: string | string[]) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatCompact(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return compactFormatter.format(value);
}

function formatPercent(part: number, total: number) {
  if (!total || !Number.isFinite(part)) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatRate(value: number | null | undefined, digits = 0) {
  if (!Number.isFinite(value ?? NaN)) return "—";
  const percent = (value as number) * 100;
  return `${percent.toFixed(digits)}%`;
}

function formatMetric(value: number | null | undefined, digits = 1) {
  if (!Number.isFinite(value ?? NaN)) return "—";
  const numeric = value as number;
  return digits === 0 ? Math.round(numeric).toString() : numeric.toFixed(digits);
}

function ToneBar({ stats }: { stats: ChatTextStyleSideStats }) {
  const total = stats.tone.positive + stats.tone.neutral + stats.tone.negative;
  if (!total) {
    return <p className="mt-2 text-xs text-neutral-500">No tone sample.</p>;
  }

  const positiveRate = stats.tone.positive / total;
  const neutralRate = stats.tone.neutral / total;
  const negativeRate = stats.tone.negative / total;

  return (
    <div className="mt-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-neutral-800/70">
        <div className="h-full bg-emerald-400/80" style={{ width: `${positiveRate * 100}%` }} />
        <div className="h-full bg-neutral-500/70" style={{ width: `${neutralRate * 100}%` }} />
        <div className="h-full bg-rose-400/80" style={{ width: `${negativeRate * 100}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-neutral-400">
        <span>
          + {formatRate(positiveRate)} · ○ {formatRate(neutralRate)} · − {formatRate(negativeRate)}
        </span>
        <span className="text-neutral-500">avg {formatMetric(stats.tone.averageScore, 2)}</span>
      </div>
    </div>
  );
}

function StyleCard({ title, stats }: { title: string; stats: ChatTextStyleSideStats }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-neutral-950/20 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-neutral-100">{title}</p>
        <span className="text-xs text-neutral-500">{formatNumber(stats.messageCount)} msgs</span>
      </div>

      <div className="mt-4 grid gap-3 text-sm text-neutral-200">
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">Median length</span>
          <span className="font-semibold text-white">
            {stats.medianChars ? `${formatMetric(stats.medianChars, 0)} chars` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">P90 length</span>
          <span className="font-semibold text-white">
            {stats.p90Chars ? `${formatMetric(stats.p90Chars, 0)} chars` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">Emoji density</span>
          <span className="font-semibold text-white">{formatMetric(stats.emojiPerMessage, 2)} / msg</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">Multi-line</span>
          <span className="font-semibold text-white">{formatRate(stats.multiLineRate)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">Split-up streaks</span>
          <span className="font-semibold text-white">
            {formatMetric(stats.avgRunLength, 2)} avg · {formatRate(stats.multiMessageRunRate)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-neutral-400">Affirmative starts</span>
          <span className="font-semibold text-white">{formatRate(stats.affirmativeRate)}</span>
        </div>
      </div>

      <div className="mt-5 border-t border-white/10 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Tone</p>
        <ToneBar stats={stats} />
      </div>
    </div>
  );
}

function formatDateTime(value: Date | null) {
  if (!value) return "No activity in this window";
  return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatRangeLabel(start?: Date, end?: Date) {
  if (start && end) {
    const startLabel = start.toLocaleDateString(undefined, { dateStyle: "medium" });
    const endLabel = end.toLocaleDateString(undefined, { dateStyle: "medium" });
    return `${startLabel} → ${endLabel}`;
  }
  if (start) {
    return `Since ${start.toLocaleDateString(undefined, { dateStyle: "medium" })}`;
  }
  if (end) {
    return `Up to ${end.toLocaleDateString(undefined, { dateStyle: "medium" })}`;
  }
  return "All-time overview";
}

function formatParticipantName(name: string | null | undefined) {
  if (!name) return "Unknown";
  return name;
}

function buildShareFileName(title: string) {
  const safe = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${safe || "group-report"}-report.png`;
}

export default async function ReportPage({ params, searchParams }: ReportPageProps) {
  const resolvedParams = await params;
  const queryParams = searchParams ? await searchParams : {};

  const chatId = Number.parseInt(resolvedParams.chatId, 10);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    notFound();
  }

  const start = parseDateParam(queryParams.start);
  const end = parseDateParam(queryParams.end);
  const summary = getChatSummaryById(chatId, {
    dateRange: { start, end },
  });
  const style = getChatTextStyleSummary(chatId, {
    dateRange: { start, end },
  });

  if (!summary) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-6 text-center text-neutral-100">
        <div className="max-w-md space-y-4 rounded-2xl border border-neutral-800/80 bg-neutral-900/70 p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-emerald-300">Group report</p>
          <h1 className="text-2xl font-semibold text-white">Chat unavailable</h1>
          <p className="text-sm text-neutral-400">
            We couldn&apos;t find any messages for this chat. Make sure you shared the correct link and try again.
          </p>
          <Link
            href="/messages"
            className="inline-flex items-center justify-center rounded-full border border-emerald-400/50 px-4 py-1.5 text-sm font-semibold text-emerald-200 transition hover:border-emerald-300 hover:text-white"
          >
            Back to messages
          </Link>
        </div>
      </main>
    );
  }

  const title = summary.chatDisplayName ?? "Messages report";
  const memberCount = summary.participants.length;
  const memberLabel =
    memberCount === 0 ? "No members detected" : `${memberCount} ${memberCount === 1 ? "member" : "members"}`;
  const lastActiveLabel = formatDateTime(summary.lastMessageAt);
  const rangeLabel = formatRangeLabel(start, end);
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const topMembers = summary.messageParticipants.slice(0, 10);
  const topReactors = summary.reactionParticipants.slice(0, 10);
  const totalMessages = summary.messageCount;
  const totalReactions = summary.reactions.reactionCount;
  const reactionTypeEntries = REACTION_TYPES.map((type) => ({
    type,
    ...summary.reactions.byType[type],
  })).filter((entry) => entry.reactionCount > 0);

  const participantChips = summary.participants.slice(0, 12);
  const remainingParticipants = Math.max(0, summary.participants.length - participantChips.length);

  const statCards = [
    {
      label: "Messages",
      value: formatNumber(totalMessages),
      accent: "Total volume",
      tone: "emerald",
    },
    {
      label: "Sent",
      value: formatNumber(summary.sentCount),
      accent: formatPercent(summary.sentCount, totalMessages),
      tone: "sky",
    },
    {
      label: "Received",
      value: formatNumber(summary.receivedCount),
      accent: formatPercent(summary.receivedCount, totalMessages),
      tone: "violet",
    },
    {
      label: "Reactions",
      value: formatNumber(totalReactions),
      accent: formatPercent(totalReactions, totalMessages),
      tone: "fuchsia",
    },
  ] as const;

  const shareFileName = buildShareFileName(title);

  return (
    <div id="report-capture" className="min-h-screen bg-neutral-950 text-neutral-50">
      <header className="relative overflow-hidden border-b border-neutral-900/80 bg-gradient-to-br from-emerald-600/15 via-neutral-950 to-neutral-950">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.18),_transparent_55%)]" />
        <div className="relative mx-auto max-w-5xl px-6 py-12">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-[0.4em] text-emerald-300">Group report</p>
            <ShareReportButton targetId="report-capture" fileName={shareFileName} />
          </div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">{title}</h1>
          <div className="mt-4 flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-wide text-neutral-300">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1">
              {memberLabel}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-neutral-300">
              {rangeLabel}
            </span>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-neutral-300">
              Last active · {lastActiveLabel}
            </span>
          </div>
          {participantChips.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {participantChips.map((name, index) => (
                <span
                  key={`${name}-${index}`}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-200"
                >
                  {name}
                </span>
              ))}
              {remainingParticipants > 0 && (
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-400">
                  +{remainingParticipants} more
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((card) => {
            const toneClasses: Record<string, string> = {
              emerald: "from-emerald-500/20 via-emerald-500/5 to-transparent border-emerald-500/30",
              sky: "from-sky-500/20 via-sky-500/5 to-transparent border-sky-500/30",
              violet: "from-violet-500/20 via-violet-500/5 to-transparent border-violet-500/30",
              fuchsia: "from-fuchsia-500/20 via-fuchsia-500/5 to-transparent border-fuchsia-500/30",
            };
            return (
              <div
                key={card.label}
                className={`rounded-2xl border bg-gradient-to-b p-5 shadow-lg shadow-black/30 ${toneClasses[card.tone]}`}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{card.label}</p>
                <p className="mt-3 text-3xl font-semibold text-white">{card.value}</p>
                <p className="text-sm text-neutral-300">{card.accent}</p>
              </div>
            );
          })}
        </section>

        {style && style.totalMessagesAnalyzed > 0 && (
          <section className="rounded-2xl border border-white/10 bg-neutral-900/60 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Tone &amp; style</p>
                <p className="mt-1 text-sm text-neutral-400">
                  Based on {formatNumber(style.totalMessagesAnalyzed)} text messages in this chat.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <StyleCard title="You" stats={style.me} />
              <StyleCard title="Others" stats={style.others} />
            </div>
          </section>
        )}

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-neutral-900/60 p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top contributors</p>
              <span className="text-xs text-neutral-500">Message volume</span>
            </div>
            <ul className="mt-4 space-y-3">
              {topMembers.length === 0 ? (
                <li className="text-sm text-neutral-400">No messages during this window.</li>
              ) : (
                topMembers.map((member, index) => {
                  const share = totalMessages > 0 ? (member.messageCount / totalMessages) * 100 : 0;
                  return (
                    <li key={member.id ?? `${index}-${member.displayName}`} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-neutral-500">#{index + 1}</span>
                          <span className={member.isMe ? "font-semibold text-emerald-200" : "text-neutral-100"}>
                            {formatParticipantName(member.displayName)}
                          </span>
                        </div>
                        <span className="font-semibold text-neutral-50">{formatNumber(member.messageCount)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-neutral-800">
                        <div
                          className="h-full rounded-full bg-emerald-400/80"
                          style={{ width: `${Math.max(4, share)}%` }}
                        />
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          <div className="rounded-2xl border border-white/10 bg-neutral-900/60 p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Top reactors</p>
              <span className="text-xs text-neutral-500">Tapbacks sent</span>
            </div>
            <ul className="mt-4 space-y-3">
              {topReactors.length === 0 ? (
                <li className="text-sm text-neutral-400">No reactions recorded.</li>
              ) : (
                topReactors.map((reactor, index) => (
                  <li key={reactor.id ?? `${index}-${reactor.displayName}`} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-neutral-500">#{index + 1}</span>
                      <span className={reactor.isMe ? "font-semibold text-emerald-200" : "text-neutral-100"}>
                        {formatParticipantName(reactor.displayName)}
                      </span>
                    </div>
                    <span className="font-semibold text-neutral-50">{formatNumber(reactor.reactionCount)}</span>
                  </li>
                ))
              )}
            </ul>
            <div className="mt-4 rounded-xl border border-white/10 bg-neutral-950/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Reaction types</p>
              {reactionTypeEntries.length === 0 ? (
                <p className="mt-3 text-sm text-neutral-400">No tapbacks detected.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {reactionTypeEntries.map(({ type, reactionCount }) => {
                    const share = totalReactions > 0 ? (reactionCount / totalReactions) * 100 : 0;
                    return (
                      <div key={type}>
                        <div className="flex items-center justify-between text-sm text-neutral-300">
                          <span className="capitalize">{type}</span>
                          <span className="font-semibold text-neutral-50">{formatNumber(reactionCount)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-neutral-800">
                          <div
                            className="h-full rounded-full bg-fuchsia-400/80"
                            style={{ width: `${Math.max(3, share)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-neutral-900/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Quick stats</p>
              <p className="text-sm text-neutral-300">Snapshot for this chat.</p>
            </div>
            <Link
              href="/messages"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-1.5 text-sm font-semibold text-neutral-100 transition hover:border-emerald-400/60 hover:text-emerald-100"
            >
              Back to messages
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M5 12a1 1 0 0 1 1-1h10.586l-4.293-4.293a1 1 0 0 1 1.414-1.414l6 6a1 1 0 0 1 0 1.414l-6 6a1 1 0 0 1-1.414-1.414L16.586 13H6a1 1 0 0 1-1-1"
                />
              </svg>
            </Link>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-white/10 bg-neutral-950/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Average per member</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {memberCount ? formatNumber(Math.round(totalMessages / memberCount)) : "—"}
              </p>
              <p className="text-sm text-neutral-400">Messages across participants</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-neutral-950/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Sent per day</p>
              <p className="mt-2 text-2xl font-semibold text-white">{formatCompact(summary.sentCount / 7)}</p>
              <p className="text-sm text-neutral-400">Approximate weekly cadence</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-neutral-950/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Reactions per 100 msgs</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {totalMessages ? ((totalReactions / totalMessages) * 100).toFixed(1) : "0.0"}
              </p>
              <p className="text-sm text-neutral-400">Engagement via tapbacks</p>
            </div>
          </div>
        </section>

        <footer className="rounded-2xl border border-white/10 bg-neutral-900/50 p-5 text-sm text-neutral-400">
          <p>Generated {generatedAt}. Refresh this page anytime to pull the latest stats.</p>
          <p className="text-xs text-neutral-500">All analysis happens locally on your Mac—no data leaves your device.</p>
        </footer>
      </main>
    </div>
  );
}
