import { NextResponse } from "next/server";
import { runApify } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { Candidate, ProfileData } from "@/lib/types";
import { isActualIndiaProfile } from "@/lib/utils";

function profileFromItem(item: Record<string, unknown> | undefined, candidate: Candidate): ProfileData | undefined {
  if (!item) return undefined;
  return {
    name: String(item.name ?? item.fullName ?? item.full_name ?? candidate.name_guess ?? ""),
    headline: String(item.headline ?? item.title ?? item.occupation ?? candidate.title_guess ?? ""),
    about: String(item.about ?? item.summary ?? item.description ?? ""),
    location: String(item.location ?? item.geoLocationName ?? item.geo ?? ""),
    current_company_location: String(item.currentCompanyLocation ?? item.companyLocation ?? ""),
    current_title: String(item.current_title ?? item.currentTitle ?? item.jobTitle ?? item.title ?? candidate.title_guess ?? ""),
    current_company: String(item.current_company ?? item.currentCompany ?? item.companyName ?? item.company ?? candidate.company_guess ?? ""),
    past_companies: Array.isArray(item.past_companies)
      ? (item.past_companies as string[])
      : Array.isArray(item.experience)
        ? (item.experience as Array<Record<string, unknown>>).map((exp) => String(exp.company ?? exp.companyName ?? "")).filter(Boolean)
        : [],
    experience: Array.isArray(item.experience) ? (item.experience as Array<Record<string, unknown>>) : [],
    education: Array.isArray(item.education) ? (item.education as Array<Record<string, unknown> | string>) : [],
    skills: Array.isArray(item.skills) ? (item.skills as string[]) : [],
    posts: Array.isArray(item.posts) ? (item.posts as Array<Record<string, unknown> | string>) : []
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const settings = await getSettings();
    const state = await getState();
    const selectedIds = new Set<string>(body.candidateIds ?? []);
    const max = Number(body.maxProfiles || settings.workflow.maxProfilesToApify);
    const selected = state.candidates
      .filter((candidate) => selectedIds.size === 0 || selectedIds.has(candidate.id))
      .slice(0, max);
    const outputs = await runApify(settings, selected, state.brief);
    const byId = new Map(outputs.map((output) => [output.candidate.id, output]));
    const candidates = state.candidates.map((candidate) => {
      const output = byId.get(candidate.id);
      if (!output) return candidate;
      const item = output.item as Record<string, unknown> | undefined;
      const profile = profileFromItem(item, candidate) ?? candidate.profile_data;
      const actual = isActualIndiaProfile({ ...candidate, profile_data: profile });
      return {
        ...candidate,
        apify_status: output.status,
        status: output.status,
        apify_raw: item,
        profile_data: profile,
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
      `Apify profile step merged data for ${outputs.length} candidates.`
    );
    return NextResponse.json(next);
  } catch (error) {
    const state = await patchState({ status: { errors: [error instanceof Error ? error.message : "Apify scrape failed."] } as never });
    return NextResponse.json(state, { status: 400 });
  }
}
