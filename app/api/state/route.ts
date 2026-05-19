import { NextResponse } from "next/server";
import { DEFAULT_STATE } from "@/lib/defaults";
import { getState, patchState, saveState } from "@/lib/store";
import type { AppState } from "@/lib/types";

function stateWeight(value: AppState) {
  return [
    value.brief ? 25 : 0,
    value.queries?.length ?? 0,
    value.serpResults?.length ?? 0,
    value.rejectedSerpResults?.length ?? 0,
    (value.candidates?.length ?? 0) * 2,
    value.rawSerpRuns?.length ?? 0,
    value.intentEvidenceSources?.length ?? 0,
    value.oneClick?.candidates?.length ?? 0
  ].reduce((sum, item) => sum + item, 0);
}

function stateTime(value: AppState) {
  return Date.parse(value.status?.lastUpdated ?? "") || 0;
}

export async function GET() {
  return NextResponse.json(await getState());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body.state && typeof body.state === "object") {
    const current = await getState();
    const incoming = body.state as AppState;
    const currentWeight = stateWeight(current);
    const incomingWeight = stateWeight(incoming);
    if (currentWeight > incomingWeight || (currentWeight === incomingWeight && stateTime(current) > stateTime(incoming))) {
      return NextResponse.json(current);
    }
    const restored = await saveState({
      ...DEFAULT_STATE,
      ...incoming,
      status: {
        ...DEFAULT_STATE.status,
        ...(incoming.status ?? {}),
        errors: [],
        messages: ["Workflow restored from browser backup.", ...(incoming.status?.messages ?? [])].slice(0, 50)
      }
    });
    return NextResponse.json(restored);
  }
  if (body.clearErrors) {
    return NextResponse.json(await patchState({ status: { errors: [] } as never }));
  }
  if (body.resetRunningFlags) {
    return NextResponse.json(await patchState({ status: { running: "idle", activeAction: "", errors: [] } as never }));
  }
  return NextResponse.json(await getState());
}

export async function DELETE() {
  const state = await saveState(DEFAULT_STATE);
  return NextResponse.json(state);
}
