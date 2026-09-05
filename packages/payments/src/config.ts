/**
 * Razorpay adapter configuration + the secure credential boundary.
 *
 * TEST MODE ONLY. Credentials must be `rzp_test_*`; a `rzp_live_*` key id is
 * rejected outright so this build can never touch real money. The API secret is
 * read through a {@link RazorpayCredentialSource} and is NEVER stored in
 * PostgreSQL, logged, serialized, or returned by any endpoint.
 *
 * For local development credentials come from environment variables
 * (`EnvRazorpayCredentialSource`); the interface is designed so a production
 * tenant-scoped secret store (e.g. a vault resolving `Tenant.secretsRef`) can
 * replace it without changing any caller.
 */
import { loadEnv, type Env } from "@recoveros/config";
import { RazorpayConfigError } from "./errors";

/** Official Razorpay REST base URL. Configured once, never scattered. */
export const RAZORPAY_BASE_URL = "https://api.razorpay.com/v1";
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface RazorpayConfig {
  baseUrl: string;
  timeoutMs: number;
}

export function defaultRazorpayConfig(overrides: Partial<RazorpayConfig> = {}): RazorpayConfig {
  return {
    baseUrl: overrides.baseUrl ?? RAZORPAY_BASE_URL,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Test-mode credentials for one tenant. The secret stays in memory only. */
export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

/** Tenant scope passed to every credential lookup and provider operation. */
export interface PaymentsTenantContext {
  tenantId: string;
}

/**
 * The secure configuration boundary: resolves a tenant's Razorpay credentials.
 * Production can implement this against a secret store; nothing above this line
 * ever handles raw secrets.
 */
export interface RazorpayCredentialSource {
  getCredentials(ctx: PaymentsTenantContext): Promise<RazorpayCredentials>;
}

/** Assert credentials are present and TEST MODE. Throws otherwise. */
export function assertTestMode(creds: { keyId: string; keySecret: string }): void {
  if (!creds.keyId || !creds.keySecret) {
    throw new RazorpayConfigError("Razorpay credentials are not configured.");
  }
  if (creds.keyId.startsWith("rzp_live_")) {
    throw new RazorpayConfigError("Live Razorpay credentials are forbidden; this build is TEST MODE only.");
  }
  if (!creds.keyId.startsWith("rzp_test_")) {
    throw new RazorpayConfigError("Razorpay key id must be a test-mode key (rzp_test_*).");
  }
}

/**
 * Env-based credential source (local development). Every tenant shares the
 * process-level test key; production replaces this with a per-tenant source.
 */
export class EnvRazorpayCredentialSource implements RazorpayCredentialSource {
  private readonly keyId: string;
  private readonly keySecret: string;

  constructor(env: Env = loadEnv()) {
    this.keyId = (env.RAZORPAY_KEY_ID ?? "").trim();
    this.keySecret = (env.RAZORPAY_KEY_SECRET ?? "").trim();
  }

  async getCredentials(_ctx: PaymentsTenantContext): Promise<RazorpayCredentials> {
    const creds = { keyId: this.keyId, keySecret: this.keySecret };
    assertTestMode(creds);
    return creds;
  }
}

/** Static credential source for tests — accepts explicit test-mode creds. */
export class StaticRazorpayCredentialSource implements RazorpayCredentialSource {
  constructor(private readonly creds: RazorpayCredentials) {
    assertTestMode(creds);
  }
  async getCredentials(_ctx: PaymentsTenantContext): Promise<RazorpayCredentials> {
    return this.creds;
  }
}
