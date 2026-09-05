"use client";
import React, { useMemo, useState } from "react";
import { useApi } from "../../src/lib/use-api";
import { fetchJson } from "../../src/lib/client";
import { AsyncBoundary } from "../../src/components/AsyncBoundary";
import { Card, Badge, EmptyState } from "../../src/components/primitives";
import { StageTrace, SafetyCard, InvariantList, StatsGrid } from "../../src/components/FailureLabViews";
import { useToast } from "../../src/components/Toast";
import { formatMoney } from "../../src/lib/money";
import { humanizeToken } from "../../src/lib/format";
import { friendlyError } from "../../src/lib/errors";
import type { FailureScenarioListDTO, FailureScenarioMeta, FailureLabRunDTO } from "../../src/lib/types";

const GROUP_LABEL: Record<string, string> = {
  success: "Successful recovery",
  provider: "Provider behavior",
  webhook: "Webhook delivery",
  policy: "Policy & safeguards",
  ai: "AI safety",
};
const GROUP_ORDER = ["success", "provider", "webhook", "policy", "ai"];

export default function FailureLabPage() {
  const scenarios = useApi<FailureScenarioListDTO>("/api/recoveros/failure-lab/scenarios");
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<FailureLabRunDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<FailureLabRunDTO[]>([]);

  const grouped = useMemo(() => {
    const items = scenarios.data?.scenarios ?? [];
    const by: Record<string, FailureScenarioMeta[]> = {};
    for (const s of items) (by[s.group] ??= []).push(s);
    return by;
  }, [scenarios.data]);

  const runScenario = async (id: string) => {
    setSelected(id);
    setBusy(true);
    setRun(null);
    const { data, error } = await fetchJson<FailureLabRunDTO>(`/api/recoveros/failure-lab/run/${encodeURIComponent(id)}`, {
      method: "POST",
    });
    setBusy(false);
    if (error || !data) {
      toast.error("Scenario failed to run", error ? friendlyError(error) : "No data returned.");
      return;
    }
    setRun(data);
    setComparison((prev) => [data, ...prev.filter((r) => r.scenario.id !== data.scenario.id)].slice(0, 8));
  };

  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Failure Lab</h1>
        <p>
          A controlled, development-only demonstration that RecoverOS fails <strong>safely</strong> — it never claims a recovery
          that did not happen. Each scenario runs the real lifecycle against the deterministic failure harness.
        </p>
      </div>

      <div className="sim-banner">
        <Badge variant="info">DEMO · SIMULATION</Badge>
        <span>
          <strong>Test / Simulation environment.</strong> No real money moves, no live Razorpay calls, no customer messages. Runs
          use signed mock webhooks and a mock gateway transport.
        </span>
      </div>

      {/* A. Scenario selector */}
      <Card title="Scenarios">
        <AsyncBoundary
          loading={scenarios.loading}
          error={scenarios.error}
          data={scenarios.data}
          onRetry={scenarios.reload}
          isEmpty={(d) => (d.scenarios?.length ?? 0) === 0}
          empty={<EmptyState icon="🧪" title="No scenarios available" desc="The Failure Lab is only available outside production." />}
        >
          {() => (
            <div className="stack gap-16">
              {GROUP_ORDER.filter((g) => grouped[g]?.length).map((g) => (
                <div key={g}>
                  <div className="section-title">{GROUP_LABEL[g] ?? g}</div>
                  <div className="scenario-grid">
                    {(grouped[g] ?? []).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className={`scenario-card${selected === s.id ? " scenario-card--active" : ""}`}
                        onClick={() => runScenario(s.id)}
                        disabled={busy}
                      >
                        <div className="scenario-card__title">{s.title}</div>
                        <div className="scenario-card__summary">{s.summary}</div>
                        <div className="mt-8">
                          <Badge variant={s.expectsRecovery ? "success" : "muted"}>
                            {s.expectsRecovery ? "recovers revenue" : "no recovery"}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {/* B. Run action — explicitly labelled as simulation. */}
              <div className="row gap-8">
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={busy || !selected}
                  onClick={() => selected && runScenario(selected)}
                >
                  {busy ? "Running…" : "▶ Run in Test / Simulation Environment"}
                </button>
                {run && (
                  <span className="faint" style={{ fontSize: 12 }}>
                    Last run: {run.scenario.title} · {run.providerMode} · {run.mode}
                  </span>
                )}
              </div>
            </div>
          )}
        </AsyncBoundary>
      </Card>

      {busy && (
        <Card>
          <div className="faint">Running the lifecycle against the failure harness…</div>
        </Card>
      )}

      {run && !busy && <RunView run={run} />}

      {/* G. Scenario comparison */}
      {comparison.length > 0 && (
        <Card title="Scenario comparison">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th className="num">Provider calls</th>
                  <th>Final action state</th>
                  <th className="num">Recovered revenue</th>
                  <th>Safety behavior</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((r) => (
                  <tr key={r.scenario.id} style={{ cursor: "default" }}>
                    <td>{r.scenario.title}</td>
                    <td className="num tabnum">{r.stats.providerCalls}</td>
                    <td>{r.trace.action ? humanizeToken(r.trace.action.state) : humanizeToken(r.trace.finalOutcome)}</td>
                    <td className="num tabnum">
                      {r.stats.revenueCreditedMinor > 0 ? formatMoney(r.stats.revenueCreditedMinor, { currency: r.stats.currency }) : "—"}
                    </td>
                    <td>
                      <Badge variant={r.safety.tone}>{r.safety.headline}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function RunView({ run }: { run: FailureLabRunDTO }) {
  return (
    <div className="stack gap-16">
      {/* D. Safety result */}
      <SafetyCard safety={run.safety} />

      <div className="grid grid--2">
        {/* C. Live execution trace */}
        <Card title="Execution trace">
          <StageTrace stages={run.stages} />
        </Card>

        <div className="stack gap-16">
          {/* E. Security invariants */}
          <Card title="Security invariants (verified this run)">
            <InvariantList invariants={run.invariants} />
          </Card>

          {/* Provider calls made (safe: method + path only) */}
          <Card title="Provider calls (method + path only)">
            {run.providerRequests.length === 0 ? (
              <div className="faint">No provider calls were made in this run.</div>
            ) : (
              <div className="stack gap-8">
                {run.providerRequests.map((r, i) => (
                  <div key={i} className="mono" style={{ fontSize: 12 }}>
                    <Badge variant="neutral">{r.method}</Badge> {r.path}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* F. Failure statistics */}
      <Card title="Failure statistics (this run)">
        <StatsGrid stats={run.stats} />
      </Card>

      {run.passes.length > 1 && (
        <Card title="Execution passes">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Pass</th>
                  <th>Final outcome</th>
                  <th className="num">Provider calls</th>
                  <th className="num">Recovered</th>
                  <th>Duplicate prevented</th>
                </tr>
              </thead>
              <tbody>
                {run.passes.map((p, i) => (
                  <tr key={i} style={{ cursor: "default" }}>
                    <td>{p.label}</td>
                    <td>{humanizeToken(p.finalOutcome)}</td>
                    <td className="num tabnum">{p.providerCallsDelta}</td>
                    <td className="num tabnum">{p.recoveredRevenueMinor > 0 ? formatMoney(p.recoveredRevenueMinor, { currency: run.stats.currency }) : "—"}</td>
                    <td>{p.duplicatePrevented ? "Yes" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* I. Audit integration — development/simulation events. */}
      <Card title="Development audit trail (simulation)">
        <p className="faint" style={{ fontSize: 12, marginBottom: 10 }}>
          These audit events were produced by the run and are labelled as development/simulation records — never production events.
        </p>
        {run.auditEvents.length === 0 ? (
          <div className="faint">No audit events recorded.</div>
        ) : (
          <div className="pill-row">
            {run.auditEvents.map((a, i) => (
              <span className="stage-chip" key={i}>
                {a}
              </span>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
