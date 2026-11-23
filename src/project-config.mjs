/**
 * Project-scoped translation configuration.
 *
 * This module is deliberately storage/provider agnostic.  Directus, the JSON
 * test store and the browser all consume the same defaults and rule metadata.
 */

export const PROJECT_CONFIG_VERSION = 3;

export const PROJECT_QA_RULES = Object.freeze([
  { id: "tm_exact_target_mismatch", group: "TM 与术语", label: "主 TM 精确译文不一致", description: "原文与主 TM 精确一致，但当前译文没有采用主 TM 译文。", defaultEnabled: true, defaultSeverity: "error", severities: ["error", "warning", "info"] },
  { id: "protected_token_parity", group: "格式与事实", label: "受保护内容一致", description: "占位符、转义序列、单位标记和其他必须保留的内容不能丢失。", defaultEnabled: true, defaultSeverity: "error", severities: ["error", "warning", "info"] },
  { id: "url_email_parity", group: "格式与事实", label: "URL / 邮箱一致", description: "网址和邮箱必须保持，不能被改写或遗漏。", defaultEnabled: true, defaultSeverity: "error", severities: ["error", "warning", "info"] },
  { id: "number_parity", group: "格式与事实", label: "数字与百分比一致", description: "按数值等价检查数字、百分比和常见本地化写法。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "fact_parity", group: "格式与事实", label: "日期、金额、平台和地区事实", description: "检查源文中的日期、金额、折扣、平台、地区和交付约束。", defaultEnabled: true, defaultSeverity: "error", severities: ["error", "warning", "info"] },
  { id: "term_consistency", group: "术语与一致性", label: "术语语境与禁用译法", description: "精确命中正式术语时，把登记译法交给模型结合当前句义判断；本地硬检查只处理明确的保留原文和禁用译法。", defaultEnabled: true, defaultSeverity: "error", severities: ["error", "warning", "info"] },
  { id: "term_potential", group: "术语与一致性", label: "近似术语提示", description: "日文原文与术语库条目字符近似但没有精确命中时，交给模型判断是否为同一术语；该规则可能产生误判，默认关闭。", defaultEnabled: false, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "duplicate_consistency", group: "术语与一致性", label: "重复源文译法一致", description: "同一项目内相同原文出现多个不同译法时提示复核。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "untranslated", group: "语言质量", label: "疑似未翻译", description: "译文为空、仍为日文或与原文完全相同。", defaultEnabled: true, defaultSeverity: "error", severities: ["error", "warning", "info"] },
  { id: "length_ratio", group: "语言质量", label: "长度比例", description: "源文与译文长度异常时提示可能漏译、增译或超长。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "whitespace", group: "语言质量", label: "空白格式", description: "检查首尾空白、重复空格和中文标点前多余空格。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "punctuation_balance", group: "语言质量", label: "括号与引号配对", description: "检查译文中的括号、引号是否成对闭合。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "orthography", group: "语言质量", label: "简体中文标点", description: "检查译文是否残留日式「」或『』，以及作品名是否按项目约定使用《》。仅检查标点，不判断措辞。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "register", group: "语言质量", label: "语域词表提示", description: "根据翻译页选定或自动识别的内容语体，用本地词表、感叹号、表情和句式特征提示太营销、太网感或套话密集；属于启发式提示，不判断翻译对错，默认关闭。", defaultEnabled: false, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "language_quality", group: "语言质量", label: "拼写、重复与语气启发式", description: "检查疑似重复字符、重复词、专名遗漏和语气弱化。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "newline_count", group: "布局与标签", label: "换行数量", description: "比较原文与译文的显式换行数量；默认关闭，因为软换行允许自然变化。", defaultEnabled: false, defaultSeverity: "info", severities: ["error", "warning", "info"] },
  { id: "newline_semantics", group: "布局与标签", label: "换行语义", description: "检查断行是否落在语义边界：行尾虚词（的、地、得、之）和只有一两个字单独成行。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "newline_suspicious_break", group: "布局与标签", label: "可疑断行", description: "提示换行断在数字、英文标识、单位、货币或省略号、破折号内部。", defaultEnabled: true, defaultSeverity: "warning", severities: ["error", "warning", "info"] },
  { id: "non_break_tag_structure", group: "结构强制", label: "非换行标签结构", description: "非换行标签必须保留，数量、类型和顺序不能变化。", fixed: true, defaultEnabled: true, defaultSeverity: "error", severities: ["error"] },
  { id: "document_integrity", group: "结构强制", label: "文件与锁定单元完整性", description: "原文件身份、锁定单元、条目 ID、XML 写后复解析必须通过。", fixed: true, defaultEnabled: true, defaultSeverity: "error", severities: ["error"] }
]);

const RULE_BY_ID = new Map(PROJECT_QA_RULES.map((rule) => [rule.id, rule]));

export const DEFAULT_PROJECT_SETTINGS = Object.freeze({
  version: PROJECT_CONFIG_VERSION,
  tm: {
    catMinFuzzy: 60,
    llmMinRelevance: 60,
    retrievalLimit: 5,
    contextAnchorCount: 5
  },
  batch: {
    subBatchMaxEntries: 100,
    subBatchMaxChars: 8000,
    groupMaxEntries: 10,
    groupMaxChars: 1500,
    structuredMode: "unit"
  },
  qa: {
    rules: Object.fromEntries(PROJECT_QA_RULES.map((rule) => [rule.id, {
      enabled: rule.defaultEnabled,
      severity: rule.defaultSeverity
    }]))
  }
});

function integer(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function mode(value) {
  return ["unit", "group"].includes(String(value)) ? String(value) : DEFAULT_PROJECT_SETTINGS.batch.structuredMode;
}

export function projectRuleMetadata() {
  return PROJECT_QA_RULES.map((rule) => ({ ...rule, severities: [...rule.severities] }));
}

export function createDefaultProjectSettings() {
  return structuredClone(DEFAULT_PROJECT_SETTINGS);
}

export function sanitizeProjectSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sourceVersion = Number.isInteger(Number(source.version)) ? Number(source.version) : 0;
  const settings = createDefaultProjectSettings();
  const tm = source.tm && typeof source.tm === "object" ? source.tm : {};
  const batch = source.batch && typeof source.batch === "object" ? source.batch : {};
  settings.tm.catMinFuzzy = integer(tm.catMinFuzzy, settings.tm.catMinFuzzy, 50, 99);
  settings.tm.llmMinRelevance = integer(tm.llmMinRelevance, settings.tm.llmMinRelevance, 0, 100);
  settings.tm.retrievalLimit = integer(tm.retrievalLimit, settings.tm.retrievalLimit, 1, 20);
  settings.tm.contextAnchorCount = integer(tm.contextAnchorCount, settings.tm.contextAnchorCount, 0, 10);
  settings.batch.subBatchMaxEntries = integer(batch.subBatchMaxEntries, settings.batch.subBatchMaxEntries, 10, 500);
  settings.batch.subBatchMaxChars = integer(batch.subBatchMaxChars, settings.batch.subBatchMaxChars, 1000, 50000);
  settings.batch.groupMaxEntries = integer(batch.groupMaxEntries, settings.batch.groupMaxEntries, 2, 50);
  settings.batch.groupMaxChars = integer(batch.groupMaxChars, settings.batch.groupMaxChars, 300, 12000);
  settings.batch.structuredMode = mode(batch.structuredMode);

  const requestedRules = source.qa?.rules && typeof source.qa.rules === "object" ? source.qa.rules : {};
  for (const rule of PROJECT_QA_RULES) {
    const requested = requestedRules[rule.id];
    if (!requested || typeof requested !== "object") continue;
    // v1 把近似术语作为默认开启项，无法区分用户选择和旧默认。迁移到 v2 时统一
    // 采用新的关闭默认；保存过 v2 后，用户仍可明确重新开启。
    if (rule.id === "term_potential" && sourceVersion < 2) continue;
    // v2 及更早版本把语域词表提示作为默认开启项，无法区分用户选择和旧默认。
    // 迁移到 v3 时采用新的关闭默认；保存过 v3 后仍可明确重新开启。
    if (rule.id === "register" && sourceVersion < 3) continue;
    settings.qa.rules[rule.id] = {
      enabled: rule.fixed ? true : requested.enabled !== false,
      severity: rule.severities.includes(requested.severity) ? requested.severity : rule.defaultSeverity
    };
  }
  return settings;
}

export function projectQaRule(id, settings = DEFAULT_PROJECT_SETTINGS) {
  const rule = RULE_BY_ID.get(String(id));
  if (!rule) return null;
  const resolved = sanitizeProjectSettings(settings).qa.rules[rule.id];
  return { ...rule, ...resolved, fixed: Boolean(rule.fixed) };
}

export function projectRuleIdForIssue(issue = {}) {
  const type = String(issue.type || "");
  // 行结构检查（行数、字数、标记顺序、标点禁则）始终启用，不受项目开关控制；
  // 只有语义、短行、token 拆分和换行数量归入可配置规则。
  if (type.startsWith("line_layout_")) {
    if (type === "line_layout_count") return "newline_count";
    if (type === "line_layout_token") return "newline_suspicious_break";
    if (type === "line_layout_semantic" || type === "line_layout_short_line") return "newline_semantics";
    return "";
  }
  if (type === "tm_exact_target_mismatch") return "tm_exact_target_mismatch";
  if (type === "protected_token" || type.startsWith("fact_placeholder") || type.startsWith("fact_url")) return "protected_token_parity";
  if (["required_term", "preserved_term", "forbidden_term"].includes(type)) return "term_consistency";
  if (type.startsWith("aiqa_terminology")) return "term_consistency";
  if (["potential_term", "term_case_mismatch"].includes(type)) return "term_potential";
  if (type === "number_drift" || type.startsWith("fact_number") || type.startsWith("fact_percentage") || type.startsWith("fact_money") || type.startsWith("fact_discount")) return "number_parity";
  if (type.startsWith("fact_date") || type.startsWith("fact_platform") || type.startsWith("fact_region") || type === "length_limit_exceeded") return "fact_parity";
  if (type.startsWith("fact_url") || type.startsWith("fact_placeholder")) return "protected_token_parity";
  if (type.startsWith("orthography")) return "orthography";
  if (type.startsWith("register_")) return "register";
  if (type.includes("untranslated")) return "untranslated";
  if (type.includes("whitespace")) return "whitespace";
  if (type.includes("quote") || type.includes("punctuation")) return "punctuation_balance";
  if (type.includes("newline")) return type === "newline_count" ? "newline_count" : "newline_semantics";
  if (type === "basic_brand_missing" || type === "basic_added_latin" || type === "basic_repeated_char" || type === "basic_duplicate_word" || type === "basic_tone") return "language_quality";
  return "";
}

export function applyProjectQaPolicy(issues = [], settings = DEFAULT_PROJECT_SETTINGS) {
  const sanitized = sanitizeProjectSettings(settings);
  return (Array.isArray(issues) ? issues : []).filter((issue) => {
    const ruleId = projectRuleIdForIssue(issue);
    return !ruleId || sanitized.qa.rules[ruleId]?.enabled !== false;
  }).map((issue) => {
    const ruleId = projectRuleIdForIssue(issue);
    const rule = ruleId ? sanitized.qa.rules[ruleId] : null;
    return rule ? { ...issue, severity: rule.severity, projectRule: ruleId } : issue;
  });
}
