'use client';

import { useEffect, useMemo, useState } from "react";

interface SearchResult {
  messageId: number;
  chatId: number;
  chatDisplayName: string | null;
  participants: string[];
  text: string | null;
  isFromMe: boolean;
  sentAt: string | null;
}

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

interface ConversationStats {
  topChats: ChatSummary[];
  participantBreakdown: ParticipantStats[];
  dailyCounts: DailyCount[];
  hourlyCounts: HourlyCount[];
  weekdayCounts: WeekdayCount[];
}

type StatsRange = "30d" | "90d" | "all";

function formatDateTime(value: string | null) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

function formatParticipants(chat: ChatSummary | SearchResult) {
  if ("participants" in chat && chat.participants.length > 0) {
    return chat.participants.join(", ");
  }
  if ("chatDisplayName" in chat && chat.chatDisplayName) {
    return chat.chatDisplayName;
  }
  return "(unknown)";
}

function formatNumber(value: number) {
  return value.toLocaleString();
}

function highlightText(text: string | null, query: string) {
  if (!text) return <span className="italic text-neutral-500">[no text]</span>;
  const trimmed = query.trim();
  if (!trimmed) return text;

  try {
    const pattern = new RegExp(`(${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    const parts = text.split(pattern);
    return parts.map((part, index) =>
      index % 2 === 1 ? (
        <mark key={`${part}-${index}`} className="rounded bg-amber-200 px-1 py-0.5 text-neutral-900">
          {part}
        </mark>
      ) : (
        <span key={`${part}-${index}`}>{part}</span>
      ),
    );
  } catch {
    return text;
  }
}

function computeTotals(stats: ConversationStats | null) {
  if (!stats) return { sent: 0, received: 0, total: 0 };
  const sent = stats.topChats.reduce((acc, chat) => acc + chat.sentCount, 0);
  const received = stats.topChats.reduce((acc, chat) => acc + chat.receivedCount, 0);
  return { sent, received, total: sent + received };
}

function getRangeDates(range: StatsRange) {
  if (range === "all") return {};
  const now = new Date();
  const days = range === "30d" ? 30 : 90;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
}

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type SearchRequest = {
  q: string;
  chatId?: string;
  fromMe: boolean;
  fromOthers: boolean;
  start?: string;
  end?: string;
};

const PAGE_SIZE = 200;

export default function Dashboard() {
  const [query, setQuery] = useState("");
  const [chatId, setChatId] = useState("");
  const [fromMe, setFromMe] = useState(true);
  const [fromOthers, setFromOthers] = useState(true);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadMoreLoading, setLoadMoreLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasMoreSearchResults, setHasMoreSearchResults] = useState(false);
  const [lastSearchRequest, setLastSearchRequest] = useState<SearchRequest | null>(null);

  const [statsRange, setStatsRange] = useState<StatsRange>("90d");
  const [stats, setStats] = useState<ConversationStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const totals = useMemo(() => computeTotals(stats), [stats]);

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

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "15" });
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
          throw new Error(payload.error ?? `Request failed with ${response.status}`);
        }
        const json = (await response.json()) as { data: ConversationStats };
        setStats(json.data);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatsError(error instanceof Error ? error.message : "Unable to load stats.");
      } finally {
        setStatsLoading(false);
      }
    }

    fetchStats();
    return () => controller.abort();
  }, [statsRange]);

  function buildSearchRequest(): SearchRequest {
    return {
      q: query.trim(),
      chatId: chatId.trim() || undefined,
      fromMe,
      fromOthers,
      start: startDate || undefined,
      end: endDate || undefined,
    };
  }

  function buildSearchParams(request: SearchRequest, offset: number) {
    const params = new URLSearchParams({
      q: request.q,
      limit: PAGE_SIZE.toString(),
      offset: offset.toString(),
    });
    if (request.chatId) params.set("chatId", request.chatId);
    if (!request.fromMe) params.set("fromMe", "false");
    if (!request.fromOthers) params.set("fromOthers", "false");
    if (request.start) params.set("start", request.start);
    if (request.end) params.set("end", request.end);
    return params;
  }

  async function executeSearch(append = false) {
    const request = append ? lastSearchRequest : buildSearchRequest();

    if (!request) {
      return;
    }

    if (!request.q) {
      setSearchError("Enter a search query.");
      if (!append) {
        setSearchResults([]);
      }
      return;
    }

    if (!request.fromMe && !request.fromOthers) {
      setSearchError("Enable at least one of the sender filters.");
      return;
    }

    const offset = append ? searchResults.length : 0;
    const params = buildSearchParams(request, offset);

    if (!append) {
      setSearchLoading(true);
      setSearchError(null);
      setSearchResults([]);
      setHasMoreSearchResults(false);
    } else {
      setLoadMoreLoading(true);
    }

    try {
      const response = await fetch(`/api/search?${params.toString()}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? `Request failed with ${response.status}`);
      }
      const json = (await response.json()) as { data: SearchResult[] };

      if (append) {
        setSearchResults((prev) => [...prev, ...json.data]);
      } else {
        setSearchResults(json.data);
      }

      setHasMoreSearchResults(json.data.length === PAGE_SIZE);
      if (!append) {
        setLastSearchRequest(request);
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Search failed unexpectedly.");
      if (!append) {
        setSearchResults([]);
      }
    } finally {
      if (append) {
        setLoadMoreLoading(false);
      } else {
        setSearchLoading(false);
      }
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void executeSearch(false);
  }

  function resetFilters() {
    setChatId("");
    setFromMe(true);
    setFromOthers(true);
    setStartDate("");
    setEndDate("");
  }

  return (
    <div className="min-h-screen bg-neutral-950 pb-16 text-neutral-100">
      <header className="border-b border-neutral-800 bg-neutral-900/80 py-6 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6">
          <h1 className="text-3xl font-semibold tracking-tight text-white">
            iMessage Insights
          </h1>
          <p className="text-sm text-neutral-400">
            Run read-only analytics against your local Messages database. Grant Terminal full disk
            access if you encounter authorization errors.
          </p>
        </div>
      </header>

      <main className="mx-auto mt-10 flex w-full max-w-6xl flex-col gap-10 px-6">
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 shadow-lg shadow-black/30">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="flex w-full flex-col gap-2 text-sm text-neutral-300">
                Search messages
                <div className="flex items-center gap-3">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder='Try "dinner", "NEAR(holiday, flight)" or a phone number'
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-base text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
                  />
                  <button
                    type="submit"
                    className="hidden rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 sm:block"
                    disabled={searchLoading}
                  >
                    {searchLoading ? "Searching..." : "Search"}
                  </button>
                </div>
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-2 text-sm text-neutral-300">
                Chat ID
                <input
                  value={chatId}
                  onChange={(event) => setChatId(event.target.value)}
                  placeholder="Optional numeric chat identifier"
                  className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
                />
              </label>

              <label className="flex flex-col gap-2 text-sm text-neutral-300">
                Start date
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
                />
              </label>

              <label className="flex flex-col gap-2 text-sm text-neutral-300">
                End date
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  className="rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/70"
                />
              </label>

              <div className="flex items-end gap-3">
                <label className="flex items-center gap-2 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    checked={fromMe}
                    onChange={(event) => setFromMe(event.target.checked)}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-emerald-500 focus:ring-emerald-400"
                  />
                  Sent by me
                </label>
                <label className="flex items-center gap-2 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    checked={fromOthers}
                    onChange={(event) => setFromOthers(event.target.checked)}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-emerald-500 focus:ring-emerald-400"
                  />
                  From others
                </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 sm:hidden"
                disabled={searchLoading}
              >
                {searchLoading ? "Searching..." : "Search"}
              </button>
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-500/50"
              >
                Reset filters
              </button>
              <p className="flex-1 text-sm text-neutral-500">
                Supports iMessage full-text search syntax, including boolean operators and NEAR
                queries.
              </p>
            </div>
            {searchError && <p className="text-sm text-red-400">{searchError}</p>}
          </form>

          <div className="mt-6 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Search results</h2>
              <span className="text-xs text-neutral-500">
                Showing {searchResults.length} messages
              </span>
            </div>
            <div className="divide-y divide-neutral-800 rounded-xl border border-neutral-800 bg-neutral-950/70">
              {searchResults.length === 0 && !searchLoading ? (
                <div className="p-6 text-sm text-neutral-500">
                  Results will appear here after you run a search.
                </div>
              ) : (
                searchResults.map((message) => (
                  <article key={message.messageId} className="flex flex-col gap-2 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
                      <span className="font-semibold text-emerald-400">
                        {message.isFromMe ? "Me" : "Contact"}
                      </span>
                      <span className="text-neutral-700">•</span>
                      <span>{formatParticipants(message)}</span>
                      <span className="text-neutral-700">•</span>
                      <span>{formatDateTime(message.sentAt)}</span>
                      <span className="text-neutral-700">•</span>
                      <span>Chat #{message.chatId}</span>
                    </div>
                    <p className="text-sm leading-6 text-neutral-100">
                      {highlightText(message.text, query)}
                    </p>
                  </article>
                ))
              )}
              {searchLoading && (
                <div className="p-4 text-sm text-neutral-500">Loading results…</div>
              )}
            </div>
            {hasMoreSearchResults && (
              <div className="mt-3 flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => void executeSearch(true)}
                  disabled={loadMoreLoading}
                  className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-500/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loadMoreLoading ? "Loading more…" : "Load more results"}
                </button>
              </div>
            )}
            {!searchLoading && searchResults.length > 0 && !hasMoreSearchResults && (
              <p className="mt-3 text-center text-xs text-neutral-500">
                Showing all matching messages ({searchResults.length}).
              </p>
            )}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[2fr,1fr]">
          <div className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 shadow-lg shadow-black/30">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-white">Conversation stats</h2>
              <div className="flex gap-2 text-xs text-neutral-400">
                <button
                  type="button"
                  onClick={() => setStatsRange("30d")}
                  className={`rounded-full px-3 py-1 transition ${
                    statsRange === "30d"
                      ? "bg-emerald-500 text-emerald-950"
                      : "border border-transparent hover:border-neutral-700"
                  }`}
                >
                  30d
                </button>
                <button
                  type="button"
                  onClick={() => setStatsRange("90d")}
                  className={`rounded-full px-3 py-1 transition ${
                    statsRange === "90d"
                      ? "bg-emerald-500 text-emerald-950"
                      : "border border-transparent hover:border-neutral-700"
                  }`}
                >
                  90d
                </button>
                <button
                  type="button"
                  onClick={() => setStatsRange("all")}
                  className={`rounded-full px-3 py-1 transition ${
                    statsRange === "all"
                      ? "bg-emerald-500 text-emerald-950"
                      : "border border-transparent hover:border-neutral-700"
                  }`}
                >
                  All time
                </button>
              </div>
            </div>
            {statsError && <p className="text-sm text-red-400">{statsError}</p>}
            {statsLoading && <p className="text-sm text-neutral-500">Loading stats…</p>}

            {stats && (
              <div className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
                    <p className="text-xs uppercase tracking-wide text-neutral-500">Total</p>
                    <p className="mt-2 text-2xl font-semibold text-white">
                      {formatNumber(totals.total)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
                    <p className="text-xs uppercase tracking-wide text-neutral-500">Sent</p>
                    <p className="mt-2 text-2xl font-semibold text-emerald-400">
                      {formatNumber(totals.sent)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
                    <p className="text-xs uppercase tracking-wide text-neutral-500">Received</p>
                    <p className="mt-2 text-2xl font-semibold text-sky-400">
                      {formatNumber(totals.received)}
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                    Top chats
                  </h3>
                  <div className="mt-2 divide-y divide-neutral-800 overflow-hidden rounded-xl border border-neutral-800">
                    {stats.topChats.map((chat) => {
                      const totalMessages = chat.messageCount;
                      const ratio = totals.total ? totalMessages / totals.total : 0;
                      return (
                        <div
                          key={chat.chatId}
                          className="relative flex items-center justify-between gap-4 bg-neutral-950/60 px-4 py-3"
                        >
                          <div>
                            <p className="text-sm font-medium text-neutral-100">
                              {chat.chatDisplayName ?? formatParticipants(chat)}
                            </p>
                            <p className="text-xs text-neutral-500">
                              {chat.isGroup ? "Group" : "1:1"} • Chat #{chat.chatId} • Last{" "}
                              {formatDateTime(chat.lastMessageAt)}
                            </p>
                          </div>
                          <div className="flex items-center gap-3 text-sm text-neutral-400">
                            <span className="font-semibold text-neutral-100">
                              {formatNumber(totalMessages)}
                            </span>
                            <span className="text-xs text-emerald-300">
                              ↑ {formatNumber(chat.sentCount)}
                            </span>
                            <span className="text-xs text-sky-300">
                              ↓ {formatNumber(chat.receivedCount)}
                            </span>
                          </div>
                          <div
                            className="absolute inset-y-0 left-0 w-full bg-emerald-500/10"
                            style={{ transform: `scaleX(${ratio.toFixed(2)})`, transformOrigin: "left" }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                      Hourly cadence
                    </h3>
                    <div className="mt-2 space-y-2 rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
                      {stats.hourlyCounts.length === 0 && (
                        <p className="text-sm text-neutral-500">No hourly activity recorded.</p>
                      )}
                      {stats.hourlyCounts.map((bucket) => {
                        const total = bucket.sentCount + bucket.receivedCount;
                        const width = hourlyMax
                          ? Math.min(100, Math.max(2, (total / hourlyMax) * 100))
                          : 0;
                        return (
                          <div key={bucket.hour} className="flex items-center gap-3 text-sm">
                            <span className="w-10 text-xs text-neutral-500">
                              {bucket.hour.toString().padStart(2, "0")}h
                            </span>
                            <div className="h-2 flex-1 rounded bg-neutral-800">
                              <div
                                className="h-2 rounded bg-gradient-to-r from-emerald-400 to-sky-400"
                                style={{ width: `${width}%` }}
                              />
                            </div>
                            <span className="w-12 text-right text-xs text-neutral-400">
                              {formatNumber(total)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                      Weekday cadence
                    </h3>
                    <div className="mt-2 space-y-2 rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
                      {stats.weekdayCounts.length === 0 && (
                        <p className="text-sm text-neutral-500">No weekday activity recorded.</p>
                      )}
                      {stats.weekdayCounts.map((bucket) => {
                        const total = bucket.sentCount + bucket.receivedCount;
                        const width = weekdayMax
                          ? Math.min(100, Math.max(2, (total / weekdayMax) * 100))
                          : 0;
                        return (
                          <div key={bucket.weekday} className="flex items-center gap-3 text-sm">
                            <span className="w-10 text-xs text-neutral-500">
                              {weekdayLabels[bucket.weekday]}
                            </span>
                            <div className="h-2 flex-1 rounded bg-neutral-800">
                              <div
                                className="h-2 rounded bg-gradient-to-r from-emerald-400 to-sky-400"
                                style={{ width: `${width}%` }}
                              />
                            </div>
                            <span className="w-12 text-right text-xs text-neutral-400">
                              {formatNumber(total)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <aside className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 shadow-lg shadow-black/30">
            <h2 className="text-lg font-semibold text-white">Top contacts</h2>
            {stats?.participantBreakdown && stats.participantBreakdown.length > 0 ? (
              <ul className="space-y-3">
                {stats.participantBreakdown.map((participant) => (
                  <li
                    key={participant.id ?? "me"}
                    className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4"
                  >
                    <p className="text-sm font-medium text-neutral-100">
                      {participant.displayName ?? participant.id ?? "Me"}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {formatNumber(participant.sentCount)} sent • {formatNumber(participant.receivedCount)} received
                    </p>
                  </li>
                ))}
              </ul>
            ) : statsLoading ? (
              <p className="text-sm text-neutral-500">Loading contacts…</p>
            ) : statsError ? (
              <p className="text-sm text-red-400">{statsError}</p>
            ) : (
              <p className="text-sm text-neutral-500">No contacts found in the selected range.</p>
            )}

            <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 p-4 text-xs text-neutral-500">
              <p className="font-semibold text-neutral-300">Ideas to explore</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-neutral-400">
                <li>Search by phone number or email to inspect a single thread.</li>
                <li>Use NEAR queries to surface conversations around a trip or event.</li>
                <li>Filter by date range to understand messaging cadence over time.</li>
              </ul>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}
