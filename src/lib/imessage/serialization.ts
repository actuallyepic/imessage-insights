import type {
  ConversationStats,
  SerializableConversationStats,
} from "./types";

export function serializeConversationStats(stats: ConversationStats): SerializableConversationStats {
  return {
    ...stats,
    earliestMessageAt: stats.earliestMessageAt?.toISOString() ?? null,
    latestMessageAt: stats.latestMessageAt?.toISOString() ?? null,
    dailyCounts: stats.dailyCounts.map((bucket) => ({
      ...bucket,
      date: bucket.date.toISOString(),
    })),
    topChats: stats.topChats.map((chat) => ({
      ...chat,
      firstMessageAt: chat.firstMessageAt?.toISOString() ?? null,
      lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
    })),
  };
}
