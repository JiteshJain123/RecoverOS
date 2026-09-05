import { NextResponse } from "next/server";
import type { HealthStatus } from "@recoveros/shared";

export const dynamic = "force-dynamic";

export function GET() {
  const body: HealthStatus = {
    status: "ok",
    service: "web",
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(body);
}
