import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../scripts/migrate-local.mjs";
import { SqliteStore } from "../src/sqlite-store.mjs";

test("migration compares source twice, preserves payloads and refuses to overwrite later edits", async () => {
  const destination = await mkdtemp(join(tmpdir(), "kami-migrate-test-"));
  const records = [{ id: "legacy-id", name: "原有项目", status: "active" }];
  const fetcher = async () => new Response(JSON.stringify({ data: records }));
  const options = { baseUrl: "http://legacy.invalid", token: "test", dataDirectories: [], destination, fetcher, collections: ["localization_projects"], onProgress: () => {} };
  try {
    const result = await migrate(options);
    assert.equal(result.collections.localization_projects.count, 1);
    await migrate(options);
    const database = new SqliteStore(join(destination, "kami.sqlite"));
    assert.deepEqual(database.request("/items/localization_projects/legacy-id"), records[0]);
    database.request("/items/localization_projects/legacy-id", { method: "PATCH", body: { name: "新项目名" } });
    database.close();
    await assert.rejects(migrate(options), /refusing to overwrite/);
    assert.equal(JSON.parse(await readFile(join(destination, "migration-report.json"))).status, "incomplete");
  } finally { await rm(destination, { recursive: true, force: true }); }
});

test("changing source is not published as a complete local database", async () => {
  const destination = await mkdtemp(join(tmpdir(), "kami-migrate-change-"));
  let call = 0;
  try {
    await assert.rejects(migrate({ baseUrl: "http://legacy.invalid", token: "test", dataDirectories: [], destination, collections: ["localization_projects"], onProgress: () => {}, fetcher: async () => new Response(JSON.stringify({ data: [{ id: "one", name: String(++call) }] })) }), /Source changed/);
    await assert.rejects(access(join(destination, "kami.sqlite")));
  } finally { await rm(destination, { recursive: true, force: true }); }
});
