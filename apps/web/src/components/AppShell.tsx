"use client";
import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { EnvIndicator } from "./EnvIndicator";
import { ToastProvider } from "./Toast";
import { titleFor } from "../lib/nav";
import type { EnvironmentInfo } from "../lib/types";
import { fetchJson } from "../lib/client";

export function AppShell({
  activeWorkspaceKey,
  env,
  children,
}: {
  activeWorkspaceKey: string;
  env: EnvironmentInfo;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<number | undefined>(undefined);

  // Best-effort badge count; silently ignored if the API is unavailable.
  useEffect(() => {
    let alive = true;
    void fetchJson<{ items: unknown[] }>("/api/recoveros/approvals").then((r) => {
      if (alive && r.data) setPendingApprovals(r.data.items.length);
    });
    return () => {
      alive = false;
    };
  }, [pathname, activeWorkspaceKey]);

  // Close the mobile drawer on navigation.
  useEffect(() => setSidebarOpen(false), [pathname]);

  return (
    <ToastProvider>
      <div className="shell">
        <Sidebar open={sidebarOpen} pendingApprovals={pendingApprovals} />
        <div className="main">
          <header className="header">
            <button
              className="btn btn--ghost btn--sm menu-toggle"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label="Toggle navigation"
            >
              ☰
            </button>
            <div className="header__title">{titleFor(pathname)}</div>
            <div className="header__spacer" />
            <EnvIndicator env={env} />
            <WorkspaceSelector activeKey={activeWorkspaceKey} />
            <div className="ws__avatar" title="Signed in as dev-operator (APPROVER)" style={{ borderRadius: "50%" }}>
              OP
            </div>
          </header>
          <main className="content">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
