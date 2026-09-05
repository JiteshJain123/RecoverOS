/**
 * Gemini client configuration, resolved from validated environment variables.
 *
 * Google Gemini is the RecoverOS AI provider. The model is taken from
 * `GEMINI_MODEL` (never hardcoded across the app) and the key from
 * `GEMINI_API_KEY`. Configuration errors fail clearly and safely via
 * {@link GeminiConfigError} BEFORE any network call is attempted.
 *
 * The resolved config is NOT logged and NOT serialized anywhere; only the model
 * name (non-secret) is ever recorded.
 */
import { loadEnv, type Env } from "@recoveros/config";
import { GeminiConfigError } from "./errors";

/** Default request timeout (ms) for a single Gemini call. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Deterministic-by-default generation temperature (0 = most reproducible). */
export const DEFAULT_TEMPERATURE = 0;
/**
 * Max output tokens requested from the model.
 *
 * Modern Gemini models (2.5+/3.x) are "thinking" models: internal reasoning
 * tokens are drawn from the SAME output budget as the response. A small budget
 * (e.g. 1024) is fully consumed by thinking and the structured JSON answer is
 * truncated (`finishReason: MAX_TOKENS`) or empty, which surfaces as a
 * malformed-output failure. This budget must comfortably cover thinking + the
 * structured recommendation JSON.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface GeminiConfig {
  /** Secret API key. Kept in memory only; never logged/serialized. */
  readonly apiKey: string;
  /** Model id from GEMINI_MODEL (e.g. "gemini-3.8-flash"). */
  readonly model: string;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** REST base URL (overridable for tests/self-host; no secrets). */
  readonly baseUrl: string;
}

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface LoadGeminiConfigOptions {
  env?: Env;
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  baseUrl?: string;
}

/**
 * Resolve and validate Gemini configuration. Throws {@link GeminiConfigError}
 * when the API key is missing/blank or the model id is missing/blank.
 */
export function loadGeminiConfig(options: LoadGeminiConfigOptions = {}): GeminiConfig {
  const env = options.env ?? loadEnv();

  const apiKey = (env.GEMINI_API_KEY ?? "").trim();
  if (apiKey === "") {
    throw new GeminiConfigError(
      "GEMINI_API_KEY is not set. Configure it to enable Gemini recommendations.",
    );
  }

  const model = (env.GEMINI_MODEL ?? "").trim();
  if (model === "") {
    throw new GeminiConfigError("GEMINI_MODEL is not set or is blank.");
  }

  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  if (temperature < 0 || temperature > 2 || Number.isNaN(temperature)) {
    throw new GeminiConfigError(`Invalid Gemini temperature: ${temperature} (expected 0..2).`);
  }

  return {
    apiKey,
    model,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    temperature,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
  };
}
