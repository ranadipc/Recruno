import { NextResponse } from "next/server";
import { cleanCandidateFromResults } from "@/lib/utils";
import { screenCandidatesAgainstBrief } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { Candidate } from "@/lib/types";

function deterministicRejectReason(candidate: Candidate, exclusions: string[]) {
  const text = [candidate.name_guess, candidate.title_guess, candidate.company_guess, ...candidate.snippets].join(" ").toLowerCase();
  const roleText = candidate.title_guess.toLowerCase();
  const matched = exclusions.find((term) => {
    const clean = term.trim().toLowerCase();
    if (!clean) return false;
    return new RegExp(`\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(roleText || text);
  });
  return matched ? `Excluded term found: ${matched}` : "";
}

export async function POST() {
  const settings = await getSettings();
  const state = await getState();
  const cleaned = cleanCandidateFromResults(state.serpResults);
  const previousByUrl = new Map(state.candidates.map((candidate) => [candidate.normalized_linkedin_url, candidate]));
  const baseCandidates = cleaned.candidates.map((candidate) => ({
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
  const aiDecisions = await screenCandidatesAgainstBrief(settings, state.brief, baseCandidates).catch(() => new Map());
  const exclusions = state.brief?.exclusions ?? [];
  const candidates = baseCandidates.map((candidate) => {
    const deterministicReason = deterministicRejectReason(candidate, exclusions);
    const ai = aiDecisions.get(candidate.id);
    const shouldReject = Boolean(deterministicReason) || ai?.decision === "reject";
    const needsReview = ai?.decision === "review";
    const reason = deterministicReason || ai?.reason || "";
    const screenStatus = shouldReject ? "ai_rejected" : needsReview ? "ai_review" : "ai_passed";
    const reasonPrefix = shouldReject ? "Clean screen rejected" : needsReview ? "Clean screen review" : "Clean screen passed";
    const priorRiskFlags = (candidate.risk_flags ?? []).filter((flag) => !flag.startsWith("Clean screen "));
    const priorSourceFlags = (candidate.raw_source_flags ?? []).filter((flag) => !flag.startsWith("ai_validation:"));
    return {
      ...candidate,
      status: screenStatus,
      manual_status: shouldReject ? "rejected" as const : candidate.status === "ai_rejected" ? "pending" as const : candidate.manual_status,
      needs_contact_enrichment: shouldReject ? false : candidate.needs_contact_enrichment,
      risk_flags: reason ? Array.from(new Set([...priorRiskFlags, `${reasonPrefix}: ${reason}`])) : priorRiskFlags,
      raw_source_flags: Array.from(new Set([...priorSourceFlags, `ai_validation:${screenStatus}`])),
      recommended_manual_checks: needsReview && reason ? Array.from(new Set([...(candidate.recommended_manual_checks ?? []), reason])) : candidate.recommended_manual_checks
    };
  });
  const rejectedByScreen = candidates.filter((candidate) => candidate.status === "ai_rejected").length;
  const reviewByScreen = candidates.filter((candidate) => candidate.status === "ai_review").length;
  const next = await patchState(
    { candidates, intentEvidenceSources: cleaned.intentEvidenceSources, rejectedSerpResults: cleaned.rejectedResults, status: { currentStep: 6, errors: [] } as never },
    `Cleaned ${candidates.length} LinkedIn profiles. Smart screen rejected ${rejectedByScreen}, marked ${reviewByScreen} for review, removed ${cleaned.duplicatesRemoved} duplicates.`
  );
  return NextResponse.json(next);
}
