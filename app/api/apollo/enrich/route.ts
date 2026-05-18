import { NextResponse } from "next/server";
import { enrichApollo } from "@/lib/external";
import { getSettings, getState, patchState } from "@/lib/store";
import type { ApolloTierSelection, Candidate, Tier } from "@/lib/types";
import { isLinkedInProfileUrl } from "@/lib/utils";

function extractApollo(payload: Record<string, unknown>) {
  const person = (payload.person ?? payload) as Record<string, unknown>;
  const email = String(person.email ?? person.personal_email ?? "");
  const phoneArray = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
  const firstPhone = phoneArray[0] as Record<string, unknown> | undefined;
  return {
    email: email || undefined,
    phone: String(person.mobile_phone ?? person.phone ?? firstPhone?.raw_number ?? firstPhone?.sanitized_number ?? "") || undefined,
    email_status: String(person.email_status ?? payload.email_status ?? payload.status ?? (email ? "found" : "not_found")),
    phone_status: String(person.phone_status ?? payload.phone_status ?? (firstPhone ? "found" : "not_found")),
    email_source: String(payload.email_source ?? person.email_source ?? "apollo"),
    phone_source: String(payload.phone_source ?? person.phone_source ?? "apollo")
  };
}

function eligibleCandidates(candidates: Candidate[], useAllNonRejected: boolean) {
  return candidates.filter((candidate) => {
    if (!isLinkedInProfileUrl(candidate.normalized_linkedin_url)) return false;
    if (!candidate.needs_contact_enrichment) return false;
    return useAllNonRejected ? candidate.manual_status !== "rejected" : candidate.manual_status === "approved";
  });
}

function estimate(candidates: Candidate[], selection: ApolloTierSelection) {
  return candidates.reduce<{ email: number; phone: number; total: number; selected: number }>(
    (acc, candidate) => {
      const tier = (candidate.tier ?? "Tier 4") as Tier;
      const pick = selection[tier];
      if (!pick) return acc;
      const wantsEmail = Boolean(pick.email);
      const wantsPhone = Boolean(pick.phone);
      if (wantsEmail) acc.email += 1;
      if (wantsPhone) acc.phone += 1;
      if (wantsEmail || wantsPhone) acc.selected += 1;
      return acc;
    },
    { email: 0, phone: 0, total: 0, selected: 0 }
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const settings = await getSettings();
    const state = await getState();
    const selection = (body.selection ?? state.apolloTierSelection) as ApolloTierSelection;
    const useAllNonRejected = Boolean(body.useAllNonRejected);
    const candidatesToEnrich = eligibleCandidates(state.candidates, useAllNonRejected);
    const credit = estimate(candidatesToEnrich, selection);
    credit.total = credit.email + credit.phone * 8;
    if (!body.confirm) {
      const next = await patchState({ apolloTierSelection: selection }, "Apollo credit estimate refreshed.");
      return NextResponse.json({
        state: next,
        estimate: credit,
        message: credit.selected === 0 ? `${candidatesToEnrich.length} eligible candidates, but 0 selected by tier/email/phone settings.` : `${credit.selected} candidates selected for enrichment.`
      });
    }
    const eligibleIds = new Set(candidatesToEnrich.map((candidate) => candidate.id));
    const updated: Candidate[] = [];
    for (const candidate of state.candidates) {
      const tier = (candidate.tier ?? "Tier 4") as Tier;
      const pick = selection[tier] ?? { email: false, phone: false };
      if (!eligibleIds.has(candidate.id) || (!pick.email && !pick.phone)) {
        updated.push({
          ...candidate,
          apollo_status: candidate.apollo_status === "not_started" ? "skipped" : candidate.apollo_status,
          email_status: pick.email ? candidate.email_status : candidate.email_status ?? "not_requested",
          phone_status: pick.phone ? candidate.phone_status : candidate.phone_status ?? "not_requested"
        });
        continue;
      }
      try {
        const payload = (await enrichApollo(settings, candidate, pick.email, pick.phone)) as Record<string, unknown>;
        const contact = extractApollo(payload);
        updated.push({
          ...candidate,
          email: contact.email,
          email_source: contact.email ? "apollo" : undefined,
          email_status: pick.email ? contact.email_status : "not_requested",
          phone: contact.phone,
          phone_source: contact.phone ? "apollo" : undefined,
          phone_status: pick.phone ? contact.phone_status : "not_requested",
          apollo_status: contact.email || contact.phone ? "enriched" : "not_found",
          apollo_raw_json: payload,
          apollo_credit_estimate: (pick.email ? 1 : 0) + (pick.phone ? 8 : 0)
        });
      } catch (error) {
        updated.push({
          ...candidate,
          apollo_status: "failed",
          email_status: error instanceof Error ? error.message : "Apollo failed",
          phone_status: error instanceof Error ? error.message : "Apollo failed"
        });
      }
    }
    const next = await patchState(
      { candidates: updated, apolloTierSelection: selection, status: { currentStep: 11, errors: [] } as never },
      `Apollo enrichment completed. Estimated credits: ${credit.total}.`
    );
    return NextResponse.json({ state: next, estimate: credit });
  } catch (error) {
    const state = await patchState({ status: { errors: [error instanceof Error ? error.message : "Apollo enrichment failed."] } as never });
    return NextResponse.json({ state }, { status: 400 });
  }
}
