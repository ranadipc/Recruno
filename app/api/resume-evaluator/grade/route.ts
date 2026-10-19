import { NextResponse } from "next/server";
import {
  createStructuredResumeResponse,
  DEFAULT_OPENAI_MODEL,
  parseResumeLlmEffort,
  parseResumeLlmProvider
} from "@/lib/resume-llm";

import { gradingPrompt, validateGrade } from "@/lib/rubric";
import { responseJson, rulesForRequest } from "@/lib/rubric-server";

const MAX_PDF_BYTES = 3_000_000;
const MAX_VISUAL_FALLBACK_BYTES = 15_000_000;
const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

function extensionFor(fileName: string) {
  return fileName.toLowerCase().split(".").pop() ?? "";
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const rubric = String(form.get("rubric") ?? "").trim();
    const provider = parseResumeLlmProvider(form.get("provider"));
    const model = String(form.get("model") ?? DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
    const effort = parseResumeLlmEffort(form.get("effort"));
    const apiKey = String(form.get("apiKey") ?? "").trim();
    const fileName = String(form.get("fileName") ?? "resume.pdf");
    const extractedText = String(form.get("extractedText") ?? "").trim();
    const extractionMethod = String(form.get("extractionMethod") ?? "none").trim();
    const visualFallbackError = String(form.get("visualFallbackError") ?? "").trim();
    const pageImages = form.getAll("pageImages")
      .filter((value): value is string => typeof value === "string" && /^data:image\/(?:jpeg|png|webp);base64,/i.test(value))
      .slice(0, 8);
    let extractionStatus: "good" | "uncertain" | "poor" | "unknown" = "unknown";
    let extractionIssues: string[] = [];
    try {
      const quality = JSON.parse(String(form.get("extractionQuality") ?? "{}")) as { status?: unknown; issues?: unknown };
      if (quality.status === "good" || quality.status === "uncertain" || quality.status === "poor") extractionStatus = quality.status;
      if (Array.isArray(quality.issues)) extractionIssues = quality.issues.map((issue) => String(issue)).slice(0, 10);
    } catch {
      extractionStatus = "unknown";
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Upload one resume file to grade." }, { status: 400 });
    }
    if (!file.size) throw new Error("Resume file is empty. Re-upload a readable file.");
    if (extractedText.length > 200000) throw new Error("Resume text exceeds the supported size. Split the document; no text was silently truncated.");
    const extension = extensionFor(fileName || file.name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return NextResponse.json({ error: "Only PDF, DOC, and DOCX resumes can be graded." }, { status: 400 });
    }
    const textOnlyDocument = extension === "doc" || extension === "docx";
    const extractedTextIsUsable = textOnlyDocument
      ? extractedText.length >= 100
      : extractionStatus === "good"
        ? extractedText.length >= 100
        : extractionStatus === "unknown" && extractedText.length >= 500;
    if (file.size > MAX_VISUAL_FALLBACK_BYTES && !extractedTextIsUsable) {
      return NextResponse.json({ error: "This resume is too large for visual fallback. Keep it under 15 MB or upload a text-readable version." }, { status: 413 });
    }
    if (file.size > MAX_PDF_BYTES && !extractedTextIsUsable && !pageImages.length) {
      return NextResponse.json({ error: `This file needs visual fallback, but page images could not be prepared${visualFallbackError ? `: ${visualFallbackError}` : "."}` }, { status: 413 });
    }
    if (textOnlyDocument && extractedText.length < 100) {
      return NextResponse.json({ error: "Could not extract enough text from this DOC/DOCX file. Please convert it to PDF or upload a text-readable DOCX." }, { status: 400 });
    }
    if (!rubric) {
      return NextResponse.json({ error: "Add a rubric prompt before grading." }, { status: 400 });
    }

    if (!apiKey) {
      return NextResponse.json({ error: `Enter your ${provider === "deepseek" ? "DeepSeek" : "OpenAI"} API key before grading.` }, { status: 400 });
    }

    if (Number(form.get("pageCount")) > 8 && !extractedTextIsUsable) throw new Error("Visual fallback supports up to 8 pages. Upload a text-readable PDF or split this resume; later pages must not be silently omitted.");
    const useExtractedText = extractedTextIsUsable;
    const usePageImages = pageImages.length > 0 && !useExtractedText;
    const includeUncertainText = usePageImages && extractionStatus === "uncertain" && extractedText.length >= 100;
    const rules = rulesForRequest(JSON.parse(String(form.get("rules") ?? "null")), rubric);
    const prompt = `${gradingPrompt(rules)}

Resume filename: ${fileName}
Text extraction method: ${extractionMethod}
Text extraction status: ${extractionStatus}
${extractionIssues.length ? `Extraction warnings: ${extractionIssues.join("; ")}` : ""}
${useExtractedText ? `\nResume text extracted locally:\n${extractedText}` : ""}
${includeUncertainText ? `\nThe following locally extracted text may have layout or character errors. Cross-check it against the attached page images:\n${extractedText}` : ""}
`;

    const content: Array<Record<string, string>> = useExtractedText ? [{ type: "input_text", text: prompt }] : [];
    if (usePageImages) {
      content.push(
        ...pageImages.map((imageUrl) => ({ type: "input_image", image_url: imageUrl, detail: "high" })),
        { type: "input_text", text: prompt }
      );
    } else if (!useExtractedText) {
      if (provider === "deepseek") {
        return NextResponse.json({ error: "Text extraction failed and no readable page images were produced for DeepSeek." }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const mime = MIME_BY_EXTENSION[extension] || file.type || "application/octet-stream";
      const fileData = `data:${mime};base64,${buffer.toString("base64")}`;
      content.push({ type: "input_file", filename: fileName, file_data: fileData }, { type: "input_text", text: prompt });
    }

    const payload = await createStructuredResumeResponse({
      signal: request.signal,
      provider,
      apiKey,
      model,
      effort,
      input: [
        {
          role: "user",
          content
        }
      ]
    });
    const parsed = responseJson(payload);
    return NextResponse.json({
      grade: validateGrade(parsed, rules, [], useExtractedText ? extractedText : undefined),
      provider,
      model: provider === "deepseek" ? "deepseek-flash" : model,
      effort,
      inputMode: useExtractedText ? "text" : usePageImages ? "page-images" : "original-file",
      extractionMethod,
      extractionStatus
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Resume grading failed." }, { status: 400 });
  }
}
