import { open, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function workspaceFs() {
  if (process.env.DSH_TEST_LLM_MODULE) {
    const sdk = process.env.DSH_TEST_LLM_MODULE;
    const [{ Context }, { default: LocalFileSystem }] = await Promise.all([
      import(new URL("../../cordis/lib/index.js", sdk)),
      import(new URL("../../dsh-fs-local/lib/index.js", sdk))
    ]);
    const ctx = new Context();
    const fs = new LocalFileSystem(ctx, { cwd: process.cwd(), diffBasisMaxBytes: 1024 * 1024 });
    return { fs, close: () => ctx.fiber.dispose() };
  }
  // Contract double for portable tests. SDK-enabled runs use the installed provider above.
  const fs = {
    resolve: async (path, options = {}) => ({ targetKey: resolve(options.cwd || process.cwd(), path) }),
    processPath: (target) => target.targetKey,
    async stat(target) {
      try { const value = await stat(target.targetKey, { bigint: true }); return { type: value.isFile() ? "file" : "directory", size: Number(value.size), version: `${value.mtimeNs}:${value.size}` }; }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
    },
    async readBytes(target, signal, limit) { signal?.throwIfAborted(); const bytes = await readFile(target.targetKey); if (bytes.length > limit) throw new Error("File too large"); return bytes; },
    async readByteRange(target, range, signal) {
      signal?.throwIfAborted(); const file = await open(target.targetKey, "r");
      try { const buffer = Buffer.alloc(range.length); const { bytesRead } = await file.read(buffer, 0, range.length, range.offset); return buffer.subarray(0, bytesRead); }
      finally { await file.close(); }
    },
    async writeText(target, text, expected) {
      const info = await this.stat(target);
      if (expected.kind === "replaceIfVersion" && expected.version !== info?.version) throw new Error("File changed");
      await writeFile(target.targetKey, text, { flag: expected.kind === "createIfAbsent" ? "wx" : "w" });
    }
  };
  return { fs, close: async () => {} };
}
