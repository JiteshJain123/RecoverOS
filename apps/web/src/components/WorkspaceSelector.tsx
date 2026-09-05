"use client";
/**
 * Workspace selector. The browser only ever picks a workspace KEY from a fixed
 * allowlist; the server maps it to a tenantId. Selecting writes the workspace
 * cookie and reloads so all server-side fetches use the new tenant context.
 * There is no free-text tenantId input — tenant isolation stays server-side.
 */
import React, { useState } from "react";
import { WORKSPACES, WORKSPACE_COOKIE, DEFAULT_WORKSPACE, type Workspace } from "../lib/workspaces";

export function WorkspaceSelector({ activeKey }: { activeKey: string }) {
  const [open, setOpen] = useState(false);
  const active = WORKSPACES.find((w) => w.key === activeKey) ?? DEFAULT_WORKSPACE;

  const select = (ws: Workspace) => {
    document.cookie = `${WORKSPACE_COOKIE}=${encodeURIComponent(ws.key)}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload();
  };

  return (
    <div className="ws">
      <button className="ws__button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="ws__avatar">{active.name.charAt(0)}</span>
        <span className="ws__name">{active.name}</span>
        <span className="faint">▾</span>
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setOpen(false)} />
          <div className="ws__menu" role="listbox">
            <div className="ws__hint">Workspace (tenant is resolved server-side)</div>
            {WORKSPACES.map((ws) => (
              <button
                key={ws.key}
                className={`ws__option${ws.key === active.key ? " ws__option--active" : ""}`}
                role="option"
                aria-selected={ws.key === active.key}
                onClick={() => select(ws)}
              >
                <span className="ws__avatar">{ws.name.charAt(0)}</span>
                <span>
                  <div style={{ fontWeight: 600 }}>{ws.name}</div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {ws.key}
                  </div>
                </span>
                {ws.key === active.key && <span style={{ marginLeft: "auto", color: "var(--brand)" }}>✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
