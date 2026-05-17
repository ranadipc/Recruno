import { NextResponse } from "next/server";
import { getState, patchState } from "@/lib/store";
import type { Candidate } from "@/lib/types";

export async function POST(request: Request) {
  const body = await request.json();
  const state = await getState();
  let candidates = state.candidates;
  if (Array.isArray(body.candidates)) {
    candidates = body.candidates;
  } else if (body.id) {
    candidates = state.candidates.map((candidate) =>
      candidate.id === body.id ? ({ ...candidate, ...body.patch } as Candidate) : candidate
    );
  }
  const next = await patchState({ candidates }, "Candidate edits saved.");
  return NextResponse.json(next);
}
