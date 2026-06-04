import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";

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

function normalizeEvaluation(value: unknown): InterviewEvaluation {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const allowed = new Set(["Strong Hire", "Hire", "Maybe", "No Hire", "Strong No Hire"]);
  const recommendation = asString(input.recommendation);
  const sectionScores = Array.isArray(input.sectionScores)
    ? input.sectionScores.map((item) => {
        const section = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          section: asString(section.section || "Unspecified"),
          score: clampScore(section.score),
          maxScore: Math.max(1, clampScore(section.maxScore, 100)),
          evidence: asStringArray(section.evidence),
          feedback: asString(section.feedback)
        };
      })
    : [];
  const questionCoverage = Array.isArray(input.questionCoverage)
    ? input.questionCoverage.map((item) => {
        const question = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const rawAnswered = asString(question.answered);
        const answered: "yes" | "partial" | "no" = rawAnswered === "yes" || rawAnswered === "partial" || rawAnswered === "no" ? rawAnswered : "partial";
        return {
          question: asString(question.question),
          answered,
          evidence: asString(question.evidence),
          scoreImpact: asString(question.scoreImpact)
        };
      })
    : [];
  return {
    candidateName: asString(input.candidateName) || "Unnamed candidate",
    cleanedTranscript: asString(input.cleanedTranscript),
    totalScore: clampScore(input.totalScore),
    recommendation: allowed.has(recommendation) ? recommendation as InterviewEvaluation["recommendation"] : "Maybe",
    sectionScores,
    questionCoverage,
    strengths: asStringArray(input.strengths),
    weaknesses: asStringArray(input.weaknesses),
    risks: asStringArray(input.risks),
    followUps: asStringArray(input.followUps),
    summary: asString(input.summary)
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const transcript = asString(body.transcript);
    const rubric = asString(body.rubric);
    const questionnaire = asString(body.questionnaire);
    const candidateName = asString(body.candidateName) || "Unnamed candidate";
    const model = asString(body.model) || DEFAULT_MODEL;

    if (!transcript) return NextResponse.json({ error: "Interview transcript is required." }, { status: 400 });
    if (!rubric) return NextResponse.json({ error: "Rubric is required." }, { status: 400 });
    if (!questionnaire) return NextResponse.json({ error: "Questionnaire is required." }, { status: 400 });

    const settings = await getSettings();
    if (!settings.OPENAI_API_KEY) {
      return NextResponse.json({ error: "OPENAI_API_KEY is missing. Add it in Settings or Vercel environment variables." }, { status: 400 });
    }

    const prompt = `
You are evaluating a single interview candidate for a recruiting workflow.

First clean the raw V0 interview transcript into a readable V1 transcript:
- Fix obvious speech-to-text errors, broken word order, filler words, repeated fragments, and punctuation.
- Preserve meaning. Do not invent answers, skills, employers, or facts that are not supported by the raw transcript.
- If a phrase is uncertain, keep the closest readable version and avoid overclaiming.

Then grade the cleaned transcript against the questionnaire and rubric.

Candidate name:
${candidateName}

Questionnaire:
${questionnaire}

Rubric:
${rubric}

Raw V0 transcript:
${transcript.slice(0, 60000)}

Return only valid JSON with exactly this shape:
{
  "candidateName": "string",
  "cleanedTranscript": "string",
  "totalScore": 0,
  "recommendation": "Strong Hire|Hire|Maybe|No Hire|Strong No Hire",
  "sectionScores": [{"section":"string","score":0,"maxScore":100,"evidence":["string"],"feedback":"string"}],
  "questionCoverage": [{"question":"string","answered":"yes|partial|no","evidence":"string","scoreImpact":"string"}],
  "strengths": ["string"],
  "weaknesses": ["string"],
  "risks": ["string"],
  "followUps": ["string"],
  "summary": "string"
}

Rules:
- totalScore must be 0-100.
- sectionScores must be quantifiable. Use rubric sections when available. If the rubric asks for 3 sections, return those 3 sections.
- questionCoverage must map important questionnaire questions to whether the candidate answered them.
- Feedback must cite evidence from the cleaned transcript.
- Be strict when the transcript does not contain evidence.
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
    return NextResponse.json({ evaluation: normalizeEvaluation(parsed), model });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Interview evaluation failed." }, { status: 400 });
  }
}
