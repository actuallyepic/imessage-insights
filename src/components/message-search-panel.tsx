'use client';

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { MessageSearchMode, SerializableChatSummary } from "@/lib/imessage/types";

type SearchApiMessage = {
  messageId: number;
  chatId: number;
  chatDisplayName: string | null;
  participants: string[];
  senderId: string | null;
  senderDisplayName: string | null;
  senderHandle: string | null;
  text: string | null;
  isFromMe: boolean;
  sentAt: string | null;
};

type SearchRangeMode = "view" | "all";

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs, value]);

  return debounced;
}

function formatTimestamp(value: string | null) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function buildChatLabel(chat: SerializableChatSummary) {
  const label =
    chat.chatDisplayName ??
    (chat.participants.length > 0 ? chat.participants.join(", ") : null) ??
    `Chat ${chat.chatId}`;
  if (chat.isGroup) return `${label} (group)`;
  return label;
}

async function fetchSearchResults(params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  const res = await fetch(`/api/search?${sp.toString()}`, { credentials: "same-origin" });
  const json = (await res.json()) as { data?: SearchApiMessage[]; error?: unknown };
  if (!res.ok) {
    const message =
      typeof json?.error === "string"
        ? json.error
        : (json?.error as { message?: string } | undefined)?.message ??
          "Unable to search messages.";
    throw new Error(message);
  }
  return json.data ?? [];
}

export function MessageSearchPanel({
  rangeStart,
  rangeEnd,
  topChats,
}: {
  rangeStart?: string;
  rangeEnd?: string;
  topChats: SerializableChatSummary[];
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<MessageSearchMode>("smart");
  const [sender, setSender] = useState("");
  const [includeSent, setIncludeSent] = useState(true);
  const [includeReceived, setIncludeReceived] = useState(true);
  const [rangeMode, setRangeMode] = useState<SearchRangeMode>("view");
  const [chatId, setChatId] = useState<string>("");

  const debouncedQuery = useDebouncedValue(query, 350);
  const debouncedSender = useDebouncedValue(sender, 350);

  const pageKey = useMemo(() => {
    return JSON.stringify({
      q: debouncedQuery,
      s: debouncedSender,
      mode,
      sent: includeSent,
      received: includeReceived,
      range: rangeMode,
      chat: chatId,
    });
  }, [chatId, debouncedQuery, debouncedSender, includeReceived, includeSent, mode, rangeMode]);

  const [pageByKey, setPageByKey] = useState<Record<string, number>>({});
  const page = pageByKey[pageKey] ?? 0;

  const setPage = useCallback(
    (updater: number | ((value: number) => number)) => {
      setPageByKey((current) => {
        const existing = current[pageKey] ?? 0;
        const next = typeof updater === "function" ? updater(existing) : updater;
        if (next === existing) return current;
        return { ...current, [pageKey]: next };
      });
    },
    [pageKey],
  );

  const chatOptions = useMemo(() => {
    const options = topChats
      .slice(0, 30)
      .map((chat) => ({
        value: String(chat.chatId),
        label: buildChatLabel(chat),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return [{ value: "", label: "All chats" }, ...options];
  }, [topChats]);

  const limit = 50;
  const offset = page * limit;

  const trimmedQuery = debouncedQuery.trim();
  const trimmedSender = debouncedSender.trim();
  const trimmedChatId = chatId.trim();
  const effectiveSender = includeReceived ? trimmedSender : "";

  const canSearch =
    (includeSent || includeReceived) &&
    (trimmedQuery.length > 0 || effectiveSender.length > 0 || trimmedChatId.length > 0);

  const searchParams = useMemo(() => {
    if (!canSearch) return null;

    const params: Record<string, string> = {
      limit: String(limit),
      offset: String(offset),
      mode,
    };

    if (trimmedQuery) params.q = trimmedQuery;
    if (effectiveSender) params.sender = effectiveSender;
    if (trimmedChatId) params.chatId = trimmedChatId;
    params.fromMe = includeSent ? "true" : "false";
    params.fromOthers = includeReceived ? "true" : "false";

    if (rangeMode === "view") {
      if (rangeStart) params.start = rangeStart;
      if (rangeEnd) params.end = rangeEnd;
    }

    return params;
  }, [
    canSearch,
    includeReceived,
    includeSent,
    limit,
    mode,
    offset,
    rangeEnd,
    rangeMode,
    rangeStart,
    trimmedChatId,
    trimmedQuery,
    effectiveSender,
  ]);

  const searchQuery = useQuery({
    queryKey: ["message-search", searchParams],
    queryFn: () => fetchSearchResults(searchParams ?? {}),
    enabled: Boolean(searchParams),
    staleTime: 30_000,
    gcTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const results = searchQuery.data ?? [];
  const hasMore = results.length === limit;

  return (
    <section className="rounded-2xl border border-neutral-800/70 bg-neutral-900/40 p-6 shadow-lg shadow-black/30">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Search</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Filter by sender, sent/received, and match style.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          <label className="flex items-center gap-2 rounded-full border border-neutral-800/80 bg-neutral-950/40 px-3 py-1">
            <span className="text-neutral-500">Range</span>
            <select
              value={rangeMode}
              onChange={(event) => setRangeMode(event.target.value as SearchRangeMode)}
              className="bg-transparent text-neutral-200 outline-none"
            >
              <option value="view">This view</option>
              <option value="all">All time</option>
            </select>
          </label>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-12">
        <div className="lg:col-span-6">
          <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Query
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search text…"
              className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-500/30 transition focus:ring-2"
            />
          </label>
        </div>

        <div className="lg:col-span-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Match
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as MessageSearchMode)}
              className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-500/30 transition focus:ring-2"
            >
              <option value="smart">Smart</option>
              <option value="fuzzy">Fuzzy (any word)</option>
              <option value="phrase">Exact phrase</option>
              <option value="contains">Contains</option>
              <option value="exact">Exact message</option>
            </select>
          </label>
        </div>

        <div className="lg:col-span-3">
          <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Chat
            <select
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-500/30 transition focus:ring-2"
            >
              {chatOptions.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="lg:col-span-6">
          <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Sender (received)
            <input
              value={sender}
              onChange={(event) => setSender(event.target.value)}
              placeholder="Name / number / email…"
              className="mt-2 w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none ring-emerald-500/30 transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!includeReceived}
            />
          </label>
          <p className="mt-2 text-[11px] text-neutral-500">
            Matches incoming sender by handle (and display name when available). Turn on “Received” to use this filter.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3 lg:col-span-6">
          <label className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={includeSent}
              onChange={(event) => setIncludeSent(event.target.checked)}
              className="h-4 w-4 accent-emerald-400"
            />
            Sent
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={includeReceived}
              onChange={(event) => setIncludeReceived(event.target.checked)}
              className="h-4 w-4 accent-sky-400"
            />
            Received
          </label>

          <div className="ml-auto flex items-center gap-2 text-xs text-neutral-400">
            {searchQuery.isFetching ? (
              <span className="rounded-full border border-neutral-800/70 bg-neutral-950/40 px-3 py-1">
                Searching…
              </span>
            ) : searchQuery.data ? (
              <span className="rounded-full border border-neutral-800/70 bg-neutral-950/40 px-3 py-1">
                {results.length} result{results.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {searchQuery.error ? (
        <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
          {(searchQuery.error as Error).message}
        </div>
      ) : null}

      {!canSearch ? (
        <div className="mt-5 rounded-2xl border border-dashed border-neutral-800/80 bg-neutral-950/40 p-6 text-center text-sm text-neutral-400">
          Add a query, sender, or chat filter to start searching.
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {searchQuery.isPending ? (
            Array.from({ length: 5 }).map((_, index) => (
              <div
                key={`search-skel-${index}`}
                className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-4"
              >
                <div className="h-3 w-56 animate-pulse rounded bg-neutral-800/60" />
                <div className="mt-2 h-3 w-80 animate-pulse rounded bg-neutral-800/60" />
                <div className="mt-3 h-3 w-40 animate-pulse rounded bg-neutral-800/60" />
              </div>
            ))
          ) : results.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-800/80 bg-neutral-950/40 p-6 text-center text-sm text-neutral-400">
              No matches.
            </div>
          ) : (
            <>
              <ul className="space-y-3">
                {results.map((message) => {
                  const chatLabel =
                    message.chatDisplayName ??
                    (message.participants.length > 0 ? message.participants.join(", ") : `Chat ${message.chatId}`);
                  const senderLabel = message.senderDisplayName ?? (message.isFromMe ? "You" : "Unknown");
                  return (
                    <li
                      key={message.messageId}
                      className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-neutral-800/80 bg-neutral-950/60 px-2 py-0.5 text-[10px] font-semibold text-neutral-300">
                            #{message.messageId}
                          </span>
                          <span className={message.isFromMe ? "text-emerald-200" : "text-sky-200"}>
                            {senderLabel}
                          </span>
                          <span className="text-neutral-700">•</span>
                          <span>{formatTimestamp(message.sentAt)}</span>
                        </div>
                        {message.senderHandle && !message.isFromMe && (
                          <span className="truncate text-[11px] text-neutral-500">{message.senderHandle}</span>
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-100">
                        {message.text ?? <span className="text-neutral-500">(no text)</span>}
                      </p>
                      <p className="mt-3 truncate text-[11px] text-neutral-500">{chatLabel}</p>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  disabled={page === 0 || searchQuery.isFetching}
                  className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Previous
                </button>
                <span className="text-xs text-neutral-500">
                  Page {page + 1}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((value) => value + 1)}
                  disabled={!hasMore || searchQuery.isFetching}
                  className="rounded-full border border-neutral-800/80 bg-neutral-900/70 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-neutral-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
