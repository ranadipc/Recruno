import { NextResponse } from "next/server";
import { DEFAULT_STATE } from "@/lib/defaults";
import { getState, patchState, saveState } from "@/lib/store";

export async function GET() {
  return NextResponse.json(await getState());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body.state && typeof body.state === "object") {
    const restored = await saveState({
      ...DEFAULT_STATE,
      ...body.state,
      status: {
        ...DEFAULT_STATE.status,
        ...(body.state.status ?? {}),
        errors: [],
        messages: ["Workflow restored from browser backup.", ...(body.state.status?.messages ?? [])].slice(0, 50)
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
