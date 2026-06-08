"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DB_NAME = "recruno-interview-evaluator";
const STORE_NAME = "projects";
const DEFAULT_MODEL = "gpt-5.4-mini";

type SectionScore = {
  section: string;
  score: number;
  maxScore: number;
  evidence: string[];
  feedback: string;
};

type InterviewEvaluation = {
  candidateName: string;
  cleanedTranscript: string;
  totalScore: number;
  recommendation: "Strong Hire" | "Hire" | "Maybe" | "No Hire" | "Strong No Hire";
  sectionScores: SectionScore[];
  questionCoverage: Array<{ question: string; answered: "yes" | "partial" | "no"; evidence: string; scoreImpact: string }>;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  followUps: string[];
  summary: string;
};

type Candidate = {
  id: string;
  name: string;
  transcript: string;
  status: "draft" | "queued" | "evaluating" | "evaluated" | "failed";
  saved: boolean;
  error?: string;
  result?: InterviewEvaluation;
  evaluatedAt?: string;
};

type Project = {
  id: string;
  name: string;
  model: string;
  rubric: string;
  questionnaire: string;
  candidates: Candidate[];
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_RUBRIC = [
  "Evaluate interview performance out of 100.",
  "Use the questionnaire sections if present. Otherwise score across:",
  "- Role competence and technical depth",
  "- Communication clarity",
  "- Problem solving and examples",
  "- Ownership, judgment, and culture fit",
  "- Evidence quality and completeness",
  "Penalize vague answers, missing examples, and unsupported claims."
].join("\n");

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function listProjects() {
  const db = await openDb();
  return new Promise<Project[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as Project[]);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function saveProject(project: Project) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(project);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function removeProject(projectId: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(projectId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

function newProject(name = "Interview Project"): Project {
  const now = new Date().toISOString();
  return { id: id("project"), name, model: DEFAULT_MODEL, rubric: DEFAULT_RUBRIC, questionnaire: "", candidates: [], createdAt: now, updatedAt: now };
}

function newCandidate(index: number): Candidate {
  return { id: id("candidate"), name: `Candidate ${index}`, transcript: "", status: "draft", saved: false };
}

function formatList(items: string[]) {
  return items.length ? items.map((item) => `• ${item}`).join("\n") : "-";
}

function sheetCell(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").replace(/\t/g, " ").trim();
}

function sheetRow(candidate: Candidate | undefined) {
  if (!candidate?.result) return "";
  const result = candidate.result;
  const sectionCells = result.sectionScores.flatMap((section) => [
    `${section.section} Score`,
    `${section.score}/${section.maxScore}`
  ]);
  return [
    "Name",
    result.candidateName,
    ...sectionCells,
    "Total Score",
    result.totalScore,
    "Verdict",
    result.recommendation,
    "Summary",
    result.summary
  ].map(sheetCell).join("\t");
}

export default function InterviewEvaluatorPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stopRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  const activeProject = useMemo(() => projects.find((project) => project.id === activeId) ?? projects[0], [activeId, projects]);
  const selectedCandidate = useMemo(() => activeProject?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? activeProject?.candidates[0], [activeProject, selectedCandidateId]);
  const leaderboard = useMemo(() => {
    return (activeProject?.candidates ?? [])
      .filter((candidate) => candidate.saved && candidate.result)
      .sort((a, b) => (b.result?.totalScore ?? 0) - (a.result?.totalScore ?? 0));
  }, [activeProject]);
  const evaluatedCount = activeProject?.candidates.filter((candidate) => candidate.status === "evaluated").length ?? 0;
  const queuedCount = activeProject?.candidates.filter((candidate) => candidate.status === "queued" || candidate.status === "failed" || candidate.status === "draft").length ?? 0;
  const averageScore = useMemo(() => {
    const scores = (activeProject?.candidates ?? []).map((candidate) => candidate.result?.totalScore).filter((score): score is number => typeof score === "number");
    return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  }, [activeProject]);

  useEffect(() => {
    let mounted = true;
    listProjects()
      .then(async (stored) => {
        if (!mounted) return;
        const next = stored.length ? stored.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [newProject()];
        if (!stored.length) await saveProject(next[0]);
        setProjects(next);
        setActiveId(next[0].id);
        setSelectedCandidateId(next[0].candidates[0]?.id ?? "");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Could not open browser storage."))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, []);

  function commitProject(project: Project) {
    const next = { ...project, updatedAt: new Date().toISOString() };
    setProjects((current) => current.map((item) => (item.id === next.id ? next : item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    void saveProject(next).catch((error) => setMessage(error instanceof Error ? error.message : "Could not save project."));
  }

  function updateActiveProject(patch: Partial<Project>) {
    if (!activeProject) return;
    commitProject({ ...activeProject, ...patch });
  }

  function updateCandidate(candidateId: string, patch: Partial<Candidate>) {
    if (!activeProject) return;
    const next = {
      ...activeProject,
      candidates: activeProject.candidates.map((candidate) => candidate.id === candidateId ? { ...candidate, ...patch } : candidate)
    };
    commitProject(next);
  }

  async function handleCreateProject() {
    const project = newProject(`Interview Project ${projects.length + 1}`);
    await saveProject(project);
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    setSelectedCandidateId("");
  }

  async function handleDeleteProject() {
    if (!activeProject || projects.length <= 1) return;
    await removeProject(activeProject.id);
    const remaining = projects.filter((project) => project.id !== activeProject.id);
    setProjects(remaining);
    setActiveId(remaining[0]?.id ?? "");
    setSelectedCandidateId(remaining[0]?.candidates[0]?.id ?? "");
  }

  function handleAddCandidate() {
    if (!activeProject) return;
    const candidate = newCandidate(activeProject.candidates.length + 1);
    updateActiveProject({ candidates: [candidate, ...activeProject.candidates] });
    setSelectedCandidateId(candidate.id);
  }

  function handleRenameProject() {
    if (!activeProject) return;
    const nextName = window.prompt("Rename project", activeProject.name);
    if (nextName?.trim()) updateActiveProject({ name: nextName.trim() });
  }

  function clearCandidates() {
    if (!activeProject) return;
    updateActiveProject({ candidates: [] });
    setSelectedCandidateId("");
    setMessage("Cleared candidates. Questionnaire and rubric were kept.");
  }

  function removeCandidate(candidateId: string) {
    if (!activeProject) return;
    const nextCandidates = activeProject.candidates.filter((candidate) => candidate.id !== candidateId);
    updateActiveProject({ candidates: nextCandidates });
    if (selectedCandidateId === candidateId) setSelectedCandidateId(nextCandidates[0]?.id ?? "");
  }

  async function handleTxtUpload(file: File | undefined, target: "questionnaire" | "transcript") {
    if (!file || !activeProject) return;
    const text = await file.text();
    if (target === "questionnaire") {
      updateActiveProject({ questionnaire: text });
    } else if (selectedCandidate) {
      updateCandidate(selectedCandidate.id, { transcript: text });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function evaluateCandidate(candidate: Candidate, signal?: AbortSignal) {
    if (!activeProject) return;
    if (!candidate.transcript.trim()) {
      updateCandidate(candidate.id, { status: "failed", error: "Transcript is missing." });
      return;
    }
    updateCandidate(candidate.id, { status: "evaluating", error: undefined });
    const response = await fetch("/api/interview-evaluator/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        candidateName: candidate.name,
        transcript: candidate.transcript,
        rubric: activeProject.rubric,
        questionnaire: activeProject.questionnaire,
        model: activeProject.model || DEFAULT_MODEL
      })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      updateCandidate(candidate.id, { status: "failed", error: json.error || "Evaluation failed." });
      return;
    }
    updateCandidate(candidate.id, {
      name: json.evaluation?.candidateName || candidate.name,
      status: "evaluated",
      result: json.evaluation,
      evaluatedAt: new Date().toISOString(),
      error: undefined
    });
  }

  async function handleEvaluateOne(candidate: Candidate) {
    setRunning(true);
    stopRef.current = false;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setMessage(`Evaluating ${candidate.name}...`);
    try {
      await evaluateCandidate(candidate, controller.signal);
      setMessage(`Finished ${candidate.name}.`);
    } catch (error) {
      updateCandidate(candidate.id, { status: "queued", error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Evaluation failed." });
    } finally {
      controllersRef.current.delete(controller);
      setRunning(false);
    }
  }

  async function handleEvaluateBatch() {
    if (!activeProject) return;
    const queue = activeProject.candidates.filter((candidate) => candidate.transcript.trim() && candidate.status !== "evaluating");
    if (!queue.length) {
      setMessage("Add candidate transcripts before evaluating.");
      return;
    }
    setRunning(true);
    stopRef.current = false;
    let completed = 0;
    setMessage(`Queued ${queue.length} candidate${queue.length === 1 ? "" : "s"}. Evaluating one at a time...`);
    for (const candidate of queue) {
      if (stopRef.current) break;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        setMessage(`Evaluating ${candidate.name} (${completed + 1}/${queue.length})...`);
        await evaluateCandidate(candidate, controller.signal);
        completed += 1;
      } catch (error) {
        updateCandidate(candidate.id, { status: "queued", error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Evaluation failed." });
      } finally {
        controllersRef.current.delete(controller);
      }
    }
    setRunning(false);
    setMessage(stopRef.current ? `Stopped queue after ${completed}/${queue.length} candidates.` : `Finished evaluating ${completed} candidate${completed === 1 ? "" : "s"} in sequence.`);
    stopRef.current = false;
  }

  function stopEvaluation() {
    stopRef.current = true;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    if (activeProject) {
      updateActiveProject({
        candidates: activeProject.candidates.map((candidate) => candidate.status === "evaluating" ? { ...candidate, status: "queued", error: "Stopped before completion." } : candidate)
      });
    }
    setRunning(false);
    setMessage("Stop requested.");
  }

  if (loading) {
    return <main className="interview-shell"><div className="interview-loading">Loading interview evaluator...</div></main>;
  }

  return (
    <main className="interview-shell">
      <aside className="interview-sidebar">
        <div className="interview-brand">
          <span>I</span>
          <div>
            <h1>Interview Evaluator</h1>
            <p>Transcript cleanup and scoring</p>
          </div>
        </div>
        <button className="interview-button primary" onClick={handleCreateProject}>New Project</button>
        <div className="interview-project-list">
          {projects.map((project) => (
            <button key={project.id} className={project.id === activeProject?.id ? "active" : ""} onClick={() => { setActiveId(project.id); setSelectedCandidateId(project.candidates[0]?.id ?? ""); }}>
              <strong>{project.name}</strong>
              <span>{project.candidates.length} candidates · {project.candidates.filter((candidate) => candidate.saved).length} saved</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="interview-workspace">
        {!activeProject ? null : (
          <>
            <header className="interview-topbar">
              <div>
                <input className="interview-title-input" value={activeProject.name} onChange={(event) => updateActiveProject({ name: event.target.value })} />
                <p>Paste questionnaire and rubric once, then add candidate transcripts and evaluate up to 5 at a time.</p>
              </div>
              <div className="interview-actions">
                <button className="interview-button" onClick={handleRenameProject}>Rename</button>
                <button className="interview-button" onClick={handleAddCandidate}>Add Candidate</button>
                <button className="interview-button danger" disabled={!activeProject.candidates.length} onClick={clearCandidates}>Clear Candidates</button>
                <button className="interview-button danger" disabled={projects.length <= 1} onClick={handleDeleteProject}>Delete Project</button>
              </div>
            </header>

            {message ? <div className="interview-message">{message}</div> : null}

            <div className="interview-metrics">
              <div><strong>{activeProject.candidates.length}</strong><span>Candidates</span></div>
              <div><strong>{evaluatedCount}</strong><span>Evaluated</span></div>
              <div><strong>{leaderboard.length}</strong><span>Saved</span></div>
              <div><strong>{queuedCount}</strong><span>Ready / retry</span></div>
              <div><strong>{averageScore || "-"}</strong><span>Avg score</span></div>
            </div>

            <section className="interview-panel">
              <div className="interview-config-grid">
                <label>
                  <span>Model</span>
                  <input value={activeProject.model} onChange={(event) => updateActiveProject({ model: event.target.value })} />
                </label>
                <label>
                  <span>Questionnaire</span>
                  <textarea rows={8} value={activeProject.questionnaire} onChange={(event) => updateActiveProject({ questionnaire: event.target.value })} placeholder="Paste sections/questions here..." />
                  <input ref={fileInputRef} type="file" accept=".txt,text/plain" onChange={(event) => void handleTxtUpload(event.target.files?.[0], "questionnaire")} />
                </label>
                <label>
                  <span>Rubric</span>
                  <textarea rows={8} value={activeProject.rubric} onChange={(event) => updateActiveProject({ rubric: event.target.value })} />
                </label>
              </div>
            </section>

            <div className="interview-main-grid">
              <section className="interview-panel">
                <div className="interview-section-head">
                  <div>
                    <h2>Candidates</h2>
                    <p>Queue mode evaluates all candidates with transcripts one at a time.</p>
                  </div>
                  <div className="interview-actions">
                    <button className="interview-button primary" disabled={running || !activeProject.candidates.length} onClick={() => void handleEvaluateBatch()}>Start Queue</button>
                    <button className="interview-button danger" disabled={!running} onClick={stopEvaluation}>Stop</button>
                  </div>
                </div>
                <div className="interview-candidate-list">
                  {activeProject.candidates.length ? activeProject.candidates.map((candidate) => (
                    <button key={candidate.id} className={candidate.id === selectedCandidate?.id ? "active" : ""} onClick={() => setSelectedCandidateId(candidate.id)}>
                      <strong>{candidate.name}</strong>
                      <span>{candidate.status}{candidate.result ? ` · ${candidate.result.totalScore}` : ""}{candidate.saved ? " · saved" : ""}</span>
                    </button>
                  )) : <div className="interview-empty">No candidates yet.</div>}
                </div>
              </section>

              <section className="interview-panel">
                {selectedCandidate ? (
                  <>
                    <div className="interview-section-head">
                      <label className="interview-candidate-name">
                        <span>Candidate name</span>
                        <input value={selectedCandidate.name} onChange={(event) => updateCandidate(selectedCandidate.id, { name: event.target.value })} />
                      </label>
                      <div className="interview-actions">
                        <button className="interview-button primary" disabled={running} onClick={() => void handleEvaluateOne(selectedCandidate)}>Evaluate</button>
                        <button className="interview-button" disabled={!selectedCandidate.result} onClick={() => updateCandidate(selectedCandidate.id, { saved: !selectedCandidate.saved })}>{selectedCandidate.saved ? "Unsave" : "Save Candidate"}</button>
                        <button className="interview-button danger" onClick={() => removeCandidate(selectedCandidate.id)}>Remove</button>
                      </div>
                    </div>
                    <label className="interview-transcript-field">
                      <span>Raw V0 transcript</span>
                      <textarea rows={12} value={selectedCandidate.transcript} onChange={(event) => updateCandidate(selectedCandidate.id, { transcript: event.target.value, status: "queued" })} placeholder="Paste messy transcript here..." />
                      <input type="file" accept=".txt,text/plain" onChange={(event) => void handleTxtUpload(event.target.files?.[0], "transcript")} />
                    </label>
                    {selectedCandidate.error ? <div className="interview-error">{selectedCandidate.error}</div> : null}
                  </>
                ) : <div className="interview-empty">Add a candidate to paste a transcript.</div>}
              </section>
            </div>

            {selectedCandidate?.result ? (
              <section className="interview-panel interview-results">
                <div className="interview-result-head">
                  <div>
                    <h2>{selectedCandidate.result.candidateName}</h2>
                    <p>{selectedCandidate.result.summary}</p>
                  </div>
                  <div className="interview-score-card">
                    <strong>{selectedCandidate.result.totalScore}</strong>
                    <span>{selectedCandidate.result.recommendation}</span>
                  </div>
                </div>
                <div className="interview-detail-grid">
                  <div>
                    <h3>Section Marks</h3>
                    <div className="interview-score-list">
                      {selectedCandidate.result.sectionScores.map((section, index) => (
                        <div key={`${section.section}-${index}`}>
                          <strong>{section.section}: {section.score}/{section.maxScore}</strong>
                          <p>{section.feedback}</p>
                          <em>{formatList(section.evidence)}</em>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3>Feedback</h3>
                    <dl className="interview-feedback">
                      <dt>Strengths</dt><dd>{formatList(selectedCandidate.result.strengths)}</dd>
                      <dt>Weaknesses</dt><dd>{formatList(selectedCandidate.result.weaknesses)}</dd>
                      <dt>Risks</dt><dd>{formatList(selectedCandidate.result.risks)}</dd>
                      <dt>Follow-ups</dt><dd>{formatList(selectedCandidate.result.followUps)}</dd>
                    </dl>
                  </div>
                </div>
                <div className="interview-detail-grid">
                  <div>
                    <h3>Question Coverage</h3>
                    <div className="interview-question-list">
                      {selectedCandidate.result.questionCoverage.map((item, index) => (
                        <div key={`${item.question}-${index}`}>
                          <strong>{item.answered.toUpperCase()} · {item.question}</strong>
                          <p>{item.evidence}</p>
                          <em>{item.scoreImpact}</em>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3>Cleaned V1 Transcript</h3>
                    <pre className="interview-cleaned">{selectedCandidate.result.cleanedTranscript}</pre>
                  </div>
                </div>
                <div className="interview-sheet-row">
                  <div className="interview-section-head">
                    <div>
                      <h3>Excel / Sheets Row</h3>
                      <p>Copy this row and paste directly into a spreadsheet.</p>
                    </div>
                    <button className="interview-button" onClick={() => void navigator.clipboard.writeText(sheetRow(selectedCandidate))}>Copy Row</button>
                  </div>
                  <textarea readOnly rows={3} value={sheetRow(selectedCandidate)} />
                </div>
              </section>
            ) : null}

            <section className="interview-panel">
              <div className="interview-section-head">
                <div>
                  <h2>Saved Leaderboard</h2>
                  <p>Saved candidates are ranked by total score.</p>
                </div>
              </div>
              <div className="interview-leaderboard">
                {leaderboard.length ? leaderboard.map((candidate, index) => (
                  <button key={candidate.id} onClick={() => setSelectedCandidateId(candidate.id)}>
                    <strong>#{index + 1} · {candidate.name}</strong>
                    <span>{candidate.result?.totalScore} · {candidate.result?.recommendation}</span>
                  </button>
                )) : <div className="interview-empty">No saved candidates yet.</div>}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
