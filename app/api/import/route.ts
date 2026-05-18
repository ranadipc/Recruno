import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getState, patchState } from "@/lib/store";
import type { Candidate, Tier } from "@/lib/types";
import { isLinkedInProfileUrl, normalizeLinkedInUrl } from "@/lib/utils";

function parseCsv(text: string): Record<string, string>[] {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(headerLine);
  return lines.map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function splitCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function parseXlsx(buffer: ArrayBuffer): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headers = (sheet.getRow(1).values as unknown[])
    .slice(1)
    .map((value) => String(value ?? ""));
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = (row.values as unknown[]).slice(1);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? "")])));
  });
  return rows;
}

function importedCandidate(row: Record<string, string>): Candidate | undefined {
  const rawUrl = row["LinkedIn URL"] || row.linkedin || row.linkedin_url || "";
  const normalized = normalizeLinkedInUrl(rawUrl);
  if (!normalized || !isLinkedInProfileUrl(normalized)) return undefined;
  return {
    id: `import_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    normalized_linkedin_url: normalized,
    original_urls: [`https://${normalized}`],
    name_guess: row["Candidate Name"] || row.name || "",
    title_guess: row["Current Title"] || row.title || "",
    company_guess: row["Current Company"] || row.company || "",
    snippets: [],
    visibility_factor: Number(row["Visibility Factor"] || 0),
    matched_query_ids: [],
    matched_query_types: [],
    matched_filter_hints: row["Matched Queries"] ? [row["Matched Queries"]] : [],
    intent_evidence_sources: [],
    raw_source_flags: ["manual_import"],
    serp_evidence: [],
    source: "manual",
    status: "imported",
    apify_status: "pending_apify",
    fit_score: Number(row["Fit Score / 100"] || row["Fit Score / 70"] || "") || undefined,
    intent_score: Number(row["Intent Score / 30"] || "") || undefined,
    total_score: Number(row["Total Score / 100"] || "") || undefined,
    tier: (row.Tier || undefined) as Tier | undefined,
    fit_evidence: row["Fit Evidence"] ? [row["Fit Evidence"]] : [],
    intent_evidence: row["Supporting Signals"] ? [row["Supporting Signals"]] : row["Intent Evidence"] ? [row["Intent Evidence"]] : [],
    missing_data: [],
    risk_flags: [],
    recommended_manual_checks: [],
    manual_status: "pending",
    manual_notes: row["Manual Notes"] || "",
    needs_contact_enrichment: true,
    apollo_status: "not_started",
    email: row.Email || undefined,
    email_status: row["Email Status"] || undefined,
    phone: row.Phone || undefined,
    phone_status: row["Phone Status"] || undefined
  };
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file." }, { status: 400 });
  const rows = file.name.toLowerCase().endsWith(".xlsx")
    ? await parseXlsx(await file.arrayBuffer())
    : parseCsv(await file.text());
  const state = await getState();
  const existingByUrl = new Map(state.candidates.map((candidate) => [candidate.normalized_linkedin_url, candidate]));
  const imported = rows.map(importedCandidate).filter((candidate): candidate is Candidate => Boolean(candidate));
  const merged = [...state.candidates];
  for (const candidate of imported) {
    const existing = existingByUrl.get(candidate.normalized_linkedin_url);
    if (existing) {
      Object.assign(existing, {
        name_guess: candidate.name_guess || existing.name_guess,
        title_guess: candidate.title_guess || existing.title_guess,
        company_guess: candidate.company_guess || existing.company_guess,
        manual_notes: candidate.manual_notes || existing.manual_notes,
        tier: candidate.tier || existing.tier,
        email: candidate.email || existing.email,
        phone: candidate.phone || existing.phone
      });
    } else {
      merged.push(candidate);
    }
  }
  const next = await patchState({ candidates: merged }, `Imported ${imported.length} rows from ${file.name}.`);
  return NextResponse.json(next);
}
