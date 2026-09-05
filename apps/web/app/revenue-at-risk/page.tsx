"use client";
import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "../../src/lib/use-api";
import { toQuery } from "../../src/lib/client";
import { AsyncBoundary } from "../../src/components/AsyncBoundary";
import { Card, CaseStatusBadge, SeverityBadge, Badge } from "../../src/components/primitives";
import { DataTable, type Column } from "../../src/components/DataTable";
import { formatMoney } from "../../src/lib/money";
import { formatRelative, humanizeToken } from "../../src/lib/format";
import { priorityVariant } from "../../src/lib/badges";
import type { CaseListDTO, CaseListItemDTO, CaseSort } from "../../src/lib/types";

const SEVERITIES = ["", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUSES = ["", "DETECTED", "ANALYZING", "PROPOSED", "PENDING_APPROVAL", "AUTHORIZED", "EXECUTING", "RECOVERED", "FAILED", "BLOCKED", "REJECTED", "EXPIRED"];
const ROOT_CAUSES = ["", "BANK_DECLINE", "INSUFFICIENT_FUNDS", "TIMEOUT", "GATEWAY_ERROR", "CUSTOMER_ABANDONMENT", "EXPIRED_CHECKOUT", "UNKNOWN"];

interface Filters {
  severity: string;
  status: string;
  rootCause: string;
  minAmountMajor: string;
  minPriority: string;
  from: string;
  to: string;
  sort: CaseSort;
  page: number;
}

const INITIAL: Filters = { severity: "", status: "", rootCause: "", minAmountMajor: "", minPriority: "", from: "", to: "", sort: "priority", page: 1 };

export default function RevenueAtRiskPage() {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(INITIAL);

  const path = useMemo(() => {
    const minAmountMinor = filters.minAmountMajor ? Math.round(Number(filters.minAmountMajor) * 100) : undefined;
    return (
      "/api/recoveros/cases" +
      toQuery({
        severity: filters.severity || undefined,
        status: filters.status || undefined,
        rootCause: filters.rootCause || undefined,
        minAmountMinor: Number.isFinite(minAmountMinor) ? minAmountMinor : undefined,
        minPriority: filters.minPriority || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        sort: filters.sort,
        page: filters.page,
        pageSize: 20,
      })
    );
  }, [filters]);

  const { data, error, loading, reload } = useApi<CaseListDTO>(path);
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));

  const columns: Array<Column<CaseListItemDTO>> = [
    { key: "customer", header: "Customer / Payment", render: (c) => (
      <div>
        <div className="mono">{c.customerId ?? "—"}</div>
        <div className="faint" style={{ fontSize: 11.5 }}>{c.paymentId ?? "—"}</div>
      </div>
    ) },
    { key: "amount", header: "Amount", align: "right", render: (c) => <strong>{formatMoney(c.amountAtRiskMinor, { currency: c.currency })}</strong> },
    { key: "reason", header: "Failure reason", render: (c) => humanizeToken(c.reason) },
    { key: "rootCause", header: "Root cause", render: (c) => <Badge variant="neutral">{humanizeToken(c.rootCause)}</Badge> },
    { key: "severity", header: "Severity", render: (c) => <SeverityBadge severity={c.severity} /> },
    { key: "priority", header: "Priority", align: "right", render: (c) => <Badge variant={priorityVariant(c.priorityScore)}>{c.priorityScore ?? "—"}</Badge> },
    { key: "status", header: "Status", render: (c) => <CaseStatusBadge status={c.status} /> },
    { key: "activity", header: "Last activity", render: (c) => <span className="faint">{formatRelative(c.lastDetectedAt ?? c.openedAt)}</span> },
  ];

  return (
    <div className="stack gap-16">
      <div className="page-head">
        <h1>Revenue at Risk</h1>
        <p>Every open recovery case for this workspace, with the intelligence behind it.</p>
      </div>

      <Card title="Filters">
        <div className="filter-bar">
          <Field label="Severity"><Select value={filters.severity} onChange={(v) => set({ severity: v })} options={SEVERITIES} /></Field>
          <Field label="Status"><Select value={filters.status} onChange={(v) => set({ status: v })} options={STATUSES} /></Field>
          <Field label="Root cause"><Select value={filters.rootCause} onChange={(v) => set({ rootCause: v })} options={ROOT_CAUSES} /></Field>
          <Field label="Min amount (₹)"><input className="input" style={{ width: 120 }} inputMode="numeric" value={filters.minAmountMajor} onChange={(e) => set({ minAmountMajor: e.target.value.replace(/[^0-9]/g, "") })} placeholder="0" /></Field>
          <Field label="Min priority"><input className="input" style={{ width: 100 }} inputMode="numeric" value={filters.minPriority} onChange={(e) => set({ minPriority: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) })} placeholder="0-100" /></Field>
          <Field label="From"><input className="input" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} /></Field>
          <Field label="To"><input className="input" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} /></Field>
          <Field label="Sort"><Select value={filters.sort} onChange={(v) => set({ sort: v as CaseSort })} options={["priority", "amount", "recent"]} /></Field>
          <button className="btn btn--sm" onClick={() => setFilters(INITIAL)} type="button">Reset</button>
        </div>
      </Card>

      <Card
        title="Recovery cases"
        action={data ? <span className="faint">{data.total} total · page {data.page}/{data.totalPages || 1}</span> : null}
      >
        <AsyncBoundary
          loading={loading}
          error={error}
          data={data}
          onRetry={reload}
          isEmpty={(d) => d.items.length === 0}
          empty={<div className="faint" style={{ padding: 20, textAlign: "center" }}>No cases match these filters.</div>}
        >
          {(d) => (
            <>
              <DataTable columns={columns} rows={d.items} rowKey={(c) => c.id} onRowClick={(c) => router.push(`/cases/${c.id}`)} />
              <Pagination page={d.page} totalPages={d.totalPages} onPage={(p) => setFilters((f) => ({ ...f, page: p }))} />
            </>
          )}
        </AsyncBoundary>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}
function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o === "" ? "All" : humanizeToken(o)}
        </option>
      ))}
    </select>
  );
}
function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="row gap-8 mt-16" style={{ justifyContent: "flex-end" }}>
      <button className="btn btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)} type="button">← Prev</button>
      <span className="faint tabnum">Page {page} / {totalPages}</span>
      <button className="btn btn--sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)} type="button">Next →</button>
    </div>
  );
}
