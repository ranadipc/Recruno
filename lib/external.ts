import type { Brief, Candidate, Query, Settings, Tier } from "./types";
import { candidateSearchText, id, quote, tierFromScore } from "./utils";

function requireKey(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is missing. Add it on Settings.`);
  return value;
}

function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? text;
  return JSON.parse(candidate) as T;
}

async function openaiJson<T>(settings: Settings, prompt: string): Promise<T> {
  const key = requireKey(settings.OPENAI_API_KEY, "OPENAI_API_KEY");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: "gpt-5.2",
      input: prompt,
      text: {
        format: { type: "json_object" }
      }
    })
  });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const outputText =
    payload.output_text ??
    payload.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n") ??
    "";
  return extractJson<T>(outputText);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function asTier(value: unknown, total: number): Tier {
  return tierFromScore(total);
}

export async function generateQueries(settings: Settings, brief: Brief, promptOverride?: string): Promise<Query[]> {
  if (settings.workflow.mockMode) return mockQueries(brief);
  requireKey(settings.OPENAI_API_KEY, "OPENAI_API_KEY");
  const indiaHelper = brief.locations.some((location) => /india/i.test(location))
    ? `("India" OR "Bengaluru" OR "Bangalore" OR "Mumbai" OR "Delhi" OR "Noida" OR "Gurgaon" OR "Gurugram" OR "Pune" OR "Hyderabad")`
    : "";
  const prompt = `
Generate a LinkedIn X-ray query matrix for a recruiter sourcing workflow.
${promptOverride?.trim() ? `Recruiter-editable instructions:\n${promptOverride.trim()}\n` : ""}
Return only JSON with this shape:
{"queries":[{"query_text":"string","query_type":"profile_location|profile_keyword|profile_education|career_path|intent_post|layoff_post|hiring_comment","expected_filters":["string"],"priority":1,"selected":true,"notes":"string"}]}

Rules:
- Include master/high-precision queries.
- Hard filters: role/title + current company + past company.
- Rotating filters: location, keywords, education, intent phrase, layoff phrase.
- Do not use experience proxy years such as 2019, 2020, 2021 in any query.
- Do not put every filter into one query.
- Use site:linkedin.com/in for profile searches and site:linkedin.com/posts for intent or layoff posts.
- Include exclusion keywords with Google negative quoted terms where useful.
- Query groups should include title + current company + past company + location; title + current company + past company + keyword; title + current company + past company + education; title + keyword + intent phrase; layoff phrase + title + company/keyword; ex-BCG/former Bain/McKinsey alum career paths.
- If India is requested, use this helper in some location queries: ${indiaHelper || "use only the provided city/location variants"}.
- Query text only helps search. Actual location will be validated later from SerpAPI/Apify; do not over-trust query terms.

Brief:
${JSON.stringify(brief, null, 2)}
`;
  const parsed = await openaiJson<{ queries: Omit<Query, "id" | "brief_id">[] }>(settings, prompt);
  return (parsed.queries ?? []).map((query, index) => ({
    id: id("qry"),
    brief_id: brief.id,
    selected: query.selected ?? true,
    priority: Number(query.priority ?? index + 1),
    notes: query.notes ?? "",
    expected_filters: query.expected_filters ?? [],
    query_text: query.query_text,
    query_type: query.query_type
  }));
}

export async function runSerpApiSearch(settings: Settings, query: Query, page: number, startOffset: number, location?: string) {
  if (settings.workflow.mockMode) return mockSerpApi(query, page);
  const key = requireKey(settings.SERPAPI_API_KEY, "SERPAPI_API_KEY");
  const params = new URLSearchParams({
    engine: "google",
    q: query.query_text,
    api_key: key,
    start: String(startOffset),
    num: String(settings.workflow.resultsPerPage || 10),
    google_domain: "google.co.in",
    gl: "in",
    hl: "en"
  });
  params.set("location", location || "India");
  const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
  if (!response.ok) throw new Error(`SerpAPI failed on ${query.id} page ${page}: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function runApify(settings: Settings, candidates: Candidate[], brief?: Brief) {
  if (settings.workflow.mockMode) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    return candidates.map((candidate, index) => ({
      candidate,
      item: mockApifyItem(candidate, index),
      status: (index % 7 === 0 ? "apify_partial" : "apify_success") as "apify_success" | "apify_partial"
    }));
  }
  const token = requireKey(settings.APIFY_API_TOKEN, "APIFY_API_TOKEN");
  const configuredActor = settings.APIFY_ACTOR_ID || "harvestapi/linkedin-profile-scraper";
  const actorId = configuredActor === "LpVuK3Zozwuipa5bp" ? configuredActor : configuredActor.replace("/", "~");
  const urls = candidates.map((candidate) => `https://${candidate.normalized_linkedin_url}`);
  const isHarvestProfileScraper =
    configuredActor.includes("linkedin-profile-scraper") ||
    configuredActor === "LpVuK3Zozwuipa5bp";

  if (isHarvestProfileScraper) {
    const input = {
      profileScraperMode: "Profile details no email ($4 per 1k)",
      queries: urls.slice(0, settings.workflow.maxProfilesToApify)
    };
    const runResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!runResponse.ok) throw new Error(`Apify scraper run failed to start: ${runResponse.status} ${await runResponse.text()}`);
    const runPayload = await runResponse.json();
    const runId = runPayload.data?.id;
    if (!runId) throw new Error("Apify did not return a run id.");
    let run = runPayload.data;
    for (let attempt = 0; attempt < 12 && ["READY", "RUNNING"].includes(run.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
      run = (await poll.json()).data;
    }
    if (!run.defaultDatasetId) throw new Error(`Apify scraper run has no dataset yet. Current status: ${run.status}.`);
    if (!["SUCCEEDED", "RUNNING", "READY"].includes(run.status)) throw new Error(`Apify scraper run ended with status ${run.status}.`);
    const datasetResponse = await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&token=${encodeURIComponent(token)}`);
    if (!datasetResponse.ok) throw new Error(`Apify scraper dataset fetch failed: ${datasetResponse.status}`);
    const items = await datasetResponse.json();
    return candidates.map((candidate, index) => ({
      candidate,
      item: items[index] ?? items.find((item: Record<string, unknown>) => JSON.stringify(item).includes(candidate.normalized_linkedin_url.split("/").pop() ?? "")),
      status: (run.status === "SUCCEEDED" && items[index] ? "apify_success" : "apify_partial") as "apify_success" | "apify_partial"
    }));
  }

  const schemaResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}?token=${encodeURIComponent(token)}`);
  const schema = schemaResponse.ok ? await schemaResponse.json() : undefined;
  const props = schema?.data?.inputSchema?.properties ?? schema?.inputSchema?.properties ?? {};
  const profileUrlKey = ["profileUrls", "profileURLs", "urls", "startUrls"].find((key) => props[key]);
  const input: Record<string, unknown> = {
    maxItems: Math.min(settings.workflow.maxProfilesToApify, candidates.length),
    profileScraperMode: props.profileScraperMode ? "Full" : undefined,
    takePages: props.takePages ? Math.max(1, Math.ceil(Math.min(settings.workflow.maxProfilesToApify, candidates.length) / 25)) : undefined,
    startPage: props.startPage ? 1 : undefined,
    autoQuerySegmentation: props.autoQuerySegmentation ? false : undefined
  };
  if (profileUrlKey) {
    input[profileUrlKey] = profileUrlKey === "startUrls" ? urls.map((url) => ({ url })) : urls;
  } else {
    input.searchQuery = [
      brief?.role_titles?.[0],
      brief?.current_companies?.[0],
      brief?.past_companies?.[0],
      brief?.keywords?.[0] ?? brief?.domains?.[0]
    ]
      .filter(Boolean)
      .join(" ") || candidates.map((candidate) => candidate.name_guess).filter(Boolean).slice(0, 5).join(" OR ");
  }
  Object.keys(input).forEach((key) => input[key] === undefined && delete input[key]);

  const runResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!runResponse.ok) throw new Error(`Apify run failed to start: ${runResponse.status} ${await runResponse.text()}`);
  const runPayload = await runResponse.json();
  const runId = runPayload.data?.id;
  if (!runId) throw new Error("Apify did not return a run id.");

  let run = runPayload.data;
  for (let attempt = 0; attempt < 12 && ["READY", "RUNNING"].includes(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`);
    run = (await poll.json()).data;
  }
  if (!run.defaultDatasetId) throw new Error(`Apify run has no dataset yet. Current status: ${run.status}.`);
  if (!["SUCCEEDED", "RUNNING", "READY"].includes(run.status)) throw new Error(`Apify run ended with status ${run.status}.`);
  const datasetId = run.defaultDatasetId;
  const datasetResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?clean=true&token=${encodeURIComponent(token)}`);
  if (!datasetResponse.ok) throw new Error(`Apify dataset fetch failed: ${datasetResponse.status}`);
  const items = await datasetResponse.json();
  return candidates.map((candidate, index) => ({
    candidate,
    item: items[index] ?? items.find((item: Record<string, unknown>) => JSON.stringify(item).includes(candidate.normalized_linkedin_url.split("/").pop() ?? "")),
    status: (run.status === "SUCCEEDED" && items[index] ? "apify_success" : "apify_partial") as "apify_success" | "apify_partial"
  }));
}

export async function analyzeCandidate(settings: Settings, brief: Brief, candidate: Candidate, mode: "fit_intent" | "fit" | "intent", promptOverride?: string) {
  requireKey(settings.OPENAI_API_KEY, "OPENAI_API_KEY");
  const prompt = `
Analyze this LinkedIn sourcing candidate against the brief. Return only JSON:
${promptOverride?.trim() ? `Recruiter-editable scoring instructions:\n${promptOverride.trim()}\n` : ""}
{
  "fit_score": 0,
  "intent_score": 0,
  "total_score": 0,
  "tier": "Tier 1|Tier 2|Tier 3|Tier 4",
  "fit_evidence": ["string"],
  "intent_evidence": ["string"],
  "missing_data": ["string"],
  "risk_flags": ["string"],
  "recommended_manual_checks": ["string"],
  "short_summary": "string",
  "strengths": "string",
  "concerns": "string",
  "tenure_months": 0,
  "promotion_flag": "string",
  "layoff_signal": "string",
  "open_to_work_signal": "string",
  "hiring_comment_signal": "string",
  "recommended_outreach_angle": "string"
}

Scoring:
- Use the full JD/client brief below as the source of truth for fit. Compare the candidate against role requirements, must-haves, nice-to-haves, domain, location, seniority, exclusions, and intent language from the JD.
- SerpAPI snippets are weak evidence. Apify profile fields are stronger.
- Actual profile location must come from structured/profile location when available.
- Do not infer India from Indian names.
- Do not infer India from "India" appearing in education/company/project text if candidate location is foreign or unknown.
- If location is uncertain, mark unknown and add a manual check.
- fit_score max 70. Consider current title/company, past company, actual location, education, keywords/domain, experience after profile parsing, exclusions.
- intent_score max 30. Consider Open to Work, opportunity language, layoff/restructuring, 24-36 month tenure, 36+ month same-title stagnation, hiring comments.
- Absence of Open to Work is neutral.
- Do not remove or reject automatically.
- If mode is ${mode}, keep unavailable sections conservative, not zero-punitive.
- Tier thresholds are strict: Tier 1 total_score > 80, Tier 2 60-80, Tier 3 30-60, Tier 4 below 30.
- Always rank/summarize candidates based on both match strength and evidence certainty.
- Higher visibility_factor means the profile appeared across more selected queries and should increase confidence when the evidence is relevant.
- Prefer high-confidence matches with Apify-backed title/company/location/experience evidence over snippet-only matches.
- If two candidates have similar fit, the one with stronger evidence and higher visibility should be treated as the surer/better match.

Full JD / client brief and structured filters:
${JSON.stringify(brief)}

Candidate:
${JSON.stringify(candidate)}
`;
  const parsed = await openaiJson<Record<string, unknown>>(settings, prompt);
  const total = Math.max(0, Math.min(100, Number(parsed.total_score ?? Number(parsed.fit_score ?? 0) + Number(parsed.intent_score ?? 0))));
  return {
    ...parsed,
    fit_score: Math.max(0, Math.min(70, Number(parsed.fit_score ?? 0))),
    intent_score: Math.max(0, Math.min(30, Number(parsed.intent_score ?? 0))),
    total_score: total,
    tier: asTier(parsed.tier, total),
    fit_evidence: asStringArray(parsed.fit_evidence),
    intent_evidence: asStringArray(parsed.intent_evidence),
    missing_data: asStringArray(parsed.missing_data),
    risk_flags: asStringArray(parsed.risk_flags),
    recommended_manual_checks: asStringArray(parsed.recommended_manual_checks),
    short_summary: typeof parsed.short_summary === "string" ? parsed.short_summary : "",
    strengths: typeof parsed.strengths === "string" ? parsed.strengths : "",
    concerns: typeof parsed.concerns === "string" ? parsed.concerns : "",
    recommended_outreach_angle: typeof parsed.recommended_outreach_angle === "string" ? parsed.recommended_outreach_angle : "",
    tenure_months: parsed.tenure_months === undefined ? undefined : Number(parsed.tenure_months),
    promotion_flag: typeof parsed.promotion_flag === "string" ? parsed.promotion_flag : undefined,
    layoff_signal: typeof parsed.layoff_signal === "string" ? parsed.layoff_signal : undefined,
    open_to_work_signal: typeof parsed.open_to_work_signal === "string" ? parsed.open_to_work_signal : undefined,
    hiring_comment_signal: typeof parsed.hiring_comment_signal === "string" ? parsed.hiring_comment_signal : undefined
  };
}

export async function testProvider(settings: Settings, provider: string) {
  if (provider === "openai") {
    await openaiJson(settings, "Return JSON only: {\"ok\":true,\"message\":\"OpenAI reachable\"}");
    return { ok: true, message: "OpenAI test succeeded." };
  }
  if (provider === "serpapi") {
    const key = requireKey(settings.SERPAPI_API_KEY, "SERPAPI_API_KEY");
    const response = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent("site:linkedin.com/in Product Manager")}&api_key=${encodeURIComponent(key)}&num=1`);
    if (!response.ok) throw new Error(await response.text());
    return { ok: true, message: "SerpAPI test succeeded." };
  }
  if (provider === "apify") {
    const token = requireKey(settings.APIFY_API_TOKEN, "APIFY_API_TOKEN");
    const configuredActor = settings.APIFY_ACTOR_ID || "harvestapi/linkedin-profile-scraper";
    const actorId = configuredActor === "LpVuK3Zozwuipa5bp" ? configuredActor : configuredActor.replace("/", "~");
    const response = await fetch(`https://api.apify.com/v2/acts/${actorId}?token=${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error(await response.text());
    return { ok: true, message: "Apify actor lookup succeeded." };
  }
  if (provider === "apollo") {
    requireKey(settings.APOLLO_API_KEY, "APOLLO_API_KEY");
    return { ok: true, message: "Apollo key is present. Full test runs during enrichment to avoid spending credits." };
  }
  throw new Error("Unknown provider.");
}

export async function enrichApollo(settings: Settings, candidate: Candidate, revealEmail: boolean, revealPhone: boolean) {
  const key = requireKey(settings.APOLLO_API_KEY, "APOLLO_API_KEY");
  const name = candidate.profile_data?.name ?? candidate.name_guess;
  const [first_name, ...lastParts] = name.split(/\s+/);
  const body = {
    api_key: key,
    first_name,
    last_name: lastParts.join(" "),
    name,
    linkedin_url: `https://${candidate.normalized_linkedin_url}`,
    organization_name: candidate.profile_data?.current_company ?? candidate.company_guess,
    title: candidate.profile_data?.current_title ?? candidate.title_guess,
    city: candidate.profile_data?.location,
    reveal_personal_emails: revealEmail,
    reveal_phone_number: revealPhone,
    run_waterfall_email: revealEmail,
    run_waterfall_phone: revealPhone
  };
  const response = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Apollo enrichment failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export function makeApifySearchFallbackQuery(brief?: Brief) {
  return [
    ...(brief?.role_titles ?? []).slice(0, 2).map(quote),
    ...(brief?.current_companies ?? []).slice(0, 2).map(quote),
    ...(brief?.past_companies ?? []).slice(0, 2).map(quote)
  ].join(" ");
}

export function summarizeEvidence(candidate: Candidate) {
  const text = candidateSearchText(candidate);
  return text.slice(0, 1200);
}

function mockQueries(brief: Brief): Query[] {
  const title = brief.role_titles[0] ?? "Product Manager";
  const company = brief.current_companies[0] ?? "Razorpay";
  const past = brief.past_companies[0] ?? "BCG";
  const keyword = brief.keywords[0] ?? "payments";
  const location = brief.locations[0] ?? "Bangalore";
  const texts = [
    [`site:linkedin.com/in ${quote(title)} ${quote(company)} ${quote(past)} (${quote(location)} OR "Bengaluru")`, "profile_location"],
    [`site:linkedin.com/in ${quote(title)} ${quote(company)} ${quote(past)} ${quote(keyword)}`, "profile_keyword"],
    [`site:linkedin.com/in ${quote(title)} ${quote(company)} ${quote(past)} ("IIT" OR "IIM" OR "BITS" OR "ISB")`, "profile_education"],
    [`site:linkedin.com/posts ("open to work" OR "looking for opportunities") ${quote(title)} ${quote(keyword)}`, "intent_post"],
    [`site:linkedin.com/posts ("laid off" OR "impacted by layoffs") ${quote(title)} (${quote(company)} OR ${quote(keyword)})`, "layoff_post"],
    [`site:linkedin.com/in ("ex-BCG" OR "former Bain" OR "McKinsey alum") ${quote(title)} ${quote(keyword)}`, "career_path"]
  ] as Array<[string, Query["query_type"]]>;
  return texts.map(([query_text, query_type], index) => ({ id: id("qry"), brief_id: brief.id, query_text, query_type, expected_filters: [query_type], priority: index + 1, selected: true, notes: "Mock query" }));
}

function mockSerpApi(query: Query, page: number) {
  const base = [
    { title: "Aarav Mehta on LinkedIn", link: "https://www.linkedin.com/in/aarav-mehta-pm", displayed_link: "linkedin.com/in/aarav-mehta-pm", snippet: "Product Manager at Razorpay · Location: Bengaluru, Karnataka, India · payments UPI", rich_snippet: { top: { extensions: ["Bengaluru, Karnataka, India"] } } },
    { title: "Priya Sharma on LinkedIn", link: "https://www.linkedin.com/in/priya-sharma-growth", displayed_link: "linkedin.com/in/priya-sharma-growth", snippet: "Growth PM at PhonePe · Education: IIT Delhi · Location: Mumbai · open to work" },
    { title: "Rohan Iyer on LinkedIn", link: "https://in.linkedin.com/in/rohan-iyer-london", displayed_link: "in.linkedin.com/in/rohan-iyer-london", snippet: "Indian fintech PM, built India payments projects · Location: London, England", rich_snippet: { top: { extensions: ["London, England, United Kingdom"] } } },
    { title: "Neha Gupta on LinkedIn", link: "https://www.linkedin.com/in/neha-gupta-sf", displayed_link: "linkedin.com/in/neha-gupta-sf", snippet: "Product Lead at CRED · Education: ISB India · Location: San Francisco, United States", about_this_result: { source: { description: "Location: San Francisco, United States" } } },
    { title: "Karan Malhotra on LinkedIn", link: "https://www.linkedin.com/in/karan-malhotra-unknown", displayed_link: "linkedin.com/in/karan-malhotra-unknown", snippet: "Product Manager at Razorpay · B2B SaaS · no visible location" },
    { title: "Open to work post by unknown", link: "https://www.linkedin.com/posts/someone_open-to-work-product-manager-activity", displayed_link: "linkedin.com/posts/someone", snippet: "Open to work after layoffs. Product manager in fintech." },
    { title: "LinkedIn Jobs", link: "https://www.linkedin.com/jobs/view/123", displayed_link: "linkedin.com/jobs", snippet: "Product Manager role in India" }
  ];
  return { organic_results: base.map((item, index) => ({ ...item, position: index + 1 + (page - 1) * 10 })) };
}

function mockApifyItem(candidate: Candidate, index: number) {
  const foreign = /sf|london/i.test(candidate.normalized_linkedin_url) || index === 3;
  const unknown = /unknown/i.test(candidate.normalized_linkedin_url);
  return {
    name: candidate.name_guess || `Mock Candidate ${index + 1}`,
    headline: index % 4 === 0 ? "Open to Work - Product Manager, payments and fintech" : "Product Manager | fintech | payments",
    about: index % 5 === 0 ? "Impacted by layoffs and exploring product roles." : "Built UPI, lending, and growth products.",
    location: foreign ? "San Francisco, United States" : unknown ? "" : "Bengaluru, Karnataka, India",
    currentTitle: index % 3 === 0 ? "Senior Product Manager" : "Product Manager",
    currentCompany: candidate.company_guess || "Razorpay",
    experience: [
      { title: index % 3 === 0 ? "Senior Product Manager" : "Product Manager", company: candidate.company_guess || "Razorpay", startDate: index % 2 === 0 ? "2023-01" : undefined, location: foreign ? "San Francisco" : "Bengaluru" },
      { title: "Associate Consultant", company: index % 2 === 0 ? "BCG" : "Bain", startDate: "2020-01", endDate: "2022-12" }
    ],
    education: [{ schoolName: "IIM Bangalore" }],
    skills: ["Product Management", "UPI", "Fintech", "Growth"],
    posts: index % 5 === 0 ? ["Open to work after restructuring"] : []
  };
}
