import { NextResponse } from "next/server";
import { patchState } from "@/lib/store";
import type { Query } from "@/lib/types";
import { id } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json();
  const queries: Query[] = (body.queries ?? []).map((query: Query) => ({
    ...query,
    id: query.id || id("qry"),
    expected_filters: query.expected_filters ?? [],
    selected: Boolean(query.selected)
  }));
  const state = await patchState({ queries, status: { currentStep: 4 } as never }, "Query edits saved.");
  return NextResponse.json(state);
}
