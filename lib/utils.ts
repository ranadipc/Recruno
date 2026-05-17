import { randomUUID } from "node:crypto";
import type { Brief, Candidate, IntentEvidenceSource, QueryType, SerpResult, Tier } from "./types";

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

export function cleanCandidateFromResults(results: SerpResult[]): { candidates: Candidate[]; intentEvidenceSources: IntentEvidenceSource[] } {
  const bySlug = new Map<string, Candidate>();
  const postResults: SerpResult[] = [];
  for (const result of results) {
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

  return { candidates: candidates.sort((a, b) => b.visibility_factor - a.visibility_factor), intentEvidenceSources };
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
