import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getConversationStats } from "@/lib/imessage/queries";
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
      if (error instanceof Error && /authorization denied/i.test(error.message)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "macOS denied access to the Messages database. Grant Terminal full disk access and try again.",
        });
      }

      console.error("Stats router error:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unexpected error while retrieving stats.",
      });
    }
  }),
});

export const appRouter = router({
  stats: statsRouter,
});

export type AppRouter = typeof appRouter;
