/**
 * The structured output contract for Gemini.
 *
 * Gemini is advisory: it chooses a STRATEGY and explains it. It never emits
 * amounts, currencies, customer data, payment status, idempotency keys, or
 * capabilities — those are filled deterministically by the provider from the
 * trusted context, so the model cannot invent financial facts. This keeps the
 * model's surface minimal and auditable.
 *
 * Two representations are derived from the same allowed-value lists:
 *  - `geminiResponseSchema`: a JSON-schema-like object sent to Gemini as the
 *    `responseSchema` generation config (forces structured output + enums).
 *  - `geminiOutputSchema` (zod): validates the returned JSON on the way back.
 */
import { z } from "zod";
import {
  STRATEGIES,
  RISK_LEVELS,
  STOPPING_CONDITION_TYPES,
  ACTION_KINDS,
} from "@recoveros/strategy";

/** Action kinds the model is allowed to suggest (the executable primitives). */
export const SUGGESTIBLE_ACTION_KINDS = ACTION_KINDS;

/** zod schema for the model's JSON. Explicit enums, no free-form fields. */
export const geminiOutputSchema = z
  .object({
    recommendation: z.enum(STRATEGIES),
    rationale: z.string().min(1).max(2000),
    /** References to provided evidence (labels/ids), NOT new facts. */
    evidenceRefs: z.array(z.string().min(1)).max(20).default([]),
    confidence: z.number().min(0).max(1),
    riskLevel: z.enum(RISK_LEVELS),
    expectedOutcome: z
      .object({
        successProbability: z.number().min(0).max(1),
        description: z.string().min(1).max(500),
      })
      .strict(),
    /** The bounded action primitives the model suggests (enriched later). */
    proposedActionKinds: z.array(z.enum(ACTION_KINDS)).max(4).default([]),
    stoppingConditions: z
      .array(
        z
          .object({
            type: z.enum(STOPPING_CONDITION_TYPES),
            description: z.string().min(1).max(300),
          })
          .strict(),
      )
      .max(6)
      .default([]),
  })
  .strict();

export type GeminiOutput = z.infer<typeof geminiOutputSchema>;

/**
 * JSON-schema-like object handed to Gemini's `responseSchema`. Mirrors the zod
 * schema above; `enum` constrains the model to our allowed values.
 */
export const geminiResponseSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    recommendation: { type: "string", enum: [...STRATEGIES] },
    rationale: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    riskLevel: { type: "string", enum: [...RISK_LEVELS] },
    expectedOutcome: {
      type: "object",
      properties: {
        successProbability: { type: "number" },
        description: { type: "string" },
      },
      required: ["successProbability", "description"],
    },
    proposedActionKinds: { type: "array", items: { type: "string", enum: [...ACTION_KINDS] } },
    stoppingConditions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...STOPPING_CONDITION_TYPES] },
          description: { type: "string" },
        },
        required: ["type", "description"],
      },
    },
  },
  required: [
    "recommendation",
    "rationale",
    "confidence",
    "riskLevel",
    "expectedOutcome",
  ],
};
