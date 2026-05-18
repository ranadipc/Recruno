import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SETTINGS, DEFAULT_STATE } from "./defaults";
import type { AppState, PublicSettings, SecretSettings, Settings } from "./types";

const dataDir = process.env.VERCEL ? path.join("/tmp", "recruno-automated-leads") : path.join(process.cwd(), "data");
const stateFile = path.join(dataDir, "state.json");
const settingsFile = path.join(dataDir, "settings.json");

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, "utf8");
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown) {
  await ensureDataDir();
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

export async function getState(): Promise<AppState> {
  const state = await readJson<AppState>(stateFile, DEFAULT_STATE);
  return {
    ...DEFAULT_STATE,
    ...state,
    rejectedSerpResults: state.rejectedSerpResults ?? [],
    intentEvidenceSources: state.intentEvidenceSources ?? [],
    profileFilters: { ...DEFAULT_STATE.profileFilters, ...(state.profileFilters ?? {}) },
    oneClick: { ...DEFAULT_STATE.oneClick, ...(state.oneClick ?? {}) },
    status: { ...DEFAULT_STATE.status, ...state.status },
    apolloTierSelection: { ...DEFAULT_STATE.apolloTierSelection, ...state.apolloTierSelection }
  };
}

export async function saveState(state: AppState): Promise<AppState> {
  const next = {
    ...state,
    status: { ...state.status, lastUpdated: new Date().toISOString() }
  };
  await writeJson(stateFile, next);
  return next;
}

type AppStatePatch = Partial<Omit<AppState, "status">> & { status?: Partial<AppState["status"]> };

export async function patchState(patch: AppStatePatch, message?: string): Promise<AppState> {
  const state = await getState();
  const next: AppState = {
    ...state,
    ...patch,
    status: {
      ...state.status,
      ...(patch.status ?? {}),
      messages: message ? [message, ...state.status.messages].slice(0, 50) : state.status.messages,
      errors: patch.status?.errors ?? state.status.errors,
      lastUpdated: new Date().toISOString()
    }
  };
  return saveState(next);
}

export async function getSettings(): Promise<Settings> {
  const persisted = await readJson<Settings>(settingsFile, DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...persisted,
    OPENAI_API_KEY: persisted.OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    SERPAPI_API_KEY: persisted.SERPAPI_API_KEY || process.env.SERPAPI_API_KEY,
    APIFY_API_TOKEN: persisted.APIFY_API_TOKEN || process.env.APIFY_API_TOKEN,
    APIFY_ACTOR_ID: persisted.APIFY_ACTOR_ID || process.env.APIFY_ACTOR_ID || DEFAULT_SETTINGS.APIFY_ACTOR_ID,
    APOLLO_API_KEY: persisted.APOLLO_API_KEY || process.env.APOLLO_API_KEY,
    workflow: { ...DEFAULT_SETTINGS.workflow, ...persisted.workflow }
  };
}

export async function saveSettings(input: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const secretKeys: Array<keyof SecretSettings> = [
    "OPENAI_API_KEY",
    "SERPAPI_API_KEY",
    "APIFY_API_TOKEN",
    "APIFY_ACTOR_ID",
    "APOLLO_API_KEY"
  ];
  const next: Settings = {
    ...current,
    workflow: { ...current.workflow, ...(input.workflow ?? {}) }
  };
  for (const key of secretKeys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      next[key] = value.trim();
    }
  }
  await writeJson(settingsFile, next);
  return next;
}

export function toPublicSettings(settings: Settings): PublicSettings {
  return {
    keyPresence: {
      OPENAI_API_KEY: Boolean(settings.OPENAI_API_KEY),
      SERPAPI_API_KEY: Boolean(settings.SERPAPI_API_KEY),
      APIFY_API_TOKEN: Boolean(settings.APIFY_API_TOKEN),
      APIFY_ACTOR_ID: Boolean(settings.APIFY_ACTOR_ID),
      APOLLO_API_KEY: Boolean(settings.APOLLO_API_KEY)
    },
    workflow: settings.workflow,
    apifyActorId: settings.APIFY_ACTOR_ID || "harvestapi/linkedin-profile-scraper"
  };
}
