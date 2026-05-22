import { NextResponse } from "next/server";
import { runSerpApiSearch } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { SerpResult } from "@/lib/types";
import { classifySerpResult, id } from "@/lib/utils";

function requiredExactPhrases(query: string) {
  const phrases: string[] = [];
  const matches = query.matchAll(/"([^"]{2,})"/g);
  for (const match of matches) {
    const phrase = match[1].trim();
    const before = query.slice(0, match.index);
    const open = before.lastIndexOf("(");
    const close = before.lastIndexOf(")");
    const inOpenGroup = open > close;
    const groupEnd = inOpenGroup ? query.indexOf(")", match.index) : -1;
    const groupText = inOpenGroup && groupEnd > -1 ? query.slice(open, groupEnd + 1) : "";
    const isOrAlternative = /\bOR\b/i.test(groupText);
    const isNegative = /-\s*$/.test(before);
    if (!isOrAlternative && !isNegative && !/^(jobs|hiring|recruiter)$/i.test(phrase)) phrases.push(phrase.toLowerCase());
  }
  return phrases;
}

function applyRequiredPhraseGate(result: SerpResult) {
  const phrases = requiredExactPhrases(result.query_text);
  if (phrases.length === 0 || !result.classification?.keep_result || !result.classification.is_linkedin_profile) return result;
  const visible = [result.title, result.snippet, result.displayed_link, result.link].join(" ").toLowerCase();
  const missing = phrases.filter((phrase) => !visible.includes(phrase));
  if (missing.length === 0) return result;
  return {
    ...result,
    classification: {
      ...result.classification,
      keep_result: false,
      rejection_reason: `Missing required exact query phrase in visible result: ${missing.join(", ")}`
    }
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const settings = await getSettings();
    const state = await getState();
    const pages = Number(body.pagesPerQuery || settings.workflow.defaultSerpPages || 2);
    const startPageOffset = Number(body.startOffset || 0);
    const location = body.location ? String(body.location) : undefined;
    const targetCountry = body.targetCountry === "Any" ? "Any" : "India";
    const strictIndiaOnly = body.strictIndiaOnly !== false;
    const keepUnknownLocation = body.keepUnknownLocation !== false;
    const selected = state.queries.filter((query) => query.selected);
    const searchPairs = selected.flatMap((query) =>
      Array.from({ length: pages }, (_, index) => ({ query, page: index + 1, start: startPageOffset + index * 10 }))
    );

    const results: SerpResult[] = [];
    const rawSerpRuns = [];
    for (const pair of searchPairs) {
      const json = await runSerpApiSearch(settings, pair.query, pair.page, pair.start, location);
      rawSerpRuns.push({ id: id("raw"), query_id: pair.query.id, page: pair.page, response: json, created_at: new Date().toISOString() });
      const organic = Array.isArray(json.organic_results) ? json.organic_results : [];
      organic.forEach((item: Record<string, unknown>, index: number) => {
        const result: SerpResult = {
          id: id("serp"),
          query_id: pair.query.id,
          query_text: pair.query.query_text,
          query_type: pair.query.query_type,
          title: String(item.title ?? ""),
          link: String(item.link ?? ""),
          displayed_link: String(item.displayed_link ?? ""),
          snippet: String(item.snippet ?? ""),
          position: Number(item.position ?? index + 1),
          page: pair.page,
          raw_json: item
        };
        const classification = classifySerpResult(result, { targetCountry, strictIndiaOnly, keepUnknownLocation });
        results.push(applyRequiredPhraseGate({ ...result, classification, location_evidence: classification.location_evidence }));
      });
      if (Number(body.delayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, Number(body.delayMs)));
    }
    const next = await patchState(
      { serpResults: results, rawSerpRuns, status: { currentStep: 5, errors: [] } as never },
      `SerpAPI run completed with ${results.length} organic results.`
    );
    return NextResponse.json(next);
  } catch (error) {
    const state = await patchState({ status: { errors: [error instanceof Error ? error.message : "SerpAPI run failed."] } as never });
    return NextResponse.json(state, { status: 400 });
  }
}
