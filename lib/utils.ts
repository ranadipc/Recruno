import { randomUUID } from "node:crypto";
import type { Brief, Candidate, IntentEvidenceSource, LocationEvidence, ProfileFilters, QueryType, SerpClassification, SerpResult, Tier } from "./types";

export function id(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function splitTerms(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildExpansions(input: Partial<Brief>): Record<string, string[]> {
  const rules: Record<string, string[]> = {
    Bangalore: ["Bangalore", "Bengaluru"],
    Bengaluru: ["Bangalore", "Bengaluru"],
    Gurgaon: ["Gurgaon", "Gurugram"],
    Gurugram: ["Gurgaon", "Gurugram"],
    Bombay: ["Bombay", "Mumbai"],
    Mumbai: ["Bombay", "Mumbai"],
    BCG: ["BCG", "ex-BCG", "former BCG", "BCG alum"],
    Bain: ["Bain", "ex-Bain", "former Bain", "Bain alum"],
    McKinsey: ["McKinsey", "ex-McKinsey", "former McKinsey", "McKinsey alum"]
  };
  const terms = [
    ...(input.locations ?? []),
    ...(input.past_companies ?? []),
    ...(input.current_companies ?? []),
    ...(input.keywords ?? []),
    ...(input.domains ?? [])
  ];
  return terms.reduce<Record<string, string[]>>((acc, term) => {
    const match = Object.keys(rules).find((key) => key.toLowerCase() === term.toLowerCase());
    if (match) acc[term] = rules[match];
    return acc;
  }, {});
}

export function quote(term: string) {
  return `"${term.replace(/"/g, "")}"`;
}

export function orGroup(terms: string[]) {
  const clean = terms.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return quote(clean[0]);
  return `(${clean.map(quote).join(" OR ")})`;
}

export function normalizeLinkedInUrl(url: string): string | undefined {
  const raw = url.trim();
  const match = raw.match(/linkedin\.com\/(in|posts)\/([^/?#\s]+)/i);
  if (!match) return undefined;
  const section = match[1].toLowerCase();
  const slug = decodeURIComponent(match[2])
    .replace(/\/+$/, "")
    .replace(/[^\w\-%.]/g, "");
  return slug ? `linkedin.com/${section}/${slug}` : undefined;
}

export function isLinkedInProfileUrl(url: string) {
  return normalizeLinkedInUrl(url)?.startsWith("linkedin.com/in/") ?? false;
}

export function isLinkedInPostUrl(url: string) {
  return normalizeLinkedInUrl(url)?.startsWith("linkedin.com/posts/") ?? false;
}

export function isAllowedLinkedInResult(url: string, queryType?: QueryType) {
  const normalized = normalizeLinkedInUrl(url);
  if (!normalized) return false;
  if (normalized.includes("/posts/")) {
    return queryType === "intent_post" || queryType === "layoff_post" || queryType === "hiring_comment";
  }
  return normalized.includes("/in/");
}

const INDIA_TERMS = [
  "india", "bengaluru", "bangalore", "mumbai", "delhi", "new delhi", "noida", "gurugram", "gurgaon",
  "hyderabad", "pune", "chennai", "kolkata", "ahmedabad", "jaipur", "lucknow", "kanpur", "chandigarh",
  "kochi", "indore", "surat", "nagpur", "coimbatore", "karnataka", "maharashtra", "telangana",
  "tamil nadu", "uttar pradesh", "haryana", "gujarat", "rajasthan", "kerala", "west bengal"
];

const FOREIGN_TERMS = [
  "united states", "usa", "u.s.", "canada", "united kingdom", "uk", "england", "london", "germany",
  "berlin", "netherlands", "singapore", "dubai", "uae", "australia", "europe", "france", "san francisco",
  "new york", "toronto", "sydney", "melbourne", "amsterdam", "paris", "dublin"
];

function hasAny(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(lower));
}

function pickLocationFromRaw(raw: unknown): LocationEvidence {
  const item = (raw ?? {}) as Record<string, unknown>;
  const rich = item.rich_snippet as Record<string, unknown> | undefined;
  const top = rich?.top as Record<string, unknown> | undefined;
  const extensions = top?.extensions;
  if (Array.isArray(extensions)) {
    const location = extensions.map(String).find((value) => hasAny(value, [...INDIA_TERMS, ...FOREIGN_TERMS]));
    if (location) return classifyLocationText(location, "rich_snippet", "high");
  }
  const about = item.about_this_result as Record<string, unknown> | undefined;
  const source = about?.source as Record<string, unknown> | undefined;
  const description = String(source?.description ?? "");
  const locationLine = description.match(/location\s*:\s*([^|.;\n]+)/i)?.[1] ?? description;
  if (description && /location/i.test(description)) return classifyLocationText(locationLine, "about_description", "high");
  const snippet = String(item.snippet ?? "");
  const snippetLocation = snippet.match(/location\s*[:·-]\s*([^|.;\n]+)/i)?.[1];
  if (snippetLocation) return classifyLocationText(snippetLocation, "snippet", "medium");
  const link = String(item.link ?? "");
  const displayed = String(item.displayed_link ?? "");
  if (/\/\/in\.linkedin\.com|^in\.linkedin\.com/i.test(link) || /in\.linkedin\.com/i.test(displayed)) {
    return { location_text: "in.linkedin.com", location_source: "weak_domain", is_india_location: "unknown", confidence: "low", rejection_reason: "Weak India domain hint only; actual profile location missing." };
  }
  return { location_text: "", location_source: "missing", is_india_location: "unknown", confidence: "low", rejection_reason: "No actual location evidence found." };
}

function classifyLocationText(text: string, source: LocationEvidence["location_source"], confidence: LocationEvidence["confidence"]): LocationEvidence {
  const clean = text.replace(/\s+/g, " ").trim();
  if (hasAny(clean, FOREIGN_TERMS)) {
    return { location_text: clean, location_source: source, is_india_location: false, confidence, rejection_reason: "Actual location evidence appears foreign." };
  }
  if (hasAny(clean, INDIA_TERMS)) {
    return { location_text: clean, location_source: source, is_india_location: true, confidence };
  }
  return { location_text: clean, location_source: source, is_india_location: "unknown", confidence: source === "snippet" ? "medium" : confidence, rejection_reason: "Location evidence does not clearly match India." };
}

export function extractLocationEvidence(result: Record<string, unknown>): LocationEvidence {
  return pickLocationFromRaw(result);
}

export function classifySerpResult(result: SerpResult, options: { targetCountry: "India" | "Any"; strictIndiaOnly: boolean; keepUnknownLocation: boolean }): SerpClassification {
  const normalized = normalizeLinkedInUrl(result.link);
  const isProfile = Boolean(normalized?.startsWith("linkedin.com/in/"));
  const isPost = Boolean(normalized?.startsWith("linkedin.com/posts/"));
  const isCompanyOrJob = /linkedin\.com\/(company|jobs)\//i.test(result.link);
  const location_evidence = extractLocationEvidence({ ...(result.raw_json as Record<string, unknown>), link: result.link, displayed_link: result.displayed_link, snippet: result.snippet });
  const location_status = location_evidence.is_india_location === true ? "india" : location_evidence.is_india_location === false ? "foreign" : "unknown";
  let keep_result = false;
  let rejection_reason = "";
  if (isCompanyOrJob) rejection_reason = "LinkedIn company/job page.";
  else if (isPost) keep_result = true;
  else if (!isProfile) rejection_reason = "Not a LinkedIn profile/post URL.";
  else if (options.targetCountry === "Any" || !options.strictIndiaOnly) keep_result = true;
  else if (location_status === "india") keep_result = true;
  else if (location_status === "unknown" && options.keepUnknownLocation) keep_result = true;
  else rejection_reason = location_status === "foreign" ? location_evidence.rejection_reason ?? "Foreign profile location." : "Unknown actual profile location.";
  return { is_linkedin_profile: isProfile, is_linkedin_post: isPost, is_company_or_job: isCompanyOrJob, location_status, keep_result, rejection_reason, location_evidence };
}

export function cleanLinkedInName(value: string) {
  return value
    .replace(/\s+on\s+LinkedIn\s*$/i, "")
    .replace(/\s*[\-|–]\s*LinkedIn\s*$/i, "")
    .replace(/\s*\|\s*LinkedIn.*$/i, "")
    .replace(/\s+-\s+LinkedIn.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tidyCompany(value: string | undefined) {
  if (!value) return "";
  const clean = value
    .replace(/\b(working|focused|former|based|open|looking|exploring|impacted|laid|restructuring|payments?|lending|upi)\b.*$/i, "")
    .replace(/[|,.;:()[\]]+.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > 35 || /\d{4}/.test(clean)) return "";
  if (/^(former|ex|alum|consultant|product|manager|senior|lead|pm|apm)$/i.test(clean)) return "";
  return clean;
}

function tidyTitle(value: string | undefined) {
  if (!value) return "";
  const clean = value
    .replace(/\bat\s+[A-Z].*$/i, "")
    .replace(/[|,.;:()[\]]+.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > 45) return "";
  if (!/\b(product|manager|lead|associate|principal|consultant|analyst|pm|apm|director|head|senior)\b/i.test(clean)) return "";
  return clean;
}

export function guessFromSerp(title: string, snippet: string) {
  const cleanTitle = cleanLinkedInName(title);
  const parts = cleanTitle.split(/\s[-–|]\s/).map((part) => part.trim()).filter(Boolean);
  const name = cleanLinkedInName(parts[0] || cleanTitle);
  const detailParts = parts.slice(1);
  const detail = detailParts.join(" - ");
  const atMatch = `${detail} ${snippet}`.match(/\b([^|.;:]{2,45}?)\s+at\s+([A-Z][A-Za-z0-9&.\s-]{1,35})/);
  const titleGuess = tidyTitle(atMatch?.[1] ?? detailParts[0]);
  const companyGuess = tidyCompany(atMatch?.[2] ?? detailParts[1] ?? `${title} ${snippet}`.match(/\bat\s+([A-Z][A-Za-z0-9&.\s-]{1,35})/)?.[1]);
  return {
    name_guess: name,
    title_guess: titleGuess,
    company_guess: companyGuess
  };
}

export function tierFromScore(total: number): Tier {
  if (total > 80) return "Tier 1";
  if (total >= 60) return "Tier 2";
  if (total >= 30) return "Tier 3";
  return "Tier 4";
}

export function cleanCandidateFromResults(results: SerpResult[]): { candidates: Candidate[]; intentEvidenceSources: IntentEvidenceSource[]; rejectedResults: SerpResult[]; duplicatesRemoved: number } {
  const bySlug = new Map<string, Candidate>();
  const postResults: SerpResult[] = [];
  const rejectedResults: SerpResult[] = [];
  let duplicatesRemoved = 0;
  for (const result of results) {
    if (result.classification && !result.classification.keep_result) {
      rejectedResults.push(result);
      continue;
    }
    if (isLinkedInPostUrl(result.link)) {
      postResults.push(result);
      continue;
    }
    if (!isLinkedInProfileUrl(result.link)) continue;
    const normalized = normalizeLinkedInUrl(result.link);
    if (!normalized) continue;
    const existing = bySlug.get(normalized);
    const guess = guessFromSerp(result.title, result.snippet);
    if (existing) {
      duplicatesRemoved += 1;
      existing.original_urls = Array.from(new Set([...existing.original_urls, result.link]));
      existing.snippets = Array.from(new Set([...existing.snippets, result.snippet].filter(Boolean)));
      existing.matched_query_ids = Array.from(new Set([...existing.matched_query_ids, result.query_id]));
      existing.matched_query_types = Array.from(new Set([...existing.matched_query_types, result.query_type]));
      existing.visibility_factor = existing.matched_query_ids.length;
      existing.serp_evidence.push(result);
      existing.matched_filter_hints = Array.from(new Set([...existing.matched_filter_hints, result.query_text]));
      existing.raw_source_flags = Array.from(new Set([...(existing.raw_source_flags ?? []), "profile_result"]));
      continue;
    }
    bySlug.set(normalized, {
      id: id("cand"),
      normalized_linkedin_url: normalized,
      original_urls: [result.link],
      name_guess: guess.name_guess,
      title_guess: guess.title_guess,
      company_guess: guess.company_guess,
      snippets: [result.snippet].filter(Boolean),
      visibility_factor: 1,
      matched_query_ids: [result.query_id],
      matched_query_types: [result.query_type],
      matched_filter_hints: [result.query_text],
      intent_evidence_sources: [],
      raw_source_flags: ["profile_result"],
      serp_evidence: [result],
      source: "serpapi",
      status: "pending_apify",
      apify_status: "pending_apify",
      fit_evidence: [],
      intent_evidence: [],
      missing_data: [],
      risk_flags: [],
      recommended_manual_checks: [],
      manual_status: "pending",
      manual_notes: "",
      needs_contact_enrichment: true,
      apollo_status: "not_started"
    });
    const created = bySlug.get(normalized);
    if (created) {
      created.actual_location_status = result.classification?.location_status;
      created.location_evidence = result.classification?.location_evidence.location_text;
      created.location_confidence = result.classification?.location_evidence.confidence;
      created.location_source = result.classification?.location_evidence.location_source;
    }
  }

  const candidates = Array.from(bySlug.values());
  const intentEvidenceSources = postResults.map((result) => {
    const guess = guessFromSerp(result.title, result.snippet);
    const matched = candidates.find((candidate) => {
      const candidateName = cleanLinkedInName(candidate.name_guess).toLowerCase();
      return candidateName && cleanLinkedInName(guess.name_guess).toLowerCase() === candidateName;
    });
    const source: IntentEvidenceSource = {
      id: id("intent"),
      url: result.link,
      title: cleanLinkedInName(result.title),
      snippet: result.snippet,
      query_id: result.query_id,
      query_text: result.query_text,
      query_type: result.query_type,
      page: result.page,
      source_status: matched ? "linked_to_profile" : "author_profile_missing",
      matched_candidate_id: matched?.id
    };
    if (matched) {
      matched.intent_evidence_sources.push(source);
      matched.intent_evidence = Array.from(new Set([...matched.intent_evidence, result.snippet].filter(Boolean)));
      matched.raw_source_flags = Array.from(new Set([...(matched.raw_source_flags ?? []), "post_intent_evidence"]));
    }
    return source;
  });

  return { candidates: candidates.sort((a, b) => b.visibility_factor - a.visibility_factor), intentEvidenceSources, rejectedResults, duplicatesRemoved };
}

export function isActualIndiaProfile(candidate: Candidate) {
  const profile = candidate.profile_data;
  const location = String(profile?.location ?? profile?.current_company_location ?? "");
  if (location) {
    const classified = classifyLocationText(location, "rich_snippet", "high");
    return {
      status: classified.is_india_location === true ? "india" as const : classified.is_india_location === false ? "foreign" as const : "unknown" as const,
      evidence: classified.location_text,
      confidence: classified.confidence,
      source: "apify_profile_location"
    };
  }
  if (candidate.location_evidence && candidate.actual_location_status === "india") return { status: "india" as const, evidence: candidate.location_evidence, confidence: "medium" as const, source: "serpapi_location" };
  return { status: "unknown" as const, evidence: "", confidence: "low" as const, source: "missing" };
}

export function applyProfileFilters(candidate: Candidate, filters: ProfileFilters): Candidate {
  const actual = isActualIndiaProfile(candidate);
  const text = candidateSearchText(candidate).toLowerCase();
  const profile = candidate.profile_data;
  const reasons: string[] = [];
  const requireAny = (label: string, values: string[], haystack: string) => {
    const terms = values.map((value) => value.toLowerCase()).filter(Boolean);
    if (terms.length && !terms.some((term) => haystack.includes(term))) reasons.push(`${label} missing: ${values.join(", ")}`);
  };
  requireAny("Actual location", filters.actual_location_must_include, actual.evidence || profile?.location || "");
  requireAny("Current title", filters.current_title_must_include, profile?.current_title || candidate.title_guess || "");
  requireAny("Current company", filters.current_company_must_include, profile?.current_company || candidate.company_guess || "");
  requireAny("Past company", filters.past_company_must_include, JSON.stringify(profile?.experience ?? profile?.past_companies ?? []));
  requireAny("Keywords", filters.keywords_must_include, text);
  requireAny("Education", filters.education_must_include, JSON.stringify(profile?.education ?? []));
  if (filters.exclude_terms.some((term) => text.includes(term.toLowerCase()))) reasons.push(`Excluded term found: ${filters.exclude_terms.join(", ")}`);
  if (filters.require_open_to_work && !/open to work|looking for opportunities|actively looking|exploring roles/i.test(text)) reasons.push("Open to Work signal missing");
  if (filters.require_layoff_signal && !/laid off|impacted by layoffs|affected by layoffs|restructuring/i.test(text)) reasons.push("Layoff signal missing");
  if (filters.require_no_promotion_signal && !/no promotion|same title|stagnat/i.test(text)) reasons.push("No-promotion signal missing or unverified");
  return {
    ...candidate,
    actual_location_status: actual.status,
    location_evidence: actual.evidence,
    location_confidence: actual.confidence,
    location_source: actual.source,
    passes_profile_filter: reasons.length === 0,
    filter_fail_reasons: reasons,
    filter_confidence: actual.status === "unknown" ? "low" : "medium"
  };
}

export function candidateSearchText(candidate: Candidate) {
  return [
    candidate.name_guess,
    candidate.title_guess,
    candidate.company_guess,
    candidate.profile_data?.headline,
    candidate.profile_data?.about,
    candidate.profile_data?.location,
    candidate.snippets.join(" "),
    candidate.intent_evidence_sources?.map((source) => source.snippet).join(" "),
    JSON.stringify(candidate.profile_data?.experience ?? [])
  ]
    .filter(Boolean)
    .join("\n");
}

export function flatten(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
