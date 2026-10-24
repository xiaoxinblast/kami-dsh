import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const bootModule = process.env.DSH_TEST_LLM_MODULE && new URL("../../dsh-app-boot/lib/index.js", process.env.DSH_TEST_LLM_MODULE);

test("DSH startup accepts verified runtime versions without a version exemption", { skip: !bootModule || !existsSync(bootModule) }, async (t) => {
  const { evaluatePluginCompatibility } = await import(bootModule);
  if (!evaluatePluginCompatibility) return t.skip("This SDK predates the DSH startup compatibility gate");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const version of ["0.2.1-rc.2", "0.2.1-rc.3"]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `Startup must accept DSH ${version}`);
    const { engines, ...withoutEngine } = manifest;
    assert.equal(evaluatePluginCompatibility(withoutEngine, {}, version), undefined, `Runtime peers must accept DSH ${version}`);
  }
  for (const version of ["0.2.1-rc.1", "0.2.1-rc.4", "0.3.0"]) {
    const issue = evaluatePluginCompatibility(manifest, {}, version);
    assert.equal(issue?.exempted, false, `Unverified DSH ${version} must not receive an exemption`);
    assert.equal(issue?.requirements["engines.dsh"], manifest.engines.dsh);
  }
});
