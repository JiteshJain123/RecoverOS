/**
 * SERVER-ONLY API client. Used exclusively by the BFF route handlers under
 * `app/api/recoveros/*`; never imported into a client component.
 *
 * It is the single place that talks to the Express API. It injects the tenant
 * context server-side (`x-tenant-id`) from the resolved workspace, so the
 * browser never chooses a tenantId. Read endpoints use the header form; the
 * dev-only write endpoints (approval) take the tenantId in the path and the
 * actor via `x-user-*` headers — all injected here, server-side.
 */
import { resolveWorkspace, type Workspace } from "./workspaces";

const API_BASE = (process.env.RECOVEROS_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** The dev actor used for approvals until real auth lands (server-side only). */
const DEV_ACTOR = {
  userId: process.env.RECOVEROS_DEV_USER_ID ?? "dev-operator",
  role: process.env.RECOVEROS_DEV_USER_ROLE ?? "APPROVER",
};

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: { code: string; message: string } | null;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toResult<T>(res: Response, body: unknown): ApiResult<T> {
  if (res.ok) return { ok: true, status: res.status, data: body as T, error: null };
  const envelope = body as { error?: { code?: string; message?: string } } | null;
  const code = envelope?.error?.code ?? "request_failed";
  // Never surface raw internals to the client; keep messages operator-safe.
  const message = envelope?.error?.message ?? "The request could not be completed.";
  return { ok: false, status: res.status, data: null, error: { code, message } };
}

/** GET a tenant-scoped read endpoint (`x-tenant-id` header injected). */
export async function apiGetTenant<T>(ws: Workspace, path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { "x-tenant-id": ws.tenantId, accept: "application/json" },
      cache: "no-store",
    });
    return toResult<T>(res, await parseJson(res));
  } catch {
    return { ok: false, status: 503, data: null, error: { code: "api_unavailable", message: "The RecoverOS API is unavailable." } };
  }
}

/** GET a non-tenant dev endpoint (e.g. integration status). */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" }, cache: "no-store" });
    return toResult<T>(res, await parseJson(res));
  } catch {
    return { ok: false, status: 503, data: null, error: { code: "api_unavailable", message: "The RecoverOS API is unavailable." } };
  }
}

/**
 * Approve a recovery action via the authoritative backend approval endpoint.
 * The actor (role/user) is injected server-side; the browser can NOT set it.
 */
export async function apiApproveAction<T>(ws: Workspace, actionId: string): Promise<ApiResult<T>> {
  const path = `/dev/tenants/${encodeURIComponent(ws.tenantId)}/recovery-actions/${encodeURIComponent(actionId)}/approve`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-user-id": DEV_ACTOR.userId,
        "x-user-role": DEV_ACTOR.role,
      },
      body: JSON.stringify({ approve: true }),
      cache: "no-store",
    });
    return toResult<T>(res, await parseJson(res));
  } catch {
    return { ok: false, status: 503, data: null, error: { code: "api_unavailable", message: "The RecoverOS API is unavailable." } };
  }
}

/** POST a Gemini recommendation for a case (advisory; never executes). */
export async function apiRecommend<T>(ws: Workspace, caseId: string): Promise<ApiResult<T>> {
  const path = `/dev/tenants/${encodeURIComponent(ws.tenantId)}/recovery-cases/${encodeURIComponent(caseId)}/recommend`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      cache: "no-store",
    });
    return toResult<T>(res, await parseJson(res));
  } catch {
    return { ok: false, status: 503, data: null, error: { code: "api_unavailable", message: "The RecoverOS API is unavailable." } };
  }
}

/** Run the deterministic end-to-end lifecycle batch (dev-only). Never real money. */
export async function apiLifecycleBatch<T>(ws: Workspace): Promise<ApiResult<T>> {
  const path = `/dev/tenants/${encodeURIComponent(ws.tenantId)}/recovery/lifecycle-batch`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      cache: "no-store",
    });
    return toResult<T>(res, await parseJson(res));
  } catch {
    return { ok: false, status: 503, data: null, error: { code: "api_unavailable", message: "The RecoverOS API is unavailable." } };
  }
}

/** List the development-only Failure Lab scenarios (non-tenant, dev-only). */
export async function apiListFailureScenarios<T>(): Promise<ApiResult<T>> {
  return apiGet<T>("/dev/failure-lab/scenarios");
}

/**
 * Fetch the deterministic safety report (each guarantee backed by a real
 * failure-lab run). Tenant injected server-side. Development-only simulation.
 */
export async function apiEvaluationSafetyReport<T>(ws: Workspace): Promise<ApiResult<T>> {
  return apiGetTenant<T>(ws, `/dev/tenants/${encodeURIComponent(ws.tenantId)}/evaluation/safety-report`);
}

/**
 * Run a single Failure Lab scenario (development-only simulation). The tenant is
 * injected server-side; the browser only names a scenario from the fixed
 * catalogue. Never touches Live Mode or real money.
 */
export async function apiRunFailureScenario<T>(ws: Workspace, scenarioId: string): Promise<ApiResult<T>> {
  const path = `/dev/tenants/${encodeURIComponent(ws.tenantId)}/failure-lab/${encodeURIComponent(scenarioId)}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
      cache: "no-store",
    });
    return toResult<T>(res, await parseJson(res));
  } catch {
    return { ok: false, status: 503, data: null, error: { code: "api_unavailable", message: "The RecoverOS API is unavailable." } };
  }
}

export { resolveWorkspace };
export { API_BASE };
