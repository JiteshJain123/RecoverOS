/** Small, dependency-free display helpers (dates, relative time, labels). */

/** Absolute timestamp, e.g. "04 Sep 2026, 12:00". Invalid input → "—". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(d);
}

/** Date only, e.g. "04 Sep". */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(d);
}

/**
 * Relative time from `now` (default Date.now). Deterministic when `now` is
 * supplied, which the tests rely on.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffMs = now - t;
  const abs = Math.abs(diffMs);
  const past = diffMs >= 0;
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return past ? `${n}${label} ago` : `in ${n}${label}`;
    }
  }
  return "just now";
}

/** Turn an ENUM_LIKE_TOKEN into "Enum like token" (Title case first word). */
export function humanizeToken(token: string | null | undefined): string {
  if (!token) return "—";
  const lower = token.replace(/[_.]+/g, " ").trim().toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
