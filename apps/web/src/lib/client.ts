/**
 * Browser-side fetch helper. Client components call the same-origin BFF
 * (`/api/recoveros/*`) which proxies to the API with the server-injected tenant
 * context. This never talks to the Express API directly and never sees a tenantId.
 */
import type { ApiError } from "./types";

export interface FetchState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
}

/** Fetch JSON from the BFF, returning a normalized {data|error}. */
export async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ data: T | null; error: ApiError | null }> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const envelope = body as { error?: { code?: string; message?: string } } | null;
      return {
        data: null,
        error: {
          status: res.status,
          code: envelope?.error?.code ?? "request_failed",
          message: envelope?.error?.message ?? "The request could not be completed.",
        },
      };
    }
    return { data: body as T, error: null };
  } catch {
    return { data: null, error: { status: 0, code: "network_error", message: "Could not reach the RecoverOS server." } };
  }
}

/** Build a query string from a filters object (skips empty values). */
export function toQuery(params: Record<string, string | number | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}
