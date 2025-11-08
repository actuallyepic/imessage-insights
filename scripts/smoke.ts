import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ConversationStats,
  SearchResultMessage,
} from "../src/lib/imessage/types";
import { createMockDb } from "./mock-db";

async function loadQueries() {
  const moduleUrl = new URL("../src/lib/imessage/queries.ts", import.meta.url);
  return import(moduleUrl.href);
}

async function loadDb() {
  const moduleUrl = new URL("../src/lib/imessage/db.ts", import.meta.url);
  return import(moduleUrl.href);
}

async function main() {
  const [{ getConversationStats, searchMessages }, { closeDatabase }] = await Promise.all([
    loadQueries(),
    loadDb(),
  ]);

  const args = process.argv.slice(2);
  const useRealDb = args.includes("--real") || process.env.SMOKE_USE_REAL_DB === "1";

  let dispose = () => {};

  if (useRealDb) {
    const envPath = process.env.IMESSAGE_DB_PATH;
    const dbPath = envPath
      ? path.resolve(envPath)
      : path.join(os.homedir(), "Library", "Messages", "chat.db");

    if (!fs.existsSync(dbPath)) {
      throw new Error(
        `Could not find Messages database at ${dbPath}. Set IMESSAGE_DB_PATH or remove --real.`,
      );
    }

    process.env.IMESSAGE_DB_PATH = dbPath;
    console.log(`Using real Messages database at ${dbPath} (read-only query mode).`);
  } else {
    const mock = createMockDb();
    process.env.IMESSAGE_DB_PATH = mock.dbPath;
    dispose = mock.dispose;
    console.log(`Using mock database located at ${mock.dbPath}.`);
  }

  try {
    console.log("Running search for 'dinner'...");
    const searchResults = searchMessages({ query: "dinner" });
    if (useRealDb) {
      const firstMessages = searchResults.slice(0, 3).map((message: SearchResultMessage) => ({
        messageId: message.messageId,
        chatId: message.chatId,
        fromMe: message.isFromMe,
        sentAt: message.sentAt,
      }));
      console.log(
        `Found ${searchResults.length} messages. Sample: ${JSON.stringify(firstMessages, null, 2)}`,
      );
    } else {
      console.log(JSON.stringify(searchResults, null, 2));
    }

    console.log("Running stats summary...");
    const stats: ConversationStats = getConversationStats({ limit: 5 });
    if (useRealDb) {
      console.log(
        JSON.stringify(
          {
            topChats: stats.topChats
              .slice(0, 3)
              .map((chat: ConversationStats["topChats"][number]) => ({
              chatId: chat.chatId,
              displayName: chat.chatDisplayName ?? null,
              isGroup: chat.isGroup,
              messageCount: chat.messageCount,
              lastMessageAt: chat.lastMessageAt,
            })),
            topContact: stats.participantBreakdown[0],
            dailySample: stats.dailyCounts.slice(0, 3),
            hourlySample: stats.hourlyCounts.slice(0, 3),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(JSON.stringify(stats, null, 2));
    }
  } finally {
    closeDatabase();
    dispose();
  }
}

main().catch((error) => {
  console.error("Smoke script failed:", error);
  process.exitCode = 1;
});
