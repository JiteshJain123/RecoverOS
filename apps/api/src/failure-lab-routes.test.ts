/**
 * HTTP-level tests for the development-only Failure Lab router, with an emphasis
 * on PRODUCTION PROTECTION: the endpoints must be impossible to reach in a
 * production configuration — not merely hidden in the UI.
 *
 * Responses are dynamic JSON, so `any` is intentionally permitted here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createFailureLabRouter } from "./failure-lab-routes";

function mountApp(enableDevEndpoints: boolean): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createFailureLabRouter({ enableDevEndpoints }));
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("failure-lab routes — enabled (development)", () => {
  let server: Server;
  let base: string;

  before(async () => {
    ({ server, base } = await listen(mountApp(true)));
  });
  after(() => server.close());

  it("lists the scenario catalogue", async () => {
    const res = await fetch(`${base}/dev/failure-lab/scenarios`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.mode, "development");
    assert.equal(body.simulation, true);
    assert.equal(body.scenarios.length, 17);
  });

  it("runs a scenario and returns a safe, derived result", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/failure-lab/successful_recovery`, { method: "POST" });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.mode, "development");
    assert.equal(body.stats.revenueCreditedMinor, 500_000);
    assert.equal(body.safety.credited, true);
    assert.equal(body.stages.length, 11);
  });

  it("rejects an unknown scenario with 404", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/failure-lab/not_a_scenario`, { method: "POST" });
    assert.equal(res.status, 404);
    const body: any = await res.json();
    assert.equal(body.error.code, "not_found");
  });

  it("never leaks a secret in a scenario run response", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/failure-lab/duplicate_webhook`, { method: "POST" });
    const text = await res.text();
    assert.ok(!text.includes("whsec_"), "webhook secret prefix must never appear");
    assert.ok(!text.toLowerCase().includes("keysecret"));
  });

  it("returns the evaluation safety report with every guarantee holding", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/evaluation/safety-report`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.allHold, true);
    assert.ok(body.evidence.length >= 9);
    assert.ok(body.evidence.every((e: any) => e.holds === true));
  });
});

describe("failure-lab routes — disabled (not mounted)", () => {
  let server: Server;
  let base: string;

  before(async () => {
    ({ server, base } = await listen(mountApp(false)));
  });
  after(() => server.close());

  it("does not expose the scenario list when dev endpoints are off", async () => {
    const res = await fetch(`${base}/dev/failure-lab/scenarios`);
    assert.equal(res.status, 404); // route was never registered
  });

  it("does not expose the run endpoint when dev endpoints are off", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/failure-lab/successful_recovery`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});

describe("failure-lab routes — production guard (defence in depth)", () => {
  let server: Server;
  let base: string;
  const prev = process.env.NODE_ENV;

  before(async () => {
    // Even if the router is mounted, each handler must refuse in production.
    process.env.NODE_ENV = "production";
    ({ server, base } = await listen(mountApp(true)));
  });
  after(() => {
    server.close();
    process.env.NODE_ENV = prev;
  });

  it("returns 404 for the scenario list in production", async () => {
    const res = await fetch(`${base}/dev/failure-lab/scenarios`);
    assert.equal(res.status, 404);
  });

  it("returns 404 for a scenario run in production", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/failure-lab/successful_recovery`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("returns 404 for the evaluation safety report in production", async () => {
    const res = await fetch(`${base}/dev/tenants/t1/evaluation/safety-report`);
    assert.equal(res.status, 404);
  });
});
