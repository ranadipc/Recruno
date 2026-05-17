import { NextResponse } from "next/server";
import { generateQueries, runApify, runSerpApiSearch, analyzeCandidate } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { Brief, Candidate, ProfileData, SerpResult } from "@/lib/types";
import { buildExpansions, cleanCandidateFromResults, id, splitTerms } from "@/lib/utils";

function profileFromItem(item: Record<string, unknown> | undefined, candidate: Candidate): ProfileData | undefined {
  if (!item) return undefined;
  return {
    name: String(item.name ?? item.fullName ?? item.full_name ?? candidate.name_guess ?? ""),
    headline: String(item.headline ?? item.title ?? item.occupation ?? candidate.title_guess ?? ""),
    about: String(item.about ?? item.summary ?? item.description ?? ""),
    location: String(item.location ?? item.geoLocationName ?? item.geo ?? ""),
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

function briefFromText(jdText: string): Brief {
  const tokens = jdText.toLowerCase();
  const companies = ["Razorpay", "PhonePe", "CRED", "McKinsey", "BCG", "Bain"].filter((term) => tokens.includes(term.toLowerCase()));
  const locations = ["Bangalore", "Bengaluru", "Noida", "Mumbai", "Gurgaon", "Gurugram"].filter((term) => tokens.includes(term.toLowerCase()));
  const domains = ["fintech", "payments", "UPI", "lending", "credit"].filter((term) => tokens.includes(term.toLowerCase()));
  const education = ["IIT", "IIM", "BITS", "ISB"].filter((term) => tokens.includes(term.toLowerCase()));
  const partial = {
    role_titles: splitTerms(tokens.includes("product") ? "Product Manager, Product Lead, APM" : "Product Manager"),
    current_companies: companies.filter((term) => !["McKinsey", "BCG", "Bain"].includes(term)),
    past_companies: companies.filter((term) => ["McKinsey", "BCG", "Bain"].includes(term)),
    domains,
    locations,
    education,
    years: [],
    intent_terms: ["open to work", "looking for opportunities", "exploring roles", "laid off", "impacted by layoffs"],
    exclusions: ["Founder", "VP", "Director", "Recruiter", "Intern", "Student"],
    jd_text: jdText
  };
  return {
    id: id("brief"),
    ...partial,
    expansions: buildExpansions(partial),
    created_at: new Date().toISOString()
  };
}

export async function POST(request: Request) {
  const body = await request.json();
  const jdText = String(body.jd_text ?? "").trim();
  if (!jdText) return NextResponse.json({ error: "Paste a JD or hiring brief first." }, { status: 400 });

  const startedAt = new Date().toISOString();
  try {
    const settings = await getSettings();
    const brief = briefFromText(jdText);
    const queries = (await generateQueries(settings, brief)).map((query) => ({ ...query, selected: true }));
    const pages = Number(body.pagesPerQuery || settings.workflow.defaultSerpPages || 2);
    const maxSearches = Number(body.maxSearches || settings.workflow.maxQueriesPerRun * pages);
    const selected = queries.slice(0, settings.workflow.maxQueriesPerRun);
    let serpResults: SerpResult[] = [];

    const pairs = selected.flatMap((query) => Array.from({ length: pages }, (_, index) => ({ query, page: index + 1, start: index * 10 }))).slice(0, maxSearches);
    for (const pair of pairs) {
      const json = await runSerpApiSearch(settings, pair.query, pair.page, pair.start, body.location ? String(body.location) : undefined);
      const organic = Array.isArray(json.organic_results) ? json.organic_results : [];
      organic.forEach((item: Record<string, unknown>, index: number) => {
        serpResults.push({
          id: id("serp"),
          query_id: pair.query.id,
          query_text: pair.query.query_text,
          query_type: pair.query.query_type,
          title: String(item.title ?? ""),
          link: String(item.link ?? ""),
          displayed_link: String(item.displayed_link ?? ""),
          snippet: String(item.snippet ?? ""),
          position: Number(item.position ?? index + 1),
          page: pair.page,
          raw_json: item
        });
      });
    }

    const cleaned = cleanCandidateFromResults(serpResults);
    const apifyOutputs = await runApify(settings, cleaned.candidates.slice(0, settings.workflow.maxProfilesToApify), brief);
    const apifyById = new Map(apifyOutputs.map((output) => [output.candidate.id, output]));
    const withProfiles = cleaned.candidates.map((candidate) => {
      const output = apifyById.get(candidate.id);
      if (!output) return candidate;
      const item = output.item as Record<string, unknown> | undefined;
      return {
        ...candidate,
        apify_status: output.status,
        status: output.status,
        apify_raw: item,
        profile_data: profileFromItem(item, candidate) ?? candidate.profile_data
      };
    });

    const scoringCap = Math.max(1, Number(body.maxCandidates || 50));
    const scoringSet = withProfiles
      .filter((candidate) => candidate.apify_status === "apify_success" || candidate.apify_status === "apify_partial")
      .sort((a, b) => b.visibility_factor - a.visibility_factor)
      .slice(0, scoringCap);
    const analysisById = new Map<string, Awaited<ReturnType<typeof analyzeCandidate>>>();
    const concurrency = Math.min(5, scoringSet.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < scoringSet.length) {
        const candidate = scoringSet[cursor];
        cursor += 1;
        const analysis = await analyzeCandidate(settings, brief, candidate, "fit_intent");
        analysisById.set(candidate.id, analysis);
      }
    }));
    const scored = withProfiles.map((candidate) => analysisById.has(candidate.id) ? { ...candidate, ...analysisById.get(candidate.id)! } : candidate);

    const funnel = [
      { step: "SerpAPI results", count: serpResults.length, note: `${selected.length} selected queries across ${pages} page(s)` },
      { step: "Profile URLs", count: cleaned.candidates.length, note: "Normalized and deduplicated linkedin.com/in profiles" },
      { step: "Apify success/partial", count: scored.filter((candidate) => candidate.apify_status === "apify_success" || candidate.apify_status === "apify_partial").length, note: "Visible profile data merged" },
      { step: "Fit shortlist", count: scored.filter((candidate) => Number(candidate.fit_score ?? 0) >= 45).length, note: "Fit score 45+/70" },
      { step: "Intent shortlist", count: scored.filter((candidate) => Number(candidate.intent_score ?? 0) >= 15).length, note: "Intent score 15+/30" },
      { step: "Tier 1/2 shortlist", count: scored.filter((candidate) => candidate.tier === "Tier 1" || candidate.tier === "Tier 2").length, note: "Ready for manual review before Apollo" }
    ];

    const state = await getState();
    const next = await patchState({
      oneClick: {
        ...state.oneClick,
        jd_text: jdText,
        brief,
        queries,
        serpResults,
        candidates: scored,
        intentEvidenceSources: cleaned.intentEvidenceSources,
        status: "completed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        funnel
      },
      status: { errors: [] } as never
    }, `One Click completed with ${analysisById.size} scored profiles.`);
    return NextResponse.json(next.oneClick);
  } catch (error) {
    const state = await getState();
    const next = await patchState({
      oneClick: {
        ...state.oneClick,
        jd_text: jdText,
        status: "failed",
        error: error instanceof Error ? error.message : "One Click failed.",
        started_at: startedAt,
        completed_at: new Date().toISOString()
      }
    });
    return NextResponse.json(next.oneClick, { status: 400 });
  }
}
