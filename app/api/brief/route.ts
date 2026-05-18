import { NextResponse } from "next/server";
import { patchState } from "@/lib/store";
import type { Brief } from "@/lib/types";
import { buildExpansions, id, splitTerms } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json();
  const partial = {
    role_titles: splitTerms(body.role_titles),
    current_companies: splitTerms(body.current_companies),
    past_companies: splitTerms(body.past_companies),
    keywords: splitTerms(body.keywords ?? body.domains),
    domains: splitTerms(body.keywords ?? body.domains),
    locations: splitTerms(body.locations),
    education: splitTerms(body.education),
    intent_terms: splitTerms(body.intent_terms),
    exclusions: splitTerms(body.exclusions),
    jd_text: String(body.jd_text ?? "")
  };
  const brief: Brief = {
    id: body.id ?? id("brief"),
    ...partial,
    expansions: buildExpansions(partial),
    created_at: body.created_at ?? new Date().toISOString()
  };
  const state = await patchState({ brief, status: { currentStep: 3 } as never }, "Brief saved and expansions prepared.");
  return NextResponse.json(state);
}
