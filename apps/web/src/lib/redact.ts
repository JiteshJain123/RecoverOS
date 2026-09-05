/**
 * Defensive client-side redaction for anything rendered from free-form provider
 * data (e.g. audit `metadata`). The backend already withholds secrets, but audit
 * payloads are open-ended `unknown`, so we scrub secret-shaped substrings before
 * they can ever reach the DOM. Belt-and-suspenders — never the only line of
 * defense.
 */
const PATTERNS: RegExp[] = [
  /rzp_(?:live|test)_[A-Za-z0-9]+/g, // Razorpay key ids
  /Basic\s+[A-Za-z0-9+/=]{8,}/g, // base64 Basic-auth headers
  /Bearer\s+[A-Za-z0-9._-]{8,}/g, // bearer tokens
  /"?(?:key_secret|api[_-]?key|webhook[_-]?secret|authorization|secret)"?\s*[:=]\s*"?[^"\s,}]+/gi,
  /\bwhsec_[A-Za-z0-9]+/g, // webhook secrets
  /\bAIza[0-9A-Za-z_-]{10,}/g, // Google API key shape
];

/** Replace secret-shaped substrings in a string with `***`. */
export function redactString(input: string): string {
  let out = input;
  for (const p of PATTERNS) out = out.replace(p, "***");
  return out;
}

/** Redact any value (recursively) for safe display; also drops obvious secret keys. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|api[_-]?key|authorization|password|token/i.test(k)) {
        out[k] = "***";
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}

/** Pretty-print an unknown value as redacted JSON for display. */
export function redactedJson(value: unknown, space = 2): string {
  try {
    return JSON.stringify(redactValue(value), null, space);
  } catch {
    return "—";
  }
}
