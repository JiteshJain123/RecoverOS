/** Server-only helpers for the BFF route handlers. */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveWorkspace, WORKSPACE_COOKIE, type Workspace } from "./workspaces";
import type { ApiResult } from "./server";

/** Resolve the active workspace from the cookie (server-side tenant context). */
export async function currentWorkspace(): Promise<Workspace> {
  const store = await cookies();
  return resolveWorkspace(store.get(WORKSPACE_COOKIE)?.value);
}

/** Turn an ApiResult into a NextResponse, preserving status + error envelope. */
export function respond<T>(result: ApiResult<T>): NextResponse {
  if (result.ok) return NextResponse.json(result.data, { status: 200 });
  return NextResponse.json({ error: result.error }, { status: result.status || 502 });
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
