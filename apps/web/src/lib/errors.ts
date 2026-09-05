/**
 * Map API error codes to operator-facing messages. Never leaks internals or
 * secrets — unknown codes get a safe generic message. Pure + testable.
 */
import type { ApiError } from "./types";

const MESSAGES: Record<string, string> = {
  api_unavailable: "The RecoverOS API is not reachable. Start it with `pnpm dev:api` and try again.",
  network_error: "Could not reach the RecoverOS server. Check your connection and retry.",
  tenant_context_required: "No workspace is selected. Pick a workspace from the top-right selector.",
  tenant_override_forbidden: "That request tried to override the tenant context and was blocked.",
  not_found: "We couldn't find that item in this workspace. It may belong to another tenant or no longer exist.",
  validation_error: "Some request parameters were invalid. Adjust the filters and try again.",
  forbidden: "Your role is not permitted to perform this action.",
  actor_required: "An authorized operator is required to approve this action.",
  invalid_transition: "This action can no longer be approved — its state changed (it may be expired or already handled).",
  gemini_not_configured: "Gemini is not configured. Add GEMINI_API_KEY to enable AI recommendations.",
  gemini_timeout: "Gemini timed out. This is an external connectivity issue, not a data problem.",
  gemini_request_failed: "The Gemini request failed. Please retry shortly.",
  gemini_rate_limited: "Gemini is rate-limited or the API quota is exhausted. Wait a moment and try again.",
  gemini_invalid_output: "Gemini returned output that failed validation; no action was taken.",
  razorpay_not_configured: "Razorpay Test Mode is not configured.",
  razorpay_timeout: "Razorpay timed out (external connectivity). No money moved.",
  razorpay_unreachable: "Razorpay could not be reached. No money moved.",
  internal_error: "Something went wrong on the server. No changes were made.",
  request_failed: "The request could not be completed.",
};

const GENERIC = "The request could not be completed.";

export function friendlyError(error: ApiError | null | undefined): string {
  if (!error) return GENERIC;
  return MESSAGES[error.code] ?? error.message ?? GENERIC;
}

/** A short title suited to an error state header. */
export function errorTitle(error: ApiError | null | undefined): string {
  if (!error) return "Something went wrong";
  if (error.code === "not_found") return "Not found";
  if (error.status === 401 || error.code === "tenant_context_required") return "No workspace selected";
  if (error.status === 403 || error.code === "forbidden") return "Not permitted";
  if (error.code === "api_unavailable" || error.code === "network_error") return "API unavailable";
  return "Something went wrong";
}
