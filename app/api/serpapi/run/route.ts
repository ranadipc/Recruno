import { NextResponse } from "next/server";
import { runSerpApiSearch } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { SerpResult } from "@/lib/types";
import { classifySerpResult, id } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const settings = await getSettings();
    const state = await getState();
    const pages = Number(body.pagesPerQuery || settings.workflow.defaultSerpPages || 2);
    const startPageOffset = Number(body.startOffset || 0);
    const maxSearches = Number(body.maxSearches || settings.workflow.maxQueriesPerRun * pages);
    const location = body.location ? String(body.location) : undefined;
    const targetCountry = body.targetCountry === "Any" ? "Any" : "India";
    const strictIndiaOnly = body.strictIndiaOnly !== false;
    const keepUnknownLocation = body.keepUnknownLocation === true;
    const selected = state.queries.filter((query) => query.selected).slice(0, settings.workflow.maxQueriesPerRun);
    const limitedPairs = selected.flatMap((query) =>
      Array.from({ length: pages }, (_, index) => ({ query, page: index + 1, start: startPageOffset + index * 10 }))
    ).slice(0, maxSearches);

    const results: SerpResult[] = [];
    const rawSerpRuns = [];
    for (const pair of limitedPairs) {
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
        results.push({ ...result, classification, location_evidence: classification.location_evidence });
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
