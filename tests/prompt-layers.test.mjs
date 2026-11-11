import test from "node:test";
import assert from "node:assert/strict";

globalThis.fetch = async () => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ choices: [{ message: { content: "" } }] }) });

const { packPrompt, contextPackText, projectContextPack } = await import("../src/provider.mjs");

const styleGuide = [
  "# FF7 简体中文翻译风格指南",
  "## 1.1 引号",
  "- 中文译文只能用弯引号，禁止使用日式角引号「」",
  "## 1.2 破折号",
  "- 使用中文破折号 ——"
].join("\n");

function pack(overrides = {}) {
  return {
    source: "プレミアムパスを購入してください。",
    sourceLanguage: "日语",
    targetLocale: "zh-CN",
    targetLanguage: "简体中文",
    contentType: "store",
    contentTypeLabel: "商店 / 商品说明",
    contentTags: ["purchase_flow"],
    domain: "game",
    register: "版本、包含内容、购买条件与授权关系必须准确。",
    localeInstruction: "自然的简体中文。",
    punctuation: "中文标点全角。",
    requiredTerms: [{ source: "プレミアムパス", target: "高级通行证", preserveOriginal: true }],
    preferredTerms: [{ source: "購入", target: "购买", matchMode: "exact", note: "正式用语" }],
    protectedTokens: [],
    translationReferences: [{ source: "購入する", target: "购买" }],
    qaGuidance: [],
    styleProfile: {
      id: "style-1", name: "简体中文 general 风格", version: 4,
      instruction: "系统说明保持中性客观。",
      contentTypeDirective: "商品说明要讲清楚包含内容。",
      registerPolicy: { promotional: 0.6, casual: 0.3, generic: 0.5 },
      rules: ["数值必须精确"],
      examples: []
    },
    userProfile: { name: "风格指南", version: 2, instruction: styleGuide, examples: [{ source: "テスト", target: "测试", note: "示例" }] },
    translationSkill: { id: "skill-1", name: "稳定流程", version: 3, instruction: "先判断语境", additionalRules: ["不要过度营销"] },
    documentBrief: {
      document: { purpose: "store", tone: "正式", summary: "商店页文案" },
      section: { from: 1, to: 20, purpose: "store", tone: "正式", note: "价格与条件逐项对应" },
      notes: [{ text: "保留 <br> 标签" }],
      crossRefs: [{ ids: ["seg-1"], note: "同一道具名前后一致" }]
    },
    neighborContext: { previous: "前一句", next: "后一句", document: "商店.xlsx" },
    factSchema: { facts: [{ type: "money", value: "1200円" }], limits: [] },
    ...overrides
  };
}

test("审校与术语裁决按用途裁剪字段，不再整包外发", () => {
  const source = pack();
  const review = projectContextPack(source, "review");
  assert.equal(review.translationSkill, null, "审校不需要翻译技能");
  assert.equal(review.source, source.source);
  assert.equal(review.userProfile.instruction, styleGuide);

  const adjudicate = projectContextPack(source, "adjudicate");
  assert.equal(adjudicate.translationReferences, undefined, "裁决不需要历史译例");
  assert.equal(adjudicate.translationSkill, undefined);
  assert.equal(adjudicate.requiredTerms.length, 1);
  assert.deepEqual(adjudicate.factSchema.facts.length, 1);
});

test("初译提示词：稳定段在最前，变量段与原文在后，人工指南不再 JSON 转义", () => {
  const prompt = packPrompt(pack());
  const guideIndex = prompt.indexOf("禁止使用日式角引号");
  const referenceIndex = prompt.indexOf("历史译例");
  const briefIndex = prompt.indexOf("文件语境（来自整份文件的语境分析）");
  const sourceIndex = prompt.lastIndexOf("当前原文：");
  assert.ok(guideIndex > 0, "人工风格指南必须在提示词里");
  assert.ok(guideIndex < referenceIndex, "稳定的人工指南要排在逐段变化的译例之前");
  assert.ok(briefIndex > guideIndex, "语境档案属于变量段，排在稳定段之后");
  assert.ok(sourceIndex > referenceIndex, "原文放在最后");
  assert.match(prompt, /^你是资深游戏本地化写手/u);
  assert.ok(!prompt.includes("\\n"), "不能把整份指南转义成 \\n 串");
  assert.match(prompt, /硬规则（任何其它说明与它冲突时以硬规则为准）/u);
  assert.match(prompt, /本段所属区间：第 1–20 条/u);
});

test("同项目不同句段的提示词共享稳定前缀，只有变量段不同", () => {
  const first = packPrompt(pack({ source: "一つ目の文です。" }));
  const second = packPrompt(pack({
    source: "二つ目の文です。",
    translationReferences: [{ source: "别的一句", target: "另一句" }]
  }));
  const stableLength = first.indexOf("文件语境（来自整份文件的语境分析）");
  assert.ok(stableLength > 500);
  assert.equal(first.slice(0, stableLength), second.slice(0, stableLength), "稳定前缀必须逐字一致");
  assert.notEqual(first, second);
});

test("审校文本按投影渲染：带上人工指南、语义用途与术语，不带翻译技能", () => {
  const text = contextPackText(pack(), "review");
  assert.match(text, /人工风格指南（优先级最高/u);
  assert.match(text, /禁止使用日式角引号/u);
  assert.match(text, /内容用途：商店 \/ 商品说明/u);
  assert.match(text, /强制术语（必须逐字采用）.*高级通行证/u);
  assert.equal(text.includes("翻译技能"), false);
  assert.ok(text.trimEnd().endsWith("プレミアムパスを購入してください。"));
});

test("初译提示词分层下发工作术语与同句式参考", () => {
  const prompt = packPrompt(pack({
    workingTerms: [{ source: "プレミアムパス", target: "高级通行证", matchMode: "exact", working: true }],
    patternReferences: [{ segmentId: "seg-1", source: "プレミアムパスを買うと3個の宝箱", target: "购买高级通行证可获得 3 个宝箱", similarity: 1 }]
  }));
  assert.match(prompt, /本文件工作术语（优先级低于主术语库/u);
  assert.match(prompt, /同句式参考·机器草稿或未确认译文（/u);
  assert.match(prompt, /购买高级通行证可获得 3 个宝箱/u);
});

test("独立审校及修订不接收未核实的工作术语，正式术语仍保留", () => {
  const source = pack({ workingTerms: [{ source: "ベット", target: "贝特", working: true }] });
  assert.match(packPrompt(source), /贝特/u, "初译仍可参考文件内候选");
  for (const purpose of ["review", "revise"]) {
    const text = contextPackText(source, purpose);
    assert.doesNotMatch(text, /贝特|本文件工作术语/u, "机器候选不能作为独立 QA 的改写依据");
    assert.match(text, /高级通行证/u);
    assert.match(text, /购买/u);
    assert.match(text, /前一句/u);
  }
  assert.equal(source.workingTerms.length, 1, "投影不修改初译的上下文");
});
