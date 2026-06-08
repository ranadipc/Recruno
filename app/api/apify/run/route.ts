import { NextResponse } from "next/server";
import { runApify } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { Candidate } from "@/lib/types";
import { id, isActualIndiaProfile, normalizeLinkedInUrl } from "@/lib/utils";
import { profileFromApifyItem } from "@/lib/apify";

export const maxDuration = 300;

function manualCandidate(normalizedUrl: string, originalUrl: string): Candidate {
  return {
    id: id("cand"),
    normalized_linkedin_url: normalizedUrl,
    original_urls: [originalUrl],
    name_guess: "",
    title_guess: "",
    company_guess: "",
    snippets: [],
    visibility_factor: 0,
    matched_query_ids: [],
    matched_query_types: [],
    matched_filter_hints: [],
    intent_evidence_sources: [],
    raw_source_flags: ["manual_apify_input"],
    serp_evidence: [],
    source: "manual",
    status: "pending_apify",
    apify_status: "pending_apify",
    fit_evidence: [],
    intent_evidence: [],
    missing_data: [],
    risk_flags: [],
    recommended_manual_checks: [],
    manual_status: "pending",
    manual_notes: "Added through Apify Input Links.",
    needs_contact_enrichment: true,
    apollo_status: "not_started"
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();
    const state = await getState();
    const manualMode = Array.isArray(body.manualLinks);
    const rawManualLinks: string[] = manualMode ? body.manualLinks.map(String) : [];
    const manualLinks = Array.from(new Map(
      rawManualLinks
        .map((url) => ({ original: url, normalized: normalizeLinkedInUrl(url) }))
        .filter((entry): entry is { original: string; normalized: string } => Boolean(entry.normalized?.startsWith("linkedin.com/in/")))
        .map((entry) => [entry.normalized, entry] as const)
    ).values());
    const selectedIds = new Set<string>(body.candidateIds ?? []);
    const runAll = body.runAll === true;
    const includeRejected = body.includeRejected === true;
    const max = runAll ? Number.MAX_SAFE_INTEGER : Number(body.maxProfiles || settings.workflow.maxProfilesToApify);
    const requestCandidates = Array.isArray(body.candidates) ? body.candidates as Candidate[] : [];
    const sourceCandidates = state.candidates.length > 0 ? state.candidates : requestCandidates;
    const existingByUrl = new Map(state.candidates.map((candidate) => [candidate.normalized_linkedin_url, candidate]));
    const newManualCandidates = manualLinks
      .filter((entry) => !existingByUrl.has(entry.normalized))
      .map((entry) => manualCandidate(entry.normalized, entry.original));
    const manualOriginalByUrl = new Map(manualLinks.map((entry) => [entry.normalized, entry.original]));
    const currentCandidates = manualMode
      ? [
          ...state.candidates.map((candidate) => manualOriginalByUrl.has(candidate.normalized_linkedin_url)
            ? {
                ...candidate,
                original_urls: Array.from(new Set([...candidate.original_urls, manualOriginalByUrl.get(candidate.normalized_linkedin_url)!])),
                raw_source_flags: Array.from(new Set([...(candidate.raw_source_flags ?? []), "manual_apify_input"]))
              }
            : candidate),
          ...newManualCandidates
        ]
      : sourceCandidates;
    const currentByUrl = new Map(currentCandidates.map((candidate) => [candidate.normalized_linkedin_url, candidate]));
    const profileCandidates = currentCandidates.filter((candidate) => candidate.normalized_linkedin_url?.startsWith("linkedin.com/in/"));
    const selected = manualMode
      ? manualLinks.map((entry) => currentByUrl.get(entry.normalized)).filter((candidate): candidate is Candidate => Boolean(candidate))
      : profileCandidates
        .filter((candidate) => selectedIds.size === 0 || selectedIds.has(candidate.id))
        .filter((candidate) => includeRejected || (candidate.manual_status !== "rejected" && candidate.status !== "ai_rejected" && candidate.status !== "deleted"))
        .filter((candidate) => selectedIds.size > 0 || candidate.apify_status === "pending_apify")
        .sort((a, b) => {
          const statusRank = (status: string) => status === "pending_apify" ? 0 : status === "apify_partial" ? 1 : status === "apify_failed" ? 2 : 3;
          return statusRank(a.apify_status) - statusRank(b.apify_status) || b.visibility_factor - a.visibility_factor;
        })
        .slice(0, max);
    if (selected.length === 0) {
      const message = manualMode
        ? "No valid linkedin.com/in profile links were provided."
        : "No pending LinkedIn profile candidates available for Apify. Clean SerpAPI data first, or all non-rejected profiles are already done.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const outputs = await runApify(settings, selected, state.brief);
    const byId = new Map(outputs.map((output) => [output.candidate.id, output]));
    const candidates = currentCandidates.map((candidate) => {
      const output = byId.get(candidate.id);
      if (!output) return candidate;
      const item = output.item as Record<string, unknown> | undefined;
      const profile = profileFromApifyItem(item, candidate) ?? candidate.profile_data;
      const actual = isActualIndiaProfile({ ...candidate, profile_data: profile });
      const status: Candidate["apify_status"] = item ? "apify_success" : output.status === "apify_failed" ? "apify_failed" : "pending_apify";
      return {
        ...candidate,
        apify_status: status,
        status,
        apify_raw: item,
        profile_data: profile,
        name_guess: profile?.name || candidate.name_guess,
        title_guess: profile?.current_title || profile?.headline || candidate.title_guess,
        company_guess: profile?.current_company || candidate.company_guess,
        actual_location_status: actual.status,
        location_evidence: actual.evidence,
        location_confidence: actual.confidence,
        location_source: actual.source,
        visibility_factor: candidate.visibility_factor,
        intent_evidence_sources: candidate.intent_evidence_sources ?? [],
        raw_source_flags: candidate.raw_source_flags ?? []
      };
    });
    const next = await patchState(
      { candidates, status: { currentStep: 7, errors: [] } as never },
      `${manualMode ? "Apify Input Links" : "Apify profile step"} merged data for ${outputs.length} candidates. ${outputs.filter((output) => output.item).length} succeeded, ${outputs.filter((output) => !output.item).length} failed.`
    );
    return NextResponse.json(next);
  } catch (error) {
    const state = await patchState({ status: { errors: [error instanceof Error ? error.message : "Apify scrape failed."] } as never });
    return NextResponse.json(state, { status: 400 });
  }
}
