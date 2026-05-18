import { NextResponse } from "next/server";
import { getState, patchState } from "@/lib/store";
import type { ProfileFilters } from "@/lib/types";
import { applyProfileFilters, splitTerms } from "@/lib/utils";

function numberOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && String(value ?? "").trim() !== "" ? number : undefined;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const filters: ProfileFilters = {
    actual_location_must_include: splitTerms(body.actual_location_must_include),
    current_title_must_include: splitTerms(body.current_title_must_include),
    current_company_must_include: splitTerms(body.current_company_must_include),
    past_company_must_include: splitTerms(body.past_company_must_include),
    keywords_must_include: splitTerms(body.keywords_must_include),
    education_must_include: splitTerms(body.education_must_include),
    min_total_experience_years: numberOrUndefined(body.min_total_experience_years),
    max_total_experience_years: numberOrUndefined(body.max_total_experience_years),
    current_company_tenure_min_months: numberOrUndefined(body.current_company_tenure_min_months),
    current_company_tenure_max_months: numberOrUndefined(body.current_company_tenure_max_months),
    current_role_tenure_min_months: numberOrUndefined(body.current_role_tenure_min_months),
    current_role_tenure_max_months: numberOrUndefined(body.current_role_tenure_max_months),
    require_open_to_work: body.require_open_to_work === true,
    require_layoff_signal: body.require_layoff_signal === true,
    require_no_promotion_signal: body.require_no_promotion_signal === true,
    exclude_terms: splitTerms(body.exclude_terms)
  };
  const state = await getState();
  const candidates = state.candidates.map((candidate) => applyProfileFilters(candidate, filters));
  const next = await patchState(
    { candidates, profileFilters: filters, status: { currentStep: 8, errors: [] } as never },
    `Profile filters applied. ${candidates.filter((candidate) => candidate.passes_profile_filter).length} passed, ${candidates.filter((candidate) => candidate.passes_profile_filter === false).length} failed.`
  );
  return NextResponse.json(next);
}
