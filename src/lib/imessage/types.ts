export type AppleTimestamp = number | null;

export interface DateRange {
  start?: Date;
  end?: Date;
}

export interface SearchOptions {
  query: string;
  chatId?: number;
  limit?: number;
  offset?: number;
  includeFromMe?: boolean;
  includeFromOthers?: boolean;
  dateRange?: DateRange;
}

export interface SearchResultMessage {
  messageId: number;
  chatId: number;
  chatDisplayName: string | null;
  participants: string[];
  text: string | null;
  isFromMe: boolean;
  sentAt: Date | null;
}

export interface ChatParticipantStats {
  id: string | null;
  displayName: string | null;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  isMe?: boolean;
}

export const REACTION_TYPES = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;

export type ReactionType = (typeof REACTION_TYPES)[number];

export interface ReactionCountSummary {
  reactionCount: number;
  sentCount: number;
  receivedCount: number;
}

export type ReactionBreakdown = Record<ReactionType, ReactionCountSummary>;

export interface ReactionTotals extends ReactionCountSummary {
  byType: ReactionBreakdown;
}

export interface AttachmentTopSender {
  id: string | null;
  displayName: string | null;
  count: number;
  isMe: boolean;
}

export interface AttachmentStats {
  totalCount: number;
  sentCount: number;
  receivedCount: number;
  topSender: AttachmentTopSender | null;
}

export interface ChatReactionParticipantStats {
  id: string;
  displayName: string | null;
  reactionCount: number;
  isMe: boolean;
}

export interface ChatSummary {
  chatId: number;
  chatDisplayName: string | null;
  isGroup: boolean;
  participants: string[];
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  lastMessageAt: Date | null;
  reactions: ReactionTotals;
  reactionParticipants: ChatReactionParticipantStats[];
  messageParticipants: ChatParticipantStats[];
}

export interface DailyCount {
  date: Date;
  sentCount: number;
  receivedCount: number;
}

export interface HourlyCount {
  hour: number;
  sentCount: number;
  receivedCount: number;
}

export interface WeekdayCount {
  weekday: number;
  sentCount: number;
  receivedCount: number;
}

export interface MessageTotals {
  messageCount: number;
  sentCount: number;
  receivedCount: number;
}

export interface ConversationStats {
  topChats: ChatSummary[];
  participantBreakdown: ChatParticipantStats[];
  dailyCounts: DailyCount[];
  hourlyCounts: HourlyCount[];
  weekdayCounts: WeekdayCount[];
  totals: MessageTotals;
  reactionTotals: ReactionTotals;
  attachmentStats: AttachmentStats;
  latestMessageAt: Date | null;
}
