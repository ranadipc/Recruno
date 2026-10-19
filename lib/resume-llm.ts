export type ResumeLlmProvider = "openai" | "deepseek";
export type ResumeLlmEffort = "low" | "medium" | "high";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEEPSEEK_MODEL = "deepseek-flash";

type StructuredResponseInput = string | Array<Record<string, unknown>>;

type StructuredResponseOptions = {
  provider: ResumeLlmProvider;
  apiKey: string;
  model?: string;
  effort?: ResumeLlmEffort;
  input: StructuredResponseInput;
  signal?: AbortSignal;
};

function deepSeekEffort(effort: ResumeLlmEffort | undefined) {
  if (effort === "low") return "low";
  if (effort === "high") return "max";
  return "high";
}

export function parseResumeLlmProvider(value: unknown): ResumeLlmProvider {
  return value === "deepseek" ? "deepseek" : "openai";
}

export function parseResumeLlmEffort(value: unknown): ResumeLlmEffort {
  return value === "low" || value === "high" ? value : "medium";
}

export async function createStructuredResumeResponse(options: StructuredResponseOptions) {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error(`Enter your ${options.provider === "deepseek" ? "DeepSeek" : "OpenAI"} API key before grading.`);

  const isDeepSeek = options.provider === "deepseek";
  const providerName = isDeepSeek ? "DeepSeek" : "OpenAI";
  const response = await fetch(isDeepSeek ? "https://api.deepseek.com/responses" : "https://api.openai.com/v1/responses", {
    method: "POST",
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: isDeepSeek ? DEEPSEEK_MODEL : options.model || DEFAULT_OPENAI_MODEL,
      input: options.input,
      ...(isDeepSeek ? { reasoning: { effort: deepSeekEffort(options.effort) } } : {}),
      text: { format: { type: "json_object" } }
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000);
    throw new Error(`${providerName} request failed (${response.status}): ${detail}`);
  }

  return response.json();
}
