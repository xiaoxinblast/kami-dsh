import { expectedTermTarget, filterEffectiveTerms } from "./asset-governance.mjs";
import { normalizeSource, similarity } from "./text.mjs";

function scopeBoost(term, contentType, domain) {
  let boost = 0;
  if (term.contentTypes?.includes(contentType)) boost += 0.16;
  else if (term.contentTypes?.includes("general")) boost += 0.04;
  if (term.domains?.includes(domain)) boost += 0.12;
  else if (term.domains?.includes("general")) boost += 0.03;
  if (term.status === "approved") boost += 0.08;
  return boost;
}

function isContentScopeCompatible(term, contentType) {
  const scopes = Array.isArray(term.contentTypes) ? term.contentTypes.filter(Boolean) : [];
  return !scopes.length || scopes.includes(contentType) || scopes.includes("general");
}

/**
 * Same folding as `normalizeSource` minus the case fold, so a case-sensitive
 * term can be compared without lowercasing the text first.
 */
function foldPreservingCase(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unorderedCharacterSimilarity(left, right) {
  const leftCounts = new Map();
  const rightCounts = new Map();
  for (const character of [...left].filter((value) => !/\s/u.test(value))) leftCounts.set(character, (leftCounts.get(character) || 0) + 1);
  for (const character of [...right].filter((value) => !/\s/u.test(value))) rightCounts.set(character, (rightCounts.get(character) || 0) + 1);
  const overlap = [...leftCounts].reduce((sum, [character, count]) => sum + Math.min(count, rightCounts.get(character) || 0), 0);
  const maximum = Math.max([...leftCounts.values()].reduce((sum, count) => sum + count, 0), [...rightCounts.values()].reduce((sum, count) => sum + count, 0));
  return maximum ? overlap / maximum : 0;
}

/**
 * 术语能不能进入模糊/智能匹配的廉价前置判断。
 *
 * 模糊路径要求编辑相似度 ≥0.78，智能路径要求无序字符相似度 ≥0.86（或全字符命中），
 * 两者都蕴含"术语的大部分字符必须出现在原文里"。所以先按字符集合算一次重合度，
 * 低于 0.6 的直接跳过——这个界远低于两条真实阈值，不会改变任何匹配结果。
 *
 * 不做这一步的代价是实测出来的：滑窗 × 每窗一次 Levenshtein + 一次无序比较，
 * 单句耗时随术语量线性上涨到 1 万条 10 秒、5 万条 48 秒，模型还没开始调用。
 */
function couldFuzzyMatch(sourceCharacters, normalizedVariant) {
  const variantCharacters = [...normalizedVariant];
  if (!variantCharacters.length) return false;
  let shared = 0;
  for (const character of variantCharacters) if (sourceCharacters.has(character)) shared += 1;
  return shared / variantCharacters.length >= 0.6;
}

/**
 * 日语形态归一：片假名/平假名互写、长音符脱落、动词活用语尾。
 *
 * 术语库登记的是辞书形（`リミットブレイク`、`解放する`），正文里却常写作
 * `リミットブレーク`、`解放して`。旧实现只做 NFKC + 全半角，这几个变化全都
 * 得靠编辑距离兜底，长的专名往往刚好压在线下。这里先把它们折叠成同一个形态，
 * 再走原有的精确/模糊/智能三级匹配。
 */
const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_FOLD_MIN_LENGTH = 4;

function katakanaToHiragana(value = "") {
  let output = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    output += code >= KATAKANA_START && code <= KATAKANA_END ? String.fromCodePoint(code - 0x60) : character;
  }
  return output;
}

const JAPANESE_VERB_TAILS = ["している", "してい", "します", "しました", "しない", "される", "された", "する", "した", "して"];

export function japaneseMatchForms(value = "") {
  const base = normalizeSource(value);
  const forms = new Set();
  if (!base) return [];
  forms.add(base);
  const folded = katakanaToHiragana(base).replace(/[\u30fc]/gu, "");
  if ([...folded].length >= KANA_FOLD_MIN_LENGTH) forms.add(folded);
  for (const tail of JAPANESE_VERB_TAILS) {
    if (!base.endsWith(tail)) continue;
    const stem = base.slice(0, base.length - tail.length);
    if ([...stem].length >= 2) forms.add(stem);
    const foldedStem = katakanaToHiragana(stem).replace(/[\u30fc]/gu, "");
    if ([...foldedStem].length >= KANA_FOLD_MIN_LENGTH) forms.add(foldedStem);
  }
  return [...forms];
}

/**
 * 长段落往往命中十几条术语：默认上限会把排在最后的正式术语整条截掉，
 * 模型看不到就等于没登记。这里按长度放宽，并且保留原文的术语永不被截断。
 */
const LONG_TEXT_THRESHOLD = 350;
/** 超过这个长度的句子不做模糊/智能匹配：一条 1000+ 字的句子乘 4 万条术语就是几十亿次比较。 */
const FUZZY_MAX_TEXT_LENGTH = 200;
const LONG_TEXT_LIMIT = 30;

/**
 * @param options.project/channel/platform/region  投放上下文。术语上标注的适用
 *   项目、渠道、平台和地区据此生效；调用方不传就等于不限定，与旧行为一致。
 * @param options.now  判定术语有效期的时点。过期、未生效和已废弃的术语不再参与
 *   匹配，因此它们既不会被强制要求，也不会再触发 QA 报错。
 *
 * 内容语体与业务领域不参与准入过滤：跨语体的术语仍会被匹配出来并标记
 * `scopeMismatch`，交由人工判断，这是既有约定。
 */
/** 术语预处理缓存：归一化文本、折叠形态和大词片段只算一次，之后每句只做查表。 */
const TERM_PREP_CACHE = new WeakMap();

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function prepareTerm(term) {
  const cached = TERM_PREP_CACHE.get(term);
  if (cached) return cached;
  const variants = [];
  for (const raw of [term.source, ...(term.aliases ?? [])].filter(Boolean)) {
    const normalized = normalizeSource(raw);
    if (!normalized) continue;
    const forms = japaneseMatchForms(raw);
    const keys = new Set();
    for (const value of [raw, normalized, ...forms]) {
      const chars = [...String(value ?? "")];
      if (!chars.length) continue;
      keys.add(chars[0]);
      if (chars.length > 1) keys.add(chars[0] + chars[1]);
    }
    const bigrams = new Set();
    const chars = [...normalized];
    for (let index = 0; index < chars.length; index += 1) {
      bigrams.add(chars[index]);
      if (index + 1 < chars.length) bigrams.add(chars[index] + chars[index + 1]);
    }
    variants.push({ raw, normalized, forms, keys, bigrams });
  }
  const prepared = { caseSensitive: Boolean(term.caseSensitive), variants };
  TERM_PREP_CACHE.set(term, prepared);
  return prepared;
}

export function matchTerms(text, assets, {
  contentType = "general",
  domain = "general",
  limit = 20,
  project = "",
  channel = "",
  platform = "",
  region = "",
  // 只算"原文里确实包含该词"的精确命中：一致性核对/术语证据只取 exact，
  // 关掉滑窗编辑距离后 5.8k 条术语从几十秒降到几十毫秒。
  exactOnly = false,
  now = new Date()
} = {}) {
  if (!assets?.locale) throw new Error("Asset collection must have an explicit locale");
  const normalizedText = normalizeSource(text);
  const caseSensitiveText = foldPreservingCase(text);
  const sourceCharacters = new Set([...normalizedText]);
  const textForms = japaneseMatchForms(text);
  const matches = [];
  // 治理准入：只保留已批准、正式层级、当前有效且投放范围命中的术语版本。
  const governedTerms = filterEffectiveTerms(assets.terms ?? [], {
    locale: assets.locale, project, channel, platform, region
  }, { now });
  // 候选预筛：精确命中要求"首两字片段"出现在原文里；模糊/智能命中要求至少共享一个
  // 两字片段。4 万条术语时这一步把每句的候选从 4 万降到几百，滑窗只在这些候选上跑。
  // 超长句子直接跳过模糊/智能匹配（见 FUZZY_MAX_TEXT_LENGTH）：长句里术语基本是原样使用，
  // 而窗口数随句子长度线性增长，是之前单句匹配超过 60 秒的根因。
  const textBigrams = new Set();
  for (const form of [normalizedText, ...textForms]) {
    const chars = [...form];
    for (let index = 0; index < chars.length; index += 1) {
      textBigrams.add(chars[index]);
      if (index + 1 < chars.length) textBigrams.add(chars[index] + chars[index + 1]);
    }
  }
  const textCharacters = [...normalizedText];
  const allowFuzzy = !exactOnly && textCharacters.length <= FUZZY_MAX_TEXT_LENGTH;
  for (const term of governedTerms) {
    const prepared = prepareTerm(term);
    const caseSensitive = prepared.caseSensitive;
    let best = null;
    for (const variant of prepared.variants) {
      const normalizedVariant = variant.normalized;
      if (!normalizedVariant) continue;
      const exactPossible = intersects(variant.keys, textBigrams);
      const exactHit = exactPossible && normalizedText.includes(normalizedVariant);
      const foldedHit = exactPossible && !exactHit
        ? variant.forms.find((form) => form !== normalizedVariant && textForms.some((textForm) => textForm.includes(form)))
        : undefined;
      if (exactHit || foldedHit) {
        // 区分大小写的术语只有大小写也一致才算精确命中；仅拼写相同的，降级成
        // 待确认提示，让人工决定 iOS / ios 是不是同一个东西。
        const caseMatched = !caseSensitive || caseSensitiveText.includes(foldPreservingCase(variant.raw));
        // 形态差异（片假名长短音、活用尾）只是写法不同，按精确命中处理，
        // 但分数略低于字面完全一致，方便排序时把完全一致的排前面。
        const exactness = normalizedVariant === normalizedText ? 1 : (foldedHit && !exactHit ? 0.9 : 0.92);
        // 形态折叠命中时 matchPhrase 仍然给登记源词：折叠形态（片假名转平假名、
        // 去掉长音符）不是原文里真实存在的字符串，不能当作"命中的片段"展示或核对。
        const candidate = caseMatched
          ? { mode: "exact", variant: variant.raw, matchPhrase: variant.raw, score: exactness, ...(foldedHit ? { variantForm: foldedHit } : {}) }
          : { mode: "fuzzy", variant: variant.raw, matchPhrase: variant.raw, score: exactness * 0.82, caseMismatch: true };
        if (!best || candidate.score > best.score) best = candidate;
        continue;
      }
      if (!allowFuzzy || normalizedVariant.length < 3) continue;
      // 一个共享的两字片段都没有的术语不可能是模糊/智能命中：直接跳过。
      if (!intersects(variant.bigrams, textBigrams)) continue;
      if (!couldFuzzyMatch(sourceCharacters, normalizedVariant)) continue;
      const size = [...normalizedVariant].length;
      const lastStart = textCharacters.length - Math.max(2, size - 1);
      for (let index = 0; index <= lastStart; index += 1) {
        const window = textCharacters.slice(index, index + size).join("");
        const editScore = similarity(window, normalizedVariant);
        const unorderedScore = unorderedCharacterSimilarity(window, normalizedVariant);
        let candidate = null;
        if (editScore >= 0.78) candidate = { mode: "fuzzy", variant: variant.raw, matchPhrase: window, score: editScore * 0.82 };
        else if ((unorderedScore === 1 && size >= 4 && editScore + Number.EPSILON >= 0.2) || (unorderedScore >= 0.86 && editScore >= 0.38)) {
          candidate = { mode: "smart", variant: variant.raw, matchPhrase: window, score: (unorderedScore * 0.72 + editScore * 0.18) * 0.82 };
        }
        if (candidate && (!best || candidate.score > best.score)) best = candidate;
      }
    }
    if (!best) continue;
    matches.push({
      ...best,
      // 归一化只做一次：最长匹配去重是 O(命中数²)，以前每次比较都重新 normalize，
      // 长句里命中上千条时会变成几十秒的纯正则开销。
      phraseKey: normalizeSource(best.matchPhrase || term.source),
      score: Math.min(1, best.score + scopeBoost(term, contentType, domain)),
      locale: assets.locale,
      scopeMismatch: !isContentScopeCompatible(term, contentType),
      caseSensitive,
      // 保留原文的术语，期望译文里出现的是原文形态本身，而不是 target 字段。
      expectedTarget: expectedTermTarget(term, { matchedSource: best.matchPhrase || term.source }),
      preserveOriginal: Boolean(term.preserveOriginal),
      working: term.working === true,
      term
    });
  }
  // 同一源词的冲突译法按库优先级收窄：数字越小优先级越高；同优先级不擅自替用户选译法，全部保留给 AI/QA 显示冲突。
  const winners = new Map();
  for (const match of matches) {
    const key = match.phraseKey || match.term.source;
    const priority = Number.isFinite(Number(match.term.libraryPriority)) ? Number(match.term.libraryPriority) : 100;
    const current = winners.get(key);
    if (!current || priority < current.priority) winners.set(key, { priority, matches: [match] });
    else if (priority === current.priority) current.matches.push(match);
  }
  const sorted = [...winners.values()].flatMap((item) => item.matches).sort((a, b) => {
    const aPriority = Number.isFinite(Number(a.term.libraryPriority)) ? Number(a.term.libraryPriority) : 100;
    const bPriority = Number.isFinite(Number(b.term.libraryPriority)) ? Number(b.term.libraryPriority) : 100;
    return aPriority - bPriority || b.score - a.score;
  });
  // 最长匹配优先：短术语落在更长命中里时不再单独下发。
  // 「パス→帕斯」嵌在「プレミアムパス→高级通行证」里、单字「運→运气」嵌在「運営」里，
  // 两条一起送进提示词就是在诱导模型把长词拆成短词的译法，也会让术语采用率虚低。
  const phraseOf = (match) => match.phraseKey || "";
  const effective = sorted.filter((match) => {
    const phrase = phraseOf(match);
    if (!phrase) return true;
    return !sorted.some((other) => {
      if (other === match) return false;
      const otherPhrase = phraseOf(other);
      return otherPhrase.length > phrase.length && otherPhrase.includes(phrase) && other.score >= match.score - 0.05;
    });
  });
  const targetLimit = [...normalizedText].length > LONG_TEXT_THRESHOLD ? Math.max(limit, LONG_TEXT_LIMIT) : limit;
  if (effective.length <= targetLimit) return effective;
  const kept = new Set(effective.filter((match) => match.preserveOriginal || match.term?.preserveOriginal));
  for (const match of effective) {
    if (kept.size >= targetLimit) break;
    kept.add(match);
  }
  return effective.filter((match) => kept.has(match));
}
