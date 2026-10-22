import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/sqlite-store.mjs";

test("local assets preserve project scopes, pagination, aggregates and atomic writes", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.request("/items/terms_zh_cn", { method: "POST", body: [
      { id: "a", project_id: "one", source: "設定", target: "设置" },
      { id: "b", project_id: "two", source: "設定", target: "设定" },
      { id: "c", project_id: "one", source: "保存", target: "保存" }
    ] });
    assert.deepEqual(store.request("/items/terms_zh_cn?filter[project_id][_eq]=one&fields=id&sort=-id&limit=1"), [{ id: "c" }]);
    assert.equal(store.request("/items/terms_zh_cn?filter[_or][0][source][_icontains]=設定&filter[_or][1][source][_eq]=保存&aggregate[count]=*")[0].count, "3");
    assert.equal(store.request("/items/terms_zh_cn?aggregate[count]=id")[0].count.id, "3");
    assert.throws(() => store.request("/items/terms_zh_cn", { method: "POST", body: [{ id: "d" }, { id: "a" }] }));
    assert.throws(() => store.request("/items/terms_zh_cn/d"), /not found/);
    store.request("/items/terms_zh_cn/a", { method: "PATCH", body: { target: "选项" } });
    assert.equal(store.request("/items/terms_zh_cn/a").target, "选项");
    assert.equal(store.integrity()[0].integrity_check, "ok");
    assert.throws(() => store.request("/items/terms_zh_cn?sort=bad%27name"), /Invalid field/);
  } finally { store.close(); }
});

test("migration is repeatable and preserves identifiers and original payloads", () => {
  const store = new SqliteStore(":memory:");
  try {
    const data = [{ id: "old-id", project_id: "legacy", provenance: { authority: "human" }, date_created: "2025-01-01" }];
    store.import("style_evidence", data);
    store.import("style_evidence", data);
    assert.deepEqual(store.request("/items/style_evidence/old-id"), data[0]);
    assert.equal(store.request("/items/style_evidence?aggregate[count]=*")[0].count, "1");
  } finally { store.close(); }
});
