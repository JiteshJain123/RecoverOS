/**
 * Typed errors for the webhook pipeline. Each carries a stable `code` used in
 * audit records and HTTP envelopes. None ever contain secrets.
 */
export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Signature verification failed — the request is not trusted. */
export class WebhookSignatureError extends WebhookError {
  constructor() {
    super("Webhook signature verification failed.", "invalid_signature");
  }
}

/** The body was not valid JSON or did not match the expected event envelope. */
export class WebhookPayloadError extends WebhookError {
  constructor(message = "Webhook payload is invalid.") {
    super(message, "invalid_payload");
  }
}

/** The provider account is not mapped to any RecoverOS tenant. */
export class UnmappedAccountError extends WebhookError {
  constructor() {
    super("Provider account is not mapped to a tenant.", "unmapped_account");
  }
}
