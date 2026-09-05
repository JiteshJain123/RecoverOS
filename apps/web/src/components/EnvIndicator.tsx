/** Demo / environment indicator (pure). Makes clear no real money is moving. */
import React from "react";
import type { EnvironmentInfo } from "../lib/types";

export function EnvIndicator({ env }: { env: EnvironmentInfo }) {
  return (
    <div className="row gap-8">
      {env.demo && (
        <span className="env-pill" title="Running against seeded data — no real money moves.">
          <span className="env-pill__dot" />
          DEMO DATA
        </span>
      )}
      <span
        className="env-pill env-pill--test"
        title={`Execution provider: ${env.executionProvider}. Razorpay runs in Test Mode only.`}
      >
        <span className="env-pill__dot" />
        {env.executionProvider === "RAZORPAY_TEST" ? "RAZORPAY TEST MODE" : "SIMULATED / TEST"}
      </span>
    </div>
  );
}
