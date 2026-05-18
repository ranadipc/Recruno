"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApolloTierSelection, AppState, Candidate, ProfileFilters, PublicSettings, Query, QueryType, Tier, WorkflowSettings } from "@/lib/types";
import { DEFAULT_APOLLO_TIERS, DEFAULT_WORKFLOW } from "@/lib/defaults";

const steps = [
  "Setup + API Keys",
  "JD Brief",
  "OpenAI Queries",
  "SerpAPI Search",
  "Clean + Dedupe",
  "Apify Profiles",
  "Profile Filters",
  "OpenAI Scoring",
  "Review + Download",
  "Apollo Enrichment",
  "Final Sheet"
];
const queryTypes: QueryType[] = ["profile_location", "profile_keyword", "profile_education", "career_path", "intent_post", "layoff_post", "hiring_comment"];
const tiers: Tier[] = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];

type Estimate = { email: number; phone: number; total: number; selected: number } | null;

function emptyState(): AppState {
  return {
    queries: [],
    serpResults: [],
    rejectedSerpResults: [],
    candidates: [],
    rawSerpRuns: [],
    intentEvidenceSources: [],
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

function downloadUrl(format: "csv" | "xlsx" | "json") {
  return `/api/export/${format}`;
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
  if (/tier 1|found|enriched|approved|success|visible/i.test(value)) return "badge good";
  if (/tier 2|pending|partial/i.test(value)) return "badge info";
  if (/tier 3|missing|not_requested|skipped|manual/i.test(value)) return "badge warn";
  if (/tier 4|failed|rejected|risk|not_found/i.test(value)) return "badge bad";
  return "badge neutral";
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

export default function Home() {
  const [state, setState] = useState<AppState>(emptyState());
  const [settings, setSettings] = useState<PublicSettings>({
    keyPresence: { OPENAI_API_KEY: false, SERPAPI_API_KEY: false, APIFY_API_TOKEN: false, APIFY_ACTOR_ID: true, APOLLO_API_KEY: false },
    workflow: DEFAULT_WORKFLOW,
    apifyActorId: "harvestapi/linkedin-profile-scraper"
  });
  const [activeStep, setActiveStep] = useState(1);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [evidenceCandidate, setEvidenceCandidate] = useState<Candidate | null>(null);
  const [oneClickText, setOneClickText] = useState("");
  const [oneClickSettings, setOneClickSettings] = useState({ pagesPerQuery: 2, maxSearches: 20, maxCandidates: 50, location: "India" });
  const [briefForm, setBriefForm] = useState({
    role_titles: "Product Manager, APM, Product Lead",
    current_companies: "Razorpay, PhonePe, CRED",
    past_companies: "McKinsey, BCG, Bain",
    keywords: "fintech, payments, UPI, lending",
    education: "IIT, IIM, BITS, ISB",
    locations: "Bangalore, Noida, Mumbai",
    intent_terms: "open to work, looking for opportunities, exploring roles, laid off, impacted by layoffs",
    exclusions: "Founder, VP, Director, Recruiter, Intern, Student",
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
  const [runSettings, setRunSettings] = useState({ pagesPerQuery: 2, startOffset: 0, maxSearches: 20, delayMs: 0, location: "India", targetCountry: "India", strictIndiaOnly: true, keepUnknownLocation: false });
  const [scoreSettings, setScoreSettings] = useState({ maxCandidates: 50, onlyScraped: true });
  const [profileFilterForm, setProfileFilterForm] = useState<ProfileFilters>({
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
  });
  const [tierSelection, setTierSelection] = useState<ApolloTierSelection>(DEFAULT_APOLLO_TIERS);
  const [useAllNonRejected, setUseAllNonRejected] = useState(true);
  const [apolloEstimate, setApolloEstimate] = useState<Estimate>(null);
  const [finalFilter, setFinalFilter] = useState({ tier: "all", contact: "all", search: "" });

  async function refresh(keepStep = false) {
    const [nextState, nextSettings] = await Promise.all([api<AppState>("/api/state"), api<PublicSettings>("/api/settings")]);
    setState(nextState);
    setSettings(nextSettings);
    setWorkflow(nextSettings.workflow);
    setSecretForm((form) => ({ ...form, APIFY_ACTOR_ID: nextSettings.apifyActorId }));
    setTierSelection(nextState.apolloTierSelection);
    setProfileFilterForm(nextState.profileFilters);
    if (!keepStep) setActiveStep(Math.min(nextState.status.currentStep || 1, steps.length));
  }

  useEffect(() => {
    refresh().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      refresh(true).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
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
      setState(next);
    }
  }

  async function runAction<T>(label: string, action: () => Promise<T>, after?: (value: T) => void) {
    setBusy(label);
    setNotice("");
    try {
      const result = await action();
      after?.(result);
      if (!after && result && typeof result === "object" && "status" in result) setState(result as unknown as AppState);
      await refresh(true);
      setNotice(`${label} completed`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label} failed`);
    } finally {
      setBusy("");
    }
  }

  const profileCandidates = state.candidates.filter((candidate) => candidate.normalized_linkedin_url.startsWith("linkedin.com/in/"));
  const selectedQueries = state.queries.filter((query) => query.selected);
  const apifySuccessCount = profileCandidates.filter((c) => c.apify_status === "apify_success").length;
  const apifyPartialCount = profileCandidates.filter((c) => c.apify_status === "apify_partial").length;
  const scoredCount = profileCandidates.filter((c) => typeof c.total_score === "number").length;
  const approvedCount = profileCandidates.filter((candidate) => candidate.manual_status === "approved").length;
  const tierCounts = Object.fromEntries(tiers.map((tier) => [tier, profileCandidates.filter((candidate) => (candidate.tier ?? "Tier 4") === tier).length])) as Record<Tier, number>;
  const foundEmails = profileCandidates.filter((candidate) => candidate.email).length;
  const foundPhones = profileCandidates.filter((candidate) => candidate.phone).length;
  const isOneClick = activeStep === 12;
  const oneClickCandidates = state.oneClick.candidates.filter((candidate) => candidate.normalized_linkedin_url.startsWith("linkedin.com/in/"));

  const selectedForApollo = useMemo(() => {
    return profileCandidates.filter((candidate) => {
      if (!candidate.needs_contact_enrichment) return false;
      if (useAllNonRejected ? candidate.manual_status === "rejected" : candidate.manual_status !== "approved") return false;
      const pick = tierSelection[(candidate.tier ?? "Tier 4") as Tier];
      return Boolean(pick?.email || pick?.phone);
    });
  }, [profileCandidates, tierSelection, useAllNonRejected]);

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
    return profileCandidates
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
  }, [profileCandidates, finalFilter]);

  function updateQuery(index: number, patch: Partial<Query>) {
    const queries = [...state.queries];
    queries[index] = { ...queries[index], ...patch };
    setState({ ...state, queries });
  }

  function updateCandidate(id: string, patch: Partial<Candidate>) {
    setState({ ...state, candidates: state.candidates.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)) });
  }

  async function saveQueries() {
    const next = await api<AppState>("/api/queries/update", { method: "POST", body: JSON.stringify({ queries: state.queries }) });
    setState(next);
  }

  async function saveCandidates() {
    const next = await api<AppState>("/api/candidates/update", { method: "POST", body: JSON.stringify({ candidates: state.candidates }) });
    setState(next);
  }

  async function handleImport(file: File) {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/import", { method: "POST", body: form });
    const next = await response.json();
    if (!response.ok) throw new Error(next.error || "Import failed.");
    setState(next);
  }

  async function resetData() {
    const next = await api<AppState>("/api/state", { method: "DELETE" });
    setState(next);
    setActiveStep(1);
    setNotice("Workflow data reset");
  }

  async function handleOneClickFile(file: File) {
    setOneClickText(await file.text());
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
              <button key={step} className={activeStep === number ? "active" : ""} onClick={() => setActiveStep(number)}>
                <span>{number}</span>
                {step}
              </button>
            );
          })}
          <div className="sidebar-divider" />
          <button className={isOneClick ? "active one-click-nav" : "one-click-nav"} onClick={() => setActiveStep(12)}>
            <span>1</span>
            One Click
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h2>{isOneClick ? "One Click" : steps[activeStep - 1]}</h2>
            <p>{isOneClick ? "Paste a JD, click Start, and stop at the scored shortlist before Apollo." : helperCopy(activeStep)}</p>
          </div>
          <div className="top-actions">
            <span className="mode real">Live API mode</span>
            <SmallButton onClick={() => refresh(true)}>Refresh</SmallButton>
            <SmallButton onClick={() => runAction("Reload state from disk", () => api<AppState>("/api/state"))}>Reload state</SmallButton>
            <SmallButton onClick={() => runAction("Reset running flags", () => api<AppState>("/api/state", { method: "POST", body: JSON.stringify({ resetRunningFlags: true }) }))}>Reset running</SmallButton>
            <SmallButton variant="danger" onClick={resetData}>Reset data</SmallButton>
          </div>
        </header>

        {!isOneClick ? (
          <div className="top-stepper">
            {steps.map((step, index) => <button key={step} className={activeStep === index + 1 ? "active" : activeStep > index + 1 ? "done" : ""} onClick={() => setActiveStep(index + 1)}>{step}</button>)}
          </div>
        ) : (
          <div className="top-stepper one-click-steps">
            {["Upload JD", "Generate searches", "Find profiles", "Scrape profiles", "Score fit + intent", "Download shortlist"].map((step, index) => <button key={step} className={state.oneClick.status === "completed" || index === 0 ? "done" : ""}>{step}</button>)}
          </div>
        )}

        {(notice || busy || state.status.errors.length > 0) && (
          <div className="toast">
            {!busy && <button className="toast-close" onClick={clearToast} aria-label="Dismiss notification">Dismiss</button>}
            {busy && <ProgressBanner label={busy} step={activeStep} candidates={profileCandidates.length} apifyDone={apifySuccessCount + apifyPartialCount} scored={scoredCount} messages={state.status.messages} />}
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
                <label><span>Max queries per run</span><input type="number" value={workflow.maxQueriesPerRun} onChange={(event) => setWorkflow({ ...workflow, maxQueriesPerRun: Number(event.target.value) })} /></label>
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
              <Field label="Intent keywords" value={briefForm.intent_terms} onChange={(value) => setBriefForm({ ...briefForm, intent_terms: value })} />
              <Field label="Exclusion keywords" value={briefForm.exclusions} onChange={(value) => setBriefForm({ ...briefForm, exclusions: value })} />
            </div>
            <Field label="Free-text JD / client brief" textarea value={briefForm.jd_text} onChange={(value) => setBriefForm({ ...briefForm, jd_text: value })} placeholder="Paste the client brief or role notes." />
            {state.brief?.expansions && Object.keys(state.brief.expansions).length > 0 && <div className="expansions"><strong>Auto-expanded terms</strong>{Object.entries(state.brief.expansions).map(([term, values]) => <span key={term}>{term}: {values.join(" OR ")}</span>)}</div>}
            <div className="actions"><SmallButton variant="primary" onClick={() => runAction("Save brief", () => api<AppState>("/api/brief", { method: "POST", body: JSON.stringify(briefForm) }))}>Save Brief</SmallButton><SmallButton onClick={() => setActiveStep(3)}>Next</SmallButton></div>
          </section>
        )}

        {activeStep === 3 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Generate and choose searches</h3><p>Precision searches find obvious matches. Recall searches catch people whose profiles miss one visible keyword.</p></div>
            <div className="summary-cards"><Metric label="Brief" value={state.brief ? "Saved" : "Missing"} /><Metric label="Queries" value={state.queries.length} /><Metric label="Selected" value={selectedQueries.length} /><Metric label="Estimated searches" value={selectedQueries.length * runSettings.pagesPerQuery} /></div>
            <div className="actions"><SmallButton variant="primary" disabled={!state.brief} onClick={() => runAction("Generate query matrix", () => api<AppState>("/api/queries/generate", { method: "POST" }))}>Generate Query Matrix</SmallButton></div>
            {state.queries.length > 0 && (
              <details className="details-card" open>
                <summary>Review query list</summary>
                <QueryTable queries={state.queries} updateQuery={updateQuery} removeQuery={(index) => setState({ ...state, queries: state.queries.filter((_, idx) => idx !== index) })} />
                <div className="actions"><SmallButton onClick={() => setState({ ...state, queries: [...state.queries, { id: `manual_${Date.now()}`, brief_id: state.brief?.id ?? "manual", query_text: "site:linkedin.com/in ", query_type: "career_path", expected_filters: [], selected: true, priority: 5, notes: "Manual query" }] })}>Add Manual Query</SmallButton><SmallButton onClick={() => runAction("Save queries", saveQueries)}>Save Query Edits</SmallButton></div>
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
              <label><span>Max searches</span><input type="number" value={runSettings.maxSearches} onChange={(event) => setRunSettings({ ...runSettings, maxSearches: Number(event.target.value) })} /></label>
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
            <div className="actions"><SmallButton variant="primary" onClick={() => runAction("Clean data", () => api<AppState>("/api/candidates/clean", { method: "POST" }))}>Clean Data</SmallButton><a className="button secondary" href={downloadUrl("csv")}>Export CSV</a><a className="button secondary" href={downloadUrl("xlsx")}>Export XLSX</a><label className="button secondary file-button">Import CSV/XLSX<input type="file" accept=".csv,.xlsx" onChange={(event) => event.target.files?.[0] && handleImport(event.target.files[0])} /></label></div>
            <div className="summary-cards"><Metric label="Profile candidates" value={profileCandidates.length} /><Metric label="Post evidence saved" value={state.intentEvidenceSources.length} /><Metric label="Rejected results" value={state.rejectedSerpResults.length} /><Metric label="Missing post authors" value={state.intentEvidenceSources.filter((source) => source.source_status === "author_profile_missing").length} /></div>
            <CandidateEditor candidates={profileCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save candidates", saveCandidates)} />
          </section>
        )}

        {activeStep === 6 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Pull visible LinkedIn profile data</h3><p>Apify data enriches the existing SerpAPI evidence. Visibility and matched queries are preserved.</p></div>
            <div className="summary-cards"><Metric label="Candidates" value={profileCandidates.length} /><Metric label="Scraped" value={apifySuccessCount} /><Metric label="Partial" value={apifyPartialCount} /><Metric label="Run cap" value={workflow.maxProfilesToApify} /></div>
            <div className="actions"><SmallButton variant="primary" onClick={() => runAction("Scrape profiles with Apify", () => api<AppState>("/api/apify/run", { method: "POST", body: JSON.stringify({ maxProfiles: workflow.maxProfilesToApify }) }))}>Scrape Profiles with Apify</SmallButton></div>
            <ApifyProfileTable candidates={profileCandidates} onEvidence={setEvidenceCandidate} />
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
            <div className="summary-cards"><Metric label="Total parsed" value={profileCandidates.filter((c) => c.apify_status !== "pending_apify").length} /><Metric label="Passed" value={profileCandidates.filter((c) => c.passes_profile_filter).length} /><Metric label="Failed" value={profileCandidates.filter((c) => c.passes_profile_filter === false).length} /><Metric label="Location unknown" value={profileCandidates.filter((c) => c.actual_location_status === "unknown").length} /></div>
            <div className="actions"><SmallButton variant="primary" onClick={() => runAction("Apply profile filters", () => api<AppState>("/api/profile-filters/run", { method: "POST", body: JSON.stringify(profileFilterForm) }))}>Apply Profile Filters</SmallButton></div>
            <ProfileFilterTable candidates={profileCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save profile filter decisions", saveCandidates)} />
          </section>
        )}

        {activeStep === 8 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Score fit and intent</h3><p>Scores rank candidates. They do not remove anyone automatically.</p></div>
            <div className="cost-panel">
              <div>
                <strong>Cost saver is on</strong>
                <p>Default scoring uses scraped profiles first, sorted by visibility, capped at {scoreSettings.maxCandidates}. Raise the cap only when you need more coverage.</p>
              </div>
              <label><span>Max candidates</span><input type="number" min={1} value={scoreSettings.maxCandidates} onChange={(event) => setScoreSettings({ ...scoreSettings, maxCandidates: Number(event.target.value) })} /></label>
              <label className="switch-row"><input type="checkbox" checked={scoreSettings.onlyScraped} onChange={(event) => setScoreSettings({ ...scoreSettings, onlyScraped: event.target.checked })} /> scored scraped/partial only</label>
            </div>
            <div className="actions"><SmallButton variant="primary" onClick={() => runAction("Fit + Intent", () => api<AppState>("/api/analyze/run", { method: "POST", body: JSON.stringify({ mode: "fit_intent", ...scoreSettings }) }))}>Fit + Intent</SmallButton><SmallButton onClick={() => runAction("Fit Only", () => api<AppState>("/api/analyze/run", { method: "POST", body: JSON.stringify({ mode: "fit", ...scoreSettings }) }))}>Fit Only</SmallButton><SmallButton onClick={() => runAction("Intent Only", () => api<AppState>("/api/analyze/run", { method: "POST", body: JSON.stringify({ mode: "intent", ...scoreSettings }) }))}>Intent Only</SmallButton><SmallButton onClick={() => setActiveStep(9)}>Skip</SmallButton></div>
            <div className="summary-cards"><Metric label="Profiles" value={profileCandidates.length} /><Metric label="Scored" value={scoredCount} /><Metric label="Scraped/partial" value={apifySuccessCount + apifyPartialCount} /><Metric label="Default cap" value={scoreSettings.maxCandidates} /></div>
            <ScoredTable candidates={profileCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save scores", saveCandidates)} onEvidence={setEvidenceCandidate} />
          </section>
        )}

        {activeStep === 9 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Human review gate</h3><p>Approve profiles before any Apollo spend. You can also download the scored shortlist here while Apollo is paused.</p></div>
            <div className="actions compact-actions"><a className="button primary" href={downloadUrl("xlsx")}>Download scored XLSX</a><a className="button secondary" href={downloadUrl("csv")}>Download scored CSV</a><a className="button secondary" href={downloadUrl("json")}>Download scored JSON</a></div>
            <div className="summary-cards"><Metric label="Approved" value={approvedCount} /><Metric label="Rejected" value={profileCandidates.filter((c) => c.manual_status === "rejected").length} /><Metric label="Needs enrichment" value={profileCandidates.filter((c) => c.needs_contact_enrichment).length} /></div>
            <ScoredTable candidates={profileCandidates} updateCandidate={updateCandidate} saveCandidates={() => runAction("Save manual review", saveCandidates)} onEvidence={setEvidenceCandidate} manual />
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
            <div className="actions"><SmallButton onClick={() => runAction("Estimate Apollo credits", () => api<{ state: AppState; estimate: Estimate; message: string }>("/api/apollo/enrich", { method: "POST", body: JSON.stringify({ selection: tierSelection, confirm: false, useAllNonRejected }) }), (value) => { setState(value.state); setApolloEstimate(value.estimate); setNotice(value.message); })}>Estimate Credits</SmallButton><SmallButton variant="primary" onClick={() => runAction("Apollo enrichment", () => api<{ state: AppState; estimate: Estimate }>("/api/apollo/enrich", { method: "POST", body: JSON.stringify({ selection: tierSelection, confirm: true, useAllNonRejected }) }), (value) => { setState(value.state); setApolloEstimate(value.estimate); })}>Confirm + Run Apollo</SmallButton></div>
          </section>
        )}

        {activeStep === 11 && (
          <section className="panel simple">
            <div className="section-heading"><h3>Final recruiter sheet</h3><p>Only real LinkedIn profile URLs appear here. Post URLs are evidence-only in the drawer and export evidence column.</p></div>
            <div className="summary-cards"><Metric label="Total candidates" value={profileCandidates.length} /><Metric label="Tier 1" value={tierCounts["Tier 1"]} /><Metric label="Tier 2" value={tierCounts["Tier 2"]} /><Metric label="Emails found" value={foundEmails} /><Metric label="Phones found" value={foundPhones} /></div>
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
                      setState({ ...state, oneClick: value });
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
    "Score fit and intent using the brief and merged candidate data.",
    "Approve, reject, or annotate before contact enrichment.",
    "Estimate Apollo credits and enrich selected tiers.",
    "Review and export the recruiter-ready sheet."
  ][step - 1];
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="metric-card"><strong>{value}</strong><span>{label}</span></div>;
}

function FilterField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <label><span>{label}</span><input value={value.join(", ")} onChange={(event) => onChange(event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></label>;
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

function ProgressBanner({ label, step, candidates, apifyDone, scored, messages }: { label: string; step: number; candidates: number; apifyDone: number; scored: number; messages: string[] }) {
  const target = step === 6 ? candidates : step === 7 ? candidates : undefined;
  const done = step === 6 ? apifyDone : step === 7 ? scored : undefined;
  const percent = target ? Math.min(100, Math.round(((done ?? 0) / Math.max(1, target)) * 100)) : undefined;
  const detail = step === 6
    ? `${apifyDone} of ${candidates} profiles have Apify data saved`
    : step === 7
      ? `${scored} of ${candidates} profiles scored`
      : messages[0] ?? "Working on the current step";
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
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Use</th><th>Query</th><th>Type</th><th>Filters</th><th>Priority</th><th>Notes</th><th /></tr></thead>
        <tbody>{queries.map((query, index) => <tr key={query.id}><td><input type="checkbox" checked={query.selected} onChange={(event) => updateQuery(index, { selected: event.target.checked })} /></td><td><textarea value={query.query_text} onChange={(event) => updateQuery(index, { query_text: event.target.value })} rows={2} /></td><td><select value={query.query_type} onChange={(event) => updateQuery(index, { query_type: event.target.value as QueryType })}>{queryTypes.map((type) => <option key={type}>{type}</option>)}</select></td><td><input value={query.expected_filters.join(", ")} onChange={(event) => updateQuery(index, { expected_filters: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></td><td><input type="number" value={query.priority} onChange={(event) => updateQuery(index, { priority: Number(event.target.value) })} /></td><td><input value={query.notes} onChange={(event) => updateQuery(index, { notes: event.target.value })} /></td><td><SmallButton variant="danger" onClick={() => removeQuery(index)}>Delete</SmallButton></td></tr>)}</tbody>
      </table>
    </div>
  );
}

function CandidateEditor({ candidates, updateCandidate, saveCandidates }: { candidates: Candidate[]; updateCandidate: (id: string, patch: Partial<Candidate>) => void; saveCandidates: () => void }) {
  if (candidates.length === 0) return <div className="empty-state">No profile candidates yet. Run search, then Clean Data.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>LinkedIn profile</th><th>Title</th><th>Company</th><th>Visibility</th><th>Status</th><th>Evidence notes</th><th /></tr></thead>
        <tbody>{candidates.map((candidate) => <tr key={candidate.id}><td><input value={candidate.name_guess} onChange={(event) => updateCandidate(candidate.id, { name_guess: event.target.value })} /></td><td><a href={profileUrl(candidate)} target="_blank">{candidate.normalized_linkedin_url}</a></td><td><input value={candidate.title_guess} onChange={(event) => updateCandidate(candidate.id, { title_guess: event.target.value })} /></td><td><input value={candidate.company_guess} onChange={(event) => updateCandidate(candidate.id, { company_guess: event.target.value })} /></td><td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td><td><span className={badgeClass(candidate.apify_status)}>{candidate.apify_status}</span></td><td className="clip">{candidate.snippets.join(" | ")}</td><td><SmallButton variant="danger" onClick={() => updateCandidate(candidate.id, { status: "deleted", manual_status: "rejected" })}>Reject</SmallButton></td></tr>)}</tbody>
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
                <td><span className={badgeClass(candidate.apify_status)}>{candidate.apify_status}</span></td>
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
          <thead><tr><th>Name</th><th>LinkedIn</th><th>Fit</th><th>Intent</th><th>Total</th><th>Tier</th><th>Visibility</th><th>Evidence</th>{manual && <th>Review</th>}<th>Notes</th></tr></thead>
          <tbody>{visible.map((candidate) => <tr key={candidate.id}><td>{displayName(candidate)}</td><td><a href={profileUrl(candidate)} target="_blank">Open profile</a></td><td><input type="number" value={candidate.fit_score ?? 0} onChange={(event) => updateCandidate(candidate.id, { fit_score: Number(event.target.value) })} /></td><td><input type="number" value={candidate.intent_score ?? 0} onChange={(event) => updateCandidate(candidate.id, { intent_score: Number(event.target.value) })} /></td><td><input type="number" value={candidate.total_score ?? 0} onChange={(event) => updateCandidate(candidate.id, { total_score: Number(event.target.value) })} /></td><td><select className={badgeClass(candidate.tier)} value={candidate.tier ?? "Tier 4"} onChange={(event) => updateCandidate(candidate.id, { tier: event.target.value as Tier })}>{tiers.map((tier) => <option key={tier}>{tier}</option>)}</select></td><td><span className="badge neutral">Visibility: {candidate.visibility_factor}</span></td><td><button className="link-button" onClick={() => onEvidence(candidate)}>View evidence</button></td>{manual && <td><select value={candidate.manual_status} onChange={(event) => updateCandidate(candidate.id, { manual_status: event.target.value as Candidate["manual_status"] })}><option value="pending">pending</option><option value="approved">approved</option><option value="rejected">rejected</option></select><label className="inline-check"><input type="checkbox" checked={candidate.needs_contact_enrichment} onChange={(event) => updateCandidate(candidate.id, { needs_contact_enrichment: event.target.checked })} /> enrich</label></td>}<td><textarea value={candidate.manual_notes} onChange={(event) => updateCandidate(candidate.id, { manual_notes: event.target.value })} rows={2} /></td></tr>)}</tbody>
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
    { step: "Intent shortlist", count: 50, note: "Intent signals found" },
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
        <thead><tr><th>Name</th><th>LinkedIn profile</th><th>Title</th><th>Company</th><th>Fit</th><th>Intent</th><th>Total</th><th>Tier</th><th>Visibility</th><th>Evidence</th></tr></thead>
        <tbody>
          {candidates.map((candidate) => (
            <tr key={candidate.id}>
              <td className="key-col">{displayName(candidate)}</td>
              <td><a href={profileUrl(candidate)} target="_blank">{candidate.normalized_linkedin_url}</a></td>
              <td>{candidate.profile_data?.current_title || candidate.title_guess}</td>
              <td>{candidate.profile_data?.current_company || candidate.company_guess}</td>
              <td>{candidate.fit_score ?? ""}</td>
              <td>{candidate.intent_score ?? ""}</td>
              <td className="key-col">{candidate.total_score ?? ""}</td>
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
        <EvidenceSection title="Intent evidence" items={candidate.intent_evidence} />
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
    ["Fit", candidate.fit_score ?? ""],
    ["Intent", candidate.intent_score ?? ""],
    ["Title", profile?.current_title || candidate.title_guess],
    ["Company", profile?.current_company || candidate.company_guess],
    ["Location", profile?.location || ""],
    ["Apify", candidate.apify_status],
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
