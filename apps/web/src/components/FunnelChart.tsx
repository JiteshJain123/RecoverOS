/** Revenue recovery funnel (pure). Bar width scales to the largest stage. */
import React from "react";
import type { FunnelStage, MoneyMeta } from "../lib/types";
import { formatMoneyCompact } from "../lib/money";

/** Display labels that tell the recovery narrative (presentation only; counts are authoritative). */
const NARRATIVE_LABEL: Record<string, string> = {
  at_risk: "Revenue at Risk",
  eligible: "Recovery Candidates",
  approved: "Policy-Approved",
  attempted: "Attempted Recovery",
  recovered: "Verified Recoveries",
};

export function FunnelChart({ stages, money }: { stages: FunnelStage[]; money: MoneyMeta }) {
  const maxCases = Math.max(1, ...stages.map((s) => s.cases));
  return (
    <div className="funnel">
      {stages.map((stage) => {
        const pct = Math.round((stage.cases / maxCases) * 100);
        return (
          <div className={`funnel__row${stage.key === "recovered" ? " funnel__row--recovered" : ""}`} key={stage.key}>
            <div className="funnel__label">{NARRATIVE_LABEL[stage.key] ?? stage.label}</div>
            <div className="funnel__track">
              <div className="funnel__fill" style={{ width: `${Math.max(pct, stage.cases > 0 ? 6 : 0)}%` }}>
                {stage.cases > 0 ? `${stage.cases} cases` : ""}
              </div>
            </div>
            <div className="funnel__value tabnum">
              {formatMoneyCompact(stage.amountMinor, money)}
              <small>{stage.cases} cases</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}
