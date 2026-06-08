import type { Candidate } from "./types";
import { profileFromApifyItem } from "./apify";
import { flatten, isLinkedInProfileUrl } from "./utils";

function aiValidationStatus(candidate: Candidate) {
  if (candidate.status === "ai_rejected" || candidate.manual_status === "rejected" || candidate.status === "deleted") return "rejected";
  if (candidate.status === "ai_review") return "review";
  if (candidate.status === "ai_passed") return "ai_passed";
  const flag = candidate.raw_source_flags?.find((item) => item.startsWith("ai_validation:"));
  if (flag) return flag.replace("ai_validation:", "");
  return candidate.status || "";
}

function aiValidationReason(candidate: Candidate) {
  return [...(candidate.risk_flags ?? []), ...(candidate.recommended_manual_checks ?? [])]
    .filter((item) => /clean screen|ai|excluded|mismatch|not relevant|seniority|role/i.test(item))
    .join("; ");
}

export function recruiterRows(candidates: Candidate[], options: { includeRejected?: boolean } = {}) {
  return candidates
    .filter((candidate) => isLinkedInProfileUrl(candidate.normalized_linkedin_url))
    .filter((candidate) => options.includeRejected || (candidate.manual_status !== "rejected" && candidate.status !== "ai_rejected" && candidate.status !== "deleted"))
    .map((candidate) => ({
    "Candidate Name": candidate.profile_data?.name || candidate.name_guess,
    "LinkedIn URL": `https://${candidate.normalized_linkedin_url}`,
    "Current Title": candidate.profile_data?.current_title || candidate.title_guess,
    "Current Company": candidate.profile_data?.current_company || candidate.company_guess,
    "AI Validation": aiValidationStatus(candidate),
    "AI Validation Reason": aiValidationReason(candidate),
    "Past Company / Past Experience": flatten(candidate.profile_data?.past_companies || candidate.profile_data?.experience),
    Location: candidate.profile_data?.location || "",
    Education: flatten(candidate.profile_data?.education),
    "Experience Summary": flatten(candidate.profile_data?.experience),
    "Visibility Factor": candidate.visibility_factor,
    "Matched Queries": candidate.matched_filter_hints.join("; "),
    "Post Evidence Source URLs": candidate.intent_evidence_sources?.map((source) => source.url).join("; ") ?? "",
    "Fit Score / 100": candidate.total_score ?? candidate.fit_score ?? "",
    "Total Score / 100": candidate.total_score ?? "",
    Tier: candidate.tier ?? "",
    "Fit Evidence": candidate.fit_evidence.join("; "),
    "Supporting Signals": candidate.intent_evidence.join("; "),
    "Open to Work Signal": candidate.open_to_work_signal ?? "",
    "Tenure Months": candidate.tenure_months ?? "",
    "Promotion Flag": candidate.promotion_flag ?? "",
    "Layoff Signal": candidate.layoff_signal ?? "",
    "Hiring Comment Signal": candidate.hiring_comment_signal ?? "",
    Email: candidate.email ?? "",
    "Email Source": candidate.email_source ?? "",
    "Email Status": candidate.email_status ?? "",
    Phone: candidate.phone ?? "",
    "Phone Source": candidate.phone_source ?? "",
    "Phone Status": candidate.phone_status ?? "",
    "Apollo Enrichment Status": candidate.apollo_status,
    "Manual Notes": candidate.manual_notes,
    "Recommended Outreach Angle": candidate.recommended_outreach_angle ?? candidate.final_notes ?? ""
  }));
}

export function apifyRows(candidates: Candidate[]) {
  return candidates
    .filter((candidate) => isLinkedInProfileUrl(candidate.normalized_linkedin_url))
    .map((candidate) => {
      const raw = candidate.apify_raw && typeof candidate.apify_raw === "object" && !Array.isArray(candidate.apify_raw)
        ? candidate.apify_raw as Record<string, unknown>
        : undefined;
      const profile = profileFromApifyItem(raw, candidate) ?? candidate.profile_data;
      return {
        "Candidate Name": profile?.name || candidate.name_guess,
        "LinkedIn URL": `https://${candidate.normalized_linkedin_url}`,
        "Apify Status": candidate.apify_status,
        Headline: profile?.headline || "",
        Location: profile?.location || "",
        "Current Role": profile?.current_title || "",
        "Current Company": profile?.current_company || "",
        "Past Companies": flatten(profile?.past_companies),
        Education: flatten(profile?.education),
        Skills: flatten(profile?.skills),
        About: profile?.about || "",
        Experience: flatten(profile?.experience),
        "Visibility Factor": candidate.visibility_factor,
        Source: candidate.raw_source_flags?.includes("manual_apify_input") ? "Apify input links" : candidate.source,
        "Raw Apify JSON": raw ? JSON.stringify(raw) : ""
      };
    });
}

export function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
