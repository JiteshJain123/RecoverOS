/**
 * Safe provider-account → tenant mapping.
 *
 * A webhook must NEVER trust a client-supplied tenantId. Instead we map the
 * verified provider identity (`account_id` from the signed payload) to a
 * RecoverOS tenant through an explicit, configured mapping. An account with no
 * mapping is REJECTED — we never guess a tenant.
 *
 * For local/Test Mode this is a single configured account→tenant pair from env;
 * the interface lets a production multi-tenant mapping (e.g. a table keyed by
 * account id) replace it without changing the processor.
 */
import { loadEnv, type Env } from "@recoveros/config";

export interface ProviderAccountResolver {
  /** Return the tenantId for a provider account, or null if unmapped. */
  resolveTenant(accountId: string): string | null;
}

/** Static in-memory mapping (tests + simple deployments). */
export class StaticProviderAccountResolver implements ProviderAccountResolver {
  constructor(private readonly map: Record<string, string>) {}
  resolveTenant(accountId: string): string | null {
    return this.map[accountId] ?? null;
  }
}

/**
 * Env-based resolver: maps the single configured Test Mode account
 * (`RAZORPAY_WEBHOOK_ACCOUNT_ID`) to `RAZORPAY_WEBHOOK_TENANT_ID`. Everything
 * else is unmapped (rejected).
 */
export class EnvProviderAccountResolver implements ProviderAccountResolver {
  private readonly accountId: string;
  private readonly tenantId: string;

  constructor(env: Env = loadEnv()) {
    this.accountId = (env.RAZORPAY_WEBHOOK_ACCOUNT_ID ?? "").trim();
    this.tenantId = (env.RAZORPAY_WEBHOOK_TENANT_ID ?? "").trim();
  }

  resolveTenant(accountId: string): string | null {
    if (!this.accountId || !this.tenantId) return null;
    return accountId === this.accountId ? this.tenantId : null;
  }
}

/** Source of the webhook secret used for signature verification. */
export interface WebhookSecretSource {
  getSecret(): string;
}

export class EnvWebhookSecretSource implements WebhookSecretSource {
  private readonly secret: string;
  constructor(env: Env = loadEnv()) {
    this.secret = (env.RAZORPAY_WEBHOOK_SECRET ?? "").trim();
  }
  getSecret(): string {
    return this.secret;
  }
}

export class StaticWebhookSecretSource implements WebhookSecretSource {
  constructor(private readonly secret: string) {}
  getSecret(): string {
    return this.secret;
  }
}
