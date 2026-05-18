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
    name_guess: previousByUrl.get(candidate.normalized_linkedin_url)?.name_guess || candidate.name_guess,
    title_guess: previousByUrl.get(candidate.normalized_linkedin_url)?.title_guess || candidate.title_guess,
    company_guess: previousByUrl.get(candidate.normalized_linkedin_url)?.company_guess || candidate.company_guess,
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
    { candidates, intentEvidenceSources: cleaned.intentEvidenceSources, rejectedSerpResults: cleaned.rejectedResults, status: { currentStep: 6, errors: [] } as never },
    `Cleaned ${candidates.length} LinkedIn profiles, removed ${cleaned.duplicatesRemoved} duplicates, rejected ${cleaned.rejectedResults.length} results, and stored ${cleaned.intentEvidenceSources.length} post results as intent evidence.`
  );
  return NextResponse.json(next);
}
