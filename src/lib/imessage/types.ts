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

export interface ConversationStats {
  topChats: ChatSummary[];
  participantBreakdown: ChatParticipantStats[];
  dailyCounts: DailyCount[];
  hourlyCounts: HourlyCount[];
  weekdayCounts: WeekdayCount[];
}
