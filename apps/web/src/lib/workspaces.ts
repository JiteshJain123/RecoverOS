/**
 * Server-side workspace → tenant mapping (tenant isolation boundary).
 *
 * The browser NEVER sends a tenantId. It may only select a workspace by KEY
 * from this fixed allowlist; the server resolves the key to the real tenantId
 * and injects it as the `x-tenant-id` header when calling the API. An unknown or
 * absent key falls back to the default workspace. This preserves backend tenant
 * isolation — a user can never fetch an arbitrary tenant by editing a field.
 *
 * This mirrors the seeded dev tenants (`prisma/seed.ts`). Real auth will replace
 * this with the authenticated principal's tenant, unchanged for the UI.
 */
export interface Workspace {
  key: string;
  name: string;
  tenantId: string;
}

const ACME: Workspace = { key: "acme-store", name: "Acme Store", tenantId: "seed_tenant_1" };
const GLOBEX: Workspace = { key: "globex-digital", name: "Globex Digital", tenantId: "seed_tenant_2" };

export const WORKSPACES: readonly Workspace[] = [ACME, GLOBEX];

export const DEFAULT_WORKSPACE: Workspace = ACME;

/** The cookie the workspace selector writes; read server-side by the BFF. */
export const WORKSPACE_COOKIE = "recoveros_ws";

/** Resolve a (possibly untrusted) workspace key to a known workspace. */
export function resolveWorkspace(key: string | null | undefined): Workspace {
  const found = WORKSPACES.find((w) => w.key === key);
  return found ?? DEFAULT_WORKSPACE;
}
