/**
 * The Gemini client boundary.
 *
 * `GeminiClient` is the single seam the provider depends on. Tests inject a mock
 * client (no network, no API key); production uses {@link HttpGeminiClient},
 * which calls the Gemini REST `generateContent` endpoint with structured-output
 * generation config. Keeping this a narrow port means the provider/orchestrator
 * are fully testable without a real key or the network.
 *
 * SECURITY: the API key is passed as a request header and is never placed in
 * logs, errors, request metadata, or the response object returned upward.
 */
import {
  GeminiRequestError,
  GeminiTimeoutError,
} from "./errors";
import type { GeminiConfig } from "./config";

/** A JSON-schema-like object describing the required structured output. */
export type ResponseSchema = Record<string, unknown>;

export interface GeminiGenerateRequest {
  /** System-level instruction (role/guardrails). */
  systemInstruction: string;
  /** The user prompt (minimal case context only). */
  prompt: string;
  /** Structured-output schema the model must conform to. */
  responseSchema: ResponseSchema;
}

export interface GeminiUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GeminiGenerateResponse {
  /** Raw model text (expected to be a JSON document per the schema). */
  text: string;
  /** Provider request id if the transport exposed one (non-secret). */
  requestId?: string;
  usage?: GeminiUsage;
}

/** The mockable client port. */
export interface GeminiClient {
  readonly model: string;
  generate(req: GeminiGenerateRequest): Promise<GeminiGenerateResponse>;
}

interface GeminiRestCandidate {
  content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  finishReason?: string;
}
interface GeminiRestResponse {
  candidates?: GeminiRestCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

/**
 * REST-based Gemini client (no SDK dependency — uses global `fetch`). Applies a
 * hard timeout via AbortController and maps transport/HTTP failures to the typed
 * error taxonomy so the provider can decide what is safe to retry.
 */
export class HttpGeminiClient implements GeminiClient {
  readonly model: string;
  private readonly config: GeminiConfig;

  constructor(config: GeminiConfig) {
    this.config = config;
    this.model = config.model;
  }

  async generate(req: GeminiGenerateRequest): Promise<GeminiGenerateResponse> {
    const url = `${this.config.baseUrl}/models/${encodeURIComponent(this.config.model)}:generateContent`;
    const body = {
      systemInstruction: { role: "system", parts: [{ text: req.systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: this.config.temperature,
        maxOutputTokens: this.config.maxOutputTokens,
        // Structured output: force a JSON document matching the schema.
        responseMimeType: "application/json",
        responseSchema: req.responseSchema,
        candidateCount: 1,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Key travels in a header, never in the URL/query (avoids log leakage).
          "x-goog-api-key": this.config.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new GeminiTimeoutError(this.config.timeoutMs);
      }
      throw new GeminiRequestError("Gemini request failed at the transport layer.", undefined, {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Do NOT include the response body verbatim (may echo request content);
      // only the status drives retry/audit decisions.
      //
      // 429 = rate limit / quota exhausted. There is no backoff seam in the retry
      // loop, and the provider's per-minute window won't clear on an immediate
      // retry — retrying would only burn more of a small quota. Fail fast and let
      // the caller surface a clear "try again shortly" message.
      throw new GeminiRequestError(
        `Gemini returned HTTP ${res.status}.`,
        res.status,
        res.status === 429 ? { retryable: false } : undefined,
      );
    }

    const requestId = res.headers.get("x-request-id") ?? undefined;
    let json: GeminiRestResponse;
    try {
      json = (await res.json()) as GeminiRestResponse;
    } catch (err) {
      throw new GeminiRequestError("Gemini returned a non-JSON HTTP body.", res.status, {
        cause: err,
      });
    }

    const candidate = json.candidates?.[0];
    // Thinking models return multiple parts; only the non-"thought" parts carry
    // the answer text. Concatenate all answer text (never a single part).
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("");

    if (text.trim() === "") {
      // A safety block or an exhausted token budget (thinking model) yields no
      // answer text. Fail with a clear, non-secret diagnostic instead of letting
      // an empty string be misreported downstream as "malformed output".
      const blockReason = json.promptFeedback?.blockReason;
      const finishReason = candidate?.finishReason;
      if (finishReason === "MAX_TOKENS") {
        // Increasing the budget is the fix; retrying the same request will not help.
        throw new GeminiRequestError(
          "Gemini reached the output token limit before returning an answer (increase maxOutputTokens).",
          res.status,
          { retryable: false },
        );
      }
      throw new GeminiRequestError(
        `Gemini returned no answer text${blockReason ? ` (blocked: ${blockReason})` : finishReason ? ` (finishReason: ${finishReason})` : ""}.`,
        res.status,
        { retryable: false },
      );
    }

    return {
      text,
      requestId,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}
