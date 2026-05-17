import { NextResponse } from "next/server";
import { DEFAULT_STATE } from "@/lib/defaults";
import { getState, patchState, saveState } from "@/lib/store";

export async function GET() {
  return NextResponse.json(await getState());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body.clearErrors) {
    return NextResponse.json(await patchState({ status: { errors: [] } as never }));
  }
  return NextResponse.json(await getState());
}

export async function DELETE() {
  const state = await saveState(DEFAULT_STATE);
  return NextResponse.json(state);
}
