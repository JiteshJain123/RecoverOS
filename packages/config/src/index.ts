/**
 * @recoveros/config
 *
 * Centralized, validated environment configuration. Every service loads its
 * config through `loadEnv()` so that missing/invalid variables fail fast and
 * loudly rather than surfacing as confusing runtime errors later.
 *
 * Secrets are intentionally OPTIONAL at this scaffold stage because the
 * features that consume them (AI, Razorpay, DB access) are not implemented
 * yet. As those phases land, tighten the relevant fields to `.min(1)`.
 */
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_PORT: z.coerce.number().int().positive().default(3000),

  // Consumed in later phases — optional for now.
  DATABASE_URL: z.string().url().optional(),

  // Google Gemini is the AI provider (integration not implemented yet).
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Test Mode webhook account→tenant mapping. A webhook is trusted only if its
  // provider `account_id` matches RAZORPAY_WEBHOOK_ACCOUNT_ID; it is then mapped
  // to RAZORPAY_WEBHOOK_TENANT_ID. An unmapped account is rejected (never guessed).
  RAZORPAY_WEBHOOK_ACCOUNT_ID: z.string().optional(),
  RAZORPAY_WEBHOOK_TENANT_ID: z.string().optional(),

  // Execution provider selection — SERVER-SIDE ONLY. Gemini can never choose the
  // provider. Defaults to the deterministic simulator. RAZORPAY_TEST is only
  // effective when test credentials exist AND it is explicitly enabled.
  EXECUTION_PROVIDER: z.enum(["SIMULATED", "RAZORPAY_TEST"]).default("SIMULATED"),
  RAZORPAY_TEST_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate environment variables. Throws a descriptive error if
 * validation fails. Call once at process startup.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
