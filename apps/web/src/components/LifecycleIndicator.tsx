/** Renders the recovery execution lifecycle for a case status (pure). */
import React from "react";
import type { CaseStatus } from "../lib/types";
import { lifecycleFor } from "../lib/lifecycle";

export function LifecycleIndicator({ status }: { status: CaseStatus }) {
  const { steps, stopReason } = lifecycleFor(status);
  return (
    <div>
      <div className="lifecycle">
        {steps.map((step, i) => (
          <React.Fragment key={step.label}>
            <span
              className={
                "lifecycle__step" +
                (step.state === "done"
                  ? " lifecycle__step--done"
                  : step.state === "current"
                    ? " lifecycle__step--current"
                    : step.state === "stopped"
                      ? " lifecycle__step--stopped"
                      : "")
              }
            >
              {step.state === "done" && "✓ "}
              {step.state === "stopped" && "✕ "}
              {step.label}
            </span>
            {i < steps.length - 1 && <span className="lifecycle__arrow">→</span>}
          </React.Fragment>
        ))}
      </div>
      {stopReason && (
        <p className="mt-8" style={{ color: "var(--danger)", fontSize: 12.5, fontWeight: 550 }}>
          {stopReason}
        </p>
      )}
    </div>
  );
}
