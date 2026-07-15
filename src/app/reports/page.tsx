import Link from "next/link";

import { AppShell, PageHeader } from "@/components/app-shell";
import { Avatar, EmptyNote, ErrorBanner, Panel, PanelLabel } from "@/components/ui/primitives";
import { chatLabel, formatCount, formatDateTime } from "@/lib/format";
import { getConversationStats } from "@/lib/imessage/queries";
import type { ChatSummary } from "@/lib/imessage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function isAuthorizationError(error: unknown) {
  return error instanceof Error && /authorization denied/i.test(error.message);
}

function Tag({ children, tone }: { children: React.ReactNode; tone: "group" | "direct" }) {
  return (
    <span
      className="inline-flex flex-none items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em]"
      style={{
        color: tone === "group" ? "var(--violet)" : "var(--sky)",
        backgroundColor: tone === "group" ? "rgba(167,139,250,0.14)" : "rgba(56,189,248,0.14)",
      }}
    >
      {children}
    </span>
  );
}

function ChatRow({ chat, delay }: { chat: ChatSummary; delay: number }) {
  const title = chatLabel(chat);
  const memberCount = chat.participants.length;

  return (
    <Link href={`/reports/${chat.chatId}`} className="block">
      <Panel
        delay={delay}
        className="rounded-[14px] px-4 py-3.5 transition-colors hover:bg-surface-hover"
      >
        <div className="flex items-center gap-3.5">
          <Avatar label={title} identityKey={String(chat.chatId)} size={34} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold text-ink">{title}</span>
              <Tag tone={chat.isGroup ? "group" : "direct"}>{chat.isGroup ? "Group" : "Direct"}</Tag>
            </div>
            <p className="mt-1 truncate text-[11px] text-ink-faint">
              {memberCount > 0
                ? `${formatCount(memberCount)} ${memberCount === 1 ? "participant" : "participants"}`
                : "No participants detected"}
              {chat.lastMessageAt ? ` · Last active ${formatDateTime(chat.lastMessageAt)}` : ""}
            </p>
          </div>

          <div className="flex flex-none items-center gap-3.5">
            <div className="text-right">
              <p className="text-[13px] font-semibold text-ink">{formatCount(chat.messageCount)}</p>
              <p className="text-[10px] text-ink-ghost">messages</p>
            </div>
            <span aria-hidden className="text-ink-ghost">
              →
            </span>
          </div>
        </div>
      </Panel>
    </Link>
  );
}

export default async function ReportsIndexPage() {
  let topChats: ChatSummary[];
  try {
    topChats = getConversationStats({ limit: 50 }).topChats;
  } catch (error) {
    if (isAuthorizationError(error)) {
      return (
        <AppShell>
          <PageHeader title="Reports" subtitle="Per-chat breakdowns built from your local Messages history." />
          <ErrorBanner
            title="macOS denied access to the Messages database"
            detail="Grant Terminal full disk access in System Settings › Privacy & Security, then reload this page."
          />
        </AppShell>
      );
    }
    throw error;
  }

  return (
    <AppShell>
      <PageHeader
        title="Reports"
        subtitle="A shareable breakdown for each conversation — volume, tone, contributors and reactions."
      />

      <Panel className="rounded-[18px] p-[18px]">
        <div className="flex items-center justify-between gap-3">
          <PanelLabel>Conversations</PanelLabel>
          <span className="text-[11px] text-ink-faint">
            {topChats.length > 0 ? `${formatCount(topChats.length)} by message volume` : "All time"}
          </span>
        </div>

        {topChats.length === 0 ? (
          <EmptyNote className="mt-4">
            No conversations found in your Messages database yet. Once you have chat history, each one gets a report
            here.
          </EmptyNote>
        ) : (
          <div className="mt-4 flex flex-col gap-2.5">
            {topChats.map((chat, index) => (
              <ChatRow key={chat.chatId} chat={chat} delay={Math.min(index * 0.03, 0.4)} />
            ))}
          </div>
        )}
      </Panel>
    </AppShell>
  );
}
