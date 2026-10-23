import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/sqlite-store.mjs";

test("field projections preserve boolean library enablement and structured values", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.request("/items/project_resource_libraries", { method: "POST", body: { id: "off", enabled: false, name: "引用库", priority: 2, extra: { active: true } } });
    assert.deepEqual(store.request("/items/project_resource_libraries?fields=id,enabled,name,priority,extra"), [{ id: "off", enabled: false, name: "引用库", priority: 2, extra: { active: true } }]);
  } finally { store.close(); }
});

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

test("library aggregates keep counts and latest-entry timestamps in the same response", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.request("/items/translation_memories_zh_cn", { method: "POST", body: [
      { id: "a", library_id: "master", source_file: "first.docx", date_created: "2026-10-01T00:00:00Z" },
      { id: "b", library_id: "master", source_file: "second.docx", date_created: "2026-10-23T00:00:00Z" }
    ] });
    const [row] = store.request("/items/translation_memories_zh_cn?groupBy[]=library_id&aggregate[count]=*&aggregate[max]=date_created&aggregate[countDistinct]=source_file");
    assert.equal(row.count, "2");
    assert.equal(row.max.date_created, "2026-10-23T00:00:00Z");
    assert.equal(row.countDistinct.source_file, "2");
  } finally { store.close(); }
});

test("bulk updates switch learning versions atomically and roll back on a missing record", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.request("/items/translation_skills", { method: "POST", body: [{ id: "one", status: "champion" }, { id: "two", status: "draft" }] });
    store.request("/items/translation_skills", { method: "PATCH", body: [{ id: "one", status: "inactive" }, { id: "two", status: "champion" }] });
    assert.equal(store.request("/items/translation_skills/two").status, "champion");
    assert.throws(() => store.request("/items/translation_skills", { method: "PATCH", body: [{ id: "two", status: "inactive" }, { id: "missing", status: "champion" }] }), /not found/);
    assert.equal(store.request("/items/translation_skills/two").status, "champion");
    assert.throws(() => store.request("/items/translation_skills", { method: "PATCH", body: [{ status: "champion" }] }), /ID/);
  } finally { store.close(); }
});
