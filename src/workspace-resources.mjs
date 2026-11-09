import { resolve } from "node:path";
import { runtimeOptions } from "./runtime-context.mjs";
import { normalizeSource } from "./text.mjs";
import { buildMemoryIndex, selectMemoryCandidates } from "./memory-index.mjs";

const memoryIndexes = new WeakMap();

export function taskResources(projectId = "") {
  const snapshot = runtimeOptions().workspaceSnapshot;
  return snapshot && snapshot.projectId === projectId ? snapshot : null;
}

export function workspaceStyleGuide(projectId = "") {
  const snapshot = taskResources(projectId);
  if (snapshot?.styleGuideMode !== "agent-native") return snapshot?.guide;
  const files = snapshot.resources.filter((item) => item.purpose === "style-guide");
  if (!files.length) return null;
  const workspace = snapshot.workspace;
  return { id: `workspace:${snapshot.id}`, name: "工作区风格指南原件", projectId, status: "active",
    instruction: `人工风格指南只关联原文件，没有编译正文。翻译或审校前必须使用当前会话的原生工具直接查阅以下指南，遵守完整规则、例外和正反例；人工指南优先于自动风格规范、技能规则和译者画像。不要把文件路径当成已读正文，不生成纯文本转换副本或编译缓存。Office/PDF、图片中的排版和标记须按原格式查阅，文档命令中明确使用关联原件路径；读取失败时尝试其他只读工具，仍失败或未读完整则本次任务失败，不能声称已遵守指南。不得在译文中附加查阅报告、非译文说明或失败原因；错误由任务状态单独报告。正文以实际读取时的原件为准。\n${workspace ? `当前工作区：${workspace}\n请直接使用以下 absolutePath，或以当前工作区为基准使用相对 path；不要推测用户目录。\n` : ""}${files.map((item) => JSON.stringify({ path: item.path, ...(workspace ? { absolutePath: resolve(workspace, item.path) } : {}), version: item.version })).join("\n")}` };
}

export function mergeWorkspaceTerms(assets, snapshot) {
  if (!snapshot?.terms?.length) return assets;
  // Existing approved library entries retain precedence, including their aliases.
  const keys = new Set((assets.terms || []).flatMap((term) => [term.source, ...(term.aliases || [])]).map(normalizeSource));
  const terms = snapshot.terms.filter((term) => !keys.has(normalizeSource(term.source)));
  return { ...assets, terms: [...(assets.terms || []), ...terms] };
}

export function mergeWorkspaceMemories(memories, snapshot, { source = "", limit = 1000 } = {}) {
  if (!snapshot?.memories?.length) return memories;
  let candidates = snapshot.memories;
  if (source && limit > 0) {
    let cached = memoryIndexes.get(snapshot);
    if (!cached) {
      cached = { index: buildMemoryIndex(candidates), byId: new Map(candidates.map((item) => [item.id, item])) };
      memoryIndexes.set(snapshot, cached);
    }
    candidates = selectMemoryCandidates(cached.index, source, { limit }).map((item) => cached.byId.get(item.id));
  }
  const keys = new Set(memories.filter((item) => item.libraryRole === "master" || item.qualityStatus === "human_approved").map((item) => normalizeSource(item.source)));
  return [...memories, ...candidates.filter((item) => !keys.has(normalizeSource(item.source)))];
}
