'use client';

import { useQuery } from "@tanstack/react-query";

import type { RouterInputs } from "@/lib/trpc/types";
import { useTRPC } from "@/utils/trpc";

type StatsSummaryInput = RouterInputs["stats"]["summary"];
type StatsSummaryQueryOptions = NonNullable<
  Parameters<ReturnType<typeof useTRPC>["stats"]["summary"]["queryOptions"]>[1]
>;

const defaultStatsQueryOptions: StatsSummaryQueryOptions = {
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
  retry: 1,
};

export function useStatsSummary(input: StatsSummaryInput, options?: StatsSummaryQueryOptions) {
  const trpc = useTRPC();
  return useQuery(
    trpc.stats.summary.queryOptions(input, {
      ...defaultStatsQueryOptions,
      ...options,
    }),
  );
}
