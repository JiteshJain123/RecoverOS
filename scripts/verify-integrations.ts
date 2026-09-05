/**
 * Safe development integration verification command.
 *
 *   pnpm verify:integrations
 *
 * Checks — using the EXISTING RecoverOS abstractions, never a parallel path:
 *   1. Gemini config is present (server-side only) and reports the model.
 *   2. Gemini 3.5 Flash connectivity via the AI abstraction (produces a
 *      schema-validated RecoveryPlan from a synthetic, non-financial context).
 *   3. Razorpay config is present, Test Mode, and reachable via the adapter's
 *      `verifyConnection()` health call.
 *   4. The webhook signature secret is present.
 *
 * It NEVER prints, logs, echoes, or returns any secret value — only classified
 * statuses and the non-secret model id / mode. External connectivity failures
 * (UNREACHABLE) are reported distinctly from code failures (FAILED) and use a
 * different exit code, so a network hiccup is not mistaken for a broken build.
 */
import { loadEnv } from "@recoveros/config";
import {
  GeminiRecoveryStrategyProvider,
  HttpGeminiClient,
  loadGeminiConfig,
} from "@recoveros/ai";
import { createRazorpayTestProvider } from "@recoveros/payments";
import type { RecoveryStrategyContext } from "@recoveros/strategy";
import {
  checkGeminiConfig,
  formatReport,
  runIntegrationChecks,
  verdictFor,
} from "../apps/api/src/verify-integrations";

/** A synthetic, non-financial context — proves the AI path end to end without touching real data. */
const SYNTHETIC_CONTEXT: RecoveryStrategyContext = {
  caseId: "verify_case",
  tenantId: "verify_tenant",
  caseStatus: "DETECTED",
  paymentStatus: "FAILED",
  reason: "FAILED_PAYMENT",
  rootCause: "TIMEOUT",
  severity: "MEDIUM",
  priorityScore: 40,
  amountAtRiskMinor: 500_000,
  currency: "INR",
  paymentId: "pay_verify",
  customerId: "cust_verify",
  retryCount: 0,
  hasContactChannel: true,
  hasExpiredLink: false,
  policyState: "OK",
  signals: [{ type: "FAILED_PAYMENT", severity: "MEDIUM", rootCause: "TIMEOUT", confidence: 0.9, reason: "failed" }],
};

async function main(): Promise<void> {
  const env = loadEnv();

  // Build the real Gemini probe ONLY when the key is present (server-side).
  let geminiProbe: (() => Promise<unknown>) | undefined;
  if (checkGeminiConfig(env).config === "OK") {
    const cfg = loadGeminiConfig({ env });
    const client = new HttpGeminiClient(cfg);
    const provider = new GeminiRecoveryStrategyProvider({ client, config: { deterministic: cfg.temperature === 0 } });
    // Uses the existing abstraction; returns a validated RecoveryPlan (discarded — never printed raw).
    geminiProbe = () => provider.generatePlan(SYNTHETIC_CONTEXT);
  }

  // The Razorpay adapter validates Test Mode + resolves the secret internally.
  const razorpay = createRazorpayTestProvider();
  const razorpayProbe = () => razorpay.verifyConnection({ tenantId: "verify_tenant" });

  const report = await runIntegrationChecks({ env, geminiProbe, razorpayProbe });
  for (const line of formatReport(report)) console.log(line);

  const verdict = verdictFor(report);
  if (!verdict.configOk || verdict.codeFailure) {
    console.error("\nIntegration verification FAILED (configuration or code-level error).");
    process.exit(1);
  }
  if (verdict.connectivityUnreachable) {
    console.error("\nConfiguration OK, but a provider was UNREACHABLE (external connectivity — not a code failure).");
    process.exit(3);
  }
  console.log("\nIntegration verification: OK");
}

main().catch((err: unknown) => {
  // Defensive: never leak internals; report only the error name/message shape.
  console.error(`Integration verification crashed: ${err instanceof Error ? err.name : "unknown error"}`);
  process.exit(1);
});
