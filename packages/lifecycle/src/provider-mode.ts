/**
 * Execution-provider selection — SERVER-SIDE ONLY.
 *
 * The recovery lifecycle can execute through two providers:
 *   - SIMULATED     — the deterministic simulator (always available; used for
 *                     evaluation and when Razorpay is not configured/enabled).
 *   - RAZORPAY_TEST — the real Razorpay TEST MODE adapter.
 *
 * SECURITY INVARIANT: Gemini (or any strategy provider) can NEVER choose the
 * execution provider. Selection is a pure function of server configuration and
 * falls back SAFELY to SIMULATED unless RAZORPAY_TEST is explicitly enabled AND
 * test credentials are present AND a Razorpay provider was supplied.
 */
import { loadEnv, type Env } from "@recoveros/config";
import type { PaymentRecoveryProvider } from "@recoveros/execution";

export type ExecutionProviderMode = "SIMULATED" | "RAZORPAY_TEST";

export interface ProviderSelectionConfig {
  mode: ExecutionProviderMode;
  razorpayTestEnabled: boolean;
  hasRazorpayCredentials: boolean;
}

export function resolveProviderSelectionFromEnv(env: Env = loadEnv()): ProviderSelectionConfig {
  return {
    mode: env.EXECUTION_PROVIDER,
    razorpayTestEnabled: env.RAZORPAY_TEST_ENABLED,
    hasRazorpayCredentials: Boolean((env.RAZORPAY_KEY_ID ?? "").trim() && (env.RAZORPAY_KEY_SECRET ?? "").trim()),
  };
}

export interface SelectProviderDeps {
  simulated: PaymentRecoveryProvider;
  /** Built by the caller only when credentials exist. */
  razorpay?: PaymentRecoveryProvider;
}

export interface SelectedProvider {
  provider: PaymentRecoveryProvider;
  mode: ExecutionProviderMode;
  /** Why this mode was chosen (for audit/observability). */
  reason: string;
}

/**
 * Deterministically choose the execution provider. RAZORPAY_TEST requires an
 * explicit enable flag, present credentials, and an available adapter; any gate
 * failing falls back to SIMULATED (never an error, never a live call).
 */
export function selectExecutionProvider(
  cfg: ProviderSelectionConfig,
  deps: SelectProviderDeps,
): SelectedProvider {
  if (cfg.mode === "RAZORPAY_TEST") {
    if (!cfg.razorpayTestEnabled) return { provider: deps.simulated, mode: "SIMULATED", reason: "razorpay_test_not_enabled" };
    if (!cfg.hasRazorpayCredentials) return { provider: deps.simulated, mode: "SIMULATED", reason: "missing_credentials" };
    if (!deps.razorpay) return { provider: deps.simulated, mode: "SIMULATED", reason: "razorpay_provider_unavailable" };
    return { provider: deps.razorpay, mode: "RAZORPAY_TEST", reason: "enabled" };
  }
  return { provider: deps.simulated, mode: "SIMULATED", reason: "configured" };
}
