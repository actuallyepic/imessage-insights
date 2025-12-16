export type AppleTimestamp = number | null;

export interface DateRange {
  start?: Date;
  end?: Date;
}

export interface SearchOptions {
  query?: string;
  mode?: MessageSearchMode;
  sender?: string;
  chatId?: number;
  limit?: number;
  offset?: number;
  includeFromMe?: boolean;
  includeFromOthers?: boolean;
  dateRange?: DateRange;
}

export type MessageSearchMode = "smart" | "fuzzy" | "phrase" | "contains" | "exact";

export interface SearchResultMessage {
  messageId: number;
  chatId: number;
  chatDisplayName: string | null;
  participants: string[];
  senderId: string | null;
  senderDisplayName: string | null;
  senderHandle: string | null;
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

export interface GhostingStats {
  iGhosted: number;
  theyGhostedMe: number;
}

export interface SessionStarterStats {
  startedByMe: number;
  startedByOthers: number;
}

export type ConversationInitiationStats = SessionStarterStats;

export interface UnansweredStarterStats {
  youLeftThemHanging: number;
  theyLeftYouHanging: number;
}

export interface DoubleTextStats {
  youDoubleTexted: number;
  theyDoubleTexted: number;
}

export interface ResponseDirectionStats {
  averageSeconds: number | null;
  medianSeconds: number | null;
  p90Seconds: number | null;
  minSeconds: number | null;
  maxSeconds: number | null;
  sampleCount: number;
}

export interface ResponseStats {
  meResponding: ResponseDirectionStats;
  themResponding: ResponseDirectionStats;
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
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  sessionStarters: SessionStarterStats;
  unansweredStarters: UnansweredStarterStats;
  doubleTexts: DoubleTextStats;
  firstReplyTimes: ResponseStats;
  inThreadReplyTimes: ResponseStats;
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
  earliestMessageAt: Date | null;
  latestMessageAt: Date | null;
  sessionStarters: SessionStarterStats;
  unansweredStarters: UnansweredStarterStats;
  doubleTexts: DoubleTextStats;
  firstReplyTimes: ResponseStats;
  inThreadReplyTimes: ResponseStats;
}

export type SerializableChatSummary = Omit<ChatSummary, "lastMessageAt" | "firstMessageAt"> & {
  firstMessageAt: string | null;
  lastMessageAt: string | null;
};

export type SerializableDailyCount = Omit<DailyCount, "date"> & {
  date: string;
};

export type SerializableConversationStats = Omit<
  ConversationStats,
  "topChats" | "dailyCounts" | "latestMessageAt" | "earliestMessageAt"
> & {
  topChats: SerializableChatSummary[];
  dailyCounts: SerializableDailyCount[];
  latestMessageAt: string | null;
  earliestMessageAt: string | null;
};
