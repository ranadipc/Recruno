import { NextResponse } from "next/server";
import { cleanCandidateFromResults } from "@/lib/utils";
import { getState, patchState } from "@/lib/store";

export async function POST() {
  const state = await getState();
  const cleaned = cleanCandidateFromResults(state.serpResults);
  const previousByUrl = new Map(state.candidates.map((candidate) => [candidate.normalized_linkedin_url, candidate]));
  const candidates = cleaned.candidates.map((candidate) => ({
    ...candidate,
    ...(previousByUrl.get(candidate.normalized_linkedin_url) ?? {}),
    original_urls: candidate.original_urls,
    snippets: candidate.snippets,
    visibility_factor: candidate.visibility_factor,
    matched_query_ids: candidate.matched_query_ids,
    matched_query_types: candidate.matched_query_types,
    matched_filter_hints: candidate.matched_filter_hints,
    intent_evidence_sources: candidate.intent_evidence_sources,
    raw_source_flags: candidate.raw_source_flags,
    serp_evidence: candidate.serp_evidence
  }));
  const next = await patchState(
    { candidates, intentEvidenceSources: cleaned.intentEvidenceSources, status: { currentStep: 6, errors: [] } as never },
    `Cleaned ${candidates.length} LinkedIn profiles and stored ${cleaned.intentEvidenceSources.length} post results as intent evidence.`
  );
  return NextResponse.json(next);
}
