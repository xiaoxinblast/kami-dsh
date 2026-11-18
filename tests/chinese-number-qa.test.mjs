import test from "node:test";
import assert from "node:assert/strict";
import { runQa } from "../src/qa.mjs";
import { runFactQa } from "../src/fact-schema.mjs";

function problems(source, translation) {
  const input = { source, translation, locale: "zh-CN" };
  return [...runQa(input), ...runFactQa(input).issues].map(issue => issue.type);
}

test("数字、日期、金额和百分比可使用等值中文写法", () => {
  for (const [source, translation] of [
    ["15人", "十五人"], ["１５人", "拾伍人"], ["2人", "两人"], ["1024人", "壹仟零贰拾肆人"],
    ["12,000人", "一万两千人"], ["2026年8月20日", "二〇二六年八月二十日"],
    ["15%", "百分之十五"], ["15.5％", "百分之拾伍点伍"], ["100元", "人民币壹佰元整"],
    ["15人、20人", "二十人和十五人"], ["100円", "壹佰日元"], ["100USD", "壹佰美元"],
    ["100%", "百分之百"], ["-15度", "负十五度"], ["15000人", "一点五万人"],
    ["100.05元", "壹佰元零伍分"], ["128.45元", "壹佰贰拾捌元肆角伍分"], ["在820当天", "八月二十号当天"],
    ["1USD", "一美元"], ["-15%", "负百分之十五"], ["100元", "壹佰圓整"]
  ]) assert.deepEqual(problems(source, translation), [], source + " → " + translation);
});

test("数值、单位、币种、日期、受保护内容真的改变时继续报告", () => {
  for (const [source, translation, type] of [
    ["15人", "五十人", "fact_number_missing"], ["15人", "一百五十人", "fact_number_missing"],
    ["15%", "十五人", "fact_percentage_mismatch"], ["15%", "百分之五十", "fact_percentage_mismatch"],
    ["100元", "壹佰日元", "fact_money_mismatch"], ["8月20日", "八月十二日", "fact_date_missing"],
    ["{1}", "{一}", "protected_token"], ["{1} 15人", "{1} 五十人", "fact_number_missing"],
    ["15度", "负十五度", "fact_number_missing"], ["15%", "百分之负十五", "fact_percentage_mismatch"],
    ["100USD", "壹佰日元", "fact_money_mismatch"]
  ]) assert.ok(problems(source, translation).includes(type), source + " → " + translation);
});
