import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";

const DEFAULT_MODEL = "gpt-5.4-mini";
const MAX_PDF_BYTES = 3_000_000;
const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

type ResumeGrade = Record<string, unknown>;
type FixedResumeGrade = {
  name: string;
  phoneNumber: string;
  linkedInUrl: string;
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

function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? text;
  return JSON.parse(candidate) as T;
}

function outputText(payload: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }) {
  return payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("\n") ?? "";
}

function asString(value: unknown) {
  return String(value ?? "").trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean);
  const text = asString(value);
  return text ? [text] : [];
}

function clampScore(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeGrade(value: unknown): FixedResumeGrade {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as ResumeGrade : {};
  const remarks = input.remarks && typeof input.remarks === "object" && !Array.isArray(input.remarks) ? input.remarks as ResumeGrade : {};
  const subMarks = Array.isArray(input.subMarks)
    ? input.subMarks.map((item) => {
        const mark = item && typeof item === "object" ? item as ResumeGrade : {};
        return {
          section: asString(mark.section || mark.category || "Unspecified"),
          score: clampScore(mark.score),
          maxScore: Math.max(1, clampScore(mark.maxScore, 100)),
          reason: asString(mark.reason || mark.evidence)
        };
      })
    : [];
  const allowed = new Set(["Strong Select", "Select", "Maybe", "Reject", "Strong Reject"]);
  const recommendation = asString(input.recommendation);
  return {
    name: asString(input.name || input.candidateName || input["Candidate Name"]) || "Unknown candidate",
    phoneNumber: asString(input.phoneNumber || input.phone || input["Phone Number"]),
    linkedInUrl: asString(input.linkedInUrl || input.linkedinUrl || input.linkedin || input["LinkedIn URL"]),
    totalScore: clampScore(input.totalScore || input.score || input["Total Score"]),
    recommendation: allowed.has(recommendation) ? recommendation as FixedResumeGrade["recommendation"] : "Maybe",
    subMarks,
    remarks: {
      strengths: asStringArray(remarks.strengths || input.strengths),
      weaknesses: asStringArray(remarks.weaknesses || remarks.concerns || input.weaknesses || input.concerns),
      selectedOrRejectedReason: asString(remarks.selectedOrRejectedReason || remarks.reason || input.selectedOrRejectedReason || input.reason),
      missingEvidence: asStringArray(remarks.missingEvidence || input.missingEvidence),
      risks: asStringArray(remarks.risks || input.risks)
    },
    summary: asString(input.summary)
  };
}

function extensionFor(fileName: string) {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const rubric = String(form.get("rubric") ?? "").trim();
    const model = String(form.get("model") ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const fileName = String(form.get("fileName") ?? "resume.pdf");
    const extractedText = String(form.get("extractedText") ?? "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload one resume file to grade." }, { status: 400 });
    }
    const extension = extensionFor(fileName || file.name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return NextResponse.json({ error: "Only PDF, DOC, and DOCX resumes can be graded." }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "This file is too large for the v1 upload path. Keep files under 3 MB." }, { status: 413 });
    }
    if (!rubric) {
      return NextResponse.json({ error: "Add a rubric prompt before grading." }, { status: 400 });
    }

    const settings = await getSettings();
    if (!settings.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing. Add it in Settings or Vercel environment variables." }, { status: 400 });
    }

    const useExtractedText = extractedText.length >= 500;
    const prompt = `
You are grading a resume for a recruiting workflow.

Rubric / grading scheme:
${rubric}

Return only valid JSON with exactly this shape:
{
  "name": "string",
  "phoneNumber": "string",
  "linkedInUrl": "string",
  "totalScore": 0,
  "recommendation": "Strong Select|Select|Maybe|Reject|Strong Reject",
  "subMarks": [{"section":"string","score":0,"maxScore":100,"reason":"string"}],
  "remarks": {
    "strengths": ["string"],
    "weaknesses": ["string"],
    "selectedOrRejectedReason": "string",
    "missingEvidence": ["string"],
    "risks": ["string"]
  },
  "summary": "string",
}

Rules:
- Always extract name, phoneNumber, and linkedInUrl when visible in the resume. Use empty string if not found.
- totalScore must be an integer from 0 to 100.
- recommendation must be one of the allowed values.
- subMarks must be quantifiable rubric section marks, not qualitative labels. If the user's rubric has sections, use those section names. If it does not, create 3-5 practical sections from the rubric.
- remarks.selectedOrRejectedReason must clearly explain why the person was selected/rejected/maybe.
- remarks must be concise but useful, like neat bullets when rendered in a spreadsheet cell.
- Use only evidence present in the resume.
- If a criterion cannot be verified, list it in missingEvidence.
- Keep notes concise and useful for a recruiter reviewing many resumes.
- Do not include markdown or commentary outside JSON.
- Do not wrap the row in an array.

Resume filename: ${fileName}
${useExtractedText ? `\nResume text extracted locally to reduce cost:\n${extractedText.slice(0, 24000)}` : ""}
`;

    const content: Array<Record<string, string>> = useExtractedText ? [{ type: "input_text", text: prompt }] : [];
    if (!useExtractedText) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const mime = file.type || MIME_BY_EXTENSION[extension] || "application/octet-stream";
      const fileData = `data:${mime};base64,${buffer.toString("base64")}`;
      content.push({ type: "input_file", filename: fileName, file_data: fileData }, { type: "input_text", text: prompt });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "user",
            content
          }
        ],
        text: {
          format: { type: "json_object" }
        }
      })
    });

    if (!response.ok) {
      return NextResponse.json({ error: `OpenAI request failed: ${response.status} ${await response.text()}` }, { status: 400 });
    }

    const payload = await response.json();
    const parsed = extractJson<unknown>(outputText(payload));
    return NextResponse.json({ grade: normalizeGrade(parsed), model });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Resume grading failed." }, { status: 400 });
  }
}
