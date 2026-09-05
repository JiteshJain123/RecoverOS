"use client";
import React, { useState } from "react";
import { fetchJson } from "../../src/lib/client";
import { useApi } from "../../src/lib/use-api";
import { AsyncBoundary } from "../../src/components/AsyncBoundary";
import { Card, ConfigBadge, ProbeBadge, Badge } from "../../src/components/primitives";
import type { IntegrationStatusDTO } from "../../src/lib/types";

export default function IntegrationPage() {
  const base = useApi<IntegrationStatusDTO>("/api/recoveros/integration");
  const [probed, setProbed] = useState<IntegrationStatusDTO | null>(null);
  const [probing, setProbing] = useState(false);

  const status = probed ?? base.data;

  const runProbe = async () => {
    setProbing(true);
    const { data } = await fetchJson<IntegrationStatusDTO>("/api/recoveros/integration?probe=1");
    setProbing(false);
    if (data) setProbed(data);
  };

  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Integration</h1>
        <p>Provider configuration and connectivity. Secrets are never displayed — only classified statuses.</p>
      </div>

      <div className="row gap-8">
        <button className="btn btn--primary btn--sm" onClick={runProbe} disabled={probing} type="button">
          {probing ? "Checking connectivity…" : "Run connectivity check"}
        </button>
        {status?.probed || probed ? <Badge variant="info">Live probe complete</Badge> : <Badge variant="muted">Config only</Badge>}
      </div>

      <AsyncBoundary loading={base.loading} error={base.error} data={status} onRetry={base.reload}>
        {(s) => (
          <div className="grid grid--3">
            <Card title="Gemini">
              <dl className="kv">
                <dt>Configured</dt>
                <dd><ConfigBadge status={s.gemini.config} /></dd>
                <dt>Model</dt>
                <dd className="mono">{s.gemini.model ?? "—"}</dd>
                <dt>Connectivity</dt>
                <dd><ProbeBadge status={s.gemini.connectivity} /></dd>
              </dl>
              <p className="faint mt-16" style={{ fontSize: 12 }}>
                The API key is read server-side only and is never sent to the browser.
              </p>
            </Card>

            <Card title="Razorpay">
              <dl className="kv">
                <dt>Mode</dt>
                <dd><Badge variant="info">{s.razorpay.mode ?? "—"}</Badge></dd>
                <dt>Configured</dt>
                <dd><ConfigBadge status={s.razorpay.config} /></dd>
                <dt>Connectivity</dt>
                <dd><ProbeBadge status={s.razorpay.connectivity} /></dd>
              </dl>
              <p className="faint mt-16" style={{ fontSize: 12 }}>
                Test Mode only — <span className="mono">rzp_live_*</span> keys are rejected. No real money can move.
              </p>
            </Card>

            <Card title="Webhook">
              <dl className="kv">
                <dt>Secret configured</dt>
                <dd><ConfigBadge status={s.webhook.config} /></dd>
                <dt>Verification</dt>
                <dd><Badge variant={s.webhook.config === "OK" ? "success" : "muted"}>{s.webhook.config === "OK" ? "HMAC-SHA256" : "Not configured"}</Badge></dd>
              </dl>
              <p className="faint mt-16" style={{ fontSize: 12 }}>
                Signatures are verified against the raw body. The webhook secret is never displayed or logged.
              </p>
            </Card>
          </div>
        )}
      </AsyncBoundary>

      <Card title="Configuration guidance (safe)">
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.8 }}>
          <li>Set <span className="mono">GEMINI_API_KEY</span> and <span className="mono">GEMINI_MODEL</span> (e.g. <span className="mono">gemini-3.8-flash</span>) in your server <span className="mono">.env</span>.</li>
          <li>Set <span className="mono">RAZORPAY_KEY_ID</span> (<span className="mono">rzp_test_*</span>) and <span className="mono">RAZORPAY_KEY_SECRET</span>.</li>
          <li>Set <span className="mono">RAZORPAY_WEBHOOK_SECRET</span> for signature verification.</li>
          <li>Never prefix a secret with <span className="mono">NEXT_PUBLIC_</span> — that would expose it to the browser.</li>
        </ul>
      </Card>
    </div>
  );
}
