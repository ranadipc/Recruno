import { createHash } from "node:crypto";
import { RULES_VERSION, validateRules, type RubricRules } from "./rubric";

export function rubricVersion(rubric: string) {
  return `v${RULES_VERSION}-${createHash("sha256").update(rubric.trim()).digest("hex")}`;
}
export function rulesForRequest(value: unknown, rubric: string): RubricRules {
  const rules = validateRules(value);
  if (rules.sourceRubric !== rubric.trim() || rules.version !== rubricVersion(rubric)) throw new Error("Rubric changed. Prepare the new rubric rules before evaluating.");
  return rules;
}
export function responseJson(payload: { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> }) {
  const text = payload.output_text ?? payload.output?.flatMap(item => item.content ?? []).map(p => p.text ?? "").join("\n") ?? "";
  const fenced = text.match(/^\s*```(?:json)?\s*([\s\S]*?)```\s*$/i)?.[1];
  return JSON.parse(fenced ?? text) as unknown;
}
