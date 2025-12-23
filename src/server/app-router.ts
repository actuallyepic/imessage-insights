import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getConversationStats } from "@/lib/imessage/queries";
import { getDbErrorInfo } from "@/lib/imessage/db-errors";
import { serializeConversationStats } from "@/lib/imessage/serialization";
import { router, publicProcedure } from "./trpc";

const statsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(40),
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional(),
});

const statsRouter = router({
  summary: publicProcedure.input(statsInputSchema).query(({ input }) => {
    try {
      const stats = getConversationStats({
        limit: input.limit,
        dateRange: {
          start: input.start ? new Date(input.start) : undefined,
          end: input.end ? new Date(input.end) : undefined,
        },
      });

      return serializeConversationStats(stats);
    } catch (error) {
      const info = getDbErrorInfo(error);
      if (info.kind === "permission") {
        throw new TRPCError({ code: "FORBIDDEN", message: info.message });
      }
      if (info.kind === "missing") {
        throw new TRPCError({ code: "NOT_FOUND", message: info.message });
      }

      console.error("Stats router error:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: info.message,
      });
    }
  }),
});

export const appRouter = router({
  stats: statsRouter,
});

export type AppRouter = typeof appRouter;
