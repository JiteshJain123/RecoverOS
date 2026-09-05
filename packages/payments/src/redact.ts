/**
 * Defensive secret redaction. Even though the adapter never intentionally puts
 * secrets into messages/logs, these helpers scrub anything that looks like a
 * key/secret or Basic-auth header before a string could leave the process.
 */

const PATTERNS: RegExp[] = [
  /rzp_(?:live|test)_[A-Za-z0-9]+/g, // key ids
  /Basic\s+[A-Za-z0-9+/=]+/g, // base64 Basic-auth header
  /"?key_secret"?\s*[:=]\s*"?[^"\s,}]+/gi, // key_secret fields
];

/** Replace anything key/secret-like in a string with `***`. */
export function redact(input: string): string {
  let out = input;
  for (const p of PATTERNS) out = out.replace(p, "***");
  return out;
}

/** Mask a key id for safe display: `rzp_test_****`. */
export function maskKeyId(keyId: string): string {
  const m = /^(rzp_(?:live|test)_)/.exec(keyId);
  return m ? `${m[1]}****` : "****";
}
