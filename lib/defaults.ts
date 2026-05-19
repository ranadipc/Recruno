import type { ApolloTierSelection, AppState, Settings, WorkflowSettings } from "./types";

export const DEFAULT_WORKFLOW: WorkflowSettings = {
  defaultSerpPages: 2,
  resultsPerPage: 10,
  maxQueriesPerRun: 5,
  maxProfilesToApify: 30,
  apolloEmailRevealEnabled: true,
  apolloPhoneRevealEnabled: true,
  apolloPhoneRevealOnlySelectedTiers: true,
  mockMode: false
};

export const DEFAULT_APOLLO_TIERS: ApolloTierSelection = {
  "Tier 1": { email: true, phone: true },
  "Tier 2": { email: true, phone: true },
  "Tier 3": { email: true, phone: false },
  "Tier 4": { email: false, phone: false }
};

export const DEFAULT_SETTINGS: Settings = {
  APIFY_ACTOR_ID: "harvestapi/linkedin-profile-scraper",
  workflow: DEFAULT_WORKFLOW
};

export const DEFAULT_STATE: AppState = {
  queries: [],
  serpResults: [],
  rejectedSerpResults: [],
  candidates: [],
  rawSerpRuns: [],
  intentEvidenceSources: [],
  profileFilters: {
    actual_location_must_include: [],
    current_title_must_include: [],
    current_company_must_include: [],
    past_company_must_include: [],
    keywords_must_include: [],
    education_must_include: [],
    require_open_to_work: false,
    require_layoff_signal: false,
    require_no_promotion_signal: false,
    exclude_terms: []
  },
  promptOverrides: {},
  oneClick: {
    jd_text: "",
    queries: [],
    serpResults: [],
    candidates: [],
    intentEvidenceSources: [],
    status: "idle",
    funnel: []
  },
  apolloTierSelection: DEFAULT_APOLLO_TIERS,
  status: {
    currentStep: 1,
    messages: ["Prototype initialized."],
    errors: [],
    lastUpdated: new Date().toISOString()
  }
};
