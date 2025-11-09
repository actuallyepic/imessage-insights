import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLE_EPOCH_OFFSET = 978307200;

function toAppleTimestamp(date: Date): number {
  const secondsSinceUnixEpoch = date.getTime() / 1000;
  const appleSeconds = secondsSinceUnixEpoch - APPLE_EPOCH_OFFSET;
  return Math.round(appleSeconds * 1_000_000_000);
}

export interface MockMessage {
  guid: string;
  chatGuid: string;
  handleId: string | null;
  text: string;
  isFromMe: boolean;
  sentAt: Date;
  associatedMessageGuid?: string | null;
  associatedMessageType?: number | null;
  attachments?: MockAttachment[];
}

export interface MockAttachment {
  filename: string;
  mimeType: string;
  totalBytes?: number;
}

export interface MockChat {
  guid: string;
  displayName: string | null;
  handleIds: string[];
}

const DEFAULT_HANDLES: Record<string, { id: string; displayName?: string | null }> = {
  "+15555550100": { id: "+15555550100", displayName: "Alex" },
  "+15555550101": { id: "+15555550101", displayName: "Blake" },
  "me@icloud.com": { id: "me@icloud.com", displayName: "Me" },
};

const DEFAULT_CHATS: MockChat[] = [
  {
    guid: "chat1",
    displayName: "Weekend Plans",
    handleIds: ["+15555550100", "+15555550101"],
  },
  {
    guid: "chat2",
    displayName: null,
    handleIds: ["+15555550100"],
  },
];

const DEFAULT_MESSAGES: MockMessage[] = [
  {
    guid: "msg-1",
    chatGuid: "chat1",
    handleId: "+15555550100",
    text: "Are we still on for dinner tonight?",
    isFromMe: false,
    sentAt: new Date("2024-08-01T18:30:00Z"),
  },
  {
    guid: "msg-2",
    chatGuid: "chat1",
    handleId: null,
    text: "Yes! 7pm at the usual spot.",
    isFromMe: true,
    sentAt: new Date("2024-08-01T18:31:00Z"),
  },
  {
    guid: "msg-3",
    chatGuid: "chat2",
    handleId: "+15555550100",
    text: "Happy birthday! 🎉",
    isFromMe: false,
    sentAt: new Date("2024-07-15T15:00:00Z"),
  },
  {
    guid: "msg-4",
    chatGuid: "chat2",
    handleId: null,
    text: "Thank you! Appreciate it.",
    isFromMe: true,
    sentAt: new Date("2024-07-15T15:02:00Z"),
  },
  {
    guid: "msg-5",
    chatGuid: "chat1",
    handleId: "+15555550101",
    text: "Loved “Yes! 7pm at the usual spot.”",
    isFromMe: false,
    sentAt: new Date("2024-08-01T18:31:30Z"),
    associatedMessageGuid: "msg-2",
    associatedMessageType: 2000,
  },
  {
    guid: "msg-6",
    chatGuid: "chat1",
    handleId: null,
    text: "Liked “Are we still on for dinner tonight?”",
    isFromMe: true,
    sentAt: new Date("2024-08-01T18:32:00Z"),
    associatedMessageGuid: "msg-1",
    associatedMessageType: 2001,
  },
  {
    guid: "msg-7",
    chatGuid: "chat1",
    handleId: "+15555550100",
    text: "Dropping the photos from the hike.",
    isFromMe: false,
    sentAt: new Date("2024-08-02T14:00:00Z"),
    attachments: [
      {
        filename: "hike-photo.jpg",
        mimeType: "image/jpeg",
        totalBytes: 512_000,
      },
    ],
  },
  {
    guid: "msg-8",
    chatGuid: "chat1",
    handleId: null,
    text: "Here’s the packing list and playlist.",
    isFromMe: true,
    sentAt: new Date("2024-08-02T14:05:00Z"),
    attachments: [
      {
        filename: "packing-list.pdf",
        mimeType: "application/pdf",
        totalBytes: 204_800,
      },
      {
        filename: "mix.aac",
        mimeType: "audio/aac",
        totalBytes: 102_400,
      },
    ],
  },
];

export interface CreateMockDbOptions {
  directory?: string;
  handles?: typeof DEFAULT_HANDLES;
  chats?: MockChat[];
  messages?: MockMessage[];
}

export function createMockDb(options: CreateMockDbOptions = {}): {
  dbPath: string;
  dispose: () => void;
} {
  const tmpDir =
    options.directory ??
    fs.mkdtempSync(path.join(os.tmpdir(), "imessage-insights-mock-"));
  const dbPath = path.join(tmpDir, "chat.db");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const handles = options.handles ?? DEFAULT_HANDLES;
  const chats = options.chats ?? DEFAULT_CHATS;
  const messages = options.messages ?? DEFAULT_MESSAGES;

  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY,
      id TEXT,
      country TEXT,
      service TEXT,
      uncanonicalized_id TEXT,
      person_centric_id TEXT,
      display_name TEXT
    );

    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      style INTEGER,
      chat_identifier TEXT,
      service_name TEXT,
      display_name TEXT
    );

    CREATE TABLE chat_handle_join (
      chat_id INTEGER,
      handle_id INTEGER,
      uncanonicalized_handle_id TEXT
    );

    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      handle_id INTEGER,
      text TEXT,
      service TEXT,
      account TEXT,
      account_guid TEXT,
      date INTEGER,
      date_read INTEGER,
      date_delivered INTEGER,
      is_from_me INTEGER,
      associated_message_guid TEXT,
      associated_message_type INTEGER,
      cache_has_attachments INTEGER DEFAULT 0
    );

    CREATE TABLE chat_message_join (
      chat_id INTEGER,
      message_id INTEGER,
      message_date INTEGER
    );

    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      created_date INTEGER,
      start_date INTEGER,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER,
      is_outgoing INTEGER
    );

    CREATE TABLE message_attachment_join (
      message_id INTEGER,
      attachment_id INTEGER
    );

    CREATE VIRTUAL TABLE message_fts USING fts5(text, content='message', content_rowid='ROWID');
  `);

  const insertHandle = db.prepare(`
    INSERT INTO handle (ROWID, id, display_name, service)
    VALUES (@rowId, @id, @displayName, 'iMessage')
  `);

  let handleRowId = 1;
  const handleRowIds: Record<string, number> = {};

  Object.values(handles).forEach((handle) => {
    const rowId = handleRowId++;
    insertHandle.run({
      rowId,
      id: handle.id,
      displayName: handle.displayName ?? null,
    });
    handleRowIds[handle.id] = rowId;
  });

  const insertChat = db.prepare(`
    INSERT INTO chat (ROWID, guid, display_name)
    VALUES (@rowId, @guid, @displayName)
  `);

  let chatRowId = 1;
  const chatRowIds: Record<string, number> = {};

  chats.forEach((chat) => {
    const rowId = chatRowId++;
    insertChat.run({
      rowId,
      guid: chat.guid,
      displayName: chat.displayName,
    });
    chatRowIds[chat.guid] = rowId;

    const joinStmt = db.prepare(
      `INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (@chatId, @handleId)`,
    );
    chat.handleIds.forEach((handleId) => {
      joinStmt.run({
        chatId: rowId,
        handleId: handleRowIds[handleId],
      });
    });
  });

  const insertMessage = db.prepare(`
    INSERT INTO message (
      ROWID,
      guid,
      handle_id,
      text,
      date,
      is_from_me,
      associated_message_guid,
      associated_message_type,
      cache_has_attachments
    )
    VALUES (
      @rowId,
      @guid,
      @handleId,
      @text,
      @date,
      @isFromMe,
      @associatedMessageGuid,
      @associatedMessageType,
      @cacheHasAttachments
    )
  `);

  const insertChatMessageJoin = db.prepare(`
    INSERT INTO chat_message_join (chat_id, message_id, message_date)
    VALUES (@chatId, @messageId, @messageDate)
  `);

  const insertFts = db.prepare(`
    INSERT INTO message_fts (rowid, text) VALUES (@rowId, @text)
  `);
  const insertAttachment = db.prepare(`
    INSERT INTO attachment (
      ROWID,
      guid,
      created_date,
      start_date,
      filename,
      mime_type,
      transfer_name,
      total_bytes,
      is_outgoing
    )
    VALUES (
      @rowId,
      @guid,
      @createdDate,
      @startDate,
      @filename,
      @mimeType,
      @transferName,
      @totalBytes,
      @isOutgoing
    )
  `);

  const insertMessageAttachmentJoin = db.prepare(`
    INSERT INTO message_attachment_join (message_id, attachment_id)
    VALUES (@messageId, @attachmentId)
  `);

  let messageRowId = 1;
  let attachmentRowId = 1;
  messages.forEach((message) => {
    const rowId = messageRowId++;
    const chatId = chatRowIds[message.chatGuid];
    if (!chatId) {
      throw new Error(`Unknown chat GUID: ${message.chatGuid}`);
    }
    const attachments = message.attachments ?? [];

    insertMessage.run({
      rowId,
      guid: message.guid,
      handleId: message.handleId ? handleRowIds[message.handleId] : null,
      text: message.text,
      date: toAppleTimestamp(message.sentAt),
      isFromMe: message.isFromMe ? 1 : 0,
      associatedMessageGuid: message.associatedMessageGuid ?? null,
      associatedMessageType: message.associatedMessageType ?? null,
      cacheHasAttachments: attachments.length > 0 ? 1 : 0,
    });

    insertChatMessageJoin.run({
      chatId,
      messageId: rowId,
      messageDate: toAppleTimestamp(message.sentAt),
    });

    insertFts.run({
      rowId,
      text: message.text,
    });

    if (attachments.length > 0) {
      attachments.forEach((attachment, index) => {
        const attachmentId = attachmentRowId++;
        const appleTimestamp = toAppleTimestamp(message.sentAt);
        insertAttachment.run({
          rowId: attachmentId,
          guid: `${message.guid}-attachment-${index + 1}`,
          createdDate: appleTimestamp,
          startDate: appleTimestamp,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          transferName: attachment.filename,
          totalBytes: attachment.totalBytes ?? 0,
          isOutgoing: message.isFromMe ? 1 : 0,
        });

        insertMessageAttachmentJoin.run({
          messageId: rowId,
          attachmentId,
        });
      });
    }
  });

  const dispose = () => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to remove mock db directory:", error);
    }
  };

  return { dbPath, dispose };
}
