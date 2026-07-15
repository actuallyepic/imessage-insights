"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  EmptyNote,
  ErrorBanner,
  Panel,
  PanelSubtitle,
  PanelTitle,
} from "@/components/ui/primitives";
import { SearchIcon } from "@/components/ui/icons";
import { chatLabel, formatDateTime } from "@/lib/format";
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

function buildChatLabel(chat: SerializableChatSummary) {
  const label = chatLabel(chat);
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
        : ((json?.error as { message?: string } | undefined)?.message ?? "Unable to search messages.");
    throw new Error(message);
  }
  return json.data ?? [];
}

/** Bordered control shell shared by the query box and the selects. */
const CONTROL =
  "flex items-center gap-2 rounded-[11px] border border-line-control bg-elevated px-[13px] py-2.5 text-xs";

/** A toggle chip that tints itself when active ("✓ Sent" / "✓ Received"). */
function FilterChip({
  active,
  onToggle,
  rgb,
  activeClass,
  children,
}: {
  active: boolean;
  onToggle: () => void;
  /** Raw "r,g,b" so the chip can compose its own alpha stops. */
  rgb: string;
  activeClass: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={`flex cursor-pointer items-center gap-2 rounded-[11px] border px-[13px] py-2.5 text-xs font-semibold transition-colors ${
        active ? activeClass : "border-line-control bg-elevated text-ink-dim hover:text-ink-secondary"
      }`}
      style={
        active
          ? { borderColor: `rgba(${rgb},0.4)`, backgroundColor: `rgba(${rgb},0.1)` }
          : undefined
      }
    >
      <span aria-hidden>{active ? "✓" : "○"}</span>
      {children}
    </button>
  );
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
    <Panel delay={0.46} className="rounded-[20px] px-[22px] py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PanelTitle>Search</PanelTitle>
          <PanelSubtitle>Full-text · filter by sender, chat, and match style</PanelSubtitle>
        </div>
        <div className="flex items-center gap-2">
          <label className={`${CONTROL} text-ink-muted`}>
            <span>Range</span>
            <select
              aria-label="Search range"
              value={rangeMode}
              onChange={(event) => setRangeMode(event.target.value as SearchRangeMode)}
              className="cursor-pointer bg-transparent font-semibold text-ink-secondary outline-none"
            >
              <option value="view">This view</option>
              <option value="all">All time</option>
            </select>
          </label>
          {searchQuery.isFetching ? (
            <span className="rounded-[7px] border border-line-control px-2.5 py-[3px] font-mono text-[11px] text-ink-faint">
              Searching…
            </span>
          ) : searchQuery.data ? (
            <span className="rounded-[7px] border border-line-control px-2.5 py-[3px] font-mono text-[11px] text-ink-faint">
              {results.length} result{results.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap gap-2.5">
        <div className={`${CONTROL} min-w-[200px] flex-1`}>
          <SearchIcon color="var(--ink-faint)" size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search text…"
            aria-label="Search query"
            className="w-full bg-transparent text-[13px] text-ink-secondary outline-none placeholder:text-ink-ghost"
          />
        </div>

        <label className={`${CONTROL} text-ink-muted`}>
          <span>Match</span>
          <select
            aria-label="Match mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as MessageSearchMode)}
            className="cursor-pointer bg-transparent font-semibold text-ink-secondary outline-none"
          >
            <option value="smart">Smart</option>
            <option value="fuzzy">Fuzzy</option>
            <option value="phrase">Phrase</option>
            <option value="contains">Contains</option>
            <option value="exact">Exact</option>
          </select>
        </label>

        <label className={`${CONTROL} max-w-[220px] text-ink-muted`}>
          <span>Chat</span>
          <select
            aria-label="Chat filter"
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
            className="min-w-0 cursor-pointer bg-transparent font-semibold text-ink-secondary outline-none"
          >
            {chatOptions.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <FilterChip
          active={includeSent}
          onToggle={() => setIncludeSent((value) => !value)}
          rgb="52,211,153"
          activeClass="text-accent-soft"
        >
          Sent
        </FilterChip>
        <FilterChip
          active={includeReceived}
          onToggle={() => setIncludeReceived((value) => !value)}
          rgb="56,189,248"
          activeClass="text-sky-soft"
        >
          Received
        </FilterChip>
      </div>

      <div className="mt-2.5">
        <input
          value={sender}
          onChange={(event) => setSender(event.target.value)}
          placeholder="Sender — name, number, or email…"
          aria-label="Sender filter"
          disabled={!includeReceived}
          className={`${CONTROL} w-full text-[13px] text-ink-secondary outline-none placeholder:text-ink-ghost disabled:cursor-not-allowed disabled:opacity-60`}
        />
        <p className="mt-1.5 text-[11px] text-ink-ghost">
          Matches incoming senders by handle, and by display name when available. Turn on “Received” to use this
          filter.
        </p>
      </div>

      {searchQuery.error ? (
        <div className="mt-3.5">
          <ErrorBanner title="Search failed" detail={(searchQuery.error as Error).message} />
        </div>
      ) : null}

      {!canSearch ? (
        <div className="mt-3.5 rounded-[13px] border border-dashed border-line-panel bg-inset p-6 text-center">
          <EmptyNote>Add a query, sender, or chat filter to start searching.</EmptyNote>
        </div>
      ) : (
        <div className="mt-3.5 flex flex-col gap-2.5">
          {searchQuery.isPending ? (
            Array.from({ length: 3 }).map((_, index) => (
              <div
                key={`search-skel-${index}`}
                className="rounded-[13px] border border-line-subtle bg-inset p-[15px]"
              >
                <div className="h-3 w-56 animate-pulse rounded bg-track" />
                <div className="mt-2 h-3 w-80 animate-pulse rounded bg-track" />
                <div className="mt-3 h-3 w-40 animate-pulse rounded bg-track" />
              </div>
            ))
          ) : results.length === 0 ? (
            <div className="rounded-[13px] border border-dashed border-line-panel bg-inset p-6 text-center">
              <EmptyNote>No matches.</EmptyNote>
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2.5">
                {results.map((message) => {
                  const chatLabel =
                    message.chatDisplayName ??
                    (message.participants.length > 0
                      ? message.participants.join(", ")
                      : `Chat ${message.chatId}`);
                  const senderLabel = message.senderDisplayName ?? (message.isFromMe ? "You" : "Unknown");
                  return (
                    <li
                      key={message.messageId}
                      className="rounded-[13px] border border-line-subtle bg-inset px-[15px] py-[13px]"
                    >
                      <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
                        <span className="rounded-[5px] border border-line-control px-1.5 py-px font-mono text-ink-ghost">
                          #{message.messageId}
                        </span>
                        <span className={`font-semibold ${message.isFromMe ? "text-accent" : "text-sky"}`}>
                          {senderLabel}
                        </span>
                        <span aria-hidden className="text-ink-ghost">
                          •
                        </span>
                        <span className="text-ink-faint">{formatDateTime(message.sentAt)}</span>
                        {message.senderHandle && !message.isFromMe ? (
                          <span className="ml-auto truncate text-ink-ghost">{message.senderHandle}</span>
                        ) : null}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-[13px] leading-[1.5] text-ink-secondary">
                        {message.text ?? <span className="text-ink-ghost">(no text)</span>}
                      </p>
                      <p className="mt-2 truncate text-[11px] text-ink-ghost">{chatLabel}</p>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-1.5 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  disabled={page === 0 || searchQuery.isFetching}
                  className="cursor-pointer rounded-[11px] border border-line-control bg-surface px-4 py-2 text-xs font-semibold text-ink-secondary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="font-mono text-[11px] text-ink-faint">Page {page + 1}</span>
                <button
                  type="button"
                  onClick={() => setPage((value) => value + 1)}
                  disabled={!hasMore || searchQuery.isFetching}
                  className="cursor-pointer rounded-[11px] border border-line-control bg-surface px-4 py-2 text-xs font-semibold text-ink-secondary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
