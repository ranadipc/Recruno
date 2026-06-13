import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";

const DEFAULT_MODEL = "gpt-5.4-mini";

type RawGrade = Record<string, unknown>;
type FixedGrade = {
  name: string;
  phoneNumber: string;
  email: string;
  linkedInUrl: string;
  extraFields: Record<string, string>;
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

function normalizeIndianPhone(value: unknown) {
  return asString(value).replace(/^\s*(?:\+{1,2}91|0091)[\s-]*/i, "").replace(/[^\d]/g, "");
}

function normalizeGrade(value: unknown, requestedColumns: string[]): FixedGrade {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as RawGrade : {};
  const remarks = input.remarks && typeof input.remarks === "object" && !Array.isArray(input.remarks) ? input.remarks as RawGrade : {};
  const rawExtraFields = input.extraFields && typeof input.extraFields === "object" && !Array.isArray(input.extraFields) ? input.extraFields as RawGrade : {};
  const subMarks = Array.isArray(input.subMarks)
    ? input.subMarks.map((item) => {
        const mark = item && typeof item === "object" ? item as RawGrade : {};
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
    phoneNumber: normalizeIndianPhone(input.phoneNumber || input.phone || input["Phone Number"]),
    email: asString(input.email || input.emailAddress || input["Email"]),
    linkedInUrl: asString(input.linkedInUrl || input.linkedinUrl || input.linkedin || input["LinkedIn URL"]),
    extraFields: Object.fromEntries(requestedColumns.map((column) => {
      const match = Object.entries(rawExtraFields).find(([key]) => key.toLowerCase() === column.toLowerCase());
      return [column, asString(match?.[1])];
    })),
    totalScore: clampScore(input.totalScore || input.score || input["Total Score"]),
    recommendation: allowed.has(recommendation) ? recommendation as FixedGrade["recommendation"] : "Maybe",
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

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const row = body.row && typeof body.row === "object" && !Array.isArray(body.row) ? body.row as Record<string, unknown> : {};
    const rubric = asString(body.rubric);
    const model = asString(body.model) || DEFAULT_MODEL;
    const requestedColumns = asString(body.additionalColumns)
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!Object.keys(row).length) return NextResponse.json({ error: "Spreadsheet row data is required." }, { status: 400 });
    if (!rubric) return NextResponse.json({ error: "Rubric is required." }, { status: 400 });

    const settings = await getSettings();
    if (!settings.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing. Add it in Settings or Vercel environment variables." }, { status: 400 });
    }

    const prompt = `
You are grading one candidate represented by a spreadsheet row.

Rubric / grading scheme:
${rubric}

Candidate row data:
${JSON.stringify(row, null, 2).slice(0, 30000)}

Return only valid JSON with exactly this shape:
{
  "name": "string",
  "phoneNumber": "string",
  "email": "string",
  "linkedInUrl": "string",
  "extraFields": {
    ${requestedColumns.length ? requestedColumns.map((column) => `"${column.replace(/"/g, "\\\"")}": "string"`).join(",\n    ") : ""}
  },
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
  "summary": "string"
}

Rules:
- Use only the provided row data. Do not invent missing experience or qualifications.
- Preserve and return LinkedIn/profile URL whenever one exists in any source column. This is especially important.
- Preserve name, email, and phone when available.
- Fill every requested extraFields key from the available row data. Use an empty string when the row does not contain enough evidence.
- Requested additional output columns: ${requestedColumns.length ? requestedColumns.join(", ") : "None"}.
- For explicit Indian country-code prefixes such as +91, ++91, or 0091, remove only that prefix.
- totalScore must be 0-100.
- subMarks must be quantifiable and follow the rubric sections.
- Clearly explain selection/rejection in remarks.
- Use empty strings for missing contact/profile fields.
- Do not include markdown outside JSON.
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        input: prompt,
        text: { format: { type: "json_object" } }
      })
    });

    if (!response.ok) {
      return NextResponse.json({ error: `OpenAI request failed: ${response.status} ${await response.text()}` }, { status: 400 });
    }
    const payload = await response.json();
    return NextResponse.json({ grade: normalizeGrade(extractJson<unknown>(outputText(payload)), requestedColumns), model });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spreadsheet row grading failed." }, { status: 400 });
  }
}
