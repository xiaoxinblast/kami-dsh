import { withRuntimeCall } from "./runtime-context.mjs";
import { digitSequence, extractProtectedTokens, parseModelJsonObject } from "./text.mjs";
import { textContainsTerm } from "./asset-governance.mjs";
import { translationOutputIssue } from "./translation-output.mjs";

// Jobs run their normal evidence, checking and persistence paths. Only the one model
// request identified by label may rendezvous; early failures release the other jobs.
export async function runFollowupGroups(run, items, label, worker, { size = 4 } = {}) {
  const positions = new Map(run.segments.map((s, i) => [s.id, i]));
  const results = new Map();
  let group = [], lastScope, lastIndex;
  async function flush() {
    const batch = group;
    group = [];
    let arrived = 0;
    const waiting = [];
    function ready() {
      if (++arrived !== batch.length || !waiting.length) return;
      const [first] = waiting;
      const send = waiting.length > 1 ? first.combine(waiting) : Promise.resolve(new Map());
      send.then(async values => {
        await Promise.all(waiting.map(async row => {
          try { row.resolve(values.get(row.item.segment.id) ?? await row.single()); }
          catch (error) { row.reject(error); }
        }));
      }, error => waiting.forEach(row => row.reject(error)));
    }
    await Promise.all(batch.map(async item => {
      let joined = false;
      const submit = (request, single, combine) => joined ? single() : new Promise((resolve, reject) => {
        joined = true;
        waiting.push({ item, ...request, single, combine, resolve, reject });
        ready();
      });
      try {
        const value = await withRuntimeCall({ followupBatch: batch.length > 1 ? { label, submit } : null }, () => worker(item));
        results.set(item.segment.id, { value });
      } catch (error) { results.set(item.segment.id, { error }); }
      finally { if (!joined) ready(); }
    }));
  }
  for (const item of items) {
    const s = item.segment, ctx = s.context || {}, loc = s.locator || {};
    const purpose = s.result?.segmentPurpose || run.contentType || "general";
    const position = positions.get(s.id);
    const section = run.contextBrief?.sections?.find(part => part.from <= position + 1 && part.to >= position + 1);
    const scope = JSON.stringify([run.locale, purpose, loc.file, loc.sheet, ctx.sheet, ctx.scene, section?.from, section?.to, ctx.note, ctx.speaker, ctx.addressee, ctx.listener, ctx.metadata]);
    const explicitScene = Boolean(ctx.scene || section);
    const shortUi = ["ui", "game_ui", "tutorial", "item_name", "item_description", "rules", "store"].includes(purpose);
    const dialogue = /dialog|对白|台词/iu.test(purpose);
    const solo = [...(s.source + (item.translation || s.translation || ""))].length > 450
      || (!shortUi && !explicitScene) || (dialogue && !(ctx.speaker && (ctx.addressee || ctx.listener)));
    if (group.length && (solo || group.length >= size || lastScope !== scope || (!explicitScene && lastIndex + 1 !== position))) await flush();
    group.push(item);
    lastScope = scope; lastIndex = position;
    if (solo) await flush();
  }
  if (group.length) await flush();
  return results;
}

export function followupMessages(rows, qa) {
  const texts = rows.map(row => row.messages.at(-1).content.split("\n"));
  let shared = 0;
  while (shared < texts[0].length && texts.every(lines => lines[shared] === texts[0][shared])) shared++;
  const contract = qa ? '{"results":[{"id":"原ID","issues":[同原审校标准的问题对象]}]}' : '{"results":[{"id":"原ID","translation":"完整修订译文"}]}';
  return [{ role: "system", content: rows[0].messages[0].content + "\n以下为独立句段的小批任务。共用规则适用于每段，逐段独立检查，不能串用其他段的证据、人物或台词。最终输出一个 JSON 对象，每个输入 ID 恰有一个结果。输出格式以此为准：" + contract },
    { role: "user", content: texts[0].slice(0, shared).join("\n") + "\n" + JSON.stringify(rows.map((r,i) => ({ id: r.item.segment.id, input: texts[i].slice(shared).join("\n") }))) }];
}

export function parseFollowupResults(content, rows, qa) {
  const values = new Map(), seen = new Set();
  let results;
  try { results = parseModelJsonObject(content).results; } catch { return values; }
  if (!Array.isArray(results)) return values;
  for (const row of results) {
    const item = rows.find(r => r.item.segment.id === row?.id)?.item;
    if (!item) continue;
    if (seen.has(row.id)) { values.delete(row.id); continue; }
    seen.add(row.id);
    if (qa) {
      if (!Array.isArray(row.issues) || !row.issues.every(i => i && ["major","critical","minor"].includes(i.severity) && typeof i.message === "string" && i.message.trim()
        && typeof i.category === "string" && (!i.sourceSpan || item.segment.source.includes(i.sourceSpan)) && (!i.targetSpan || (item.translation || item.segment.translation).includes(i.targetSpan)))) continue;
      values.set(row.id, JSON.stringify({ issues: row.issues }));
    } else {
      const before = item.translation || item.segment.translation, after = row.translation;
      const layout = value => String(value).match(/<[^<>]+>|\r\n|[\r\n]/gu) || [];
      if (typeof after !== "string" || !after.trim() || translationOutputIssue(after) || digitSequence(before) !== digitSequence(after)
        || JSON.stringify(layout(before)) !== JSON.stringify(layout(after))
        || JSON.stringify(extractProtectedTokens(before)) !== JSON.stringify(extractProtectedTokens(after))
        || item.targets?.some(target => !textContainsTerm(after, target))) continue;
      values.set(row.id, after.trim());
    }
  }
  return values;
}
