import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { inflateSync } from "node:zlib";

let readerSource;
const sheetLookup = {
  name: "lookup_reference_rows",
  description: "在一份已关联 XLSX 或文本原件查词。首次可省略表名与表头行查看表名和前几行，再指定实际表名与表头行取得含列名的匹配原行。文本返回行号和相邻行。优先用本工具查专名或称呼。同一语境可复用原文片段，复杂格式仍可用原生文档工具。",
  parameters: { type: "object", properties: { path: { type: "string" }, query: { type: "string" }, sheet: { type: "string" }, headerRow: { type: "integer", minimum: 1 }, segmentId: { type: "string", description: "分组翻译时填写这条证据适用的条目 ID" } }, required: ["path", "query"], additionalProperties: false }
};

// The batch worker owns the two maps. All original reads, including permission
// and version probes on hits, go through the current agent's guarded shell.
export function batchReferenceEvidence({ cache, workspace, styleGuides, references, shell, dispatch, onActivity }) {
  if (!cache || !shell) return null;
  let currentEntries = [];
  const scopedRefs = new Map(), segmentLookups = new Map();
  async function original(file, op, extra = {}) {
    readerSource ??= await readFile(new URL("./read-reference.py", import.meta.url), "utf8");
    const data = Buffer.from(JSON.stringify({ ...extra, op, workspace, path: resolve(workspace, file.path) })).toString("base64");
    const command = shell === "bash"
      ? `python -X utf8 -B - '${data}' <<'KAMI_READER'\n${readerSource}\nKAMI_READER`
      : `@'\n${readerSource}\n'@ | python -X utf8 -B - '${data}'`;
    const result = await dispatch(shell, { command, description: "核对关联原件的版本、权限及内容" });
    const v = result?.value;
    if (result?.isError || v?.exitCode !== 0 || v.timedOut || v.aborted || v.stdout?.truncated) {
      const reason = result?.error?.message || v?.stderr?.text || result?.content?.find(block => block.type === "text")?.text;
      throw new Error(`原件工具未返回完整结果${reason ? "：" + reason.slice(0, 220) : ""}`);
    }
    const match = /^KAMI1 ([A-Za-z0-9+/=]+)$/.exec(v.stdout.text.trim());
    if (!match) throw new Error("原件工具返回格式不完整");
    const item = JSON.parse(inflateSync(Buffer.from(match[1], "base64"), { maxOutputLength: 180000 }).toString("utf8"));
    return { version: JSON.stringify(item.stamp), value: item.value };
  }
  function scope(pack) {
    const n = pack?.neighborContext || {};
    // The batch runner appends a sliding window of numbered neighbours to
    // every note. It is translation context, not the identity of the speakers.
    const note = (n.note || "").split(/(?:^|\n)相邻原文（只用于消歧）：\n#/u)[0];
    const facts = [n.document, n.sheet, note, n.metadata, pack?.documentBrief?.section];
    const relation = /\S+\s+(?:对|對|→|->|to)\s+\S+/iu.test(note) || (n.speaker && (n.addressee || n.listener));
    return JSON.stringify([pack?.targetLocale, pack?.contentType, ...facts, n.speaker, n.addressee || n.listener,
      relation ? null : [pack?.source, n.previous, n.next]]);
  }
  function record(file, tool, version, extra = {}) {
    const ref = { path: file.path, version, tool, ...extra };
    scopedRefs.set(JSON.stringify([file.path, extra.query]), ref);
    onActivity?.({ ...ref, native: true, isError: false });
  }
  return {
    schema: references.some(f => /\.(xlsx|md|txt)$/iu.test(f.path)) ? sheetLookup : null,
    refs: () => [...scopedRefs.values()],
    async prepare(pack, entries) {
      currentEntries = entries || [{ contextPack: pack }];
      scopedRefs.clear();
      const guides = [], snippets = [];
      for (const file of styleGuides) {
        if (![".txt", ".md", ".docx", ".png", ".jpg", ".jpeg", ".webp"].includes(extname(file.path).toLowerCase())) continue;
        try {
          const { version } = await original(file, "probe");
          let entry = cache.guides.get(file.path);
          const hit = entry?.version === version;
          if (!hit) {
            entry = { version, promise: original(file, "guide").then(item => {
              if (item.version !== version || !(typeof item.value === "string" ? item.value.trim() : item.value?.type === "image_url")) throw new Error("指南版本变化或缺少正文");
              return item.value;
            }) };
            cache.guides.set(file.path, entry);
          }
          const content = await entry.promise;
          if (!hit && (await original(file, "probe")).version !== version) throw new Error("指南版本变化");
          guides.push({ path: file.path, content });
          record(file, hit ? "guide_reuse" : "guide_read", version);
        } catch (error) {
          // The model can still read complex originals with its document tools.
          // Never treat a failed or truncated probe as evidence.
          onActivity?.({ tool: "guide_fallback", path: file.path, error: error.message });
          const entry = cache.guides.get(file.path);
          if (entry) entry.promise.catch(() => { if (cache.guides.get(file.path) === entry) cache.guides.delete(file.path); });
        }
      }
      for (const [key, item] of new Map([...segmentLookups, ...[...cache.snippets].reverse()])) {
        const relevant = item.groupIds ? currentEntries.filter(entry => item.groupIds.includes(entry.id)) : currentEntries.filter(entry => scope(entry.contextPack) === item.scope && (segmentLookups.has(key) || entry.contextPack.source?.includes(item.query)));
        if (!relevant.length || (!segmentLookups.has(key) && snippets.length >= 3 * currentEntries.length)) continue;
        const file = references.find(f => f.path === item.path);
        if (!file) continue;
        try {
          if ((await original(file, "probe")).version !== item.version) continue;
          snippets.push(entries ? `适用条目 ID：${relevant.map(entry => entry.id).join("、")}\n${item.text}` : item.text);
          record(file, "reference_reuse", item.version, { query: item.query, locations: item.locations });
        } catch { /* Leave the original available for a fresh lookup. */ }
      }
      return { guides, allGuides: styleGuides.length > 0 && guides.length === styleGuides.length, snippets };
    },
    async lookup(args) {
      const file = references.find(item => item.path === args.path);
      if (!file || !args.query?.trim() || !/\.(xlsx|md|txt)$/iu.test(file.path)) throw new Error("请选择已关联原件和非空查询词");
      if (args.headerRow != null && (!Number.isSafeInteger(args.headerRow) || args.headerRow < 1)) throw new Error("表头行号必须是正整数");
      const currentPack = currentEntries.length === 1 ? currentEntries[0].contextPack : currentEntries.find(entry => entry.id === args.segmentId)?.contextPack;
      const context = scope(currentPack);
      const key = JSON.stringify([file.path, args.sheet, args.headerRow, args.query, context]);
      const existing = cache.snippets.get(key);
      if (existing && (await original(file, "probe")).version === existing.version) {
        segmentLookups.set(key, existing);
        record(file, "reference_reuse", existing.version, { query: args.query, locations: existing.locations });
        return { text: existing.text, refs: [{ path: file.path, tool: "reference_reuse", locations: existing.locations }] };
      }
      const { value, version } = await original(file, "lookup", args);
      if ((await original(file, "probe")).version !== version) throw new Error("读取期间原件发生变化");
      if (value?.sheets) return { text: `关联原件表名和起始行，仅作定位：${JSON.stringify(value.sheets)}`, refs: [] };
      if (!Array.isArray(value)) throw new Error("资料查阅结果不完整");
      const complete = value.length < 9;
      const rows = value.slice(0, 8);
      const locations = rows.map(row => row.sheet ? `${row.sheet}!${row.row}` : `L${row.line}`);
      const text = `参考原件事实证据，请核对本句词义、说话人及对象：${file.path}，查询词 ${args.query}\n${JSON.stringify(rows)}${complete ? "" : "\n结果未列全，请缩小查询范围。"}`;
      if (rows.length) record(file, sheetLookup.name, version, { query: args.query, locations });
      if (rows.length && currentEntries.length) {
        const item = { path: file.path, version, scope: context, query: args.query, locations, text, ...(!currentPack ? { groupIds: currentEntries.map(entry => entry.id) } : {}) };
        segmentLookups.set(key, item);
        if (complete && currentPack) cache.snippets.set(key, item);
        if (cache.snippets.size > 100) cache.snippets.delete(cache.snippets.keys().next().value);
      }
      return { text, refs: rows.length ? [{ path: file.path, tool: sheetLookup.name, locations }] : [] };
    }
  };
}
