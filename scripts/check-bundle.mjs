import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const relative of [manifest.main, manifest.exports["./client"], manifest.dsh.bundle.patch, "locale/zh.json", "locale/en.json", manifest.exports["./icon"]]) await access(join(root, relative));
for (const relative of ["dsh/index.mjs", "dsh/agent.mjs", "dsh/client.js", "dsh/model-adapter.mjs", "dsh/workbench.mjs", "dsh/workspace-files.mjs", "src/workspace-resources.mjs", "dsh/ui-bridge.mjs", "server.mjs"]) {
  const source = await readFile(join(root, relative), "utf8");
  for (const [, name] of source.matchAll(/from\s+["'](@deepseek-ai\/[^"']+)["']/g)) {
    if (!manifest.peerDependencies?.[name]) throw new Error(`Missing DSH runtime peer: ${name}`);
  }
  const result = spawnSync(process.execPath, ["--check", join(root, relative)], { encoding: "utf8" });
  if (result.status) throw new Error(result.stderr);
}
console.log(JSON.stringify({ name: manifest.name, version: manifest.version, dsh: manifest.engines.dsh, status: "valid", installDirectory: root, runtime: "DSH Host + local SQLite; no standalone backend" }, null, 2));
