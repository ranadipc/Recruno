import { NextResponse } from "next/server";
import { getState, saveState } from "@/lib/store";
import { DEFAULT_STATE } from "@/lib/defaults";
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
  const previous = await getState();
  const state = await saveState({
    ...DEFAULT_STATE,
    brief,
    promptOverrides: previous.promptOverrides,
    apolloTierSelection: previous.apolloTierSelection,
    status: {
      ...DEFAULT_STATE.status,
      currentStep: 3,
      messages: ["Brief saved. Previous workflow data cleared for this new JD."],
      errors: []
    }
  });
  return NextResponse.json(state);
}
