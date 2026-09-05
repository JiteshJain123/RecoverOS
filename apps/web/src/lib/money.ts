/**
 * Integer-safe money formatting for minor-unit amounts.
 *
 * All backend amounts are integers in MINOR currency units (e.g. paise). We
 * NEVER do floating-point arithmetic on money: the major/fraction split is done
 * with integer operations, and only the (exact) integer major part is passed to
 * Intl for digit grouping. This guarantees the displayed value equals the stored
 * minor-unit amount exactly.
 */
import type { MoneyMeta } from "./types";

function localeFor(currency: string): string {
  return currency === "INR" ? "en-IN" : "en-US";
}

/** The currency symbol for a code (e.g. INR → ₹), via Intl, with a safe fallback. */
export function currencySymbol(currency: string): string {
  try {
    const parts = new Intl.NumberFormat(localeFor(currency), {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
    }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

export interface FormatMoneyOptions {
  currency?: string;
  exponent?: number;
  /** Show the currency symbol (default true). */
  symbol?: boolean;
}

/**
 * Format an integer minor-unit amount as a human-readable currency string.
 * Example: formatMoney(34116900, { currency: "INR" }) → "₹3,41,169.00".
 */
export function formatMoney(minor: number, options: FormatMoneyOptions | MoneyMeta = {}): string {
  const currency = "currency" in options && options.currency ? options.currency : "INR";
  const exponent = "exponent" in options && typeof options.exponent === "number" ? options.exponent : 2;
  const showSymbol = "symbol" in options && typeof options.symbol === "boolean" ? options.symbol : true;

  const safeMinor = Number.isFinite(minor) ? Math.round(minor) : 0;
  const negative = safeMinor < 0;
  const abs = Math.abs(safeMinor);
  const base = 10 ** exponent;

  // Fully integer-safe decomposition — no float division of money.
  const fraction = abs % base;
  const major = (abs - fraction) / base;

  const groupedMajor = new Intl.NumberFormat(localeFor(currency)).format(major);
  const fractionStr = exponent > 0 ? "." + String(fraction).padStart(exponent, "0") : "";
  const symbol = showSymbol ? currencySymbol(currency) : "";
  return `${negative ? "-" : ""}${symbol}${groupedMajor}${fractionStr}`;
}

/**
 * Compact form for dense dashboards (e.g. ₹3.4L / ₹1.2Cr for INR, ₹34.1K
 * otherwise). Uses integer thresholds; only the label division is approximate
 * (display-only), never the underlying stored amount.
 */
export function formatMoneyCompact(minor: number, meta: MoneyMeta | FormatMoneyOptions = {}): string {
  const currency = "currency" in meta && meta.currency ? meta.currency : "INR";
  const exponent = "exponent" in meta && typeof meta.exponent === "number" ? meta.exponent : 2;
  const symbol = currencySymbol(currency);
  const base = 10 ** exponent;
  const majorUnits = Math.round(minor / base); // display-only rounding

  const fmt = (n: number, suffix: string) => `${symbol}${(n).toFixed(n < 10 ? 1 : 0)}${suffix}`;
  const abs = Math.abs(majorUnits);
  const sign = majorUnits < 0 ? "-" : "";
  if (currency === "INR") {
    if (abs >= 10_000_000) return sign + fmt(abs / 10_000_000, "Cr");
    if (abs >= 100_000) return sign + fmt(abs / 100_000, "L");
    if (abs >= 1_000) return sign + fmt(abs / 1_000, "K");
    return `${symbol}${abs}`;
  }
  if (abs >= 1_000_000) return sign + fmt(abs / 1_000_000, "M");
  if (abs >= 1_000) return sign + fmt(abs / 1_000, "K");
  return `${symbol}${abs}`;
}

/** Format a 0..1 ratio as a percentage string; null → "—". */
export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(digits)}%`;
}
