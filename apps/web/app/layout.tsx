import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";
import { AppShell } from "../src/components/AppShell";
import { resolveWorkspace, WORKSPACE_COOKIE } from "../src/lib/workspaces";
import type { EnvironmentInfo } from "../src/lib/types";

export const metadata = {
  title: "RecoverOS — Revenue Recovery Operating System",
  description:
    "Detect revenue at risk, generate AI-assisted recovery strategies, enforce policy, and recover revenue safely.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Tenant context is derived server-side from the workspace cookie (a key from a
  // fixed allowlist), never from a user-supplied tenantId.
  const store = await cookies();
  const ws = resolveWorkspace(store.get(WORKSPACE_COOKIE)?.value);
  const provider = process.env.EXECUTION_PROVIDER === "RAZORPAY_TEST" ? "RAZORPAY_TEST" : "SIMULATED";

  const env: EnvironmentInfo = {
    workspace: ws.name,
    workspaceKey: ws.key,
    demo: true,
    nodeEnv: process.env.NODE_ENV ?? "development",
    executionProvider: provider,
  };

  return (
    <html lang="en">
      <body>
        <AppShell activeWorkspaceKey={ws.key} env={env}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
