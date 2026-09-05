/** Small pure presentational primitives. No hooks, no next/* — safe to unit-test. */
import React from "react";
import type { BadgeVariant } from "../lib/badges";
import {
  caseStatusVariant,
  caseStatusLabel,
  severityVariant,
  policyVariant,
  configVariant,
  probeVariant,
} from "../lib/badges";
import type { CaseStatus, ConfigStatus, ProbeStatus, Severity } from "../lib/types";
import { humanizeToken } from "../lib/format";

export function Badge({
  variant = "neutral",
  children,
  dot = true,
}: {
  variant?: BadgeVariant;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge badge--${variant}`}>
      {dot && <span className="badge__dot" />}
      {children}
    </span>
  );
}

export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  return <Badge variant={caseStatusVariant(status)}>{caseStatusLabel(status)}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  return <Badge variant={severityVariant(severity)}>{severity ? humanizeToken(severity) : "Unknown"}</Badge>;
}

export function PolicyBadge({ decision }: { decision: string | null }) {
  return <Badge variant={policyVariant(decision)}>{decision ?? "—"}</Badge>;
}

export function ConfigBadge({ status }: { status: ConfigStatus | "OK" | "MISSING" }) {
  return <Badge variant={configVariant(status)}>{humanizeToken(status)}</Badge>;
}

export function ProbeBadge({ status }: { status: ProbeStatus }) {
  return <Badge variant={probeVariant(status)}>{humanizeToken(status)}</Badge>;
}

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? " " + className : ""}`}>
      {(title || action) && (
        <div className="card__head">
          {title && <h3 className="card__title">{title}</h3>}
          {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
        </div>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

/** Loading placeholder made of shimmer rows. */
export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack gap-8" role="status" aria-live="polite" aria-busy="true">
      <span className="faint" style={{ position: "absolute", left: -9999 }}>
        Loading…
      </span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={18} width={`${90 - i * 8}%`} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon = "🗂️",
  title,
  desc,
  action,
}: {
  icon?: string;
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="state">
      <div className="state__icon">{icon}</div>
      <div className="state__title">{title}</div>
      {desc && <div className="state__desc">{desc}</div>}
      {action && <div className="mt-16">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  desc,
  onRetry,
}: {
  title?: string;
  desc?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state state--error" role="alert">
      <div className="state__icon">⚠️</div>
      <div className="state__title">{title}</div>
      {desc && <div className="state__desc">{desc}</div>}
      {onRetry && (
        <div className="mt-16">
          <button className="btn btn--sm" onClick={onRetry} type="button">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
