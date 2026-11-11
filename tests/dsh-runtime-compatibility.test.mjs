import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const supportedVersions = ["0.2.1-rc.2", "0.2.1-rc.3", "0.2.1-rc.4", "0.2.1-rc.5", "0.2.2-rc.1", "0.2.2-rc.2"];

const bootModule = process.env.DSH_TEST_LLM_MODULE && new URL("../../dsh-app-boot/lib/index.js", process.env.DSH_TEST_LLM_MODULE);

test("DSH startup accepts verified runtime versions without a version exemption", { skip: !bootModule || !existsSync(bootModule) }, async (t) => {
  const { evaluatePluginCompatibility } = await import(bootModule);
  if (!evaluatePluginCompatibility) return t.skip("This SDK predates the DSH startup compatibility gate");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(evaluatePluginCompatibility(manifest), undefined, "Startup must accept the installed SDK runtime");
  const { engines, ...withoutEngine } = manifest;
  for (const version of supportedVersions) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `Startup must accept DSH ${version}`);
    assert.equal(evaluatePluginCompatibility(withoutEngine, {}, version), undefined, `Runtime peers must accept DSH ${version}`);
  }
  for (const version of ["0.2.1-rc.1", "0.2.1-rc.6", "0.2.2-alpha.3", "0.2.2-rc.3", "0.2.2", "0.3.0"]) {
    const issue = evaluatePluginCompatibility(manifest, {}, version);
    assert.equal(issue?.exempted, false, `Unverified DSH ${version} must not receive an exemption`);
    assert.equal(issue?.requirements["engines.dsh"], manifest.engines.dsh);
    const peerIssue = evaluatePluginCompatibility(withoutEngine, {}, version);
    assert.equal(peerIssue?.exempted, false, `Runtime peers must reject unverified DSH ${version}`);
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      assert.equal(peerIssue?.requirements[name], range, name);
    }
  }
});

test("package and lockfile agree on the explicitly verified DSH runtimes", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const expected = supportedVersions.join(" || ");
  assert.equal(manifest.engines.dsh, expected);
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    assert.equal(range, expected, name);
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, name);
  }
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].engines, manifest.engines);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(lock.packages[""].peerDependenciesMeta, manifest.peerDependenciesMeta);
});
