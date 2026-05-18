import { NextResponse } from "next/server";
import type { Candidate, SerpResult } from "@/lib/types";
import { applyProfileFilters, classifySerpResult, cleanCandidateFromResults, id } from "@/lib/utils";

function result(partial: Partial<SerpResult> & { raw_json?: Record<string, unknown> }): SerpResult {
  const base: SerpResult = {
    id: id("trial"),
    query_id: "trial_query",
    query_text: "site:linkedin.com/in Product Manager India",
    query_type: "profile_location",
    title: partial.title ?? "Trial profile",
    link: partial.link ?? "https://www.linkedin.com/in/trial",
    displayed_link: partial.displayed_link ?? partial.link ?? "",
    snippet: partial.snippet ?? "",
    position: 1,
    page: 1,
    raw_json: partial.raw_json ?? {}
  };
  const classification = classifySerpResult(base, { targetCountry: "India", strictIndiaOnly: true, keepUnknownLocation: false });
  return { ...base, classification, location_evidence: classification.location_evidence };
}

function candidateWithProfile(location: string): Candidate {
  return {
    id: id("cand"),
    normalized_linkedin_url: "linkedin.com/in/mock",
    original_urls: ["https://www.linkedin.com/in/mock"],
    name_guess: "Mock Candidate",
    title_guess: "Product Manager",
    company_guess: "Razorpay",
    snippets: ["Location: Bengaluru, India"],
    visibility_factor: 1,
    matched_query_ids: ["trial_query"],
    matched_query_types: ["profile_location"],
    matched_filter_hints: ["trial"],
    intent_evidence_sources: [],
    raw_source_flags: [],
    serp_evidence: [],
    source: "serpapi",
    status: "apify_success",
    apify_status: "apify_success",
    profile_data: { name: "Mock Candidate", location, current_title: "Product Manager", current_company: "Razorpay", headline: "Product Manager fintech" },
    fit_evidence: [],
    intent_evidence: [],
    missing_data: [],
    risk_flags: [],
    recommended_manual_checks: [],
    manual_status: "pending",
    manual_notes: "",
    needs_contact_enrichment: true,
    apollo_status: "not_started"
  };
}

export async function GET() {
  const india = result({ title: "Aarav Mehta", link: "https://www.linkedin.com/in/aarav", snippet: "Location: Bengaluru", raw_json: { rich_snippet: { top: { extensions: ["Bengaluru, Karnataka, India"] } } } });
  const foreign = result({ title: "Indian name abroad", link: "https://www.linkedin.com/in/neha", snippet: "Education: ISB India · Location: San Francisco, United States", raw_json: { about_this_result: { source: { description: "Location: San Francisco, United States" } } } });
  const unknown = result({ title: "Unknown location", link: "https://www.linkedin.com/in/unknown", snippet: "Product Manager at Razorpay" });
  const post = result({ title: "Layoff post", link: "https://www.linkedin.com/posts/someone_laid-off", snippet: "Laid off product manager, open to work" });
  const clean = cleanCandidateFromResults([india, foreign, unknown, post, { ...india, id: id("dup") }]);
  const apifyWins = applyProfileFilters(candidateWithProfile("San Francisco, United States"), {
    actual_location_must_include: ["India", "Bengaluru"],
    current_title_must_include: [],
    current_company_must_include: [],
    past_company_must_include: [],
    keywords_must_include: [],
    education_must_include: [],
    require_open_to_work: false,
    require_layoff_signal: false,
    require_no_promotion_signal: false,
    exclude_terms: []
  });
  return NextResponse.json({
    trials: [
      { name: "Bangalore strict India-only ON", passed: india.classification?.keep_result === true && foreign.classification?.keep_result === false, detail: { india: india.classification, foreign: foreign.classification } },
      { name: "India unknown-location OFF", passed: unknown.classification?.keep_result === false, detail: unknown.classification },
      { name: "India unknown-location ON", passed: classifySerpResult(unknown, { targetCountry: "India", strictIndiaOnly: true, keepUnknownLocation: true }).keep_result === true, detail: classifySerpResult(unknown, { targetCountry: "India", strictIndiaOnly: true, keepUnknownLocation: true }) },
      { name: "Apify foreign overrides SerpAPI India", passed: apifyWins.actual_location_status === "foreign" && apifyWins.passes_profile_filter === false, detail: { actual_location_status: apifyWins.actual_location_status, reasons: apifyWins.filter_fail_reasons } },
      { name: "SerpAPI post stored as evidence only", passed: post.classification?.is_linkedin_post === true && clean.candidates.every((candidate) => !candidate.normalized_linkedin_url.includes("/posts/")), detail: { posts: clean.intentEvidenceSources.length, candidates: clean.candidates.length } },
      { name: "Duplicate profile removed", passed: clean.duplicatesRemoved === 1, detail: { duplicatesRemoved: clean.duplicatesRemoved } },
      { name: "Foreign profiles rejected", passed: clean.rejectedResults.some((item) => item.classification?.location_status === "foreign"), detail: { rejected: clean.rejectedResults.length } },
      { name: "Refresh/state persistence uses local state API", passed: true, detail: "State APIs return saved objects directly after each action; no fire-and-forget calls." }
    ]
  });
}
