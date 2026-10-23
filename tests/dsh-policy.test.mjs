import test from "node:test";
import assert from "node:assert/strict";
import { assertOperation } from "../dsh/workbench.mjs";
import { configureRuntime, runtimeOptions, withRuntimeCall } from "../src/runtime-context.mjs";

test("agent cannot manufacture human approvals or access an external API", () => {
  assert.throws(() => assertOperation({ method: "POST", path: "/api/feedback/accept" }), /human/);
  assert.throws(() => assertOperation({ method: "POST", path: "/api/batch/run/example/import-review" }), /human/);
  assert.throws(() => assertOperation({ method: "POST", path: "/api/batch/run", body: { runnerOptions: { reviewFinal: { complete: true } } } }), /human/);
  assert.throws(() => assertOperation({ method: "POST", path: "/api/batch/run", body: { segments: [{ accepted: true }] } }), /human/);
  assert.throws(() => assertOperation({ method: "POST", path: "/api/learning/skills/a/activate" }), /human/);
  assert.doesNotThrow(() => assertOperation({ method: "POST", path: "/api/learning/skills/a/activate" }, true));
  assert.throws(() => assertOperation({ path: "https://other.example/api/projects" }), /Only/);
  assert.throws(() => assertOperation({ method: "POST", path: "/api/provider" }, true), /DSH/);
});

test("parallel session model routes remain isolated", async () => {
  configureRuntime({ embedded: true });
  const results = await Promise.all(["one", "two"].map((model) => withRuntimeCall({ modelRoute: { model } }, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return runtimeOptions().modelRoute.model;
  })));
  assert.deepEqual(results, ["one", "two"]);
  assert.equal(runtimeOptions().modelRoute, undefined);
});
