export const SESSION_GAP_SECONDS = 6 * 60 * 60; // 6 hours
export const REPLY_WINDOW_SECONDS = 24 * 60 * 60; // 24 hours

// Backwards-compatible aliases (older UI + queries)
export const CONVERSATION_GAP_SECONDS = SESSION_GAP_SECONDS;
export const GHOST_RESPONSE_THRESHOLD_SECONDS = REPLY_WINDOW_SECONDS;
