export interface DateRange {
  start?: Date;
  end?: Date;
}

export type CallServiceProvider = "com.apple.FaceTime" | "com.apple.Telephony" | (string & {});

export type CallProvider = "facetime" | "telephony" | "unknown";
export type CallMedia = "audio" | "video" | "unknown";
export type CallDirection = "incoming" | "outgoing" | "unknown";
export type CallOutcome = "answered" | "missed" | "unanswered" | "unknown";

export interface CallParticipant {
  id?: string | null;
  handle: string;
  displayName: string | null;
}

export interface CallRecord {
  callId: number;
  startedAt: Date | null;
  durationSeconds: number;
  provider: CallProvider;
  serviceProvider: string | null;
  media: CallMedia;
  direction: CallDirection;
  outcome: CallOutcome;
  answered: boolean;
  outgoing: boolean;
  address: string | null;
  name: string | null;
  participants: CallParticipant[];
}

export interface CallQueryOptions {
  limit?: number;
  offset?: number;
  dateRange?: DateRange;
  provider?: CallProvider;
  media?: CallMedia;
  direction?: CallDirection;
  answered?: boolean;
}
