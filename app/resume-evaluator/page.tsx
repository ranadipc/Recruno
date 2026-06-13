"use client";

import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";

const DB_NAME = "recruno-resume-evaluator";
const STORE_NAME = "projects";
const MAX_PDF_BYTES = 3_000_000;
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BATCH_DELAY_SECONDS = 3;
const DEFAULT_SHORTLIST_SCORE = 80;
const DEFAULT_REJECTION_SCORE = 45;
const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);

type Grade = {
  name: string;
  phoneNumber: string;
  email: string;
  linkedInUrl: string;
  extraFields?: Record<string, string>;
  totalScore: number;
  recommendation: "Strong Select" | "Select" | "Maybe" | "Reject" | "Strong Reject";
  subMarks: Array<{ section: string; score: number; maxScore: number; reason: string }>;
  remarks: {
    strengths: string[];
    weaknesses: string[];
    selectedOrRejectedReason: string;
    missingEvidence: string[];
    risks: string[];
  };
  summary: string;
};

type ResumeFile = {
  id: string;
  fileName: string;
  size: number;
  source: string;
  status: "queued" | "grading" | "graded" | "failed" | "skipped";
  blob?: Blob;
  extractedText?: string;
  extractionMethod?: "docx" | "pdf-best-effort" | "doc-best-effort" | "none";
  error?: string;
  result?: Grade;
  gradedAt?: string;
};

type SheetCandidate = {
  id: string;
  sourceRowNumber: number;
  original: Record<string, string>;
  status: "queued" | "grading" | "graded" | "failed";
  error?: string;
  result?: Grade;
  gradedAt?: string;
};

type ResumeProject = {
  id: string;
  name: string;
  mode: "resumes" | "sheet";
  rubric: string;
  model: string;
  batchSize: number;
  batchDelaySeconds: number;
  shortlistScore: number;
  rejectionScore: number;
  exportMinScore: number;
  files: ResumeFile[];
  sheetRows: SheetCandidate[];
  sheetFileName?: string;
  additionalColumns: string;
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
  const text = valueForCell(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function extensionFor(fileName: string) {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

function isSupportedResume(fileName: string) {
  return SUPPORTED_EXTENSIONS.has(extensionFor(fileName));
}

function decodeXml(text: string) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanExtractedText(text: string) {
  return text.replace(/[^\S\r\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function decodePdfString(value: string) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

async function extractResumeText(blob: Blob, fileName: string): Promise<{ text: string; method: ResumeFile["extractionMethod"] }> {
  const extension = extensionFor(fileName);
  try {
    if (extension === "docx") {
      const zip = await JSZip.loadAsync(blob);
      const documentXml = await zip.file("word/document.xml")?.async("text");
      if (documentXml) return { text: cleanExtractedText(decodeXml(documentXml)), method: "docx" };
    }
    const buffer = await blob.arrayBuffer();
    const raw = new TextDecoder("latin1").decode(buffer);
    if (extension === "pdf") {
      const chunks = [
        ...Array.from(raw.matchAll(/\(([^()]|\\[()nrt\\]){2,}\)\s*Tj/g)).map((match) => decodePdfString(match[0].replace(/\)\s*Tj$/, "").slice(1))),
        ...Array.from(raw.matchAll(/\[((?:\s*\((?:[^()]|\\[()nrt\\]){1,}\)\s*)+)\]\s*TJ/g)).map((match) =>
          Array.from(match[1].matchAll(/\(([^()]|\\[()nrt\\]){1,}\)/g)).map((item) => decodePdfString(item[0].slice(1, -1))).join(" ")
        )
      ];
      return { text: cleanExtractedText(chunks.join("\n")), method: chunks.length ? "pdf-best-effort" : "none" };
    }
    if (extension === "doc") {
      return { text: cleanExtractedText(raw.replace(/\0/g, " ").replace(/[^\x20-\x7E\r\n\t]+/g, " ")), method: "doc-best-effort" };
    }
  } catch {
    return { text: "", method: "none" };
  }
  return { text: "", method: "none" };
}

function valueForCell(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueForCell).filter(Boolean).join("; ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

function formatSubMarks(value: Grade["subMarks"] | undefined) {
  return (value ?? []).map((item) => `${item.section}: ${item.score}/${item.maxScore} - ${item.reason}`).join("\n");
}

function formatRemarks(grade: Grade | undefined) {
  if (!grade) return "";
  const sections = [
    ["Strengths", grade.remarks?.strengths],
    ["Weaknesses", grade.remarks?.weaknesses],
    ["Reason", grade.remarks?.selectedOrRejectedReason ? [grade.remarks.selectedOrRejectedReason] : []],
    ["Missing Evidence", grade.remarks?.missingEvidence],
    ["Risks", grade.remarks?.risks]
  ] as const;
  return sections
    .map(([label, items]) => (items ?? []).length ? `${label}:\n${(items ?? []).map((item) => `- ${item}`).join("\n")}` : "")
    .filter(Boolean)
    .join("\n\n");
}

function decisionBand(score: number | undefined, project: Pick<ResumeProject, "shortlistScore" | "rejectionScore">) {
  if (typeof score !== "number") return "";
  if (score >= project.shortlistScore) return "Shortlist";
  if (score <= project.rejectionScore) return "Reject";
  return "Review";
}

function canUseTextOnly(fileName: string, text: string) {
  const extension = extensionFor(fileName);
  return (extension === "doc" || extension === "docx") ? text.length >= 100 : text.length >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"") {
      if (quoted && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function rowsForExport(project: ResumeProject) {
  return project.files
    .filter((file) => file.result)
    .filter((file) => typeof file.result?.totalScore === "number" && file.result.totalScore >= project.exportMinScore)
    .map((file) => ({
      "File Name": file.fileName,
      Name: file.result?.name ?? "",
      "Phone Number": file.result?.phoneNumber ?? "",
      Email: file.result?.email ?? "",
      "Total Score": file.result?.totalScore ?? "",
      "LinkedIn URL": file.result?.linkedInUrl ?? "",
      "Decision Band": decisionBand(file.result?.totalScore, project),
      Recommendation: file.result?.recommendation ?? "",
      "Sub Marks": formatSubMarks(file.result?.subMarks),
      Remarks: formatRemarks(file.result),
      Summary: file.result?.summary ?? "",
      "Text Extraction": file.extractionMethod ?? "",
      "Graded Timestamp": file.gradedAt ?? ""
    }));
}

function sourceValue(row: Record<string, string>, patterns: RegExp[]) {
  const entry = Object.entries(row).find(([key, value]) => value && patterns.some((pattern) => pattern.test(key)));
  return entry?.[1] ?? "";
}

function sheetRowsForExport(project: ResumeProject) {
  const requestedColumns = project.additionalColumns
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .slice(0, 20);

  return project.sheetRows
    .filter((row) => row.result && row.result.totalScore >= project.exportMinScore)
    .map((row) => {
      const result = row.result!;
      const sourceName = sourceValue(row.original, [/^name$/i, /candidate.*name/i, /full.*name/i]);
      const sourcePhone = sourceValue(row.original, [/phone/i, /mobile/i, /contact.*number/i]);
      const sourceEmail = sourceValue(row.original, [/email/i]);
      const sourceLinkedIn = sourceValue(row.original, [/linkedin/i, /profile.*url/i, /profile.*link/i]);
      const requestedValues = Object.fromEntries(requestedColumns.map((column) => {
        const extracted = Object.entries(result.extraFields ?? {}).find(([key]) => key.toLowerCase() === column.toLowerCase())?.[1];
        const source = Object.entries(row.original).find(([key]) => key.toLowerCase() === column.toLowerCase())?.[1];
        return [column, extracted || source || ""];
      }));
      const scoredValues = {
        "Source Row": row.sourceRowNumber,
        Name: result.name || sourceName,
        "Phone Number": result.phoneNumber || sourcePhone,
        Email: result.email || sourceEmail,
        "Total Score": result.totalScore,
        "LinkedIn URL": result.linkedInUrl || sourceLinkedIn,
        ...requestedValues,
        "Decision Band": decisionBand(result.totalScore, project),
        Recommendation: result.recommendation,
        "Sub Marks": formatSubMarks(result.subMarks),
        Remarks: formatRemarks(result),
        Summary: result.summary,
        "Graded Timestamp": row.gradedAt ?? ""
      };
      const originalValues = Object.fromEntries(
        Object.entries(row.original).filter(([key]) => !Object.keys(scoredValues).some((scoredKey) => scoredKey.toLowerCase() === key.toLowerCase()))
      );
      return { ...scoredValues, ...originalValues };
    });
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
  return {
    id: id("project"),
    name,
    mode: "resumes",
    rubric: DEFAULT_RUBRIC,
    model: DEFAULT_MODEL,
    batchSize: DEFAULT_BATCH_SIZE,
    batchDelaySeconds: DEFAULT_BATCH_DELAY_SECONDS,
    shortlistScore: DEFAULT_SHORTLIST_SCORE,
    rejectionScore: DEFAULT_REJECTION_SCORE,
    exportMinScore: 70,
    files: [],
    sheetRows: [],
    additionalColumns: "",
    createdAt: now,
    updatedAt: now
  };
}

export default function ResumeEvaluatorPage() {
  const [projects, setProjects] = useState<ResumeProject[]>([]);
  const [activeId, setActiveId] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stopRequestedRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  const activeProject = useMemo(() => projects.find((project) => project.id === activeId) ?? projects[0], [activeId, projects]);
  const gradedCount = activeProject?.files.filter((file) => file.status === "graded").length ?? 0;
  const queuedCount = activeProject?.files.filter((file) => file.status === "queued").length ?? 0;
  const failedCount = activeProject?.files.filter((file) => file.status === "failed").length ?? 0;
  const sheetGradedCount = activeProject?.sheetRows.filter((row) => row.status === "graded").length ?? 0;
  const sheetQueuedCount = activeProject?.sheetRows.filter((row) => row.status === "queued").length ?? 0;
  const sheetFailedCount = activeProject?.sheetRows.filter((row) => row.status === "failed").length ?? 0;
  const averageScore = useMemo(() => {
    const items = activeProject?.mode === "sheet" ? activeProject.sheetRows : activeProject?.files ?? [];
    const scores = items
      .map((item) => Number(item.result?.totalScore))
      .filter((score) => Number.isFinite(score)) ?? [];
    return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  }, [activeProject]);

  useEffect(() => {
    let mounted = true;
    listProjects()
      .then(async (stored) => {
        if (!mounted) return;
        const next = stored.length
          ? stored
              .map((project) => ({
                ...project,
                mode: project.mode || "resumes",
                model: project.model || DEFAULT_MODEL,
                batchSize: project.batchSize || DEFAULT_BATCH_SIZE,
                batchDelaySeconds: project.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS,
                shortlistScore: project.shortlistScore || DEFAULT_SHORTLIST_SCORE,
                rejectionScore: project.rejectionScore || DEFAULT_REJECTION_SCORE,
                exportMinScore: project.exportMinScore ?? 70,
                sheetRows: project.sheetRows ?? [],
                additionalColumns: project.additionalColumns ?? ""
              }))
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          : [newProject()];
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

  function updateSheetRow(projectId: string, rowId: string, patch: Partial<SheetCandidate>) {
    setProjects((current) => current.map((project) => {
      if (project.id !== projectId) return project;
      const nextProject = {
        ...project,
        updatedAt: new Date().toISOString(),
        sheetRows: project.sheetRows.map((row) => row.id === rowId ? { ...row, ...patch } : row)
      };
      void saveProject(nextProject);
      return nextProject;
    }));
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
      sheetRows: [],
      sheetFileName: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await saveProject(copy);
    setProjects((current) => [copy, ...current]);
    setActiveId(copy.id);
  }

  function handleRenameProject() {
    if (!activeProject) return;
    const nextName = window.prompt("Rename project", activeProject.name);
    if (nextName?.trim()) updateActiveProject({ name: nextName.trim() });
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
      if (!isSupportedResume(name)) {
        resumeFiles.push({ id: id("file"), fileName: name, size: 0, source: file.name, status: "skipped", error: "Not a PDF, DOC, or DOCX file." });
        continue;
      }
      const blob = await entry.async("blob");
      const extracted = await extractResumeText(blob, name);
      const canGrade = blob.size <= MAX_PDF_BYTES || canUseTextOnly(name, extracted.text);
      resumeFiles.push({
        id: id("file"),
        fileName: name,
        size: blob.size,
        source: file.name,
        status: canGrade ? "queued" : "failed",
        error: canGrade ? undefined : "File is over the 3 MB v1 upload limit and local text extraction was too sparse.",
        blob,
        extractedText: extracted.text,
        extractionMethod: extracted.method
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
      } else if (isSupportedResume(file.name)) {
        const extracted = await extractResumeText(file, file.name);
        const canGrade = file.size <= MAX_PDF_BYTES || canUseTextOnly(file.name, extracted.text);
        collected.push({
          id: id("file"),
          fileName: file.name,
          size: file.size,
          source: "direct upload",
          status: canGrade ? "queued" : "failed",
          error: canGrade ? undefined : "File is over the 3 MB v1 upload limit and local text extraction was too sparse.",
          blob: file,
          extractedText: extracted.text,
          extractionMethod: extracted.method
        });
      } else {
        collected.push({ id: id("file"), fileName: file.name, size: file.size, source: "direct upload", status: "skipped", error: "Not a PDF, DOC, or DOCX file." });
      }
    }
    updateActiveProject({ files: [...collected, ...activeProject.files] });
    setMessage(`Added ${collected.filter((file) => file.status === "queued").length} resumes to the queue.`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSheetFile(file: File | undefined) {
    if (!activeProject || !file) return;
    setMessage(`Reading ${file.name}...`);
    let matrix: string[][] = [];
    if (file.name.toLowerCase().endsWith(".csv")) {
      matrix = parseCsv(await file.text());
    } else {
      const ExcelJS = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(await file.arrayBuffer()) as never);
      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        setMessage("The workbook has no worksheets.");
        return;
      }
      const columnCount = worksheet.columnCount;
      for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const values = Array.from({ length: columnCount }, (_, index) => worksheet.getRow(rowNumber).getCell(index + 1).text.trim());
        if (values.some(Boolean)) matrix.push(values);
      }
    }
    if (matrix.length < 2) {
      setMessage("The sheet needs a header row and at least one data row.");
      return;
    }
    const headers = matrix[0].map((header, index) => header || `Column ${index + 1}`);
    const sheetRows = matrix.slice(1).map((values, index) => ({
      id: id("sheet-row"),
      sourceRowNumber: index + 2,
      original: Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex] ?? ""])),
      status: "queued" as const
    }));
    updateActiveProject({ mode: "sheet", sheetFileName: file.name, sheetRows });
    setMessage(`Loaded ${sheetRows.length} rows from ${file.name}.`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function gradeSheetCandidate(projectId: string, row: SheetCandidate, rubric: string, model: string, additionalColumns: string, signal?: AbortSignal) {
    updateSheetRow(projectId, row.id, { status: "grading", error: undefined });
    const response = await fetch("/api/resume-evaluator/grade-row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ row: row.original, rubric, model: model || DEFAULT_MODEL, additionalColumns })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      updateSheetRow(projectId, row.id, { status: "failed", error: json.error || "Row grading failed." });
      return;
    }
    updateSheetRow(projectId, row.id, { status: "graded", result: json.grade, gradedAt: new Date().toISOString(), error: undefined });
  }

  async function gradeFile(projectId: string, file: ResumeFile, rubric: string, model: string, signal?: AbortSignal) {
    if (!file.blob) {
      updateFile(projectId, file.id, { status: "failed", error: "Original file data is missing. Re-upload this file." });
      return;
    }
    if (file.blob.size > MAX_PDF_BYTES && !canUseTextOnly(file.fileName, file.extractedText ?? "")) {
      updateFile(projectId, file.id, { status: "failed", error: "File is over the 3 MB v1 upload limit and local text extraction was too sparse." });
      return;
    }
    updateFile(projectId, file.id, { status: "grading", error: undefined });
    const form = new FormData();
    form.append("file", file.blob, file.fileName);
    form.append("fileName", file.fileName);
    form.append("rubric", rubric);
    form.append("model", model || DEFAULT_MODEL);
    if (file.extractedText) form.append("extractedText", file.extractedText);
    const response = await fetch("/api/resume-evaluator/grade", { method: "POST", body: form, signal });
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
    stopRequestedRef.current = false;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setMessage(`Grading ${file.fileName}...`);
    try {
      await gradeFile(activeProject.id, file, activeProject.rubric, activeProject.model, controller.signal);
      setMessage(`Finished ${file.fileName}.`);
    } catch (error) {
      updateFile(activeProject.id, file.id, { status: "queued", error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Grading failed." });
    } finally {
      controllersRef.current.delete(controller);
    }
    setIsRunning(false);
  }

  async function handleGradeAll() {
    if (!activeProject) return;
    setIsRunning(true);
    stopRequestedRef.current = false;
    const queue = activeProject.files.filter((file) => (file.status === "queued" || file.status === "failed") && file.blob);
    const concurrency = Math.max(1, Math.min(25, Math.floor(Number(activeProject.batchSize || DEFAULT_BATCH_SIZE))));
    const delayMs = Math.max(0, Math.min(60, Number(activeProject.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS))) * 1000;
    let cursor = 0;
    let completed = 0;
    setMessage(`Grading ${queue.length} resumes with ${concurrency} parallel request${concurrency === 1 ? "" : "s"}...`);
    async function gradeBatchFile(file: ResumeFile) {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        await gradeFile(activeProject.id, file, activeProject.rubric, activeProject.model, controller.signal);
        completed += 1;
        setMessage(`Graded ${completed}/${queue.length}. Running up to ${concurrency} at a time.`);
      } catch (error) {
        updateFile(activeProject.id, file.id, {
          status: "queued",
          error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Grading failed."
        });
      } finally {
        controllersRef.current.delete(controller);
      }
    }
    while (cursor < queue.length && !stopRequestedRef.current) {
      const batch = queue.slice(cursor, cursor + concurrency);
      cursor += batch.length;
      await Promise.all(batch.map((file) => gradeBatchFile(file)));
      if (cursor < queue.length && !stopRequestedRef.current && delayMs > 0) {
        setMessage(`Batch complete. Waiting ${delayMs / 1000}s before the next batch...`);
        await sleep(delayMs);
      }
    }
    setMessage(stopRequestedRef.current ? `Stopped grading. Completed ${completed}/${queue.length}; remaining files stayed queued.` : `Finished grading ${queue.length} resume${queue.length === 1 ? "" : "s"}.`);
    stopRequestedRef.current = false;
    setIsRunning(false);
  }

  async function handleGradeSheetRow(row: SheetCandidate) {
    if (!activeProject) return;
    setIsRunning(true);
    stopRequestedRef.current = false;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setMessage(`Grading source row ${row.sourceRowNumber}...`);
    try {
      await gradeSheetCandidate(activeProject.id, row, activeProject.rubric, activeProject.model, activeProject.additionalColumns, controller.signal);
      setMessage(`Finished source row ${row.sourceRowNumber}.`);
    } catch (error) {
      updateSheetRow(activeProject.id, row.id, { status: "queued", error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Row grading failed." });
    } finally {
      controllersRef.current.delete(controller);
      setIsRunning(false);
    }
  }

  async function handleGradeSheetAll() {
    if (!activeProject) return;
    setIsRunning(true);
    stopRequestedRef.current = false;
    const queue = activeProject.sheetRows.filter((row) => row.status === "queued" || row.status === "failed");
    const concurrency = Math.max(1, Math.min(25, Math.floor(Number(activeProject.batchSize || DEFAULT_BATCH_SIZE))));
    const delayMs = Math.max(0, Math.min(60, Number(activeProject.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS))) * 1000;
    let cursor = 0;
    let completed = 0;
    setMessage(`Grading ${queue.length} sheet rows with ${concurrency} parallel request${concurrency === 1 ? "" : "s"}...`);
    async function gradeBatchRow(row: SheetCandidate) {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        await gradeSheetCandidate(activeProject.id, row, activeProject.rubric, activeProject.model, activeProject.additionalColumns, controller.signal);
        completed += 1;
        setMessage(`Graded ${completed}/${queue.length} sheet rows.`);
      } catch (error) {
        updateSheetRow(activeProject.id, row.id, {
          status: "queued",
          error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Row grading failed."
        });
      } finally {
        controllersRef.current.delete(controller);
      }
    }
    while (cursor < queue.length && !stopRequestedRef.current) {
      const batch = queue.slice(cursor, cursor + concurrency);
      cursor += batch.length;
      await Promise.all(batch.map((row) => gradeBatchRow(row)));
      if (cursor < queue.length && !stopRequestedRef.current && delayMs > 0) {
        setMessage(`Batch complete. Waiting ${delayMs / 1000}s before the next batch...`);
        await sleep(delayMs);
      }
    }
    setMessage(stopRequestedRef.current ? `Stopped sheet grading after ${completed}/${queue.length} rows.` : `Finished grading ${completed} sheet rows.`);
    stopRequestedRef.current = false;
    setIsRunning(false);
  }

  function terminateGrading() {
    stopRequestedRef.current = true;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    if (activeProject) {
      updateActiveProject({
        files: activeProject.files.map((file) => file.status === "grading" ? { ...file, status: "queued", error: "Stopped before completion." } : file),
        sheetRows: activeProject.sheetRows.map((row) => row.status === "grading" ? { ...row, status: "queued", error: "Stopped before completion." } : row)
      });
    }
    setIsRunning(false);
    setMessage("Stop requested. In-flight grading requests are being cancelled.");
  }

  function clearResults() {
    if (!activeProject) return;
    updateActiveProject({
      files: activeProject.files.map((file) => file.blob ? { ...file, status: "queued", result: undefined, gradedAt: undefined, error: undefined } : file)
    });
  }

  function clearProfiles() {
    if (!activeProject) return;
    if (activeProject.mode === "sheet") {
      updateActiveProject({ sheetRows: [], sheetFileName: undefined });
      setMessage("Cleared spreadsheet rows. Rubric and project settings were kept.");
    } else {
      updateActiveProject({ files: [] });
      setMessage("Cleared uploaded profiles. Rubric and project settings were kept.");
    }
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
    const rows = activeProject.mode === "sheet" ? sheetRowsForExport(activeProject) : rowsForExport(activeProject);
    downloadBlob(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }), `${activeProject.name}-${activeProject.mode === "sheet" ? "sheet" : "resume"}-grades.json`);
  }

  async function downloadCsv() {
    if (!activeProject) return;
    const rows = activeProject.mode === "sheet" ? sheetRowsForExport(activeProject) : rowsForExport(activeProject);
    const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header as keyof typeof row])).join(","))].join("\n");
    downloadBlob(new Blob([csv], { type: "text/csv" }), `${activeProject.name}-${activeProject.mode === "sheet" ? "sheet" : "resume"}-grades.csv`);
  }

  async function downloadXlsx() {
    if (!activeProject) return;
    const ExcelJS = await import("exceljs");
    const rows = activeProject.mode === "sheet" ? sheetRowsForExport(activeProject) : rowsForExport(activeProject);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(activeProject.mode === "sheet" ? "Scored Candidates" : "Resume Grades");
    const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    worksheet.columns = headers.map((header) => ({
      header,
      key: header,
      width: Math.min(52, Math.max(16, header.length + 6))
    }));
    rows.forEach((row) => worksheet.addRow(row));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, headers.length) } };
    const buffer = await workbook.xlsx.writeBuffer();
    downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${activeProject.name}-${activeProject.mode === "sheet" ? "scored-sheet" : "resume-grades"}.xlsx`);
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
              <span>{project.mode === "sheet" ? `${project.sheetRows.length} rows · ${project.sheetRows.filter((row) => row.status === "graded").length} graded` : `${project.files.length} files · ${project.files.filter((file) => file.status === "graded").length} graded`}</span>
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
                <p>{activeProject.mode === "sheet" ? "Upload an Excel/CSV candidate sheet, grade each row, then download a newly scored workbook." : "Upload local resumes or a zip, tune the rubric, grade in parallel, then export the sheet."}</p>
              </div>
              <div className="resume-actions">
                <button className="resume-button" onClick={handleRenameProject}>Rename</button>
                <button className="resume-button" onClick={handleDuplicateProject}>Duplicate</button>
                <button className="resume-button danger" disabled={activeProject.mode === "sheet" ? !activeProject.sheetRows.length : !activeProject.files.length} onClick={clearProfiles}>{activeProject.mode === "sheet" ? "Clear Rows" : "Clear Profiles"}</button>
                <button className="resume-button danger" disabled={projects.length <= 1} onClick={handleDeleteProject}>Delete</button>
              </div>
            </header>

            {message ? <div className="resume-message">{message}</div> : null}

            <div className="resume-mode-tabs">
              <button className={activeProject.mode === "resumes" ? "active" : ""} onClick={() => updateActiveProject({ mode: "resumes" })}>Resume Files</button>
              <button className={activeProject.mode === "sheet" ? "active" : ""} onClick={() => updateActiveProject({ mode: "sheet" })}>Excel Sheet</button>
            </div>

            <div className="resume-metrics">
              <div><strong>{activeProject.mode === "sheet" ? activeProject.sheetRows.length : activeProject.files.length}</strong><span>{activeProject.mode === "sheet" ? "Total rows" : "Total files"}</span></div>
              <div><strong>{activeProject.mode === "sheet" ? sheetQueuedCount : queuedCount}</strong><span>Queued</span></div>
              <div><strong>{activeProject.mode === "sheet" ? sheetGradedCount : gradedCount}</strong><span>Graded</span></div>
              <div><strong>{activeProject.mode === "sheet" ? sheetFailedCount : failedCount}</strong><span>Needs review</span></div>
              <div><strong>{averageScore || "-"}</strong><span>Avg score</span></div>
            </div>

            <div className="resume-thresholds">
              <label>
                <span>Shortlist score</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={activeProject.shortlistScore || DEFAULT_SHORTLIST_SCORE}
                  onChange={(event) => updateActiveProject({ shortlistScore: Math.max(0, Math.min(100, Number(event.target.value) || DEFAULT_SHORTLIST_SCORE)) })}
                />
              </label>
              <label>
                <span>Reject score</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={activeProject.rejectionScore || DEFAULT_REJECTION_SCORE}
                  onChange={(event) => updateActiveProject({ rejectionScore: Math.max(0, Math.min(100, Number(event.target.value) || DEFAULT_REJECTION_SCORE)) })}
                />
              </label>
              <p>Scores at or above shortlist are best set. Scores at or below reject are worst set. Everything between is review.</p>
            </div>

            <div className="resume-grid">
              <section className="resume-panel">
                <div className="resume-section-head">
                  <div>
                    <h2>Rubric / grading scheme</h2>
                    <p>Required columns are always enforced. Use the rubric only to change scoring priorities.</p>
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
                    <h2>{activeProject.mode === "sheet" ? "Upload candidate sheet" : "Upload resumes"}</h2>
                    <p>{activeProject.mode === "sheet" ? "The first worksheet and first header row are used. Every nonblank row becomes a candidate." : `Zip files are unpacked in the browser. PDF, DOC, and DOCX files over ${formatBytes(MAX_PDF_BYTES)} are held for review.`}</p>
                  </div>
                </div>
                {activeProject.mode === "sheet" ? (
                  <>
                    <label className="resume-dropzone">
                      <input ref={fileInputRef} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => void handleSheetFile(event.target.files?.[0])} />
                      <strong>Add XLSX or CSV</strong>
                      <span>{activeProject.sheetFileName ? `${activeProject.sheetFileName} · ${activeProject.sheetRows.length} rows loaded` : "Your original columns will be preserved in the scored output."}</span>
                    </label>
                    <div className="resume-run-settings resume-export-filter">
                      <label>
                        <span>Additional output columns</span>
                        <input
                          value={activeProject.additionalColumns}
                          placeholder="Skills, Current company, Current company duration"
                          onChange={(event) => updateActiveProject({ additionalColumns: event.target.value })}
                        />
                      </label>
                      <p>Comma-separated, up to 20. Each field is extracted from the available row data and left blank when unavailable.</p>
                    </div>
                  </>
                ) : (
                  <label className="resume-dropzone">
                    <input ref={fileInputRef} type="file" multiple accept=".pdf,.doc,.docx,.zip,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip" onChange={(event) => void handleFiles(event.target.files)} />
                    <strong>Add resumes or zip</strong>
                    <span>Local files stay in this browser until each resume is sent for grading.</span>
                  </label>
                )}
                <div className="resume-run-settings">
                  <label>
                    <span>Parallel batch size</span>
                    <input
                      type="number"
                      min={1}
                      max={25}
                      value={activeProject.batchSize || DEFAULT_BATCH_SIZE}
                      onChange={(event) => updateActiveProject({ batchSize: Math.max(1, Math.min(25, Number(event.target.value) || DEFAULT_BATCH_SIZE)) })}
                    />
                  </label>
                  <label>
                    <span>Pause after each batch</span>
                    <select
                      value={activeProject.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS}
                      onChange={(event) => updateActiveProject({ batchDelaySeconds: Number(event.target.value) })}
                    >
                      <option value={0}>No delay</option>
                      <option value={3}>3 seconds</option>
                      <option value={5}>5 seconds</option>
                      <option value={10}>10 seconds</option>
                      <option value={20}>20 seconds</option>
                    </select>
                  </label>
                  <p>Use 10 at a time with a 3-5s pause for 100-150 resumes. Lower it if OpenAI rate limits or your machine feels slow.</p>
                </div>
                <div className="resume-run-settings resume-export-filter">
                  <label>
                    <span>Download candidates above score</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={activeProject.exportMinScore ?? 70}
                      onChange={(event) => updateActiveProject({ exportMinScore: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })}
                    />
                  </label>
                  <p>XLSX, CSV, and JSON downloads only include candidates at or above this score.</p>
                </div>
                <div className="resume-actions">
                  <button className="resume-button primary" disabled={isRunning || (activeProject.mode === "sheet" ? !activeProject.sheetRows.some((row) => row.status === "queued" || row.status === "failed") : !activeProject.files.some((file) => (file.status === "queued" || file.status === "failed") && file.blob))} onClick={() => void (activeProject.mode === "sheet" ? handleGradeSheetAll() : handleGradeAll())}>
                    Grade {activeProject.mode === "sheet" ? "Rows" : "Queue"} ({activeProject.batchSize || DEFAULT_BATCH_SIZE} at a time)
                  </button>
                  <button className="resume-button danger" disabled={!isRunning} onClick={terminateGrading}>Stop Grading</button>
                  {activeProject.mode === "resumes" ? <button className="resume-button" disabled={isRunning || !activeProject.files.length} onClick={clearResults}>Reset Results</button> : null}
                  <button className="resume-button" disabled={!(activeProject.mode === "sheet" ? sheetGradedCount : gradedCount)} onClick={() => void downloadXlsx()}>Download XLSX</button>
                  <button className="resume-button" disabled={!(activeProject.mode === "sheet" ? sheetGradedCount : gradedCount)} onClick={() => void downloadCsv()}>CSV</button>
                  <button className="resume-button" disabled={!(activeProject.mode === "sheet" ? sheetGradedCount : gradedCount)} onClick={() => void downloadJson()}>JSON</button>
                </div>
              </section>
            </div>

            <section className="resume-panel resume-results-panel">
              <div className="resume-section-head">
                <div>
                  <h2>{activeProject.mode === "sheet" ? "Sheet row queue and results" : "Resume queue and results"}</h2>
                  <p>{activeProject.mode === "sheet" ? "Original source values are preserved and the LinkedIn/profile URL is prioritized." : "Rows are stored with this project in browser storage."}</p>
                </div>
              </div>
              <div className="resume-table-wrap">
                {activeProject.mode === "sheet" ? (
                  <table className="resume-table">
                    <thead>
                      <tr>
                        <th>Source row</th>
                        <th>Status</th>
                        <th>Name</th>
                        <th>Phone</th>
                        <th>Email</th>
                        <th>Score</th>
                        <th>LinkedIn</th>
                        <th>Band</th>
                        <th>Recommendation</th>
                        <th>Sub marks</th>
                        <th>Additional fields</th>
                        <th>Remarks</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeProject.sheetRows.length ? activeProject.sheetRows.map((row) => {
                        const sourceName = sourceValue(row.original, [/^name$/i, /candidate.*name/i, /full.*name/i]);
                        const sourcePhone = sourceValue(row.original, [/phone/i, /mobile/i, /contact.*number/i]);
                        const sourceEmail = sourceValue(row.original, [/email/i]);
                        const sourceLinkedIn = sourceValue(row.original, [/linkedin/i, /profile.*url/i, /profile.*link/i]);
                        return (
                          <tr key={row.id}>
                            <td><strong>{row.sourceRowNumber}</strong></td>
                            <td><span className={`resume-status ${row.status}`}>{row.status}</span>{row.error ? <em>{row.error}</em> : null}</td>
                            <td>{row.result?.name || sourceName || "-"}</td>
                            <td>{row.result?.phoneNumber || sourcePhone || "-"}</td>
                            <td className="resume-long">{row.result?.email || sourceEmail || "-"}</td>
                            <td>{row.result?.totalScore ?? "-"}</td>
                            <td className="resume-long">{row.result?.linkedInUrl || sourceLinkedIn || "-"}</td>
                            <td>{row.result ? decisionBand(row.result.totalScore, activeProject) : "-"}</td>
                            <td>{row.result?.recommendation || "-"}</td>
                            <td className="resume-long">{formatSubMarks(row.result?.subMarks) || "-"}</td>
                            <td className="resume-long">
                              {Object.entries(row.result?.extraFields ?? {}).map(([key, value]) => `${key}: ${value || "-"}`).join("; ") || "-"}
                            </td>
                            <td className="resume-long">{formatRemarks(row.result) || "-"}</td>
                            <td>
                              <div className="resume-row-actions">
                                <button className="resume-button small" disabled={isRunning} onClick={() => void handleGradeSheetRow(row)}>Grade</button>
                                <button className="resume-button small danger" onClick={() => updateActiveProject({ sheetRows: activeProject.sheetRows.filter((item) => item.id !== row.id) })}>Remove</button>
                              </div>
                            </td>
                          </tr>
                        );
                      }) : <tr><td colSpan={13} className="resume-empty">No sheet loaded. Add an XLSX or CSV file to begin.</td></tr>}
                    </tbody>
                  </table>
                ) : (
                  <table className="resume-table">
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Status</th>
                        <th>Candidate</th>
                        <th>Phone</th>
                        <th>Email</th>
                        <th>Score</th>
                        <th>LinkedIn</th>
                        <th>Band</th>
                        <th>Recommendation</th>
                        <th>Sub marks</th>
                        <th>Remarks</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeProject.files.length ? activeProject.files.map((file) => (
                        <tr key={file.id}>
                          <td><strong>{file.fileName}</strong><span>{formatBytes(file.size)} · {file.source}</span></td>
                          <td><span className={`resume-status ${file.status}`}>{file.status}</span>{file.error ? <em>{file.error}</em> : null}</td>
                          <td>{file.result?.name || "-"}</td>
                          <td>{file.result?.phoneNumber || "-"}</td>
                          <td className="resume-long">{file.result?.email || "-"}</td>
                          <td>{file.result?.totalScore ?? "-"}</td>
                          <td className="resume-long">{file.result?.linkedInUrl || "-"}</td>
                          <td>{file.result ? decisionBand(file.result.totalScore, activeProject) : "-"}</td>
                          <td>{file.result?.recommendation || "-"}</td>
                          <td className="resume-long">{formatSubMarks(file.result?.subMarks) || "-"}</td>
                          <td className="resume-long">{formatRemarks(file.result) || "-"}</td>
                          <td><div className="resume-row-actions"><button className="resume-button small" disabled={isRunning || !file.blob} onClick={() => void handleGradeOne(file)}>Grade</button><button className="resume-button small danger" onClick={() => removeFile(file.id)}>Remove</button></div></td>
                        </tr>
                      )) : <tr><td colSpan={12} className="resume-empty">No resumes yet. Add PDF, DOC, DOCX, or a zip file to start grading.</td></tr>}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
