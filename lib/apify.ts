import type { Candidate, ProfileData } from "./types";
import { normalizeLinkedInUrl } from "./utils";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function objectText(value: unknown, keys: string[]): string {
  const direct = text(value);
  if (direct) return direct;
  const source = record(value);
  if (!source) return "";
  for (const key of keys) {
    const result = text(source[key]);
    if (result) return result;
  }
  return "";
}

function locationText(value: unknown): string {
  const direct = text(value);
  if (direct) return direct;
  const source = record(value);
  if (!source) return "";
  const parsed = record(source.parsed);
  return objectText(source, ["linkedinText", "text", "name", "fullName"])
    || objectText(parsed, ["text"])
    || [text(parsed?.city), text(parsed?.state), text(parsed?.countryFull ?? parsed?.country)].filter(Boolean).join(", ");
}

function experienceRows(item: JsonRecord) {
  return Array.isArray(item.experience) ? item.experience.filter((entry): entry is JsonRecord => Boolean(record(entry))) : [];
}

function currentExperience(item: JsonRecord) {
  const explicit = Array.isArray(item.currentPosition)
    ? item.currentPosition.find((entry) => Boolean(record(entry))) as JsonRecord | undefined
    : undefined;
  if (explicit) return explicit;
  const rows = experienceRows(item);
  return rows.find((entry) => /present/i.test(objectText(entry.endDate, ["text"]))) ?? rows[0];
}

function arrayNames(value: unknown, keys: string[]) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => objectText(entry, keys)).filter(Boolean);
}

export function profileFromApifyItem(item: JsonRecord | undefined, candidate: Candidate): ProfileData | undefined {
  if (!item) return undefined;
  const experience = experienceRows(item);
  const current = currentExperience(item);
  const firstName = text(item.firstName);
  const lastName = text(item.lastName);
  const name = objectText(item.name ?? item.fullName, ["text", "name", "fullName"])
    || [firstName, lastName].filter(Boolean).join(" ")
    || candidate.name_guess;
  return {
    name,
    headline: objectText(item.headline ?? item.occupation, ["text", "headline"]) || candidate.title_guess,
    about: objectText(item.about ?? item.summary ?? item.description, ["text", "description"]),
    location: locationText(item.location ?? item.geoLocationName ?? item.geo),
    current_company_location: locationText(item.currentCompanyLocation ?? item.companyLocation ?? current?.location),
    current_title: objectText(item.current_title ?? item.currentTitle ?? item.jobTitle ?? current?.position ?? current?.title, ["text", "name", "title", "position"]) || candidate.title_guess,
    current_company: objectText(item.current_company ?? item.currentCompany ?? item.companyName ?? item.company ?? current?.companyName ?? current?.company, ["text", "name", "companyName"]) || candidate.company_guess,
    past_companies: Array.isArray(item.past_companies)
      ? arrayNames(item.past_companies, ["name", "companyName", "text"])
      : experience.map((entry) => objectText(entry.companyName ?? entry.company, ["name", "companyName", "text"])).filter(Boolean),
    experience,
    education: Array.isArray(item.education) ? item.education as Array<JsonRecord | string> : [],
    skills: arrayNames(item.skills, ["name", "text", "skillName"]),
    posts: Array.isArray(item.posts) ? item.posts as Array<JsonRecord | string> : []
  };
}

export function apifyItemProfileUrl(item: JsonRecord) {
  const originalQuery = record(item.originalQuery);
  const possible = [
    item.linkedinUrl,
    item.linkedin_url,
    item.profileUrl,
    item.profile_url,
    item.url,
    originalQuery?.query,
    originalQuery?.url
  ];
  for (const value of possible) {
    const normalized = normalizeLinkedInUrl(text(value));
    if (normalized?.startsWith("linkedin.com/in/")) return normalized;
  }
  return undefined;
}

export function matchApifyItem(items: JsonRecord[], candidate: Candidate, index: number) {
  const byUrl = items.find((item) => apifyItemProfileUrl(item) === candidate.normalized_linkedin_url);
  if (byUrl) return byUrl;
  const slug = candidate.normalized_linkedin_url.split("/").pop()?.toLowerCase();
  const bySlug = slug ? items.find((item) => JSON.stringify(item).toLowerCase().includes(slug)) : undefined;
  if (bySlug) return bySlug;
  return items.length === 1 && index === 0 ? items[0] : undefined;
}
