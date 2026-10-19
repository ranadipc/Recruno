"use client";

import JSZip from "jszip";
import { scoreLabel, reusableRules, resumeQueue, validateRules, type RubricRules, type RubricGrade } from "@/lib/rubric";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractResumeDocument,
  renderPdfPagesAsImages,
  type ExtractionQuality,
  type ResumeExtractionMethod
} from "@/lib/resume-extraction";

const DB_NAME = "recruno-resume-evaluator";
const STORE_NAME = "projects";
const MAX_PDF_BYTES = 3_000_000;
const MAX_VISUAL_FALLBACK_BYTES = 15_000_000;
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_EFFORT = "medium";
const OPENAI_MODELS = [
  { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { value: "gpt-6-astra", label: "GPT-6 Astra" },
  { value: "gpt-6-luna", label: "GPT-6 Luna" },
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { value: DEFAULT_MODEL, label: "GPT-5.4 Mini (existing default)" }
] as const;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_BATCH_DELAY_SECONDS = 3;
const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);

type LlmProvider = "openai" | "deepseek";
type LlmEffort = "low" | "medium" | "high";

type Grade = RubricGrade;

type ResumeFile = {
  id: string;
  fileName: string;
  size: number;
  source: string;
  status: "queued" | "grading" | "graded" | "failed" | "skipped";
  blob?: Blob;
  extractedText?: string;
  extractionMethod?: ResumeExtractionMethod;
  extractionQuality?: ExtractionQuality;
  gradingInputMode?: "text" | "page-images" | "original-file";
  error?: string;
  result?: Grade;
  previousResults?: Array<{ result: Grade; gradedAt?: string }>;
  gradedAt?: string;
};

type SheetCandidate = {
  id: string;
  sourceRowNumber: number;
  original: Record<string, string>;
  status: "queued" | "grading" | "graded" | "failed";
  error?: string;
  result?: Grade;
  previousResults?: Array<{ result: Grade; gradedAt?: string }>;
  gradedAt?: string;
};

type ResumeProject = {
  id: string;
  name: string;
  mode: "resumes" | "sheet";
  rubric: string;
  rubricVersions?: RubricRules[];
  provider: LlmProvider;
  model: string;
  effort: LlmEffort;
  batchSize: number;
  batchDelaySeconds: number;
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

function valueForCell(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueForCell).filter(Boolean).join("; ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

function formatSubMarks(value: Grade["subMarks"] | undefined) {
  return (value ?? []).map((item) => `${item.section}: ${item.score ?? "Unknown"}/${item.maxScore} - ${item.reason} | Evidence: ${item.evidence || "Not available"} | Anchor: ${item.anchor || "Legacy"}`).join("\n");
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

function decisionBand(grade: Grade | undefined) {
  return grade?.disposition || "Legacy result — re-evaluate";
}

function gradeExportFields(grade: Grade) {
  return {
    "Rubric Version": grade.rubricVersion || "Legacy — unverified",
    "Score Report": scoreLabel(grade),
    "Maximum Score": grade.maxScore ?? "Unknown (legacy)",
    "Evidenced Points": grade.evidencedScore ?? "",
    "Unresolved Points": grade.unresolvedPoints ?? "",
    "Possible Minimum": grade.possibleMinimum ?? "",
    "Possible Maximum": grade.possibleMaximum ?? "",
    "Review Flags": grade.reviewFlags?.join("; ") ?? "",
    "Rubric Details": JSON.stringify(grade.details ?? {})
  };
}

function exportVersions<T extends { result?: Grade; previousResults?: Array<{ result: Grade; gradedAt?: string }>; gradedAt?: string }>(items: T[]): T[] {
  return items.flatMap(item => [
    ...(item.result ? [item] : []),
    ...(item.previousResults ?? []).map(old => ({ ...item, result: old.result, gradedAt: old.gradedAt }))
  ]);
}

function canUseTextOnly(fileName: string, text: string, quality?: ExtractionQuality) {
  const extension = extensionFor(fileName);
  const hasEnoughText = (extension === "doc" || extension === "docx") ? text.length >= 100 : text.length >= 300;
  return hasEnoughText && (!quality || quality.status === "good");
}

function canGradeResumeFile(fileName: string, size: number, text: string, quality?: ExtractionQuality) {
  if (size <= MAX_PDF_BYTES || canUseTextOnly(fileName, text, quality)) return true;
  return extensionFor(fileName) === "pdf" && size <= MAX_VISUAL_FALLBACK_BYTES;
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
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field. Correct the file and retry.");
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function rowsForExport(project: ResumeProject) {
  return exportVersions(project.files)
    .filter((file) => file.result)
    .map((file) => ({
      ...gradeExportFields(file.result!),
      "File Name": file.fileName,
      Name: file.result?.name ?? "",
      "Phone Number": file.result?.phoneNumber ?? "",
      Email: file.result?.email ?? "",
      "Total Score": file.result?.totalScore ?? "",
      "LinkedIn URL": file.result?.linkedInUrl ?? "",
      "Decision Band": decisionBand(file.result),
      Recommendation: file.result?.recommendation ?? "",
      "Sub Marks": formatSubMarks(file.result?.subMarks),
      Remarks: formatRemarks(file.result),
      Summary: file.result?.summary ?? "",
      "Text Extraction": file.extractionMethod ?? "",
      "Extraction Quality": file.extractionQuality?.status ?? "",
      "Extraction Score": file.extractionQuality?.score ?? "",
      "Extraction Issues": file.extractionQuality?.issues.join("; ") ?? "",
      "Grading Input": file.gradingInputMode ?? "",
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

  return exportVersions(project.sheetRows)
    .filter((row) => row.result)
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
        ...requestedValues,
        ...gradeExportFields(result),
        "Source Row": row.sourceRowNumber,
        Name: result.name || sourceName,
        "Phone Number": result.phoneNumber || sourcePhone,
        Email: result.email || sourceEmail,
        "Total Score": result.totalScore,
        "LinkedIn URL": result.linkedInUrl || sourceLinkedIn,
        "Decision Band": decisionBand(result),
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
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(project);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Browser storage transaction aborted."));
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
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    batchSize: DEFAULT_BATCH_SIZE,
    batchDelaySeconds: DEFAULT_BATCH_DELAY_SECONDS,
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
  const [apiKeys, setApiKeys] = useState<Record<LlmProvider, string>>({ openai: "", deepseek: "" });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stopRequestedRef = useRef(false);
  const controllersRef = useRef<Set<AbortController>>(new Set());

  const activeProject = useMemo(() => projects.find((project) => project.id === activeId) ?? projects[0], [activeId, projects]);
  const activeProvider = activeProject?.provider || DEFAULT_PROVIDER;
  const activeApiKey = apiKeys[activeProvider];
  const gradedCount = activeProject?.files.filter((file) => file.status === "graded").length ?? 0;
  const queuedCount = activeProject?.files.filter((file) => file.status === "queued").length ?? 0;
  const failedCount = activeProject?.files.filter((file) => file.status === "failed").length ?? 0;
  const sheetGradedCount = activeProject?.sheetRows.filter((row) => row.status === "graded").length ?? 0;
  const sheetQueuedCount = activeProject?.sheetRows.filter((row) => row.status === "queued").length ?? 0;
  const sheetFailedCount = activeProject?.sheetRows.filter((row) => row.status === "failed").length ?? 0;
  const activeRules = activeProject ? reusableRules(activeProject.rubricVersions ?? [], activeProject.rubric) : undefined;
  const averageScore = useMemo(() => {
    const items = activeProject?.mode === "sheet" ? activeProject.sheetRows : activeProject?.files ?? [];
    const scores = items
      .filter(item => item.result?.rubricVersion === activeRules?.version && typeof item.result?.totalScore === "number")
      .map((item) => Number(item.result?.totalScore))
      .filter((score) => Number.isFinite(score)) ?? [];
    return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  }, [activeProject, activeRules]);

  useEffect(() => {
    setApiKeys({
      openai: sessionStorage.getItem("recruno-openai-api-key") ?? "",
      deepseek: sessionStorage.getItem("recruno-deepseek-api-key") ?? ""
    });
  }, []);

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
                provider: (project.provider === "deepseek" ? "deepseek" : DEFAULT_PROVIDER) as LlmProvider,
                model: project.model || DEFAULT_MODEL,
                effort: (project.effort === "low" || project.effort === "high" ? project.effort : DEFAULT_EFFORT) as LlmEffort,
                batchSize: project.batchSize || DEFAULT_BATCH_SIZE,
                batchDelaySeconds: project.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS,
                rubricVersions: project.rubricVersions ?? [],
                files: project.files.map(file => file.status === "grading" ? { ...file, status: "queued" as const, error: "Previous evaluation was interrupted. Ready to retry." } : file),
                sheetRows: (project.sheetRows ?? []).map(row => row.status === "grading" ? { ...row, status: "queued" as const, error: "Previous evaluation was interrupted. Ready to retry." } : row),
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

  function updateApiKey(provider: LlmProvider, value: string) {
    setApiKeys((current) => ({ ...current, [provider]: value }));
    if (value) sessionStorage.setItem(`recruno-${provider}-api-key`, value);
    else sessionStorage.removeItem(`recruno-${provider}-api-key`);
  }

  function hasApiKey() {
    if (activeApiKey.trim()) return true;
    setMessage(`Enter your ${activeProvider === "deepseek" ? "DeepSeek" : "OpenAI"} API key before grading.`);
    return false;
  }

  async function prepareRules(): Promise<RubricRules | undefined> {
    if (!activeProject) return;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    try {
      if (!activeProject.rubric.trim()) throw new Error("Enter a rubric before evaluating.");
      const cached = reusableRules(activeProject.rubricVersions ?? [], activeProject.rubric);
      if (cached) return validateRules(cached);
      setMessage("Reading this rubric once and checking its scoring rules...");
      const response = await fetch("/api/resume-evaluator/prepare-rubric", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ rubric: activeProject.rubric, provider: activeProvider, model: activeProject.model, effort: activeProject.effort, apiKey: activeApiKey })
      });
      const json = await response.json();
      if (!response.ok) throw new Error([json.error, ...(json.issues ?? [])].join("\n"));
      const rules = validateRules(json.rules);
      if (rules.sourceRubric !== activeProject.rubric.trim()) throw new Error("Rubric preparation returned rules for different text. Retry preparation.");
      const next = { ...activeProject, rubricVersions: [...(activeProject.rubricVersions ?? []), rules], updatedAt: new Date().toISOString() };
      await saveProject(next);
      setProjects(current => current.map(project => project.id === next.id ? next : project));
      return rules;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not prepare rubric rules.");
      return undefined;
    } finally { controllersRef.current.delete(controller); }
  }

  function updateFile(projectId: string, fileId: string, patch: Partial<ResumeFile>) {
    setProjects((current) => {
      const nextProjects = current.map((project) => {
        if (project.id !== projectId) return project;
        const nextProject = {
          ...project,
          updatedAt: new Date().toISOString(),
          files: project.files.map((file) => (file.id === fileId ? { ...file, ...patch, previousResults: patch.result && file.result ? [...(file.previousResults ?? []), { result: file.result, gradedAt: file.gradedAt }] : patch.previousResults ?? file.previousResults } : file))
        };
        void saveProject(nextProject).catch(error => setMessage(`Could not save results: ${error instanceof Error ? error.message : "storage error"}. Download results before closing this tab.`));
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
        sheetRows: project.sheetRows.map((row) => row.id === rowId ? { ...row, ...patch, previousResults: patch.result && row.result ? [...(row.previousResults ?? []), { result: row.result, gradedAt: row.gradedAt }] : row.previousResults } : row)
      };
      void saveProject(nextProject).catch(error => setMessage(`Could not save results: ${error instanceof Error ? error.message : "storage error"}. Download results before closing this tab.`));
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
      if (entry.dir || entry.name.startsWith("__MACOSX/") || entry.name.split("/").pop()?.startsWith("._")) continue;
      const name = entry.name.split("/").pop() || entry.name;
      if (!isSupportedResume(name)) {
        resumeFiles.push({ id: id("file"), fileName: name, size: 0, source: file.name, status: "skipped", error: "Not a PDF, DOC, or DOCX file." });
        continue;
      }
      const blob = await entry.async("blob");
      const extracted = await extractResumeDocument(blob, name);
      const canGrade = canGradeResumeFile(name, blob.size, extracted.text, extracted.quality);
      resumeFiles.push({
        id: id("file"),
        fileName: name,
        size: blob.size,
        source: file.name,
        status: canGrade ? "queued" : "failed",
        error: canGrade ? undefined : `File exceeds ${formatBytes(MAX_VISUAL_FALLBACK_BYTES)} and local text extraction was not reliable.`,
        blob,
        extractedText: extracted.text,
        extractionMethod: extracted.method,
        extractionQuality: extracted.quality
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
        try {
          collected.push(...await filesFromZip(file));
        } catch (error) {
          collected.push({ id: id("file"), fileName: file.name, size: file.size, source: "ZIP upload", status: "failed", error: `Could not unpack ZIP: ${error instanceof Error ? error.message : "corrupt archive"}. Re-upload this archive.` });
        }
      } else if (isSupportedResume(file.name)) {
        const extracted = await extractResumeDocument(file, file.name);
        const canGrade = canGradeResumeFile(file.name, file.size, extracted.text, extracted.quality);
        collected.push({
          id: id("file"),
          fileName: file.name,
          size: file.size,
          source: "direct upload",
          status: canGrade ? "queued" : "failed",
          error: canGrade ? undefined : `File exceeds ${formatBytes(MAX_VISUAL_FALLBACK_BYTES)} and local text extraction was not reliable.`,
          blob: file,
          extractedText: extracted.text,
          extractionMethod: extracted.method,
          extractionQuality: extracted.quality
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
    try { await readSheetFile(file); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not read the candidate sheet. Existing rows were kept."); }
  }

  async function readSheetFile(file: File | undefined) {
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
        matrix.push(values);
      }
    }
    if (matrix.length < 2 || !matrix.slice(1).some(values => values.some(value => value.trim()))) {
      setMessage("The sheet needs a header row and at least one data row.");
      return;
    }
    const headers = matrix[0].map((header, index) => header.replace(/^\uFEFF/, "").trim() || `Column ${index + 1}`);
    if (new Set(headers.map(header => header.toLowerCase())).size !== headers.length) throw new Error("Duplicate column names would overwrite candidate data. Give every header a unique name.");
    if (matrix.slice(1).some(values => values.slice(headers.length).some(value => value.trim()))) throw new Error("Some rows contain data beyond the header columns. Add the missing headers to avoid losing candidate evidence.");
    const sheetRows = matrix.slice(1).map((values, index) => ({
      id: id("sheet-row"),
      sourceRowNumber: index + 2,
      original: Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex] ?? ""])),
      status: "queued" as const
    })).filter(row => Object.values(row.original).some(value => value.trim()));
    updateActiveProject({ mode: "sheet", sheetFileName: file.name, sheetRows });
    setMessage(`Loaded ${sheetRows.length} rows from ${file.name}.`);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function gradeSheetCandidate(projectId: string, row: SheetCandidate, rubric: string, provider: LlmProvider, model: string, effort: LlmEffort, apiKey: string, additionalColumns: string, rules: RubricRules, signal?: AbortSignal) {
    updateSheetRow(projectId, row.id, { status: "grading", error: undefined });
    const response = await fetch("/api/resume-evaluator/grade-row", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ row: row.original, rubric, provider, model: model || DEFAULT_MODEL, effort, apiKey, additionalColumns, rules })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.grade || json.grade.rubricVersion !== rules.version) {
      updateSheetRow(projectId, row.id, { status: "failed", error: json.error || "Invalid or mismatched grading response. Retry this candidate." });
      return false;
    }
    updateSheetRow(projectId, row.id, { status: "graded", result: json.grade, gradedAt: new Date().toISOString(), error: undefined });
    return true;
  }

  async function gradeFile(projectId: string, file: ResumeFile, rubric: string, provider: LlmProvider, model: string, effort: LlmEffort, apiKey: string, rules: RubricRules, signal?: AbortSignal) {
    if (!file.blob) {
      updateFile(projectId, file.id, { status: "failed", error: "Original file data is missing. Re-upload this file." });
      return false;
    }
    updateFile(projectId, file.id, { status: "grading", error: undefined });
    let extractedText = file.extractedText ?? "";
    let extractionMethod = file.extractionMethod;
    let extractionQuality = file.extractionQuality;
    if (!extractionQuality) {
      const refreshed = await extractResumeDocument(file.blob, file.fileName);
      extractedText = refreshed.text;
      extractionMethod = refreshed.method;
      extractionQuality = refreshed.quality;
      updateFile(projectId, file.id, {
        extractedText,
        extractionMethod,
        extractionQuality
      });
    }
    if (!canGradeResumeFile(file.fileName, file.blob.size, extractedText, extractionQuality)) {
      updateFile(projectId, file.id, { status: "failed", error: `File exceeds ${formatBytes(MAX_VISUAL_FALLBACK_BYTES)} and local text extraction was not reliable.` });
      return false;
    }
    const form = new FormData();
    form.append("file", file.blob, file.fileName);
    form.append("fileName", file.fileName);
    form.append("rubric", rubric);
    form.append("rules", JSON.stringify(rules));
    form.append("pageCount", String(extractionQuality?.pageCount ?? 0));
    form.append("provider", provider);
    form.append("model", model || DEFAULT_MODEL);
    form.append("effort", effort);
    form.append("apiKey", apiKey);
    if (extractedText) form.append("extractedText", extractedText);
    if (extractionMethod) form.append("extractionMethod", extractionMethod);
    if (extractionQuality) form.append("extractionQuality", JSON.stringify(extractionQuality));
    const needsVisualFallback = extensionFor(file.fileName) === "pdf" && extractionQuality?.status !== "good";
    if (needsVisualFallback) {
      try {
        const pageImages = await renderPdfPagesAsImages(file.blob);
        for (const pageImage of pageImages) form.append("pageImages", pageImage);
      } catch (error) {
        form.append("visualFallbackError", error instanceof Error ? error.message : "Could not render page images.");
      }
    }
    signal?.throwIfAborted();
    const response = await fetch("/api/resume-evaluator/grade", { method: "POST", body: form, signal });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.grade || json.grade.rubricVersion !== rules.version) {
      updateFile(projectId, file.id, { status: "failed", error: json.error || "Invalid or mismatched grading response. Retry this candidate." });
      return false;
    }
    updateFile(projectId, file.id, {
      status: "graded",
      result: json.grade,
      gradingInputMode: json.inputMode,
      gradedAt: new Date().toISOString(),
      error: undefined
    });
    return true;
  }

  async function handleGradeOne(file: ResumeFile) {
    if (!activeProject || !hasApiKey()) return;
    stopRequestedRef.current = false;
    setIsRunning(true);
    const preparedRules = await prepareRules();
    if (!preparedRules || stopRequestedRef.current) { setIsRunning(false); return; }
    const rules: RubricRules = preparedRules;
    stopRequestedRef.current = false;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setMessage(`Grading ${file.fileName}...`);
    try {
      const succeeded = await gradeFile(activeProject.id, file, activeProject.rubric, activeProvider, activeProject.model, activeProject.effort, activeApiKey, rules, controller.signal);
      setMessage(succeeded ? `Finished ${file.fileName}.` : `Could not grade ${file.fileName}. See the row error; no new score was saved.`);
    } catch (error) {
      updateFile(activeProject.id, file.id, { status: error instanceof DOMException && error.name === "AbortError" ? "queued" : "failed", error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Grading failed." });
    } finally {
      controllersRef.current.delete(controller);
    }
    setIsRunning(false);
  }

  async function handleGradeAll() {
    if (!activeProject || !hasApiKey()) return;
    stopRequestedRef.current = false;
    setIsRunning(true);
    const preparedRules = await prepareRules();
    if (!preparedRules || stopRequestedRef.current) { setIsRunning(false); return; }
    const rules: RubricRules = preparedRules;
    stopRequestedRef.current = false;
    const queue = resumeQueue(activeProject.files, rules.version);
    const concurrency = Math.max(1, Math.min(25, Math.floor(Number(activeProject.batchSize || DEFAULT_BATCH_SIZE))));
    const delayMs = Math.max(0, Math.min(60, Number(activeProject.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS))) * 1000;
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    setMessage(`Grading ${queue.length} resumes with ${concurrency} parallel request${concurrency === 1 ? "" : "s"}...`);
    async function gradeBatchFile(file: ResumeFile) {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        const succeeded = await gradeFile(activeProject.id, file, activeProject.rubric, activeProvider, activeProject.model, activeProject.effort, activeApiKey, rules, controller.signal);
        if (succeeded) completed += 1; else failed += 1;
        setMessage(`Completed ${completed}, failed ${failed}, of ${queue.length}. Running up to ${concurrency} at a time.`);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) failed += 1;
        updateFile(activeProject.id, file.id, {
          status: error instanceof DOMException && error.name === "AbortError" ? "queued" : "failed",
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
    setMessage(stopRequestedRef.current ? `Stopped grading. Completed ${completed}/${queue.length}; remaining files stayed queued.` : `Finished: ${completed} graded, ${failed} failed, ${queue.length - completed - failed} interrupted/queued.`);
    stopRequestedRef.current = false;
    setIsRunning(false);
  }

  async function handleGradeSheetRow(row: SheetCandidate) {
    if (!activeProject || !hasApiKey()) return;
    stopRequestedRef.current = false;
    setIsRunning(true);
    const preparedRules = await prepareRules();
    if (!preparedRules || stopRequestedRef.current) { setIsRunning(false); return; }
    const rules: RubricRules = preparedRules;
    stopRequestedRef.current = false;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setMessage(`Grading source row ${row.sourceRowNumber}...`);
    try {
      const succeeded = await gradeSheetCandidate(activeProject.id, row, activeProject.rubric, activeProvider, activeProject.model, activeProject.effort, activeApiKey, activeProject.additionalColumns, rules, controller.signal);
      setMessage(succeeded ? `Finished source row ${row.sourceRowNumber}.` : `Could not grade source row ${row.sourceRowNumber}. See the row error.`);
    } catch (error) {
      updateSheetRow(activeProject.id, row.id, { status: error instanceof DOMException && error.name === "AbortError" ? "queued" : "failed", error: error instanceof DOMException && error.name === "AbortError" ? "Stopped before completion." : error instanceof Error ? error.message : "Row grading failed." });
    } finally {
      controllersRef.current.delete(controller);
      setIsRunning(false);
    }
  }

  async function handleGradeSheetAll() {
    if (!activeProject || !hasApiKey()) return;
    stopRequestedRef.current = false;
    setIsRunning(true);
    const preparedRules = await prepareRules();
    if (!preparedRules || stopRequestedRef.current) { setIsRunning(false); return; }
    const rules: RubricRules = preparedRules;
    stopRequestedRef.current = false;
    const queue = resumeQueue(activeProject.sheetRows, rules.version);
    const concurrency = Math.max(1, Math.min(25, Math.floor(Number(activeProject.batchSize || DEFAULT_BATCH_SIZE))));
    const delayMs = Math.max(0, Math.min(60, Number(activeProject.batchDelaySeconds ?? DEFAULT_BATCH_DELAY_SECONDS))) * 1000;
    let cursor = 0;
    let completed = 0;
    let failed = 0;
    setMessage(`Grading ${queue.length} sheet rows with ${concurrency} parallel request${concurrency === 1 ? "" : "s"}...`);
    async function gradeBatchRow(row: SheetCandidate) {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      try {
        const succeeded = await gradeSheetCandidate(activeProject.id, row, activeProject.rubric, activeProvider, activeProject.model, activeProject.effort, activeApiKey, activeProject.additionalColumns, rules, controller.signal);
        if (succeeded) completed += 1; else failed += 1;
        setMessage(`Completed ${completed}, failed ${failed}, of ${queue.length} sheet rows.`);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) failed += 1;
        updateSheetRow(activeProject.id, row.id, {
          status: error instanceof DOMException && error.name === "AbortError" ? "queued" : "failed",
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
    setMessage(stopRequestedRef.current ? `Stopped sheet grading after ${completed}/${queue.length} rows.` : `Finished: ${completed} graded, ${failed} failed, ${queue.length - completed - failed} interrupted/queued.`);
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
    setMessage("Stop requested. In-flight grading requests are being cancelled.");
  }

  function clearResults() {
    if (!activeProject) return;
    updateActiveProject({
      files: activeProject.files.map((file) => file.blob ? { ...file, status: "queued", result: undefined, previousResults: [], gradingInputMode: undefined, gradedAt: undefined, error: undefined } : file)
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
        <button className="resume-button primary" disabled={isRunning} onClick={handleCreateProject}>New Project</button>
        <div className="resume-project-list">
          {projects.map((project) => (
            <button key={project.id} className={project.id === activeProject?.id ? "active" : ""} disabled={isRunning} onClick={() => setActiveId(project.id)}>
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
                <button className="resume-button" disabled={isRunning} onClick={handleRenameProject}>Rename</button>
                <button className="resume-button" disabled={isRunning} onClick={handleDuplicateProject}>Duplicate</button>
                <button className="resume-button danger" disabled={isRunning || (activeProject.mode === "sheet" ? !activeProject.sheetRows.length : !activeProject.files.length)} onClick={clearProfiles}>{activeProject.mode === "sheet" ? "Clear Rows" : "Clear Profiles"}</button>
                <button className="resume-button danger" disabled={isRunning || projects.length <= 1} onClick={handleDeleteProject}>Delete</button>
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
              <div><strong>{activeRules ? `${averageScore}/${activeRules.maxScore}` : "-"}</strong><span>Current rubric avg (complete scores)</span></div>
            </div>

            <div className="resume-message">
              {activeRules ? `${activeRules.title} · maximum ${activeRules.maxScore} · ${activeRules.criteria.length} components · version ${activeRules.version.slice(0, 15)}` : "This rubric has not been prepared yet. Its rules will be read once before grading."}
              <p>Results retain their rubric version. Editing the rubric prepares a new version; grading the queue re-evaluates candidates scored under another version. Downloads include all saved versions and incomplete results.</p>
              {activeRules ? <details><summary>Review saved rubric rules</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(activeRules, null, 2)}</pre></details> : null}
            </div>

            <div className="resume-grid">
              <section className="resume-panel">
                <div className="resume-section-head">
                  <div>
                    <h2>Rubric / grading scheme</h2>
                    <p>Your rubric defines criteria, points, missing-evidence handling, and decisions. Unclear or unsupported scoring rules are flagged before grading.</p>
                  </div>
                </div>
                <div className="resume-ai-settings">
                  <label>
                    <span>LLM provider</span>
                    <select
                      value={activeProvider}
                      onChange={(event) => updateActiveProject({ provider: event.target.value as LlmProvider })}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="deepseek">DeepSeek</option>
                    </select>
                  </label>
                  {activeProvider === "openai" ? (
                    <label>
                      <span>OpenAI model</span>
                      <select value={activeProject.model} onChange={(event) => updateActiveProject({ model: event.target.value })}>
                        {OPENAI_MODELS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  ) : (
                    <label>
                      <span>Reasoning effort</span>
                      <select value={activeProject.effort} onChange={(event) => updateActiveProject({ effort: event.target.value as LlmEffort })}>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                  )}
                  <label className="resume-api-key-field">
                    <span>{activeProvider === "deepseek" ? "DeepSeek" : "OpenAI"} API key</span>
                    <input
                      type="password"
                      value={activeApiKey}
                      placeholder="Enter your API key"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => updateApiKey(activeProvider, event.target.value)}
                    />
                    <small>Saved only until this browser tab is closed.</small>
                  </label>
                </div>
                <textarea
                  className="resume-rubric"
                  disabled={isRunning}
                  value={activeProject.rubric}
                  onChange={(event) => updateActiveProject({ rubric: event.target.value })}
                  rows={14}
                />
              </section>

              <section className="resume-panel">
                <div className="resume-section-head">
                  <div>
                    <h2>{activeProject.mode === "sheet" ? "Upload candidate sheet" : "Upload resumes"}</h2>
                    <p>{activeProject.mode === "sheet" ? "The first worksheet and first header row are used. Every nonblank row becomes a candidate." : `Zip files are unpacked in the browser. Text is checked locally; uncertain PDFs use page images as a fallback up to ${formatBytes(MAX_VISUAL_FALLBACK_BYTES)}.`}</p>
                  </div>
                </div>
                {activeProject.mode === "sheet" ? (
                  <>
                    <label className="resume-dropzone">
                      <input ref={fileInputRef} disabled={isRunning} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(event) => void handleSheetFile(event.target.files?.[0])} />
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
                    <input ref={fileInputRef} disabled={isRunning} type="file" multiple accept=".pdf,.doc,.docx,.zip,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/zip" onChange={(event) => void handleFiles(event.target.files)} />
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
                <div className="resume-actions">
                  <button className="resume-button primary" disabled={isRunning || !activeApiKey.trim() || (activeProject.mode === "sheet" ? !resumeQueue(activeProject.sheetRows, activeRules?.version).length : !resumeQueue(activeProject.files, activeRules?.version).length)} onClick={() => void (activeProject.mode === "sheet" ? handleGradeSheetAll() : handleGradeAll())}>
                    Grade {activeProject.mode === "sheet" ? "Rows" : "Queue"} ({activeProject.batchSize || DEFAULT_BATCH_SIZE} at a time)
                  </button>
                  <button className="resume-button danger" disabled={!isRunning} onClick={terminateGrading}>Stop Grading</button>
                  {activeProject.mode === "resumes" ? <button className="resume-button" disabled={isRunning || !activeProject.files.length} onClick={clearResults}>Reset Results</button> : null}
                  <button className="resume-button" disabled={!(activeProject.mode === "sheet" ? exportVersions(activeProject.sheetRows).length : exportVersions(activeProject.files).length)} onClick={() => void downloadXlsx()}>Download XLSX</button>
                  <button className="resume-button" disabled={!(activeProject.mode === "sheet" ? exportVersions(activeProject.sheetRows).length : exportVersions(activeProject.files).length)} onClick={() => void downloadCsv()}>CSV</button>
                  <button className="resume-button" disabled={!(activeProject.mode === "sheet" ? exportVersions(activeProject.sheetRows).length : exportVersions(activeProject.files).length)} onClick={() => void downloadJson()}>JSON</button>
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
                            <td>{scoreLabel(row.result)}<small>{row.result?.rubricVersion?.slice(0, 15) || ""}</small></td>
                            <td className="resume-long">{row.result?.linkedInUrl || sourceLinkedIn || "-"}</td>
                            <td>{row.result ? decisionBand(row.result) : "-"}</td>
                            <td>{row.result?.recommendation || "-"}</td>
                            <td className="resume-long">{formatSubMarks(row.result?.subMarks) || "-"}</td>
                            <td className="resume-long">
                              {Object.entries(row.result?.extraFields ?? {}).map(([key, value]) => `${key}: ${value || "-"}`).join("; ") || "-"}
                            </td>
                            <td className="resume-long">{formatRemarks(row.result) || "-"}{row.result ? <details><summary>Rubric details and history ({row.previousResults?.length ?? 0})</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ details: row.result.details, previous: row.previousResults }, null, 2)}</pre></details> : null}</td>
                            <td>
                              <div className="resume-row-actions">
                                <button className="resume-button small" disabled={isRunning || !activeApiKey.trim()} onClick={() => void handleGradeSheetRow(row)}>Grade</button>
                                <button className="resume-button small danger" disabled={isRunning} onClick={() => updateActiveProject({ sheetRows: activeProject.sheetRows.filter((item) => item.id !== row.id) })}>Remove</button>
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
                          <td>
                            <strong>{file.fileName}</strong>
                            <span>{formatBytes(file.size)} · {file.source}</span>
                            {file.extractionQuality ? (
                              <span title={file.extractionQuality.issues.join(" ")}>
                                Extraction: {file.extractionQuality.status} ({file.extractionQuality.score}/100)
                                {file.extractionQuality.detectedColumns ? ` · columns on ${file.extractionQuality.detectedColumns} page${file.extractionQuality.detectedColumns === 1 ? "" : "s"}` : ""}
                              </span>
                            ) : null}
                            {file.gradingInputMode ? <span>LLM input: {file.gradingInputMode}</span> : null}
                          </td>
                          <td><span className={`resume-status ${file.status}`}>{file.status}</span>{file.error ? <em>{file.error}</em> : null}</td>
                          <td>{file.result?.name || "-"}</td>
                          <td>{file.result?.phoneNumber || "-"}</td>
                          <td className="resume-long">{file.result?.email || "-"}</td>
                          <td>{scoreLabel(file.result)}<small>{file.result?.rubricVersion?.slice(0, 15) || ""}</small></td>
                          <td className="resume-long">{file.result?.linkedInUrl || "-"}</td>
                          <td>{file.result ? decisionBand(file.result) : "-"}</td>
                          <td>{file.result?.recommendation || "-"}</td>
                          <td className="resume-long">{formatSubMarks(file.result?.subMarks) || "-"}</td>
                          <td className="resume-long">{formatRemarks(file.result) || "-"}{file.result ? <details><summary>Rubric details and history ({file.previousResults?.length ?? 0})</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ details: file.result.details, previous: file.previousResults }, null, 2)}</pre></details> : null}</td>
                          <td><div className="resume-row-actions"><button className="resume-button small" disabled={isRunning || !activeApiKey.trim() || !file.blob} onClick={() => void handleGradeOne(file)}>Grade</button><button className="resume-button small danger" disabled={isRunning} onClick={() => removeFile(file.id)}>Remove</button></div></td>
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
