import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = version => ({ tag_name: `dsh-v${version}`, draft: false, published_at: "2026-11-18" });
async function select(t, { releases = [release("0.2.2-rc.4")], runs = [], jobs = [], retry = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "kami-release-ci-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = new URL("../scripts/ci/dsh-release.mjs", import.meta.url).href;
  const code = `const releases=${JSON.stringify(releases)}, runs=${JSON.stringify(runs)}, jobs=${JSON.stringify(jobs)};
    globalThis.fetch = async url => { const u=new URL(url); if(u.origin!=="https://api.github.com") throw Error("Wrong API origin");
      const rows=u.pathname.endsWith("/releases")?releases:u.pathname.endsWith("/jobs")?jobs:runs;
      const page=Number(u.searchParams.get("page")), data=rows.slice((page-1)*100,page*100);
      return {ok:true,json:async()=>u.pathname.endsWith("/releases")?data:u.pathname.endsWith("/jobs")?{jobs:data}:{workflow_runs:data}}; };
    await import(${JSON.stringify(script)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, encoding: "utf8", env: {
    ...process.env, DSH_DEV_MODULES: join(root, "node_modules"), DSH_UPSTREAM_VERSION: "", DSH_RETRY: String(retry),
    GITHUB_REPOSITORY: "xiaoxinblast/kami-dsh", GITHUB_SHA: "tested-sha", GITHUB_RUN_ID: "123", GH_TOKEN: "", GITHUB_OUTPUT: join(cwd, "outputs"), GITHUB_STEP_SUMMARY: join(cwd, "summary")
  } });
  const selection = JSON.parse(await readFile(join(cwd, ".cache/compatibility/selection.json"), "utf8"));
  return { ...result, selection, summary: await readFile(join(cwd, "summary"), "utf8") };
}

test("selection paginates official releases and finds a newer RC on the next page", async t => {
  const result = await select(t, { releases: [...Array.from({ length: 100 }, () => release("0.2.1")), release("0.2.2-rc.4")] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.selection.version, "0.2.2-rc.4");
  assert.equal(result.selection.status, "test");
});

test("failed attempts deduplicate only for this plugin SHA and retry is explicit", async t => {
  const runs = [{ id: 124, head_sha: "tested-sha", html_url: "https://github.com/example/run" }];
  const jobs = [{ name: "Windows smoke (0.2.2-rc.4)", status: "completed", conclusion: "failure" }];
  assert.equal((await select(t, { runs, jobs })).selection.status, "already-tested");
  assert.equal((await select(t, { runs, jobs, retry: true })).selection.status, "test");
  assert.equal((await select(t, { runs: [{ ...runs[0], head_sha: "another-sha" }], jobs })).selection.status, "test");
});

test("out-of-range release is reported needs-validation before installation", async t => {
  const result = await select(t, { releases: [release("0.2.3-rc.1")] });
  assert.equal(result.status, 1);
  assert.equal(result.selection.status, "needs-validation");
  assert.match(result.summary, /no install, activation, exemption/);
});

test("smoke guard blocks fetch, HTTP, sockets and TLS before sending", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "kami-offline-ci-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, "network.jsonl");
  const result = spawnSync(process.execPath, ["--import", new URL("../scripts/ci/offline.mjs", import.meta.url).href, "--input-type=module", "-e", `
    import assert from "node:assert/strict"; import http from "node:http"; import net from "node:net"; import tls from "node:tls";
    for (const call of [()=>fetch("https://example.com"),()=>http.get("http://127.0.0.1"),()=>new net.Socket().connect(443,"example.com"),()=>tls.connect(443,"example.com")]) assert.throws(call,/OFFLINE_SMOKE/);`
  ], { cwd, encoding: "utf8", env: { ...process.env, DSH_KERNEL_NETWORK_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 4);
});
