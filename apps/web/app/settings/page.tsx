"use client";
import React from "react";
import { Card, Badge } from "../../src/components/primitives";

export default function SettingsPage() {
  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Settings</h1>
        <p>Workspace, safety, and access information for this deployment.</p>
      </div>

      <div className="grid grid--2">
        <Card title="Workspace & tenant isolation">
          <p className="muted" style={{ fontSize: 13 }}>
            The active workspace is chosen from the top-right selector. The tenant id is resolved{" "}
            <strong>server-side</strong> from a fixed allowlist and injected into every API call as{" "}
            <span className="mono">x-tenant-id</span>. The browser can never set or override a tenant id, so a user cannot
            read another tenant&apos;s data.
          </p>
        </Card>

        <Card title="Safety">
          <div className="pill-row mb-16">
            <Badge variant="info">Razorpay Test Mode</Badge>
            <Badge variant="success">No real money</Badge>
            <Badge variant="success">No real customer messages</Badge>
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Gemini is advisory only and can never execute a money action. Execution runs through policy → approval →
            safeguards → the selected provider (Simulated or Razorpay Test). Live Mode is disabled.
          </p>
        </Card>

        <Card title="Roles (RBAC)">
          <div className="pill-row">
            {["OWNER", "ADMIN", "APPROVER", "ANALYST", "VIEWER"].map((r) => (
              <Badge key={r} variant="neutral">
                {r}
              </Badge>
            ))}
          </div>
          <p className="muted mt-16" style={{ fontSize: 13 }}>
            Approvals require an authorized role. Until production auth lands, the dev operator acts as{" "}
            <span className="mono">APPROVER</span>, injected server-side.
          </p>
        </Card>

        <Card title="Documentation">
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
            <li><span className="mono">docs/ARCHITECTURE.md</span> — system design</li>
            <li><span className="mono">docs/RAZORPAY_INTEGRATION.md</span> — provider boundary & accounting</li>
            <li><span className="mono">docs/POLICY_EXECUTION.md</span> — policy gate & safeguards</li>
            <li><span className="mono">docs/WEBHOOKS.md</span> — signature verification & reconciliation</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
