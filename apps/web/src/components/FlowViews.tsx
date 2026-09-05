/**
 * Pure presentational "narrative" views used across the demo surfaces. No hooks,
 * no next/* — safe to unit-test. These communicate the product's safety model at
 * a glance; they render no metrics, so there is nothing to fabricate.
 */
import React from "react";

/**
 * P3 — the AI boundary. Makes it visually explicit that Gemini only ADVISES; a
 * deterministic policy decides, and only the execution service can act. Gemini
 * never calls Razorpay directly.
 */
export function AiBoundaryStrip() {
  return (
    <div>
      <div className="ai-flow">
        <div className="ai-flow__node ai-flow__node--ai">
          <div className="ai-flow__title">GEMINI</div>
          <div className="ai-flow__sub">Advisory recommendation</div>
        </div>
        <span className="ai-flow__arrow" aria-hidden="true">→</span>
        <div className="ai-flow__node ai-flow__node--policy">
          <div className="ai-flow__title">DETERMINISTIC POLICY</div>
          <div className="ai-flow__sub">ALLOW · REVIEW · BLOCK</div>
        </div>
        <span className="ai-flow__arrow" aria-hidden="true">→</span>
        <div className="ai-flow__node ai-flow__node--exec">
          <div className="ai-flow__title">EXECUTION SERVICE</div>
          <div className="ai-flow__sub">Bounded action only</div>
        </div>
      </div>
      <p className="ai-flow__note">
        Gemini recommends. Policy decides. Only the execution service can act — <strong>Gemini never calls Razorpay directly</strong>.
      </p>
    </div>
  );
}

/**
 * P4 — what does and does not count as recovered revenue. Concise fintech-style
 * labels, not a wall of text.
 */
const RULES: Array<{ ok: boolean; text: string }> = [
  { ok: false, text: "Attempted recovery" },
  { ok: false, text: "Payment Link created" },
  { ok: false, text: "Provider HTTP 200" },
  { ok: true, text: "Verified successful payment" },
];

export function VerifiedRecoveryLegend() {
  return (
    <div className="rec-legend">
      {RULES.map((r) => (
        <span className={`rec-legend__item${r.ok ? " rec-legend__item--ok" : ""}`} key={r.text}>
          <span className="rec-legend__mark">{r.ok ? "✓" : "✕"}</span>
          {r.text}
        </span>
      ))}
      <span className="rec-legend__caption">= recovered revenue</span>
    </div>
  );
}
