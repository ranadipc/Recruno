import type { Candidate } from "./types";
import { flatten, isLinkedInProfileUrl } from "./utils";

export function recruiterRows(candidates: Candidate[]) {
  return candidates.filter((candidate) => isLinkedInProfileUrl(candidate.normalized_linkedin_url)).map((candidate) => ({
    "Candidate Name": candidate.profile_data?.name || candidate.name_guess,
    "LinkedIn URL": `https://${candidate.normalized_linkedin_url}`,
    "Current Title": candidate.profile_data?.current_title || candidate.title_guess,
    "Current Company": candidate.profile_data?.current_company || candidate.company_guess,
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

export function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
