import { NextResponse } from "next/server";
import { getState, patchState } from "@/lib/store";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const state = await getState();
  const promptOverrides = {
    ...state.promptOverrides,
    queryGeneration: typeof body.queryGeneration === "string" ? body.queryGeneration : state.promptOverrides.queryGeneration,
    scoring: typeof body.scoring === "string" ? body.scoring : state.promptOverrides.scoring
  };
  const next = await patchState({ promptOverrides }, "Prompt overrides saved.");
  return NextResponse.json(next);
}
