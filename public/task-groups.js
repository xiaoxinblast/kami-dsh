/**
 * 任务中心的分组：一次批量上传会产生几十上百条同类型后台任务，
 * 平铺在列表里会把真正需要处理的东西埋掉。这里按"同类型 + 同一批上传"聚合成组。
 *
 * 聚合口径：
 * - 任务自带 payload.groupId（新批量操作）→ 同一个 groupId 永远一组；
 * - 老任务没有 groupId → 同类型 + 同项目 + 创建时间相邻（默认 5 分钟内）视为一次操作；
 * - 只有一条的组不聚合，仍按单条任务展示。
 */

const DEFAULT_GAP_MS = 5 * 60_000;

function createdTime(task) {
  return Date.parse(String(task?.createdAt || task?.updatedAt || "")) || 0;
}

function updatedTime(task) {
  return Date.parse(String(task?.updatedAt || task?.createdAt || "")) || 0;
}

export function taskEntryStatus(entry) {
  if (!entry) return "other";
  if (entry.kind === "group") {
    const statuses = entry.tasks.map((task) => task.status);
    if (statuses.some((status) => ["in_progress", "paused"].includes(status))) return "in_progress";
    if (statuses.some((status) => ["review", "needs_attention", "failed", "abandoned"].includes(status))) return "needs_attention";
    if (statuses.every((status) => status === "completed")) return "completed";
    return "other";
  }
  if (["in_progress", "paused"].includes(entry.status)) return "in_progress";
  if (["review", "needs_attention", "failed", "abandoned"].includes(entry.status)) return "needs_attention";
  if (entry.status === "completed") return "completed";
  return "other";
}

function summarize(tasks) {
  const running = tasks.filter((task) => ["in_progress", "paused"].includes(task.status)).length;
  const attention = tasks.filter((task) => ["review", "needs_attention", "failed", "abandoned"].includes(task.status)).length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  return { running, attention, completed, other: Math.max(0, tasks.length - running - attention - completed) };
}

function makeGroup({ key, taskType, projectId, tasks, labelFor }) {
  const sorted = [...tasks].sort((left, right) => createdTime(left) - createdTime(right));
  const label = labelFor(taskType) || taskType || "后台任务";
  return {
    kind: "group",
    key,
    taskType,
    projectId: projectId || "",
    label,
    title: `${label} · ${sorted.length} 个文件`,
    tasks: sorted,
    summary: summarize(sorted),
    createdAt: sorted[0]?.createdAt || "",
    updatedAt: sorted.reduce((latest, task) => (updatedTime(task) > updatedTime(latest) ? task : latest), sorted[0])?.updatedAt || sorted[0]?.createdAt || ""
  };
}

export function groupTaskEntries(tasks, { labelFor = (type) => type, gapMs = DEFAULT_GAP_MS } = {}) {
  const entries = [];
  const explicit = new Map();
  const loose = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task) continue;
    if (task.type !== "background") { entries.push(task); continue; }
    const groupId = String(task.payload?.groupId || "");
    if (groupId) {
      const key = `group:${groupId}`;
      if (!explicit.has(key)) explicit.set(key, []);
      explicit.get(key).push(task);
    } else {
      loose.push(task);
    }
  }

  for (const [key, list] of explicit) {
    entries.push(makeGroup({ key, taskType: list[0].taskType, projectId: list[0].projectId, tasks: list, labelFor }));
  }

  const buckets = new Map();
  for (const task of loose) {
    const key = `${task.taskType || ""}\u0000${task.projectId || ""}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(task);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => createdTime(left) - createdTime(right));
    let cluster = [];
    let lastCreated = 0;
    const flush = () => {
      if (!cluster.length) return;
      if (cluster.length === 1) entries.push(cluster[0]);
      else {
        const first = cluster[0];
        entries.push(makeGroup({
          key: `cluster:${first.taskType || ""}:${first.projectId || ""}:${first.id}`,
          taskType: first.taskType,
          projectId: first.projectId,
          tasks: cluster,
          labelFor
        }));
      }
      cluster = [];
      lastCreated = 0;
    };
    for (const task of bucket) {
      const created = createdTime(task);
      if (cluster.length && lastCreated && created - lastCreated > gapMs) flush();
      cluster.push(task);
      lastCreated = created;
    }
    flush();
  }

  return entries.sort((left, right) => updatedTime(right) - updatedTime(left));
}
