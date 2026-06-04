import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";

const DEFAULT_MODEL = "gpt-5.2";
const MAX_PDF_BYTES = 3_000_000;

type ResumeGrade = {
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

function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0] ?? text;
  return JSON.parse(candidate) as T;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function clampScore(value: unknown, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeGrade(value: Partial<ResumeGrade>): ResumeGrade {
  const allowed = new Set(["Strong Yes", "Yes", "Maybe", "No", "Strong No"]);
  const categoryScores = Array.isArray(value.categoryScores)
    ? value.categoryScores.map((item) => ({
        category: String(item?.category ?? "Unspecified"),
        score: clampScore(item?.score),
        maxScore: Math.max(1, clampScore(item?.maxScore, 100)),
        evidence: String(item?.evidence ?? "")
      }))
    : [];
  return {
    candidateName: String(value.candidateName ?? "Unknown candidate"),
    totalScore: clampScore(value.totalScore),
    recommendation: allowed.has(String(value.recommendation)) ? value.recommendation as ResumeGrade["recommendation"] : "Maybe",
    categoryScores,
    strengths: asStringArray(value.strengths),
    concerns: asStringArray(value.concerns),
    missingEvidence: asStringArray(value.missingEvidence),
    summary: String(value.summary ?? ""),
    rawNotes: String(value.rawNotes ?? "")
  };
}

function outputText(payload: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }) {
  return payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("\n") ?? "";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const rubric = String(form.get("rubric") ?? "").trim();
    const model = String(form.get("model") ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const fileName = String(form.get("fileName") ?? "resume.pdf");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload one PDF file to grade." }, { status: 400 });
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Only PDF resumes can be graded." }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "This PDF is too large for the v1 upload path. Keep files under 3 MB." }, { status: 413 });
    }
    if (!rubric) {
      return NextResponse.json({ error: "Add a rubric prompt before grading." }, { status: 400 });
    }

    const settings = await getSettings();
    if (!settings.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing. Add it in Settings or Vercel environment variables." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileData = `data:application/pdf;base64,${buffer.toString("base64")}`;
    const prompt = `
You are grading a resume for a recruiting workflow.

Rubric / grading scheme:
${rubric}

Return only valid JSON with exactly this shape:
{
  "candidateName": "string",
  "totalScore": 0,
  "recommendation": "Strong Yes|Yes|Maybe|No|Strong No",
  "categoryScores": [{"category":"string","score":0,"maxScore":100,"evidence":"string"}],
  "strengths": ["string"],
  "concerns": ["string"],
  "missingEvidence": ["string"],
  "summary": "string",
  "rawNotes": "string"
}

Rules:
- totalScore must be an integer from 0 to 100.
- Use only evidence present in the resume.
- If a criterion cannot be verified from the PDF, list it in missingEvidence.
- Keep notes concise and useful for a recruiter reviewing many resumes.
- Do not include markdown or commentary outside JSON.

Resume filename: ${fileName}
`;

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
            content: [
              { type: "input_file", filename: fileName, file_data: fileData },
              { type: "input_text", text: prompt }
            ]
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
    const parsed = extractJson<Partial<ResumeGrade>>(outputText(payload));
    return NextResponse.json({ grade: normalizeGrade(parsed), model });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Resume grading failed." }, { status: 400 });
  }
}
