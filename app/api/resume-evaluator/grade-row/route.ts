import { NextResponse } from "next/server";
import { createStructuredResumeResponse, DEFAULT_OPENAI_MODEL, parseResumeLlmEffort, parseResumeLlmProvider } from "@/lib/resume-llm";
import { gradingPrompt, validateGrade } from "@/lib/rubric";
import { responseJson, rulesForRequest } from "@/lib/rubric-server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const row = body.row;
    if (!row || typeof row !== "object" || Array.isArray(row) || !Object.values(row).some(v => String(v ?? "").trim())) throw new Error("Nonblank candidate row data is required.");
    const rubric = typeof body.rubric === "string" ? body.rubric.trim() : "";
    const rules = rulesForRequest(body.rules, rubric);
    const source = JSON.stringify(row, null, 2);
    if (source.length > 200000) throw new Error("Candidate row exceeds supported size. No candidate data was silently truncated.");
    const requestedColumns = [...new Set(String(body.additionalColumns ?? "").split(",").map(c => c.trim()).filter(Boolean))].slice(0, 20);
    const provider = parseResumeLlmProvider(body.provider);
    const model = String(body.model || DEFAULT_OPENAI_MODEL);
    const effort = parseResumeLlmEffort(body.effort);
    const payload = await createStructuredResumeResponse({ signal: request.signal, provider, apiKey: String(body.apiKey ?? ""), model, effort, input: `${gradingPrompt(rules, requestedColumns)}\nCandidate row data:\n${source}` });
    return NextResponse.json({ grade: validateGrade(responseJson(payload), rules, requestedColumns, Object.values(row).map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n")), provider, model: provider === "deepseek" ? "deepseek-flash" : model, effort });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Spreadsheet row grading failed." }, { status: 400 });
  }
}
