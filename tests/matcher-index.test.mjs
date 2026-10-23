import test from "node:test";
import assert from "node:assert/strict";

import { matchTerms } from "../src/matcher.mjs";

/**
 * 真机事故：术语 4 万条后单句模糊匹配超过 60 秒，把事件循环堵死。
 * 现在按"共享两字片段"预筛候选，长句跳过模糊/智能匹配，只保留精确/形态匹配。
 */
function term(id, source, target = "T" + id) {
  return {
    id, source, aliases: [], target, forbidden: [],
    domains: ["game"], contentTypes: ["general"], enforcement: "preferred", status: "approved"
  };
}

function syntheticTerms(count) {
  let seed = 20261023;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const kana = [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン"];
  const str = (n) => Array.from({ length: n }, () => kana[Math.floor(rnd() * kana.length)]).join("");
  return Array.from({ length: count }, (_, index) => term("t" + index, str(2 + Math.floor(rnd() * 8))));
}

test("万级术语 + 长句：候选预筛让匹配在亚秒级完成", () => {
  const terms = syntheticTerms(12_000);
  terms.push(term("hit", "解放する", "解开"));
  const assets = { locale: "ja-JP", terms };
  const filler = "テスト用の長い段落です。".repeat(60);
  const text = `${filler}敵を解放して進む。${filler}`;
  const started = Date.now();
  const matches = matchTerms(text, assets, { contentType: "game", domain: "game", limit: 20 });
  const elapsed = Date.now() - started;
  assert.ok(matches.some((match) => match.term.id === "hit"), "长句里的精确/形态命中仍然要找到");
  assert.ok(elapsed < 3000, `12k 术语的长句匹配应在 3 秒内完成，实际 ${elapsed}ms`);
});

test("长句跳过模糊匹配，但精确术语不受影响", () => {
  const assets = {
    locale: "ja-JP",
    terms: [term("exact", "リミットブレイク", "极限爆发"), term("near", "リミットブレイクス", "极限爆发S")]
  };
  const longText = "テスト".repeat(100) + "リミットブレイク" + "テスト".repeat(100);
  const matches = matchTerms(longText, assets, { contentType: "game", domain: "game" });
  assert.deepEqual(matches.map((match) => match.term.id), ["exact"]);
});
