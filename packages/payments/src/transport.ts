/**
 * Minimal HTTP transport abstraction so the client boundary (and tests) do not
 * depend on the global `fetch`/DOM types directly. Tests inject a mock transport
 * that returns scripted responses; production uses {@link fetchTransport}.
 */
export interface HttpResponseLike {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type HttpTransport = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** Default transport backed by the global `fetch`. */
export const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return {
    status: res.status,
    ok: res.ok,
    headers: { get: (n: string) => res.headers.get(n) },
    text: () => res.text(),
  };
};
