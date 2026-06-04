"use client";

import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";

const DB_NAME = "recruno-resume-evaluator";
const STORE_NAME = "projects";
const MAX_PDF_BYTES = 3_000_000;
const DEFAULT_MODEL = "gpt-5.2";

type Grade = {
  candidateName: string;
  totalScore: number;
  recommendation: "Strong Yes" | "Yes" | "Maybe" | "No" | "Strong No";
  categoryScores: Array<{ category: string; score: number; maxScore: number; evidence: string }>;
  strengths: string[];
  concerns: string[];
  missingEvidence: string[];
  summary: string;
  rawNotes: string;
};

type ResumeFile = {
  id: string;
  fileName: string;
  size: number;
  source: string;
  status: "queued" | "grading" | "graded" | "failed" | "skipped";
  blob?: Blob;
  error?: string;
  result?: Grade;
  gradedAt?: string;
};

type ResumeProject = {
  id: string;
  name: string;
  rubric: string;
  model: string;
  files: ResumeFile[];
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_RUBRIC = [
  "Grade each resume for a hiring shortlist.",
  "Score out of 100 using a practical recruiter rubric:",
  "- Role match and relevant experience: 35 points",
  "- Skills, tools, and domain fit: 25 points",
  "- Impact, project quality, and measurable outcomes: 20 points",
  "- Seniority, communication, and career trajectory: 10 points",
  "- Education, certifications, and other signal: 10 points",
  "Penalize missing evidence, vague claims, inconsistent timelines, and resumes that do not match the target role.",
  "Use clear evidence from the resume only."
].join("\n");

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function csvEscape(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsForExport(project: ResumeProject) {
  return project.files
    .filter((file) => file.result)
    .map((file) => ({
      "File Name": file.fileName,
      "Candidate Name": file.result?.candidateName ?? "",
      "Total Score": file.result?.totalScore ?? "",
      Recommendation: file.result?.recommendation ?? "",
      "Category Scores": file.result?.categoryScores.map((item) => `${item.category}: ${item.score}/${item.maxScore} - ${item.evidence}`).join("; ") ?? "",
      Strengths: file.result?.strengths.join("; ") ?? "",
      Concerns: file.result?.concerns.join("; ") ?? "",
      "Missing Evidence": file.result?.missingEvidence.join("; ") ?? "",
      Summary: file.result?.summary ?? "",
      "Raw Notes": file.result?.rawNotes ?? "",
      "Graded Timestamp": file.gradedAt ?? ""
    }));
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
  return new Promise<ResumeProject[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as ResumeProject[]);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function saveProject(project: ResumeProject) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(project);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

async function removeProject(idValue: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(idValue);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

function newProject(name = "Resume Screening Project"): ResumeProject {
  const now = new Date().toISOString();
  return { id: id("project"), name, rubric: DEFAULT_RUBRIC, model: DEFAULT_MODEL, files: [], createdAt: now, updatedAt: now };
}

export default function ResumeEvaluatorPage() {
  const [projects, setProjects] = useState<ResumeProject[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeProject = useMemo(() => projects.find((project) => project.id === activeId) ?? projects[0], [activeId, projects]);
  const gradedCount = activeProject?.files.filter((file) => file.status === "graded").length ?? 0;
  const queuedCount = activeProject?.files.filter((file) => file.status === "queued").length ?? 0;
  const failedCount = activeProject?.files.filter((file) => file.status === "failed").length ?? 0;
  const averageScore = useMemo(() => {
    const scores = activeProject?.files.map((file) => file.result?.totalScore).filter((score): score is number => typeof score === "number") ?? [];
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
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "Could not open browser storage."))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, []);

  function commitProject(project: ResumeProject) {
    const next = { ...project, updatedAt: new Date().toISOString() };
    setProjects((current) => current.map((item) => (item.id === next.id ? next : item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    void saveProject(next).catch((error) => setMessage(error instanceof Error ? error.message : "Could not save project."));
  }

  function updateActiveProject(patch: Partial<ResumeProject>) {
    if (!activeProject) return;
    commitProject({ ...activeProject, ...patch });
  }

  function updateFile(projectId: string, fileId: string, patch: Partial<ResumeFile>) {
    setProjects((current) => {
      const nextProjects = current.map((project) => {
        if (project.id !== projectId) return project;
        const nextProject = {
          ...project,
          updatedAt: new Date().toISOString(),
          files: project.files.map((file) => (file.id === fileId ? { ...file, ...patch } : file))
        };
        void saveProject(nextProject);
        return nextProject;
      });
      return nextProjects;
    });
  }

  async function handleCreateProject() {
    const project = newProject(`Resume Project ${projects.length + 1}`);
    await saveProject(project);
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
  }

  async function handleDuplicateProject() {
    if (!activeProject) return;
    const copy: ResumeProject = {
      ...activeProject,
      id: id("project"),
      name: `${activeProject.name} Copy`,
      files: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveProject(copy);
    setProjects((current) => [copy, ...current]);
    setActiveId(copy.id);
  }

  async function handleDeleteProject() {
    if (!activeProject || projects.length <= 1) return;
    await removeProject(activeProject.id);
    const remaining = projects.filter((project) => project.id !== activeProject.id);
    setProjects(remaining);
    setActiveId(remaining[0]?.id ?? "");
  }

  async function filesFromZip(file: File) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files);
    const resumeFiles: ResumeFile[] = [];
    for (const entry of entries) {
      if (entry.dir) continue;
      const name = entry.name.split("/").pop() || entry.name;
      if (!name.toLowerCase().endsWith(".pdf")) {
        resumeFiles.push({ id: id("file"), fileName: name, size: 0, source: file.name, status: "skipped", error: "Not a PDF file." });
        continue;
      }
      const blob = await entry.async("blob");
      resumeFiles.push({
        id: id("file"),
        fileName: name,
        size: blob.size,
        source: file.name,
        status: blob.size > MAX_PDF_BYTES ? "failed" : "queued",
        error: blob.size > MAX_PDF_BYTES ? "PDF is over the 3 MB v1 upload limit." : undefined,
        blob
      });
    }
    return resumeFiles;
  }

  async function handleFiles(files: FileList | null) {
    if (!activeProject || !files?.length) return;
    setMessage("Reading uploads...");
    const collected: ResumeFile[] = [];
    for (const file of Array.from(files)) {
      if (file.name.toLowerCase().endsWith(".zip")) {
        collected.push(...await filesFromZip(file));
      } else if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
        collected.push({
          id: id("file"),
          fileName: file.name,
          size: file.size,
          source: "direct upload",
          status: file.size > MAX_PDF_BYTES ? "failed" : "queued",
          error: file.size > MAX_PDF_BYTES ? "PDF is over the 3 MB v1 upload limit." : undefined,
          blob: file
        });
      } else {
        collected.push({ id: id("file"), fileName: file.name, size: file.size, source: "direct upload", status: "skipped", error: "Not a PDF file." });
      }
    }
    updateActiveProject({ files: [...collected, ...activeProject.files] });
    setMessage(`Added ${collected.filter((file) => file.status === "queued").length} PDF resumes to the queue.`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function gradeFile(projectId: string, file: ResumeFile, rubric: string, model: string) {
    if (!file.blob) {
      updateFile(projectId, file.id, { status: "failed", error: "Original PDF data is missing. Re-upload this file." });
      return;
    }
    if (file.blob.size > MAX_PDF_BYTES) {
      updateFile(projectId, file.id, { status: "failed", error: "PDF is over the 3 MB v1 upload limit." });
      return;
    }
    updateFile(projectId, file.id, { status: "grading", error: undefined });
    const form = new FormData();
    form.append("file", file.blob, file.fileName);
    form.append("fileName", file.fileName);
    form.append("rubric", rubric);
    form.append("model", model || DEFAULT_MODEL);
    const response = await fetch("/api/resume-evaluator/grade", { method: "POST", body: form });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      updateFile(projectId, file.id, { status: "failed", error: json.error || "Grading failed." });
      return;
    }
    updateFile(projectId, file.id, { status: "graded", result: json.grade, gradedAt: new Date().toISOString(), error: undefined });
  }

  async function handleGradeOne(file: ResumeFile) {
    if (!activeProject) return;
    setIsRunning(true);
    setMessage(`Grading ${file.fileName}...`);
    await gradeFile(activeProject.id, file, activeProject.rubric, activeProject.model);
    setMessage(`Finished ${file.fileName}.`);
    setIsRunning(false);
  }

  async function handleGradeAll() {
    if (!activeProject) return;
    setIsRunning(true);
    const queue = activeProject.files.filter((file) => (file.status === "queued" || file.status === "failed") && file.blob);
    for (const file of queue) {
      setMessage(`Grading ${file.fileName}...`);
      await gradeFile(activeProject.id, file, activeProject.rubric, activeProject.model);
    }
    setMessage(`Finished grading ${queue.length} resume${queue.length === 1 ? "" : "s"}.`);
    setIsRunning(false);
  }

  function clearResults() {
    if (!activeProject) return;
    updateActiveProject({
      files: activeProject.files.map((file) => file.blob ? { ...file, status: "queued", result: undefined, gradedAt: undefined, error: undefined } : file)
    });
  }

  function removeFile(fileId: string) {
    if (!activeProject) return;
    updateActiveProject({ files: activeProject.files.filter((file) => file.id !== fileId) });
  }

  function downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function downloadJson() {
    if (!activeProject) return;
    downloadBlob(new Blob([JSON.stringify(rowsForExport(activeProject), null, 2)], { type: "application/json" }), `${activeProject.name}-resume-grades.json`);
  }

  async function downloadCsv() {
    if (!activeProject) return;
    const rows = rowsForExport(activeProject);
    const headers = Object.keys(rows[0] ?? { "File Name": "" });
    const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header as keyof typeof row])).join(","))].join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv" }), `${activeProject.name}-resume-grades.csv`);
  }

  async function downloadXlsx() {
    if (!activeProject) return;
    const ExcelJS = await import("exceljs");
    const rows = rowsForExport(activeProject);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Resume Grades");
    worksheet.columns = Object.keys(rows[0] ?? { "File Name": "" }).map((header) => ({
      header,
      key: header,
      width: Math.min(52, Math.max(16, header.length + 6))
    }));
    rows.forEach((row) => worksheet.addRow(row));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${activeProject.name}-resume-grades.xlsx`);
  }

  if (loading) {
    return <main className="resume-evaluator-shell"><div className="resume-loading">Loading resume evaluator...</div></main>;
  }

  return (
    <main className="resume-evaluator-shell">
      <aside className="resume-sidebar">
        <div className="resume-brand">
          <span>R</span>
          <div>
            <h1>Resume Evaluator</h1>
            <p>Project-based AI grading</p>
          </div>
        </div>
        <button className="resume-button primary" onClick={handleCreateProject}>New Project</button>
        <div className="resume-project-list">
          {projects.map((project) => (
            <button key={project.id} className={project.id === activeProject?.id ? "active" : ""} onClick={() => setActiveId(project.id)}>
              <strong>{project.name}</strong>
              <span>{project.files.length} files · {project.files.filter((file) => file.status === "graded").length} graded</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="resume-workspace">
        {!activeProject ? null : (
          <>
            <header className="resume-topbar">
              <div>
                <input
                  className="resume-title-input"
                  value={activeProject.name}
                  onChange={(event) => updateActiveProject({ name: event.target.value })}
                  aria-label="Project name"
                />
                <p>Upload local PDFs or a zip, tune the rubric, grade each resume, then export the sheet.</p>
              </div>
              <div className="resume-actions">
                <button className="resume-button" onClick={handleDuplicateProject}>Duplicate</button>
                <button className="resume-button danger" disabled={projects.length <= 1} onClick={handleDeleteProject}>Delete</button>
              </div>
            </header>

            {message ? <div className="resume-message">{message}</div> : null}

            <div className="resume-metrics">
              <div><strong>{activeProject.files.length}</strong><span>Total files</span></div>
              <div><strong>{queuedCount}</strong><span>Queued</span></div>
              <div><strong>{gradedCount}</strong><span>Graded</span></div>
              <div><strong>{failedCount}</strong><span>Needs review</span></div>
              <div><strong>{averageScore || "-"}</strong><span>Avg score</span></div>
            </div>

            <div className="resume-grid">
              <section className="resume-panel">
                <div className="resume-section-head">
                  <div>
                    <h2>Rubric / grading scheme</h2>
                    <p>Each project keeps its own prompt and model setting.</p>
                  </div>
                  <label>
                    <span>Model</span>
                    <input value={activeProject.model} onChange={(event) => updateActiveProject({ model: event.target.value })} />
                  </label>
                </div>
                <textarea
                  className="resume-rubric"
                  value={activeProject.rubric}
                  onChange={(event) => updateActiveProject({ rubric: event.target.value })}
                  rows={14}
                />
              </section>

              <section className="resume-panel">
                <div className="resume-section-head">
                  <div>
                    <h2>Upload resumes</h2>
                    <p>Zip files are unpacked in the browser. PDFs over {formatBytes(MAX_PDF_BYTES)} are held for review.</p>
                  </div>
                </div>
                <label className="resume-dropzone">
                  <input ref={fileInputRef} type="file" multiple accept=".pdf,.zip,application/pdf,application/zip" onChange={(event) => void handleFiles(event.target.files)} />
                  <strong>Add PDFs or zip</strong>
                  <span>Local files stay in this browser until each PDF is sent for grading.</span>
                </label>
                <div className="resume-actions">
                  <button className="resume-button primary" disabled={isRunning || !activeProject.files.some((file) => file.status === "queued" && file.blob)} onClick={() => void handleGradeAll()}>
                    Grade Queue
                  </button>
                  <button className="resume-button" disabled={isRunning || !activeProject.files.length} onClick={clearResults}>Reset Results</button>
                  <button className="resume-button" disabled={!gradedCount} onClick={() => void downloadXlsx()}>Download XLSX</button>
                  <button className="resume-button" disabled={!gradedCount} onClick={() => void downloadCsv()}>CSV</button>
                  <button className="resume-button" disabled={!gradedCount} onClick={() => void downloadJson()}>JSON</button>
                </div>
              </section>
            </div>

            <section className="resume-panel resume-results-panel">
              <div className="resume-section-head">
                <div>
                  <h2>Resume queue and results</h2>
                  <p>Rows are stored with this project in browser storage.</p>
                </div>
              </div>
              <div className="resume-table-wrap">
                <table className="resume-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Status</th>
                      <th>Candidate</th>
                      <th>Score</th>
                      <th>Recommendation</th>
                      <th>Summary</th>
                      <th>Concerns / missing evidence</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeProject.files.length ? activeProject.files.map((file) => (
                      <tr key={file.id}>
                        <td>
                          <strong>{file.fileName}</strong>
                          <span>{formatBytes(file.size)} · {file.source}</span>
                        </td>
                        <td><span className={`resume-status ${file.status}`}>{file.status}</span>{file.error ? <em>{file.error}</em> : null}</td>
                        <td>{file.result?.candidateName ?? "-"}</td>
                        <td>{file.result?.totalScore ?? "-"}</td>
                        <td>{file.result?.recommendation ?? "-"}</td>
                        <td className="resume-long">{file.result?.summary ?? "-"}</td>
                        <td className="resume-long">{[...(file.result?.concerns ?? []), ...(file.result?.missingEvidence ?? [])].join("; ") || "-"}</td>
                        <td>
                          <div className="resume-row-actions">
                            <button className="resume-button small" disabled={isRunning || !file.blob} onClick={() => void handleGradeOne(file)}>Grade</button>
                            <button className="resume-button small danger" onClick={() => removeFile(file.id)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={8} className="resume-empty">No resumes yet. Add PDFs or a zip file to start grading.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
