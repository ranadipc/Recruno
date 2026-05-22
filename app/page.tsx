"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApolloTierSelection, AppState, Candidate, ProfileFilters, PublicSettings, Query, QueryType, SavedWorkflow, Tier, WorkflowSettings } from "@/lib/types";
import { DEFAULT_APOLLO_TIERS, DEFAULT_WORKFLOW } from "@/lib/defaults";

const steps = [
  "Setup + API Keys",
  "JD Brief",
  "OpenAI Queries",
  "SerpAPI Search",
  "Clean + Dedupe",
  "Apify Profiles",
  "Profile Filters",
  "OpenAI Fit Score",
  "Review + Download",
  "Apollo Enrichment",
  "Final Sheet"
];
const queryTypes: QueryType[] = ["profile_location", "profile_keyword", "profile_education", "career_path"];
const tiers: Tier[] = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];

type Estimate = { email: number; phone: number; total: number; selected: number } | null;
const WORKFLOW_BACKUP_KEY = "recruno-automated-leads.workflow-state.v1";

function emptyState(): AppState {
  return {
    queries: [],
    serpResults: [],
    rejectedSerpResults: [],
    candidates: [],
    rawSerpRuns: [],
    intentEvidenceSources: [],
    promptOverrides: {},
    profileFilters: {
      actual_location_must_include: ["India", "Bangalore", "Bengaluru", "Mumbai"],
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
    status: { currentStep: 1, messages: [], errors: [], lastUpdated: new Date().toISOString() }
  };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  const json = await response.json().catch(() => ({}));
  const statusError = Array.isArray(json.status?.errors) ? json.status.errors[0] : undefined;
  const stateError = Array.isArray(json.state?.status?.errors) ? json.state.status.errors[0] : undefined;
  if (!response.ok) throw new Error(json.error || json.message || statusError || stateError || "Request failed.");
  return json as T;
}

function downloadUrl(format: "csv" | "xlsx" | "json", includeRejected = false) {
  return `/api/export/${format}${includeRejected ? "?includeRejected=1" : ""}`;
}

function oneClickDownloadUrl(format: "csv" | "xlsx" | "json") {
  return `/api/one-click/export/${format}`;
}

function displayName(candidate: Candidate) {
  return candidate.profile_data?.name || candidate.name_guess || "Unnamed profile";
}

function profileUrl(candidate: Candidate) {
  return candidate.normalized_linkedin_url.startsWith("linkedin.com/in/") ? `https://${candidate.normalized_linkedin_url}` : "";
}

function badgeClass(value?: string) {
  if (!value) return "badge neutral";
  if (/tier 1|found|enriched|approved|success|visible|passed/i.test(value)) return "badge good";
  if (/tier 2|pending|partial/i.test(value)) return "badge info";
  if (/tier 3|missing|not_requested|skipped|manual/i.test(value)) return "badge warn";
  if (/tier 4|failed|rejected|risk|not_found/i.test(value)) return "badge bad";
  return "badge neutral";
}

function apifyStatusLabel(status: Candidate["apify_status"]) {
  return status === "apify_success" || status === "apify_partial" ? "apify_success" : status === "apify_failed" ? "apify_failed" : "pending_apify";
}

function isRejectedCandidate(candidate: Candidate) {
  return candidate.manual_status === "rejected" || candidate.status === "ai_rejected" || candidate.status === "deleted";
}

function SmallButton({ children, onClick, disabled, variant = "secondary" }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button className={`button ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function Field({ label, value, onChange, placeholder, textarea = false, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; textarea?: boolean; type?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {textarea ? <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={4} /> : <input value={value} type={type} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />}
    </label>
  );
}

function parseUiTerms(value: string) {
  return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

type PromptKind = "queryGeneration" | "cleanScreening" | "profileFilters" | "scoring";

function workflowWeight(value: AppState) {
  return [
    value.brief ? 25 : 0,
    value.queries.length,
    value.serpResults.length,
    value.rejectedSerpResults.length,
    value.candidates.length * 2,
    value.rawSerpRuns.length,
    value.intentEvidenceSources.length,
    value.oneClick?.candidates?.length ?? 0
  ].reduce((sum, item) => sum + item, 0);
}

function workflowTime(value: AppState) {
  return Date.parse(value.status?.lastUpdated ?? "") || 0;
}

function betterWorkflowState(a: AppState | null, b: AppState | null) {
  if (!a) return b;
  if (!b) return a;
  const aWeight = workflowWeight(a);
  const bWeight = workflowWeight(b);
  if (aWeight !== bWeight) return aWeight > bWeight ? a : b;
  return workflowTime(a) >= workflowTime(b) ? a : b;
}

function readWorkflowBackup() {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WORKFLOW_BACKUP_KEY) || "null") as AppState | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeWorkflowBackup(value: AppState) {
  if (typeof window === "undefined") return;
  if (workflowWeight(value) <= 0) {
    window.localStorage.removeItem(WORKFLOW_BACKUP_KEY);
    return;
  }
  window.localStorage.setItem(WORKFLOW_BACKUP_KEY, JSON.stringify(value));
}

function clearWorkflowBackup() {
  if (typeof window !== "undefined") window.localStorage.removeItem(WORKFLOW_BACKUP_KEY);
}

function defaultPromptOverride(kind: PromptKind) {
  if (kind === "queryGeneration") {
    return [
      "Generate at most 5 rich LinkedIn profile X-ray queries.",
      "Strictly use only terms the recruiter entered in the brief. Do not add consulting firms, schools, companies, titles, or keywords that are not in the brief.",
      "Do not generate hiring posts, layoff posts, hiring comments, or linkedin.com/posts queries.",
      "Every query must include the most specific user-entered must-have keywords, especially exact company/brand phrases from the JD.",
      "Do not use experience proxy years in search queries.",
      "Keep location variants only for user-entered locations, for example Bangalore/Bengaluru and Gurgaon/Gurugram."
    ].join("\n");
  }
  if (kind === "profileFilters") {
    return [
      "Apply filters only to parsed profile evidence, not to weak keyword mentions.",
      "Actual location should come from the LinkedIn profile location first, then strong SerpAPI location evidence.",
      "Do not reject uncertain profiles silently. Label fail reasons and allow manual inclusion.",
      "Experience, tenure, promotion, Open to Work, and layoff checks belong here after Apify parsing."
    ].join("\n");
  }
  if (kind === "cleanScreening") {
    return [
      "Screen cleaned LinkedIn candidates before Apify.",
      "Use the JD/brief and visible SERP evidence to reject obvious bad fits.",
      "Reject wrong function, wrong seniority, excluded titles, unrelated education-only matches, and profiles that only matched a loose keyword.",
      "If a candidate might fit but evidence is thin, mark review instead of reject.",
      "Do not reject only because location is unknown.",
      "Keep reasons short and practical for recruiters."
    ].join("\n");
  }
  return [
    "Rank candidates by surety of good match.",
    "Use visibility_factor as a confidence signal when the repeated matches are relevant.",
    "Prefer Apify-backed profile evidence over SerpAPI snippets.",
    "Score fit out of 100 using a role-specific rubric you derive from the JD.",
    "Choose the rubric weights yourself based on what matters for this role, such as title, company, past company, actual location, keywords, experience, tenure, education, exclusions, and evidence certainty.",
    "Use Open to Work, layoff, tenure, and no-promotion as supporting signals only. They should help prioritize strong-fit candidates, not inflate weak-fit candidates.",
    "Set total_score equal to the final fit score out of 100.",
    "A high score should require strong fit plus clear evidence for title, company, actual location, keywords, and seniority.",
    "If evidence is weak or location/company/title is uncertain, lower confidence and add manual checks."
  ].join("\n");
}

export default function Home() {
  const [state, setState] = useState<AppState>(emptyState());
  const [settings, setSettings] = useState<PublicSettings>({
    keyPresence: { OPENAI_API_KEY: false, SERPAPI_API_KEY: false, APIFY_API_TOKEN: false, APIFY_ACTOR_ID: true, APOLLO_API_KEY: false },
    workflow: DEFAULT_WORKFLOW,
    apifyActorId: "harvestapi/linkedin-profile-scraper"
  });
  const [activeStep, setActiveStep] = useState(1);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [evidenceCandidate, setEvidenceCandidate] = useState<Candidate | null>(null);
  const [promptEditor, setPromptEditor] = useState<PromptKind | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [localPromptOverrides, setLocalPromptOverrides] = useState<Partial<Record<PromptKind, string>>>({});
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([]);
  const [workflowName, setWorkflowName] = useState("PM workflow");
  const [oneClickText, setOneClickText] = useState("");
  const [oneClickSettings, setOneClickSettings] = useState({ pagesPerQuery: 2, maxSearches: 100, maxCandidates: 50, location: "India" });
  const [briefForm, setBriefForm] = useState({
    role_titles: "",
    current_companies: "",
    past_companies: "",
    keywords: "",
    education: "",
    locations: "",
    intent_terms: "",
    exclusions: "",
    jd_text: ""
  });
  const [secretForm, setSecretForm] = useState({
    OPENAI_API_KEY: "",
    SERPAPI_API_KEY: "",
    APIFY_API_TOKEN: "",
    APIFY_ACTOR_ID: "harvestapi/linkedin-profile-scraper",
    APOLLO_API_KEY: ""
  });
  const [workflow, setWorkflow] = useState<WorkflowSettings>(DEFAULT_WORKFLOW);
  const [runSettings, setRunSettings] = useState({ pagesPerQuery: 2, startOffset: 0, delayMs: 0, location: "India", targetCountry: "India", strictIndiaOnly: true, keepUnknownLocation: true });
  const [scoreSettings, setScoreSettings] = useState({ maxCandidates: 50, onlyScraped: true });
  const [apifyBatchSize, setApifyBatchSize] = useState(DEFAULT_WORKFLOW.maxProfilesToApify);
  const [profileFilterForm, setProfileFilterForm] = useState<ProfileFilters>({
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
  });
  const [tierSelection, setTierSelection] = useState<ApolloTierSelection>(DEFAULT_APOLLO_TIERS);
  const [useAllNonRejected, setUseAllNonRejected] = useState(true);
  const [apolloEstimate, setApolloEstimate] = useState<Estimate>(null);
  const [finalFilter, setFinalFilter] = useState({ tier: "all", contact: "all", search: "" });
  const stateRef = useRef<AppState>(emptyState());
  const busyRef = useRef("");

  function commitState(nextState: AppState, options: { allowWeaker?: boolean; reason?: string } = {}) {
    const current = stateRef.current;
    const currentWeight = workflowWeight(current);
    const nextWeight = workflowWeight(nextState);
    if (!options.allowWeaker && busyRef.current && nextWeight < currentWeight) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[Recruno] Ignored stale/weaker workflow snapshot during busy action", {
          busy: busyRef.current,
          reason: options.reason,
          currentWeight,
          nextWeight,
          currentCandidates: current.candidates.length,
          nextCandidates: nextState.candidates.length
        });
      }
      return false;
    }
    stateRef.current = nextState;
    setState(nextState);
    writeWorkflowBackup(nextState);
    return true;
  }

  async function refresh(keepStep = false) {
    const [nextState, nextSettings, workflows] = await Promise.all([api<AppState>("/api/state"), api<PublicSettings>("/api/settings"), api<SavedWorkflow[]>("/api/workflows")]);
    const backup = readWorkflowBackup();
    const localBest = betterWorkflowState(stateRef.current, backup);
    const best = betterWorkflowState(nextState, localBest);
    const shouldRestoreLocal = best !== nextState && workflowWeight(best ?? emptyState()) > workflowWeight(nextState);
    const chosenState = best ?? nextState;
    if (shouldRestoreLocal) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[Recruno] Restoring stronger local workflow snapshot", {
          serverWeight: workflowWeight(nextState),
          localWeight: workflowWeight(chosenState),
          serverCandidates: nextState.candidates.length,
          localCandidates: chosenState.candidates.length
        });
      }
      commitState(chosenState, { allowWeaker: true, reason: "refresh local restore" });
      setSavedWorkflows(workflows);
      setSettings(nextSettings);
      setWorkflow(nextSettings.workflow);
      await api<AppState>("/api/state", { method: "POST", body: JSON.stringify({ state: chosenState }) }).catch(() => chosenState);
      setHydrated(true);
      return;
    }
    const accepted = commitState(chosenState, { reason: "refresh" });
    if (!accepted) return;
    setSettings(nextSettings);
    setSavedWorkflows(workflows);
    setWorkflow(nextSettings.workflow);
    setSecretForm((form) => ({ ...form, APIFY_ACTOR_ID: nextSettings.apifyActorId }));
    setTierSelection(nextState.apolloTierSelection);
    setProfileFilterForm(nextState.profileFilters);
    if (!keepStep) setActiveStep(Math.min(nextState.status.currentStep || 1, steps.length));
    setHydrated(true);
  }

  useEffect(() => {
    refresh().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (busy || (!notice && state.status.errors.length === 0)) return;
    const timer = window.setTimeout(() => {
      clearToast().catch(() => undefined);
    }, state.status.errors.length ? 12000 : 5000);
    return () => window.clearTimeout(timer);
  }, [busy, notice, state.status.errors.length]);

  async function clearToast() {
    setNotice("");
    if (state.status.errors.length > 0) {
      const next = await api<AppState>("/api/state", { method: "POST", body: JSON.stringify({ clearErrors: true }) });
      commitState(next, { reason: "clear toast" });
    }
  }

  async function runAction<T>(label: string, action: () => Promise<T>, after?: (value: T) => void | Promise<void>) {
    if (busy) return;
    if (process.env.NODE_ENV === "development") console.log(`[Recruno] ${label} started`);
    busyRef.current = label;
    setBusy(label);
    setNotice("");
    try {
      const result = await action();
      await after?.(result);
      if (!after && result && typeof result === "object" && "status" in result) commitState(result as unknown as AppState, { allowWeaker: true, reason: label });
      setNotice(`${label} completed`);
      if (process.env.NODE_ENV === "development") console.log(`[Recruno] ${label} completed`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label} failed`);
      if (process.env.NODE_ENV === "development") console.error(`[Recruno] ${label} failed`, error);
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  }

  const profileCandidates = state.candidates.filter((candidate) => candidate.normalized_linkedin_url.startsWith("linkedin.com/in/"));
  const rejectedProfileCount = profileCandidates.filter(isRejectedCandidate).length;
  const shortlistedCandidates = profileCandidates.filter((candidate) => !isRejectedCandidate(candidate));
  const selectedQueries = state.queries.filter((query) => query.selected);
  const apifySuccessCount = shortlistedCandidates.filter((c) => c.apify_status === "apify_success" || c.apify_status === "apify_partial").length;
  const apifyFailCount = shortlistedCandidates.filter((c) => c.apify_status === "apify_failed").length;
  const apifyPendingCount = shortlistedCandidates.filter((c) => c.apify_status === "pending_apify").length;
  const scoredCount = shortlistedCandidates.filter((c) => typeof c.total_score === "number").length;
  const approvedCount = shortlistedCandidates.filter((candidate) => candidate.manual_status === "approved").length;
  const tierCounts = Object.fromEntries(tiers.map((tier) => [tier, shortlistedCandidates.filter((candidate) => (candidate.tier ?? "Tier 4") === tier).length])) as Record<Tier, number>;
  const foundEmails = shortlistedCandidates.filter((candidate) => candidate.email).length;
  const foundPhones = shortlistedCandidates.filter((candidate) => candidate.phone).length;
  const isOneClick = activeStep === 12;
  const oneClickCandidates = state.oneClick.candidates.filter((candidate) => candidate.normalized_linkedin_url.startsWith("linkedin.com/in/"));

  function openPromptEditor(kind: PromptKind) {
    setPromptEditor(kind);
    setPromptDraft(localPromptOverrides[kind] || defaultPromptOverride(kind));
  }

  function savePromptOverride() {
    if (!promptEditor) return;
    setLocalPromptOverrides((current) => ({ ...current, [promptEditor]: promptDraft }));
    setPromptEditor(null);
    setNotice("Prompt saved for this browser session only");
  }

  async function manualRefresh() {
    setNotice("");
    await refresh(true);
    setNotice("Step refreshed");
  }

  const selectedForApollo = useMemo(() => {
    return shortlistedCandidates.filter((candidate) => {
      if (!candidate.needs_contact_enrichment) return false;
      if (useAllNonRejected ? candidate.manual_status === "rejected" : candidate.manual_status !== "approved") return false;
      const pick = tierSelection[(candidate.tier ?? "Tier 4") as Tier];
      return Boolean(pick?.email || pick?.phone);
    });
  }, [shortlistedCandidates, tierSelection, useAllNonRejected]);

  const liveEstimate = useMemo(() => {
    const estimate = selectedForApollo.reduce(
      (acc, candidate) => {
        const pick = tierSelection[(candidate.tier ?? "Tier 4") as Tier];
        if (pick?.email) acc.email += 1;
        if (pick?.phone) acc.phone += 1;
        return acc;
      },
      { email: 0, phone: 0, total: 0, selected: selectedForApollo.length }
    );
    estimate.total = estimate.email + estimate.phone * 8;
    return estimate;
  }, [selectedForApollo, tierSelection]);

  const finalRows = useMemo(() => {
    const search = finalFilter.search.toLowerCase().trim();
    return shortlistedCandidates
      .filter((candidate) => finalFilter.tier === "all" || candidate.tier === finalFilter.tier)
      .filter((candidate) => {
        if (finalFilter.contact === "all") return true;
        if (finalFilter.contact === "email_found") return Boolean(candidate.email);
        if (finalFilter.contact === "phone_found") return Boolean(candidate.phone);
        if (finalFilter.contact === "missing") return !candidate.email && !candidate.phone;
        return true;
      })
      .filter((candidate) => {
        if (!search) return true;
        return [displayName(candidate), candidate.profile_data?.current_company, candidate.company_guess, candidate.profile_data?.current_title, candidate.title_guess].join(" ").toLowerCase().includes(search);
      })
      .sort((a, b) => Number(b.total_score ?? 0) - Number(a.total_score ?? 0) || b.visibility_factor - a.visibility_factor);
  }, [shortlistedCandidates, finalFilter]);

  function updateQuery(index: number, patch: Partial<Query>) {
    const queries = [...state.queries];
    queries[index] = { ...queries[index], ...patch };
    commitState({ ...state, queries }, { reason: "local query edit" });
  }

  function updateCandidate(id: string, patch: Partial<Candidate>) {
    commitState({ ...state, candidates: state.candidates.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)) }, { reason: "local candidate edit" });
  }

  async function saveQueries() {
    const next = await api<AppState>("/api/queries/update", { method: "POST", body: JSON.stringify({ queries: state.queries }) });
    commitState(next, { reason: "save queries" });
  }

  async function saveCandidates() {
    const next = await api<AppState>("/api/candidates/update", { method: "POST", body: JSON.stringify({ candidates: state.candidates }) });
    commitState(next, { reason: "save candidates" });
  }

  async function saveBriefAndContinue() {
    await runAction("Save brief", () => api<AppState>("/api/brief", { method: "POST", body: JSON.stringify(briefForm) }), (next) => {
      commitState(next, { allowWeaker: true, reason: "save brief" });
      setActiveStep(3);
    });
  }

  async function saveWorkflow() {
    const response = await api<{ workflows: SavedWorkflow[] }>("/api/workflows", { method: "POST", body: JSON.stringify({ action: "save", name: workflowName }) });
    setSavedWorkflows(response.workflows);
  }

  async function loadWorkflow(id: string) {
    const response = await api<{ state: AppState; workflows: SavedWorkflow[] }>("/api/workflows", { method: "POST", body: JSON.stringify({ action: "load", id }) });
    commitState(response.state, { allowWeaker: true, reason: "load workflow" });
    setSavedWorkflows(response.workflows);
    setActiveStep(Math.min(response.state.status.currentStep || 1, steps.length));
  }

  async function deleteWorkflow(id: string) {
    const response = await api<{ workflows: SavedWorkflow[] }>("/api/workflows", { method: "POST", body: JSON.stringify({ action: "delete", id }) });
    setSavedWorkflows(response.workflows);
  }

  async function handleImport(file: File) {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/import", { method: "POST", body: form });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error || "Import failed.");
    commitState(next, { allowWeaker: true, reason: "import" });
  }

  async function resetData() {
    const next = await api<AppState>("/api/state", { method: "DELETE" });
    clearWorkflowBackup();
    commitState(next, { allowWeaker: true, reason: "reset data" });
    setActiveStep(1);
    setNotice("Workflow data reset");
  }

  async function handleOneClickFile(file: File) {
    setOneClickText(await file.text());
  }

  async function scrapeProfilesWithApify(runAll = false) {
    const next = await api<AppState>("/api/apify/run", {
      method: "POST",
      body: JSON.stringify({
        maxProfiles: apifyBatchSize,
        runAll,
        candidates: shortlistedCandidates
      })
    });
    commitState(next, { reason: "apify scrape" });
    await refresh(true);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <h1>Recruno Automated Leads</h1>
            <p>Recruiter-ready sourcing workflow</p>
          </div>
        </div>
        <nav className="steps">
          {steps.map((step, index) => {
            const number = index + 1;
            return (
              <button key={step} className={activeStep === number ? "active" : ""} onClick={() => !busy && setActiveStep(number)} disabled={Boolean(busy)}>
                <span>{number}</span>
                {step}
              </button>
            );
          })}
          <div className="sidebar-divider" />
          <button className={isOneClick ? "active one-click-nav" : "one-click-nav"} onClick={() => !busy && setActiveStep(12)} disabled={Boolean(busy)}>
            <span>1</span>
            One Click
          </button>
        </nav>
      </aside>

      <section className="workspace">
        {!hydrated && <div className="app-loading"><div className="spinner" /><strong>Loading saved workflow state...</strong></div>}
        <header className="topbar">
          <div>
            <h2>{isOneClick ? "One Click" : steps[activeStep - 1]}</h2>
                <p>{isOneClick ? "Paste a JD, click Start, and stop at the scored shortlist before Apollo." : helperCopy(activeStep)}</p>
          </div>
          <div className="top-actions">
            <span className="mode real">Live API mode</span>
            <SmallButton disabled={Boolean(busy)} onClick={() => runAction("Refresh step", manualRefresh)}>Refresh</SmallButton>
          </div>
        </header>

        {!isOneClick ? (
          <WorkflowProgress activeStep={activeStep} />
        ) : (
          <div className="top-stepper one-click-steps">
            {["Upload JD", "Generate searches", "Find profiles", "Scrape profiles", "Score fit", "Download shortlist"].map((step, index) => <button key={step} className={state.oneClick.status === "completed" || index === 0 ? "done" : ""}>{step}</button>)}
          </div>
        )}

        {(notice || busy || state.status.errors.length > 0) && (
          <div className="toast">
            {!busy && <button className="toast-close" onClick={clearToast} aria-label="Dismiss notification">Dismiss</button>}
            {busy && <ProgressBanner label={busy} step={activeStep} candidates={shortlistedCandidates.length} apifyDone={apifySuccessCount} scored={scoredCount} selectedQueries={selectedQueries.length} pagesPerQuery={runSettings.pagesPerQuery} />}
            {notice && <p>{notice}</p>}
            {state.status.errors.map((error) => <p className="error" key={error}>{error}</p>)}
          </div>
        )}

        {activeStep === 1 && (
          <section className="panel simple">
            <div className="section-heading">
              <h3>Connect the tools</h3>
              <p>Keys stay server-side in local files. All workflow calls use real APIs.</p>
            </div>
            <div className="summary-cards">
              <Metric label="OpenAI" value={settings.keyPresence.OPENAI_API_KEY ? "Ready" : "Missing"} />
              <Metric label="SerpAPI" value={settings.keyPresence.SERPAPI_API_KEY ? "Ready" : "Missing"} />
              <Metric label="Apify" value={settings.keyPresence.APIFY_API_TOKEN ? "Ready" : "Missing"} />
              <Metric label="Apollo" value={settings.keyPresence.APOLLO_API_KEY ? "Ready" : "Missing"} />
            </div>
            <details className="details-card" open>
              <summary>API keys and defaults</summary>
              <div className="grid two">
                {(["OPENAI_API_KEY", "SERPAPI_API_KEY", "APIFY_API_TOKEN", "APIFY_ACTOR_ID", "APOLLO_API_KEY"] as const).map((key) => (
                  <label className="field" key={key}>
                    <span>{key} {settings.keyPresence[key] ? <em>saved</em> : <em>missing</em>}</span>
                    <input type={key.includes("KEY") || key.includes("TOKEN") ? "password" : "text"} value={secretForm[key]} onChange={(event) => setSecretForm({ ...secretForm, [key]: event.target.value })} placeholder={key === "APIFY_ACTOR_ID" ? "harvestapi/linkedin-profile-scraper" : settings.keyPresence[key] ? "Leave blank to keep saved value" : "Paste key"} />
                  </label>
                ))}
              </div>
              <div className="grid three settings-grid">
                <label><span>Default SERP pages</span><select value={workflow.defaultSerpPages} onChange={(event) => setWorkflow({ ...workflow, defaultSerpPages: Number(event.target.value) as WorkflowSettings["defaultSerpPages"] })}>{[1, 2, 3, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
                <label><span>Results per page</span><input type="number" value={workflow.resultsPerPage} onChange={(event) => setWorkflow({ ...workflow, resultsPerPage: Number(event.target.value) })} /></label>
                <label><span>Max profiles to Apify</span><input type="number" value={workflow.maxProfilesToApify} onChange={(event) => setWorkflow({ ...workflow, maxProfilesToApify: Number(event.target.value) })} /></label>
                <label><span>Apollo email reveal</span><select value={workflow.apolloEmailRevealEnabled ? "yes" : "no"} onChange={(event) => setWorkflow({ ...workflow, apolloEmailRevealEnabled: event.target.value === "yes" })}><option>yes</option><option>no</option></select></label>
                <label><span>Apollo phone reveal</span><select value={workflow.apolloPhoneRevealEnabled ? "yes" : "no"} onChange={(event) => setWorkflow({ ...workflow, apolloPhoneRevealEnabled: event.target.value === "yes" })}><option>yes</option><option>no</option></select></label>
                <label><span>Phone only selected tiers</span><select value={workflow.apolloPhoneRevealOnlySelectedTiers ? "yes" : "no"} onChange={(event) => setWorkflow({ ...workflow, apolloPhoneRevealOnlySelectedTiers: event.target.value === "yes" })}><option>yes</option><option>no</option></select></label>
                <label><span>Mock mode</span><select value={workflow.mockMode ? "yes" : "no"} onChange={(event) => setWorkflow({ ...workflow, mockMode: event.target.value === "yes" })}><option>no</option><option>yes</option></select></label>
              </div>
            </details>
            <div className="actions">
              <SmallButton variant="primary" onClick={() => runAction("Save settings", () => api<PublicSettings>("/api/settings", { method: "POST", body: JSON.stringify({ ...secretForm, workflow }) }), (value) => { setSettings(value); setSecretForm({ OPENAI_API_KEY: "", SERPAPI_API_KEY: "", APIFY_API_TOKEN: "", APIFY_ACTOR_ID: value.apifyActorId, APOLLO_API_KEY: "" }); })}>Save Settings</SmallButton>
              {["openai", "serpapi", "apify", "apollo"].map((provider) => <SmallButton key={provider} onClick={() => runAction(`Test ${provider}`, () => api<{ ok: boolean; message: string }>("/api/settings/test", { method: "POST", body: JSON.stringify({ provider }) }), (value) => setNotice(value.message))}>Test {provider}</SmallButton>)}
            </div>
            <details className="details-card">
              <summary>Saved workflows</summary>
              <div className="workflow-save-row">
                <input value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} placeholder="PM workflow, Solar sales workflow..." />
                <SmallButton variant="primary" onClick={() => runAction("Save workflow", saveWorkflow)}>Save Current Workflow</SmallButton>
              </div>
              {savedWorkflows.length === 0 ? <div className="empty-state">No saved workflows yet. Run a project once, then save it here.</div> : (
                <div className="saved-workflows">
                  {savedWorkflows.map((workflow) => (
                    <div className="saved-workflow-card" key={workflow.id}>
                      <div>
                        <strong>{workflow.name}</strong>
                        <span>{workflow.summary.brief_title}</span>
                        <em>{workflow.summary.candidates} candidates · {workflow.summary.scored} scored · updated {new Date(workflow.updated_at).toLocaleString()}</em>
                      </div>
                      <div className="actions">
                        <SmallButton onClick={() => runAction(`Load ${workflow.name}`, () => loadWorkflow(workflow.id))}>Open</SmallButton>
                        <SmallButton variant="danger" onClick={() => runAction(`Delete ${workflow.name}`, () => deleteWorkflow(workflow.id))}>Delete</SmallButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </details>
            <details className="details-card">
              <summary>Advanced debug controls</summary>
              <div className="actions">
                <SmallButton onClick={() => refresh(true)}>Reload State</SmallButton>
                <SmallButton onClick={() => runAction("Reset running flags", () => api<AppState>("/api/state", { method: "POST", body: JSON.stringify({ resetRunningFlags: true }) }))}>Reset Running Flags</SmallButton>
                <SmallButton variant="danger" onClick={resetData}>Reset All Data</SmallButton>
              </div>
            </details>
          </section>
        )}

        {activeStep === 2 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Describe the hiring brief</h3><p>Plain English is enough. The app turns this into recruiter search logic.</p></div>
            <div className="grid two">
              <Field label="Role/title keywords" value={briefForm.role_titles} onChange={(value) => setBriefForm({ ...briefForm, role_titles: value })} />
              <Field label="Current company keywords" value={briefForm.current_companies} onChange={(value) => setBriefForm({ ...briefForm, current_companies: value })} />
              <Field label="Past company / past experience" value={briefForm.past_companies} onChange={(value) => setBriefForm({ ...briefForm, past_companies: value })} />
              <Field label="Keywords" value={briefForm.keywords} onChange={(value) => setBriefForm({ ...briefForm, keywords: value })} placeholder="fintech, payments, HR, legal, AI, solar, EPC, AutoCAD" />
              <Field label="Education keywords" value={briefForm.education} onChange={(value) => setBriefForm({ ...briefForm, education: value })} />
              <Field label="Location keywords" value={briefForm.locations} onChange={(value) => setBriefForm({ ...briefForm, locations: value })} />
              <Field label="Availability / movement signals" value={briefForm.intent_terms} onChange={(value) => setBriefForm({ ...briefForm, intent_terms: value })} />
              <Field label="Exclusion keywords" value={briefForm.exclusions} onChange={(value) => setBriefForm({ ...briefForm, exclusions: value })} />
            </div>
            <Field label="Free-text JD / client brief" textarea value={briefForm.jd_text} onChange={(value) => setBriefForm({ ...briefForm, jd_text: value })} placeholder="Paste the client brief or role notes." />
            {state.brief?.expansions && Object.keys(state.brief.expansions).length > 0 && <div className="expansions"><strong>Auto-expanded terms</strong>{Object.entries(state.brief.expansions).map(([term, values]) => <span key={term}>{term}: {values.join(" OR ")}</span>)}</div>}
            <div className="actions">
              <SmallButton variant="primary" disabled={Boolean(busy)} onClick={saveBriefAndContinue}>Save Brief + Continue</SmallButton>
              {state.brief && <SmallButton disabled={Boolean(busy)} onClick={() => setActiveStep(3)}>Continue Without Changes</SmallButton>}
            </div>
          </section>
        )}

        {activeStep === 3 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Generate and choose searches</h3><p>Precision searches find obvious matches. Recall searches catch people whose profiles miss one visible keyword.</p></div>
            <div className="summary-cards"><Metric label="Brief" value={state.brief ? "Saved" : "Missing"} /><Metric label="Queries" value={state.queries.length} /><Metric label="Selected" value={selectedQueries.length} /><Metric label="Estimated searches" value={selectedQueries.length * runSettings.pagesPerQuery} /></div>
            {!state.brief && <div className="empty-state">No brief saved yet. Go back one step and use Save Brief + Continue.</div>}
            <div className="actions"><SmallButton onClick={() => openPromptEditor("queryGeneration")}>Edit Prompt</SmallButton><SmallButton variant="primary" disabled={!state.brief || Boolean(busy)} onClick={() => runAction("Generate query matrix", () => api<AppState>("/api/queries/generate", { method: "POST", body: JSON.stringify({ promptOverride: localPromptOverrides.queryGeneration }) }))}>Generate Query Matrix</SmallButton></div>
            {state.queries.length > 0 && (
              <details className="details-card" open>
                <summary>Review query list</summary>
                <QueryTable queries={state.queries} updateQuery={updateQuery} removeQuery={(index) => commitState({ ...state, queries: state.queries.filter((_, idx) => idx !== index) }, { reason: "remove query" })} />
                <div className="actions"><SmallButton onClick={() => commitState({ ...state, queries: [...state.queries, { id: `manual_${Date.now()}`, brief_id: state.brief?.id ?? "manual", query_text: "site:linkedin.com/in ", query_type: "career_path", expected_filters: [], selected: true, priority: 5, notes: "Manual query" }] }, { reason: "add manual query" })}>Add Manual Query</SmallButton><SmallButton onClick={() => runAction("Save queries", saveQueries)}>Save Query Edits</SmallButton></div>
              </details>
            )}
          </section>
        )}

        {activeStep === 4 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Run selected searches</h3><p>Pagination is configurable here. Page 1 starts at 0, page 2 at 10, page 3 at 20.</p></div>
            <div className="run-settings">
              <label><span>Pages per query</span><select value={runSettings.pagesPerQuery} onChange={(event) => setRunSettings({ ...runSettings, pagesPerQuery: Number(event.target.value) })}>{[1, 2, 3, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
              <label><span>Start offset</span><input type="number" value={runSettings.startOffset} onChange={(event) => setRunSettings({ ...runSettings, startOffset: Number(event.target.value) })} /></label>
              <label><span>Delay ms</span><input type="number" value={runSettings.delayMs} onChange={(event) => setRunSettings({ ...runSettings, delayMs: Number(event.target.value) })} /></label>
              <label><span>Search location</span><input value={runSettings.location} onChange={(event) => setRunSettings({ ...runSettings, location: event.target.value })} /></label>
              <label><span>Target country</span><select value={runSettings.targetCountry} onChange={(event) => setRunSettings({ ...runSettings, targetCountry: event.target.value })}><option>India</option><option>Any</option></select></label>
              <label className="switch-row"><input type="checkbox" checked={runSettings.strictIndiaOnly} onChange={(event) => setRunSettings({ ...runSettings, strictIndiaOnly: event.target.checked })} /> Strict India-only</label>
              <label className="switch-row"><input type="checkbox" checked={runSettings.keepUnknownLocation} onChange={(event) => setRunSettings({ ...runSettings, keepUnknownLocation: event.target.checked })} /> Keep unknown location</label>
              <div className="estimate"><strong>{selectedQueries.length}</strong> queries x <strong>{runSettings.pagesPerQuery}</strong> pages = <strong>{selectedQueries.length * runSettings.pagesPerQuery}</strong> searches</div>
            </div>
            <div className="actions"><SmallButton variant="primary" onClick={() => runAction("Run selected queries", () => api<AppState>("/api/serpapi/run", { method: "POST", body: JSON.stringify(runSettings) }))}>Run Selected Queries</SmallButton></div>
            <div className="summary-cards"><Metric label="Total results" value={state.serpResults.length} /><Metric label="Kept India profiles" value={state.serpResults.filter((r) => r.classification?.is_linkedin_profile && r.classification.keep_result && r.classification.location_status === "india").length} /><Metric label="Foreign rejected" value={state.serpResults.filter((r) => r.classification?.location_status === "foreign" && !r.classification.keep_result).length} /><Metric label="Unknown rejected" value={state.serpResults.filter((r) => r.classification?.location_status === "unknown" && !r.classification.keep_result).length} /><Metric label="Posts evidence" value={state.serpResults.filter((r) => r.classification?.is_linkedin_post).length} /></div>
            <ResultReviewTabs results={state.serpResults} />
          </section>
        )}

        {activeStep === 5 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Clean into real candidates</h3><p>Only <code>linkedin.com/in</code> profile links become recruiter-sheet candidates. Posts stay as evidence only.</p></div>
            <div className="actions"><SmallButton onClick={() => openPromptEditor("cleanScreening")}>Edit Prompt</SmallButton><SmallButton variant="primary" onClick={() => runAction("Clean data", () => api<AppState>("/api/candidates/clean", { method: "POST", body: JSON.stringify({ promptOverride: localPromptOverrides.cleanScreening }) }))}>Clean Data</SmallButton><a className="button secondary" href={downloadUrl("csv", true)}>Export CSV</a><a className="button secondary" href={downloadUrl("xlsx", true)}>Export XLSX</a><label className="button secondary file-button">Import CSV/XLSX<input type="file" accept=".csv,.xlsx" onChange={(event) => event.target.files?.[0] && handleImport(event.target.files[0])} /></label></div>
            <div className="summary-cards"><Metric label="Total candidates" value={profileCandidates.length} /><Metric label="Rejected" value={rejectedProfileCount} /><Metric label="Shortlisted" value={shortlistedCandidates.length} /></div>
            <CandidateEditor candidates={profileCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save candidates", saveCandidates)} />
          </section>
        )}

        {activeStep === 6 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Pull visible LinkedIn profile data</h3><p>Apify data enriches the existing SerpAPI evidence. Visibility and matched queries are preserved.</p></div>
            <div className="summary-cards"><Metric label="Shortlisted candidates" value={shortlistedCandidates.length} /><Metric label="Pending Apify" value={apifyPendingCount} /><Metric label="Apify success" value={apifySuccessCount} /><Metric label="Apify failed" value={apifyFailCount} /></div>
            <div className="run-settings compact-settings">
              <label><span>Apify batch size</span><input type="number" min={1} value={apifyBatchSize} onChange={(event) => setApifyBatchSize(Math.max(1, Number(event.target.value || 1)))} /></label>
              <div className="estimate">Next batch will run <strong>{Math.min(apifyBatchSize, apifyPendingCount)}</strong> pending profiles. Run all will process <strong>{apifyPendingCount}</strong>.</div>
            </div>
            <div className="actions">
              <SmallButton variant="primary" disabled={apifyPendingCount === 0} onClick={() => runAction(`Scrape next ${Math.min(apifyBatchSize, apifyPendingCount)} profiles with Apify`, () => scrapeProfilesWithApify(false))}>Scrape Next Batch</SmallButton>
              <SmallButton disabled={apifyPendingCount === 0} onClick={() => runAction("Scrape all remaining profiles with Apify", () => scrapeProfilesWithApify(true))}>Scrape All Remaining</SmallButton>
            </div>
            <ApifyProfileTable candidates={shortlistedCandidates} onEvidence={setEvidenceCandidate} />
          </section>
        )}

        {activeStep === 7 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Profile Filters</h3><p>Apply stricter filters on parsed Apify profile data. Profiles are labelled, not deleted.</p></div>
            <div className="grid three settings-grid">
              <FilterField label="Actual location must include" value={profileFilterForm.actual_location_must_include} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, actual_location_must_include: value })} />
              <FilterField label="Current title must include" value={profileFilterForm.current_title_must_include} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, current_title_must_include: value })} />
              <FilterField label="Current company must include" value={profileFilterForm.current_company_must_include} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, current_company_must_include: value })} />
              <FilterField label="Past company must include" value={profileFilterForm.past_company_must_include} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, past_company_must_include: value })} />
              <FilterField label="Keywords/profile text must include" value={profileFilterForm.keywords_must_include} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, keywords_must_include: value })} />
              <FilterField label="Education must include" value={profileFilterForm.education_must_include} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, education_must_include: value })} />
              <label><span>Min total exp years</span><input type="number" value={profileFilterForm.min_total_experience_years ?? ""} onChange={(event) => setProfileFilterForm({ ...profileFilterForm, min_total_experience_years: event.target.value ? Number(event.target.value) : undefined })} /></label>
              <label><span>Max total exp years</span><input type="number" value={profileFilterForm.max_total_experience_years ?? ""} onChange={(event) => setProfileFilterForm({ ...profileFilterForm, max_total_experience_years: event.target.value ? Number(event.target.value) : undefined })} /></label>
              <FilterField label="Exclude titles/companies/keywords" value={profileFilterForm.exclude_terms} onChange={(value) => setProfileFilterForm({ ...profileFilterForm, exclude_terms: value })} />
            </div>
            <div className="actions">
              <label className="switch-row"><input type="checkbox" checked={profileFilterForm.require_open_to_work} onChange={(event) => setProfileFilterForm({ ...profileFilterForm, require_open_to_work: event.target.checked })} /> Require Open to Work</label>
              <label className="switch-row"><input type="checkbox" checked={profileFilterForm.require_layoff_signal} onChange={(event) => setProfileFilterForm({ ...profileFilterForm, require_layoff_signal: event.target.checked })} /> Require layoff signal</label>
              <label className="switch-row"><input type="checkbox" checked={profileFilterForm.require_no_promotion_signal} onChange={(event) => setProfileFilterForm({ ...profileFilterForm, require_no_promotion_signal: event.target.checked })} /> Require no-promotion signal</label>
            </div>
            <div className="summary-cards"><Metric label="Total parsed" value={shortlistedCandidates.filter((c) => c.apify_status !== "pending_apify").length} /><Metric label="Passed" value={shortlistedCandidates.filter((c) => c.passes_profile_filter).length} /><Metric label="Failed" value={shortlistedCandidates.filter((c) => c.passes_profile_filter === false).length} /><Metric label="Location unknown" value={shortlistedCandidates.filter((c) => c.actual_location_status === "unknown").length} /></div>
            <div className="actions"><SmallButton onClick={() => openPromptEditor("profileFilters")}>Edit Filter Logic</SmallButton><SmallButton variant="primary" onClick={() => runAction("Apply profile filters", () => api<AppState>("/api/profile-filters/run", { method: "POST", body: JSON.stringify({ ...profileFilterForm, promptOverride: localPromptOverrides.profileFilters }) }))}>Apply Profile Filters</SmallButton></div>
            <ProfileFilterTable candidates={shortlistedCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save profile filter decisions", saveCandidates)} />
          </section>
        )}

        {activeStep === 8 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Score fit</h3><p>Fit score ranks candidates out of 100. Supporting signals are evidence, not a separate score.</p></div>
            <div className="cost-panel">
              <div>
                <strong>Cost saver is on</strong>
                <p>Default scoring prefers scraped profiles first, sorted by visibility, capped at {scoreSettings.maxCandidates}. If filters are too strict, scoring still runs on available profiles instead of blocking.</p>
              </div>
              <label><span>Max candidates</span><input type="number" min={1} value={scoreSettings.maxCandidates} onChange={(event) => setScoreSettings({ ...scoreSettings, maxCandidates: Number(event.target.value) })} /></label>
              <label className="switch-row"><input type="checkbox" checked={scoreSettings.onlyScraped} onChange={(event) => setScoreSettings({ ...scoreSettings, onlyScraped: event.target.checked })} /> prefer scraped/partial profiles</label>
            </div>
            <div className="actions"><SmallButton onClick={() => openPromptEditor("scoring")}>Edit Prompt</SmallButton><SmallButton variant="primary" onClick={() => runAction("Fit scoring", () => api<AppState>("/api/analyze/run", { method: "POST", body: JSON.stringify({ mode: "fit", ...scoreSettings, promptOverride: localPromptOverrides.scoring }) }))}>Run Fit Score</SmallButton><SmallButton onClick={() => setActiveStep(9)}>Skip</SmallButton></div>
            <div className="summary-cards"><Metric label="Profiles" value={shortlistedCandidates.length} /><Metric label="Scored" value={scoredCount} /><Metric label="Apify success" value={apifySuccessCount} /><Metric label="Default cap" value={scoreSettings.maxCandidates} /></div>
            <ScoredTable candidates={shortlistedCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save scores", saveCandidates)} onEvidence={setEvidenceCandidate} />
          </section>
        )}

        {activeStep === 9 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Human review gate</h3><p>Approve profiles before any Apollo spend. You can also download the scored shortlist here while Apollo is paused.</p></div>
            <div className="actions compact-actions"><a className="button primary" href={downloadUrl("xlsx")}>Download scored XLSX</a><a className="button secondary" href={downloadUrl("csv")}>Download scored CSV</a><a className="button secondary" href={downloadUrl("json")}>Download scored JSON</a></div>
            <div className="summary-cards"><Metric label="Approved" value={approvedCount} /><Metric label="Rejected" value={rejectedProfileCount} /><Metric label="Needs enrichment" value={shortlistedCandidates.filter((c) => c.needs_contact_enrichment).length} /></div>
            <ScoredTable candidates={shortlistedCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save manual review", saveCandidates)} onEvidence={setEvidenceCandidate} manual />
          </section>
        )}

        {activeStep === 10 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Apollo enrichment</h3><p>Paused for now. This remains available for later; Apollo is the only contact provider here.</p></div>
            <label className="switch-row"><input type="checkbox" checked={useAllNonRejected} onChange={(event) => setUseAllNonRejected(event.target.checked)} /> Use all non-rejected candidates for enrichment</label>
            {!useAllNonRejected && approvedCount === 0 && <div className="empty-state">0 approved candidates selected for enrichment. Approve candidates in Review, or turn on the option above.</div>}
            <div className="tier-grid">
              {tiers.map((tier) => (
                <div className="tier-card" key={tier}>
                  <h4>{tier}</h4>
                  <p>{tierCounts[tier]} candidates</p>
                  <label><input type="checkbox" checked={tierSelection[tier].email && workflow.apolloEmailRevealEnabled} disabled={!workflow.apolloEmailRevealEnabled} onChange={(event) => setTierSelection({ ...tierSelection, [tier]: { ...tierSelection[tier], email: event.target.checked } })} /> Email</label>
                  <label><input type="checkbox" checked={tierSelection[tier].phone && workflow.apolloPhoneRevealEnabled} disabled={!workflow.apolloPhoneRevealEnabled} onChange={(event) => setTierSelection({ ...tierSelection, [tier]: { ...tierSelection[tier], phone: event.target.checked } })} /> Phone</label>
                </div>
              ))}
            </div>
            <div className="estimate large">Selected: <strong>{liveEstimate.selected}</strong>. Email credits = <strong>{liveEstimate.email}</strong>. Phone credits = <strong>{liveEstimate.phone}</strong> x 8 = <strong>{liveEstimate.phone * 8}</strong>. Total approx = <strong>{liveEstimate.total}</strong>.</div>
            {apolloEstimate && <div className="subtle">Last server estimate: {apolloEstimate.selected} selected, {apolloEstimate.total} credits.</div>}
            <div className="actions"><SmallButton onClick={() => runAction("Estimate Apollo credits", () => api<{ state: AppState; estimate: Estimate; message: string }>("/api/apollo/enrich", { method: "POST", body: JSON.stringify({ selection: tierSelection, confirm: false, useAllNonRejected }) }), (value) => { commitState(value.state, { reason: "apollo estimate" }); setApolloEstimate(value.estimate); setNotice(value.message); })}>Estimate Credits</SmallButton><SmallButton variant="primary" onClick={() => runAction("Apollo enrichment", () => api<{ state: AppState; estimate: Estimate }>("/api/apollo/enrich", { method: "POST", body: JSON.stringify({ selection: tierSelection, confirm: true, useAllNonRejected }) }), (value) => { commitState(value.state, { reason: "apollo enrichment" }); setApolloEstimate(value.estimate); })}>Confirm + Run Apollo</SmallButton></div>
          </section>
        )}

        {activeStep === 11 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Final recruiter sheet</h3><p>Only real LinkedIn profile URLs appear here. Post URLs are evidence-only in the drawer and export evidence column.</p></div>
            <div className="summary-cards"><Metric label="Total candidates" value={shortlistedCandidates.length} /><Metric label="Tier 1" value={tierCounts["Tier 1"]} /><Metric label="Tier 2" value={tierCounts["Tier 2"]} /><Metric label="Emails found" value={foundEmails} /><Metric label="Phones found" value={foundPhones} /></div>
            <div className="final-tools">
              <div className="filters">
                <label><span>Tier</span><select value={finalFilter.tier} onChange={(event) => setFinalFilter({ ...finalFilter, tier: event.target.value })}><option value="all">All tiers</option>{tiers.map((tier) => <option key={tier}>{tier}</option>)}</select></label>
                <label><span>Contact</span><select value={finalFilter.contact} onChange={(event) => setFinalFilter({ ...finalFilter, contact: event.target.value })}><option value="all">All contacts</option><option value="email_found">Email found</option><option value="phone_found">Phone found</option><option value="missing">No contact</option></select></label>
                <label><span>Search</span><input value={finalFilter.search} onChange={(event) => setFinalFilter({ ...finalFilter, search: event.target.value })} placeholder="Name, company, title" /></label>
              </div>
              <div className="actions export-actions"><a className="button primary" href={downloadUrl("xlsx")}>Export XLSX</a><a className="button secondary" href={downloadUrl("csv")}>Export CSV</a><a className="button secondary" href={downloadUrl("json")}>Export JSON</a></div>
            </div>
            <FinalTable candidates={finalRows} onEvidence={setEvidenceCandidate} />
          </section>
        )}

        {activeStep === 12 && (
          <section className="panel one-click-panel">
            <div className="one-click-hero">
              <div>
                <span className="mode real">Fast lane</span>
                <h3>One Click sourcing run</h3>
                <p>Paste the JD, run the automated flow, and download the scored shortlist before Apollo. The normal wizard data stays separate.</p>
              </div>
              <div className="one-click-card">
                <strong>{oneClickCandidates.length}</strong>
                <span>scored profiles</span>
              </div>
            </div>
            <div className="one-click-grid">
              <div>
                <label className="field">
                  <span>Upload or paste JD text</span>
                  <textarea value={oneClickText || state.oneClick.jd_text} onChange={(event) => setOneClickText(event.target.value)} rows={10} placeholder="Paste the hiring brief or JD here..." />
                </label>
                <div className="actions">
                  <label className="button secondary file-button">Upload TXT<input type="file" accept=".txt,.md,.csv" onChange={(event) => event.target.files?.[0] && handleOneClickFile(event.target.files[0])} /></label>
                  <SmallButton
                    variant="primary"
                    disabled={busy === "One Click run"}
                    onClick={() => runAction("One Click run", () => api<AppState["oneClick"]>("/api/one-click/run", { method: "POST", body: JSON.stringify({ jd_text: oneClickText || state.oneClick.jd_text, ...oneClickSettings }) }), (value) => {
                      commitState({ ...state, oneClick: value }, { reason: "one click" });
                      setNotice(`One Click completed with ${value.candidates.length} scored profiles`);
                    })}
                  >
                    Start One Click
                  </SmallButton>
                </div>
                <details className="details-card">
                  <summary>Run settings</summary>
                  <div className="grid three settings-grid">
                    <label><span>Pages per query</span><select value={oneClickSettings.pagesPerQuery} onChange={(event) => setOneClickSettings({ ...oneClickSettings, pagesPerQuery: Number(event.target.value) })}>{[1, 2, 3, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
                    <label><span>Max SerpAPI searches</span><input type="number" value={oneClickSettings.maxSearches} onChange={(event) => setOneClickSettings({ ...oneClickSettings, maxSearches: Number(event.target.value) })} /></label>
                    <label><span>Max profiles to score</span><input type="number" value={oneClickSettings.maxCandidates} onChange={(event) => setOneClickSettings({ ...oneClickSettings, maxCandidates: Number(event.target.value) })} /></label>
                    <label><span>Search location</span><input value={oneClickSettings.location} onChange={(event) => setOneClickSettings({ ...oneClickSettings, location: event.target.value })} /></label>
                  </div>
                </details>
              </div>
              <FunnelCard funnel={state.oneClick.funnel} />
            </div>
            {state.oneClick.error && <div className="empty-state error">{state.oneClick.error}</div>}
            {state.oneClick.status === "completed" && (
              <>
                <div className="actions export-actions one-click-downloads"><a className="button primary" href={oneClickDownloadUrl("xlsx")}>Download XLSX</a><a className="button secondary" href={oneClickDownloadUrl("csv")}>Download CSV</a><a className="button secondary" href={oneClickDownloadUrl("json")}>Download JSON</a></div>
                <OneClickScoredTable candidates={oneClickCandidates} onEvidence={setEvidenceCandidate} />
              </>
            )}
          </section>
        )}

        {!isOneClick && <StepFooter activeStep={activeStep} setActiveStep={setActiveStep} maxStep={steps.length} busy={Boolean(busy)} />}

        {evidenceCandidate && <EvidenceDrawer candidate={evidenceCandidate} onClose={() => setEvidenceCandidate(null)} />}
        {promptEditor && <PromptModal kind={promptEditor} value={promptDraft} onChange={setPromptDraft} onSave={savePromptOverride} onClose={() => setPromptEditor(null)} />}
      </section>
    </main>
  );
}

function helperCopy(step: number) {
  return [
    "Set API keys once. All calls run server-side.",
    "Capture the hiring requirement in normal recruiter language.",
    "Generate X-ray searches and keep only the ones you want.",
    "Run selected searches through SerpAPI with visible pagination controls.",
    "Turn search results into clean LinkedIn profile candidates.",
    "Scrape visible profile details while preserving source evidence.",
    "Filter on actual parsed profile fields before scoring.",
    "Score fit using the brief and merged candidate data.",
    "Approve, reject, or annotate before contact enrichment.",
    "Estimate Apollo credits and enrich selected tiers.",
    "Review and export the recruiter-ready sheet."
  ][step - 1];
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="metric-card"><strong>{value}</strong><span>{label}</span></div>;
}

function WorkflowProgress({ activeStep }: { activeStep: number }) {
  const beforeApollo = steps.slice(0, 9);
  const bounded = Math.min(activeStep, beforeApollo.length);
  const percent = Math.max(0, Math.min(100, ((bounded - 1) / Math.max(1, beforeApollo.length - 1)) * 100));
  return (
    <div className="workflow-progress" aria-label="Workflow progress before Apollo">
      <div className="workflow-progress-head">
        <strong>Progress to before-Apollo shortlist</strong>
        <span>Finish: Review + Download</span>
      </div>
      <div className="workflow-rail">
        <div className="workflow-fill" style={{ width: `${percent}%` }} />
        {beforeApollo.map((step, index) => {
          const number = index + 1;
          const done = activeStep > number;
          const active = activeStep === number;
          return (
            <div className={`workflow-dot ${done ? "done" : ""} ${active ? "active" : ""}`} style={{ left: `${(index / Math.max(1, beforeApollo.length - 1)) * 100}%` }} key={step}>
              <span>{done ? "✓" : number}</span>
              <em>{step}</em>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  const [draft, setDraft] = useState(value.join(", "));
  useEffect(() => {
    setDraft(value.join(", "));
  }, [value.join("\u0001")]);
  const commit = (next: string) => {
    setDraft(next);
    onChange(parseUiTerms(next));
  };
  return <label><span>{label}</span><input value={draft} onChange={(event) => commit(event.target.value)} placeholder="Use commas: Bain, McKinsey, BCG" /></label>;
}

function ResultReviewTabs({ results }: { results: AppState["serpResults"] }) {
  const [tab, setTab] = useState<"kept" | "rejected" | "unknown" | "posts">("kept");
  const rows = results.filter((result) => {
    if (tab === "kept") return result.classification?.keep_result && result.classification.is_linkedin_profile;
    if (tab === "rejected") return result.classification && !result.classification.keep_result;
    if (tab === "unknown") return result.classification?.location_status === "unknown";
    return result.classification?.is_linkedin_post;
  });
  if (results.length === 0) return null;
  return (
    <details className="details-card">
      <summary>Review SerpAPI classification</summary>
      <div className="tabs">{(["kept", "rejected", "unknown", "posts"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}</div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Title</th><th>URL</th><th>Location</th><th>Status</th><th>Reason</th><th>Snippet</th></tr></thead>
          <tbody>{rows.map((result) => <tr key={result.id}><td>{result.title}</td><td className="clip">{result.link}</td><td>{result.classification?.location_evidence.location_text || "missing"}</td><td><span className={badgeClass(result.classification?.location_status)}>{result.classification?.location_status}</span></td><td className="clip">{result.classification?.rejection_reason || "kept"}</td><td className="clip">{result.snippet}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

function ProgressBanner({ label, step, candidates, apifyDone, scored, selectedQueries, pagesPerQuery }: { label: string; step: number; candidates: number; apifyDone: number; scored: number; selectedQueries: number; pagesPerQuery: number }) {
  const target = step === 6 ? candidates : step === 8 ? candidates : undefined;
  const done = step === 6 ? apifyDone : step === 8 ? scored : undefined;
  const percent = target ? Math.min(100, Math.round(((done ?? 0) / Math.max(1, target)) * 100)) : undefined;
  const detail =
    step === 4 ? `Searching ${selectedQueries} selected quer${selectedQueries === 1 ? "y" : "ies"} across ${pagesPerQuery} page${pagesPerQuery === 1 ? "" : "s"}.` :
    step === 6 ? `${apifyDone} of ${candidates} profiles have Apify data saved.` :
    step === 7 ? "Applying filters to parsed profile data." :
    step === 8 ? `${scored} of ${candidates} profiles scored.` :
    "Working on this step. Results will appear here when it finishes.";
  return (
    <div className="progress-banner">
      <div className="spinner" />
      <div className="progress-copy">
        <strong>Running: {label}</strong>
        <span>{detail}</span>
        {percent !== undefined && <div className="progress-track"><div style={{ width: `${percent}%` }} /></div>}
      </div>
    </div>
  );
}

function StepFooter({ activeStep, setActiveStep, maxStep, busy }: { activeStep: number; setActiveStep: (step: number) => void; maxStep: number; busy: boolean }) {
  return (
    <div className="step-footer">
      <SmallButton disabled={busy || activeStep <= 1} onClick={() => setActiveStep(Math.max(1, activeStep - 1))}>Back</SmallButton>
      <div>
        <strong>Step {activeStep} of {maxStep}</strong>
        <span>Use Next when this page looks done.</span>
      </div>
      <SmallButton variant="primary" disabled={busy || activeStep >= maxStep} onClick={() => setActiveStep(Math.min(maxStep, activeStep + 1))}>Next</SmallButton>
    </div>
  );
}

function QueryTable({ queries, updateQuery, removeQuery }: { queries: Query[]; updateQuery: (index: number, patch: Partial<Query>) => void; removeQuery: (index: number) => void }) {
  const queryTypeLabel = (type: QueryType) => ({
    profile_location: "Profile location",
    profile_keyword: "Profile keyword",
    profile_domain: "Profile keyword",
    profile_education: "Profile education",
    career_path: "Career path",
    intent_post: "Signal post",
    layoff_post: "Layoff post",
    hiring_comment: "Hiring comment"
  })[type];
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Use</th><th>Query</th><th>Type</th><th>Filters</th><th>Priority</th><th>Notes</th><th /></tr></thead>
        <tbody>{queries.map((query, index) => <tr key={query.id}><td><input type="checkbox" checked={query.selected} onChange={(event) => updateQuery(index, { selected: event.target.checked })} /></td><td><textarea value={query.query_text} onChange={(event) => updateQuery(index, { query_text: event.target.value })} rows={2} /></td><td><select value={query.query_type} onChange={(event) => updateQuery(index, { query_type: event.target.value as QueryType })}>{queryTypes.map((type) => <option key={type} value={type}>{queryTypeLabel(type)}</option>)}</select></td><td><input value={query.expected_filters.join(", ")} onChange={(event) => updateQuery(index, { expected_filters: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></td><td><input type="number" value={query.priority} onChange={(event) => updateQuery(index, { priority: Number(event.target.value) })} /></td><td><input value={query.notes} onChange={(event) => updateQuery(index, { notes: event.target.value })} /></td><td><SmallButton variant="danger" onClick={() => removeQuery(index)}>Delete</SmallButton></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function CandidateEditor({ candidates, updateCandidate, saveCandidates }: { candidates: Candidate[]; updateCandidate: (id: string, patch: Partial<Candidate>) => void; saveCandidates: () => void }) {
  if (candidates.length === 0) return <div className="empty-state">No profile candidates yet. Run search, then Clean Data.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>LinkedIn profile</th><th>Title</th><th>Company</th><th>Visibility</th><th>Screen</th><th>Evidence notes</th><th /></tr></thead>
        <tbody>{candidates.map((candidate) => <tr key={candidate.id}><td><input value={candidate.name_guess} onChange={(event) => updateCandidate(candidate.id, { name_guess: event.target.value })} /></td><td><a href={profileUrl(candidate)} target="_blank">{candidate.normalized_linkedin_url}</a></td><td><input value={candidate.title_guess} onChange={(event) => updateCandidate(candidate.id, { title_guess: event.target.value })} /></td><td><input value={candidate.company_guess} onChange={(event) => updateCandidate(candidate.id, { company_guess: event.target.value })} /></td><td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td><td><span className={badgeClass(candidate.status)}>{candidate.status}</span></td><td className="clip">{[...(candidate.risk_flags ?? []), ...candidate.snippets].join(" | ")}</td><td><SmallButton variant="danger" onClick={() => updateCandidate(candidate.id, { status: "deleted", manual_status: "rejected" })}>Reject</SmallButton></td></tr>)}</tbody>
      </table>
      <div className="actions"><SmallButton onClick={saveCandidates}>Save Candidate Edits</SmallButton></div>
    </div>
  );
}

function ApifyProfileTable({ candidates, onEvidence }: { candidates: Candidate[]; onEvidence: (candidate: Candidate) => void }) {
  if (candidates.length === 0) return <div className="empty-state">No profile candidates yet. Clean SerpAPI data first.</div>;
  return (
    <div className="table-wrap apify-table">
      <table>
        <thead><tr><th>Name</th><th>LinkedIn profile</th><th>Apify status</th><th>Headline</th><th>Location</th><th>Current role</th><th>Current company</th><th>Past companies</th><th>Education</th><th>Visibility</th><th>Raw</th></tr></thead>
        <tbody>
          {candidates.map((candidate) => {
            const profile = candidate.profile_data;
            const past = profile?.past_companies?.join(", ") || profile?.experience?.map((exp) => String(exp.company ?? exp.companyName ?? "")).filter(Boolean).slice(0, 4).join(", ");
            const education = profile?.education?.map((item) => typeof item === "string" ? item : String(item.schoolName ?? item.school ?? item.name ?? "")).filter(Boolean).slice(0, 3).join(", ");
            return (
              <tr key={candidate.id}>
                <td className="key-col">{displayName(candidate)}</td>
                <td><a href={profileUrl(candidate)} target="_blank">{candidate.normalized_linkedin_url}</a></td>
                <td><span className={badgeClass(apifyStatusLabel(candidate.apify_status))}>{apifyStatusLabel(candidate.apify_status)}</span></td>
                <td className="clip">{profile?.headline || candidate.title_guess || "No headline yet"}</td>
                <td>{profile?.location || ""}</td>
                <td>{profile?.current_title || candidate.title_guess}</td>
                <td>{profile?.current_company || candidate.company_guess}</td>
                <td className="clip">{past || ""}</td>
                <td className="clip">{education || ""}</td>
                <td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td>
                <td><button className="link-button" onClick={() => onEvidence(candidate)}>View evidence</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProfileFilterTable({ candidates, updateCandidate, saveCandidates }: { candidates: Candidate[]; updateCandidate: (id: string, patch: Partial<Candidate>) => void; saveCandidates: () => void }) {
  if (candidates.length === 0) return <div className="empty-state">No candidates to filter yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Actual location</th><th>Filter</th><th>Reasons</th><th>Manual include</th><th>Visibility</th></tr></thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id}>
              <td>{displayName(candidate)}</td>
              <td><span className={badgeClass(candidate.actual_location_status)}>{candidate.actual_location_status ?? "unknown"}</span><div className="subtle">{candidate.location_evidence || candidate.profile_data?.location || "No location evidence"}</div></td>
              <td><span className={badgeClass(candidate.passes_profile_filter ? "approved" : "rejected")}>{candidate.passes_profile_filter ? "passes" : "fails"}</span></td>
              <td className="clip">{candidate.filter_fail_reasons?.join("; ") || "No failures"}</td>
              <td><label className="inline-check"><input type="checkbox" checked={Boolean(candidate.include_failed_profile_filter)} onChange={(event) => updateCandidate(candidate.id, { include_failed_profile_filter: event.target.checked })} /> include anyway</label></td>
              <td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions"><SmallButton onClick={saveCandidates}>Save Filter Decisions</SmallButton></div>
    </div>
  );
}

function ScoredTable({ candidates, updateCandidate, saveCandidates, onEvidence, manual }: { candidates: Candidate[]; updateCandidate: (id: string, patch: Partial<Candidate>) => void; saveCandidates: () => void; onEvidence: (candidate: Candidate) => void; manual?: boolean }) {
  const [tierFilter, setTierFilter] = useState("all");
  const visible = candidates.filter((candidate) => tierFilter === "all" || candidate.tier === tierFilter).sort((a, b) => Number(b.total_score ?? 0) - Number(a.total_score ?? 0) || b.visibility_factor - a.visibility_factor);
  if (visible.length === 0) return <div className="empty-state">No candidates to show yet.</div>;
  return (
    <>
      <div className="filters"><label><span>Tier filter</span><select value={tierFilter} onChange={(event) => setTierFilter(event.target.value)}><option value="all">All tiers</option>{tiers.map((tier) => <option key={tier}>{tier}</option>)}</select></label></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>LinkedIn</th><th>Fit / 100</th><th>Tier</th><th>Visibility</th><th>Evidence</th>{manual && <th>Review</th>}<th>Notes</th></tr></thead>
          <tbody>{visible.map((candidate) => <tr key={candidate.id}><td>{displayName(candidate)}</td><td><a href={profileUrl(candidate)} target="_blank">Open profile</a></td><td><input type="number" value={candidate.total_score ?? candidate.fit_score ?? 0} onChange={(event) => updateCandidate(candidate.id, { fit_score: Number(event.target.value), total_score: Number(event.target.value) })} /></td><td><select className={badgeClass(candidate.tier)} value={candidate.tier ?? "Tier 4"} onChange={(event) => updateCandidate(candidate.id, { tier: event.target.value as Tier })}>{tiers.map((tier) => <option key={tier}>{tier}</option>)}</select></td><td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td><td><button className="link-button" onClick={() => onEvidence(candidate)}>View evidence</button></td>{manual && <td><select value={candidate.manual_status} onChange={(event) => updateCandidate(candidate.id, { manual_status: event.target.value as Candidate["manual_status"] })}><option value="pending">pending</option><option value="approved">approved</option><option value="rejected">rejected</option></select><label className="inline-check"><input type="checkbox" checked={candidate.needs_contact_enrichment} onChange={(event) => updateCandidate(candidate.id, { needs_contact_enrichment: event.target.checked })} /> enrich</label></td>}<td><textarea value={candidate.manual_notes} onChange={(event) => updateCandidate(candidate.id, { manual_notes: event.target.value })} rows={2} /></td></tr>)}</tbody>
        </table>
      </div>
      <div className="actions"><SmallButton onClick={saveCandidates}>Save Review</SmallButton></div>
    </>
  );
}

function FinalTable({ candidates, onEvidence }: { candidates: Candidate[]; onEvidence: (candidate: Candidate) => void }) {
  if (candidates.length === 0) return <div className="empty-state">No recruiter-sheet rows match the current filters.</div>;
  return (
    <div className="table-wrap final">
      <table>
        <thead><tr><th className="key-col">Name</th><th className="key-col">LinkedIn profile</th><th>Title</th><th>Company</th><th className="key-col">Score</th><th className="key-col">Tier</th><th>Visibility</th><th className="key-col">Email</th><th className="key-col">Phone</th><th>Apollo</th><th>Evidence</th></tr></thead>
        <tbody>{candidates.map((candidate) => <tr key={candidate.id}><td className="key-col">{displayName(candidate)}</td><td className="key-col"><a href={profileUrl(candidate)} target="_blank">{candidate.normalized_linkedin_url}</a></td><td>{candidate.profile_data?.current_title || candidate.title_guess}</td><td>{candidate.profile_data?.current_company || candidate.company_guess}</td><td className="key-col">{candidate.total_score ?? ""}</td><td className="key-col"><span className={badgeClass(candidate.tier)}>{candidate.tier ?? "Tier 4"}</span></td><td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td><td className="key-col"><span className={badgeClass(candidate.email_status)}>{candidate.email || candidate.email_status || "not_requested"}</span></td><td className="key-col"><span className={badgeClass(candidate.phone_status)}>{candidate.phone || candidate.phone_status || "not_requested"}</span></td><td><span className={badgeClass(candidate.apollo_status)}>{candidate.apollo_status}</span></td><td><button className="link-button evidence-preview" onClick={() => onEvidence(candidate)}>{[...candidate.fit_evidence, ...candidate.intent_evidence].join("; ") || "View evidence"}</button></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: Array<{ step: string; count: number; note: string }> }) {
  const fallback = [
    { step: "SerpAPI results", count: 500, note: "Search results found" },
    { step: "Profile URLs", count: 300, note: "After normalize and dedupe" },
    { step: "Apify success", count: 280, note: "Profiles extracted" },
    { step: "Fit shortlist", count: 200, note: "Matched role filters" },
    { step: "Signal-backed shortlist", count: 50, note: "Extra movement signals found" },
    { step: "Tier 1/2 shortlist", count: 30, note: "Ready before Apollo" }
  ];
  const rows = funnel.length ? funnel : fallback;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="funnel-card">
      <div className="funnel-head">
        <h4>Before-Apollo funnel</h4>
        <p>Stops at scored shortlist</p>
      </div>
      <div className="funnel-bars">
        {rows.map((row, index) => (
          <div className="funnel-row" key={row.step}>
            <span className="funnel-index">{index + 1}</span>
            <div className="funnel-track">
              <div className="funnel-bar" style={{ width: `${Math.max(10, (row.count / max) * 100)}%` }}>
                <strong>{row.count}</strong>
              </div>
            </div>
            <div className="funnel-copy">
              <strong>{row.step}</strong>
              <span>{row.note}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OneClickScoredTable({ candidates, onEvidence }: { candidates: Candidate[]; onEvidence: (candidate: Candidate) => void }) {
  if (candidates.length === 0) return <div className="empty-state">Run One Click to generate a scored shortlist.</div>;
  return (
    <div className="table-wrap final">
      <table>
        <thead><tr><th>Name</th><th>LinkedIn profile</th><th>Title</th><th>Company</th><th>Fit / 100</th><th>Tier</th><th>Visibility</th><th>Evidence</th></tr></thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id}>
              <td className="key-col">{displayName(candidate)}</td>
              <td><a href={profileUrl(candidate)} target="_blank">{candidate.normalized_linkedin_url}</a></td>
              <td>{candidate.profile_data?.current_title || candidate.title_guess}</td>
              <td>{candidate.profile_data?.current_company || candidate.company_guess}</td>
              <td className="key-col">{candidate.total_score ?? candidate.fit_score ?? ""}</td>
              <td><span className={badgeClass(candidate.tier)}>{candidate.tier ?? "Tier 4"}</span></td>
              <td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td>
              <td><button className="link-button evidence-preview" onClick={() => onEvidence(candidate)}>{[...candidate.fit_evidence, ...candidate.intent_evidence].join("; ") || "View evidence"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceDrawer({ candidate, onClose }: { candidate: Candidate; onClose: () => void }) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head"><div><h3>{displayName(candidate)}</h3><p>{candidate.normalized_linkedin_url}</p></div><SmallButton onClick={onClose}>Close</SmallButton></div>
        <ProfileSnapshot candidate={candidate} />
        <LinkedInScrapeData candidate={candidate} />
        <EvidenceSection title="Fit evidence" items={candidate.fit_evidence} />
        <EvidenceSection title="Supporting signals" items={candidate.intent_evidence} />
        <EvidenceSection title="Matched queries" items={candidate.matched_filter_hints} />
        <EvidenceSection title="Snippets" items={candidate.snippets} />
        <EvidenceSection title="Post evidence sources" items={(candidate.intent_evidence_sources ?? []).map((source) => `${source.source_status}: ${source.url} - ${source.snippet}`)} />
        <EvidenceSection title="Manual notes" items={[candidate.manual_notes].filter(Boolean)} />
        <EvidenceSection title="Raw source flags" items={candidate.raw_source_flags ?? []} />
      </aside>
    </div>
  );
}

function ProfileSnapshot({ candidate }: { candidate: Candidate }) {
  const profile = candidate.profile_data;
  const fields = [
    ["Score", candidate.total_score ?? ""],
    ["Tier", candidate.tier ?? ""],
    ["Fit / 100", candidate.total_score ?? candidate.fit_score ?? ""],
    ["Title", profile?.current_title || candidate.title_guess],
    ["Company", profile?.current_company || candidate.company_guess],
    ["Location", profile?.location || ""],
    ["Apify", apifyStatusLabel(candidate.apify_status)],
    ["Visibility", candidate.visibility_factor]
  ];
  return (
    <section className="drawer-section profile-snapshot">
      <h4>Profile summary</h4>
      <div className="profile-grid">
        {fields.map(([label, value]) => (
          <div key={String(label)}>
            <span>{label}</span>
            <strong>{String(value || "Not captured")}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function LinkedInScrapeData({ candidate }: { candidate: Candidate }) {
  const profile = candidate.profile_data;
  return (
    <section className="drawer-section linkedin-data">
      <h4>Full LinkedIn scrape data</h4>
      {!profile && !candidate.apify_raw ? <p className="subtle">No Apify data captured yet.</p> : (
        <>
          {profile?.headline && <DataBlock label="Headline" value={profile.headline} />}
          {profile?.about && <DataBlock label="About" value={profile.about} />}
          <DataBlock label="Experience" value={profile?.experience} />
          <DataBlock label="Education" value={profile?.education} />
          <DataBlock label="Skills" value={profile?.skills} />
          <DataBlock label="Posts / activity" value={profile?.posts} />
          <details className="raw-json">
            <summary>Raw Apify JSON</summary>
            <JsonTree value={candidate.apify_raw ?? profile} />
          </details>
        </>
      )}
    </section>
  );
}

function DataBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === "") return null;
  return (
    <div className="data-block">
      <strong>{label}</strong>
      <JsonTree value={value} />
    </div>
  );
}

function JsonTree({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "") return <p className="subtle">Not captured.</p>;
  if (Array.isArray(value)) {
    return (
      <div className="json-list">
        {value.map((item, index) => (
          <div className="json-item" key={index}>
            <JsonTree value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="json-object">
        {Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
          .map(([key, entry]) => (
            <div key={key}>
              <dt>{key.replace(/_/g, " ")}</dt>
              <dd><JsonTree value={entry} /></dd>
            </div>
          ))}
      </dl>
    );
  }
  return <span className="json-value">{String(value)}</span>;
}

function EvidenceSection({ title, items }: { title: string; items: string[] }) {
  return <section className="drawer-section"><h4>{title}</h4>{items.length ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul> : <p className="subtle">No data captured.</p>}</section>;
}

function PromptModal({ kind, value, onChange, onSave, onClose }: { kind: PromptKind; value: string; onChange: (value: string) => void; onSave: () => void; onClose: () => void }) {
  const title = kind === "queryGeneration" ? "Query Generation" : kind === "cleanScreening" ? "Clean Data AI Screen" : kind === "profileFilters" ? "Profile Filter Logic" : "Fit Scoring";
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="prompt-modal" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h3>Edit {title}</h3>
            <p>This edit is local to this browser session. The app still adds the required schema and candidate/JD context server-side.</p>
          </div>
          <SmallButton onClick={onClose}>Close</SmallButton>
        </div>
        <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={14} />
        <div className="actions">
          <SmallButton onClick={() => onChange(defaultPromptOverride(kind))}>Reset Draft</SmallButton>
          <SmallButton variant="primary" onClick={onSave}>Use Prompt Locally</SmallButton>
        </div>
      </aside>
    </div>
  );
}
