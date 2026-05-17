export type QueryType =
  | "profile_location"
  | "profile_domain"
  | "profile_education"
  | "profile_year"
  | "career_path"
  | "intent_post"
  | "layoff_post"
  | "hiring_comment";

export type Tier = "Tier 1" | "Tier 2" | "Tier 3" | "Tier 4";
export type ManualStatus = "pending" | "approved" | "rejected";

export type IntentEvidenceSource = {
  id: string;
  url: string;
  title: string;
  snippet: string;
  query_id: string;
  query_text: string;
  query_type: QueryType;
  page: number;
  source_status: "linked_to_profile" | "author_profile_missing";
  matched_candidate_id?: string;
};

export type WorkflowSettings = {
  defaultSerpPages: 1 | 2 | 3 | 5;
  resultsPerPage: number;
  maxQueriesPerRun: number;
  maxProfilesToApify: number;
  apolloEmailRevealEnabled: boolean;
  apolloPhoneRevealEnabled: boolean;
  apolloPhoneRevealOnlySelectedTiers: boolean;
};

export type SecretSettings = {
  OPENAI_API_KEY?: string;
  SERPAPI_API_KEY?: string;
  APIFY_API_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  APOLLO_API_KEY?: string;
};

export type Settings = SecretSettings & {
  workflow: WorkflowSettings;
};

export type PublicSettings = {
  keyPresence: Record<keyof SecretSettings, boolean>;
  workflow: WorkflowSettings;
  apifyActorId: string;
};

export type Brief = {
  id: string;
  role_titles: string[];
  current_companies: string[];
  past_companies: string[];
  domains: string[];
  locations: string[];
  education: string[];
  years: string[];
  intent_terms: string[];
  exclusions: string[];
  jd_text: string;
  expansions: Record<string, string[]>;
  created_at: string;
};

export type Query = {
  id: string;
  brief_id: string;
  query_text: string;
  query_type: QueryType;
  expected_filters: string[];
  selected: boolean;
  priority: number;
  notes: string;
};

export type SerpResult = {
  id: string;
  query_id: string;
  query_text: string;
  query_type: QueryType;
  title: string;
  link: string;
  displayed_link?: string;
  normalized_url?: string;
  snippet: string;
  position: number;
  page: number;
  raw_json: unknown;
};

export type ProfileData = {
  name?: string;
  headline?: string;
  about?: string;
  location?: string;
  current_title?: string;
  current_company?: string;
  past_companies?: string[];
  experience?: Array<Record<string, unknown>>;
  education?: Array<Record<string, unknown> | string>;
  skills?: string[];
  posts?: Array<Record<string, unknown> | string>;
};

export type Candidate = {
  id: string;
  normalized_linkedin_url: string;
  original_urls: string[];
  name_guess: string;
  title_guess: string;
  company_guess: string;
  snippets: string[];
  visibility_factor: number;
  matched_query_ids: string[];
  matched_query_types: QueryType[];
  matched_filter_hints: string[];
  intent_evidence_sources: IntentEvidenceSource[];
  raw_source_flags: string[];
  serp_evidence: SerpResult[];
  source: "serpapi" | "manual";
  status: string;
  apify_status: "pending_apify" | "apify_success" | "apify_partial" | "apify_failed";
  apify_raw?: unknown;
  profile_data?: ProfileData;
  fit_score?: number;
  intent_score?: number;
  total_score?: number;
  tier?: Tier;
  fit_evidence: string[];
  intent_evidence: string[];
  missing_data: string[];
  risk_flags: string[];
  recommended_manual_checks: string[];
  short_summary?: string;
  strengths?: string;
  concerns?: string;
  manual_status: ManualStatus;
  manual_notes: string;
  needs_contact_enrichment: boolean;
  apollo_status: "not_started" | "enriched" | "not_found" | "failed" | "skipped";
  email?: string;
  email_source?: "apollo";
  email_status?: string;
  phone?: string;
  phone_source?: "apollo";
  phone_status?: string;
  apollo_raw_json?: unknown;
  apollo_credit_estimate?: number;
  final_notes?: string;
  recommended_outreach_angle?: string;
  tenure_months?: number;
  promotion_flag?: string;
  layoff_signal?: string;
  open_to_work_signal?: string;
  hiring_comment_signal?: string;
};

export type ApolloTierSelection = Record<Tier, { email: boolean; phone: boolean }>;

export type OneClickRun = {
  jd_text: string;
  brief?: Brief;
  queries: Query[];
  serpResults: SerpResult[];
  candidates: Candidate[];
  intentEvidenceSources: IntentEvidenceSource[];
  status: "idle" | "running" | "completed" | "failed";
  error?: string;
  started_at?: string;
  completed_at?: string;
  funnel: Array<{ step: string; count: number; note: string }>;
};

export type AppStatus = {
  currentStep: number;
  messages: string[];
  errors: string[];
  lastUpdated: string;
};

export type AppState = {
  brief?: Brief;
  queries: Query[];
  serpResults: SerpResult[];
  candidates: Candidate[];
  rawSerpRuns: Array<{ id: string; query_id: string; page: number; response: unknown; created_at: string }>;
  intentEvidenceSources: IntentEvidenceSource[];
  oneClick: OneClickRun;
  apolloTierSelection: ApolloTierSelection;
  status: AppStatus;
};
