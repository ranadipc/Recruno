import { NextResponse } from "next/server";
import { generateQueries } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const state = await getState();
    if (!state.brief) return NextResponse.json({ error: "Save a brief first." }, { status: 400 });
    const settings = await getSettings();
    const queries = await generateQueries(settings, state.brief, typeof body.promptOverride === "string" ? body.promptOverride : undefined);
    const next = await patchState({ queries, status: { currentStep: 4, errors: [] } as never }, `${queries.length} queries generated.`);
    return NextResponse.json(next);
  } catch (error) {
    const state = await patchState({ status: { errors: [error instanceof Error ? error.message : "Query generation failed."] } as never });
    return NextResponse.json(state, { status: 400 });
  }
}
