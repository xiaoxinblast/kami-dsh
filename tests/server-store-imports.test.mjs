import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * server.mjs 调用了 src/store.mjs 的导出却没写进 import 时，运行时只会抛出
 * "xxx is not defined"，而且这条错误会当成用户可见的提示显示在界面上
 * （人工风格指南导入就踩过：saveUserProfile 漏了 import，界面直接显示
 * "saveUserProfile is not defined"）。这里把这种漏导入挡在测试阶段。
 */
test("server.mjs 引用的 store 导出都必须在 import 里", async () => {
  const storeSource = await readFile(new URL("../src/store.mjs", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  const exported = [...storeSource.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gu)].map((match) => match[1]);
  assert.ok(exported.length > 0, "应该能解析出 store 的导出函数");

  const imported = new Set();
  for (const match of serverSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/src\/store\.mjs"/gu)) {
    for (const name of match[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) imported.add(trimmed.split(/\s+as\s+/u).at(-1));
    }
  }

  const local = new Set([...serverSource.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gu)].map((match) => match[1]));
  const missing = exported.filter((name) => new RegExp(`\\b${name}\\s*\\(`, "u").test(serverSource) && !imported.has(name) && !local.has(name));
  assert.deepEqual(missing, [], `server.mjs 调用了未导入的 store 导出：${missing.join(", ")}`);
});
