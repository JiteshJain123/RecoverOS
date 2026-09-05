/** Executive metric card (pure). Value is pre-formatted by the caller. */
import React from "react";
import type { BadgeVariant } from "../lib/badges";

const ACCENT_BG: Record<BadgeVariant, string> = {
  neutral: "var(--muted-tint)",
  info: "var(--info-tint)",
  success: "var(--success-tint)",
  warning: "var(--warning-tint)",
  danger: "var(--danger-tint)",
  muted: "var(--muted-tint)",
};
const ACCENT_FG: Record<BadgeVariant, string> = {
  neutral: "#364152",
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  muted: "var(--text-faint)",
};

export function MetricCard({
  label,
  value,
  sub,
  icon,
  accent = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: string;
  accent?: BadgeVariant;
}) {
  return (
    <div className="card metric">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="metric__label">{label}</div>
        {icon && (
          <div className="metric__accent" style={{ background: ACCENT_BG[accent], color: ACCENT_FG[accent] }}>
            {icon}
          </div>
        )}
      </div>
      <div className="metric__value tabnum">{value}</div>
      {sub && <div className="metric__sub">{sub}</div>}
    </div>
  );
}
