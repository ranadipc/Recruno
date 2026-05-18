import { NextResponse } from "next/server";
import { analyzeCandidate } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode ?? "fit_intent";
    const maxCandidates = Math.max(1, Number(body.maxCandidates ?? 50));
    const onlyScraped = body.onlyScraped !== false;
    const settings = await getSettings();
    const state = await getState();
    if (!state.brief) return NextResponse.json({ error: "Missing brief." }, { status: 400 });
    const ids = new Set<string>(body.candidateIds ?? []);
    const eligible = state.candidates
      .filter((candidate) => candidate.normalized_linkedin_url.startsWith("linkedin.com/in/"))
      .filter((candidate) => !ids.size || ids.has(candidate.id))
      .filter((candidate) => !onlyScraped || candidate.apify_status === "apify_success" || candidate.apify_status === "apify_partial")
      .filter((candidate) => candidate.passes_profile_filter !== false || candidate.include_failed_profile_filter)
      .sort((a, b) => b.visibility_factor - a.visibility_factor)
      .slice(0, maxCandidates);
    if (eligible.length === 0) return NextResponse.json({ error: "No candidates matched the scoring settings." }, { status: 400 });

    const analyzed = new Map<string, Awaited<ReturnType<typeof analyzeCandidate>>>();
    const concurrency = Math.min(5, eligible.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < eligible.length) {
        const candidate = eligible[cursor];
        cursor += 1;
        const analysis = await analyzeCandidate(settings, state.brief!, candidate, mode, state.promptOverrides.scoring);
        analyzed.set(candidate.id, analysis);
      }
    }));

    const updated = state.candidates.map((candidate) => analyzed.has(candidate.id) ? { ...candidate, ...analyzed.get(candidate.id)! } : candidate);
    const next = await patchState(
      { candidates: updated, status: { currentStep: 9, errors: [] } as never },
      `Fit and intent analysis completed for ${analyzed.size} candidates.`
    );
    return NextResponse.json(next);
  } catch (error) {
    const state = await patchState({ status: { errors: [error instanceof Error ? error.message : "Fit/intent analysis failed."] } as never });
    return NextResponse.json(state, { status: 400 });
  }
}
