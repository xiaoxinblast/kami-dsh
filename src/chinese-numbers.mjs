// 只生成 QA 比对用的文本，不改写译文、网址或文件中的标记。
const digits = Object.fromEntries(["零〇○", "一壹", "二两兩贰貳弐", "三叁參", "四肆", "五伍", "六陆陸", "七柒", "八捌", "九玖"]
  .flatMap((forms, value) => [...forms].map(form => [form, String(value)])));
const units = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };
const digitClass = "0-9" + Object.keys(digits).join("");
const unitClass = Object.keys(units).join("");
const quantity = new RegExp(`(百分之)?([负負]?)([${digitClass}${unitClass}]+)(?:[点點.]([${digitClass}]+)([万萬亿億])?)?`, "gu");
const words = new Intl.Segmenter("zh", { granularity: "word" });

function integerValue(text) {
  const value = [...text].map(char => digits[char] ?? char).join("");
  if (/^\d+$/u.test(value)) return value;
  // 先拆亿、再拆万，低位的小节内部按千、百、十递减。
  for (const unit of ["亿", "万"]) {
    const parts = value.replaceAll("億", "亿").replaceAll("萬", "万").split(unit);
    if (parts.length === 1) continue;
    if (parts.length !== 2 || !parts[0]) return null;
    const high = integerValue(parts[0]), low = parts[1] ? integerValue(parts[1]) : "0";
    if (high == null || low == null || BigInt(low) >= BigInt(units[unit])) return null;
    return String(BigInt(high) * BigInt(units[unit]) + BigInt(low));
  }
  let sum = 0n, previous = 10000, buffer = "";
  for (const char of value) {
    const unit = units[char];
    if (!unit) { buffer += char; continue; }
    if (unit >= previous || (!buffer && !(sum === 0n && unit === 10))) return null;
    sum += BigInt(buffer || 1) * BigInt(unit);
    previous = unit;
    buffer = "";
  }
  return String(sum + BigInt(buffer || 0));
}

export function chineseQaLocale(locale) {
  return /^zh(?:-|$)/iu.test(locale || "");
}

// 旧任务会用“820当天”这类月日简写。只在有日期语境时拆分。
export const compactCalendarDate = /(?<!\d)(1[0-2]|0?[1-9])(0[1-9]|[12]\d|3[01])(?=当天|當天|当日|當日)/gu;

export function normalizeQaQuantities(text) {
  const value = String(text ?? "").replace(/[０-９％．－]/gu, char => char.normalize("NFKC"))
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/gu, "").replace(compactCalendarDate, "$1月$2日")
    .replace(/([负負])百分之/gu, "百分之$1");
  let boundaries;
  return value.replace(quantity, (raw, percent, sign, integer, fraction, scale, offset) => {
    // 单个汉字出现在“一起、万一”等词语中，不能充当数字证据。
    const before = value[offset - 1] || "", after = value[offset + raw.length] || "";
    if (integer.length === 1 && !/\d/u.test(integer) && !percent && !fraction && !sign
      && !/[第共约約达達满滿乘加减減至到每为為有余餘剩×＝=：:]/u.test(before)
      && /\p{Script=Han}/u.test(before + after)) {
      boundaries ??= words.segment(value);
      const word = boundaries.containing(offset);
      if (word.index < offset || word.segment !== raw && !/[个個人名位只件张張本台次回级級层層章节節話话年月日号號天时時分秒元圆圓块塊点點折成倍岁歲公里米步枚发發种種組组队隊条條套周期星场場卷匹座把辆輛票颗顆刀头頭粒瓶册冊份片角支根楼樓击擊]/u.test(after)) return raw;
    }
    const whole = percent && integer === "百" ? "100" : integerValue(integer);
    if (whole == null) return raw;
    const decimals = [...(fraction || "")].map(char => digits[char] ?? char).join("");
    const shift = scale ? String(units[scale]).length - 1 : 0;
    const number = whole + decimals.padEnd(shift, "0").slice(0, shift)
      + (decimals.length > shift ? "." + decimals.slice(shift) : "");
    return (sign ? "-" : "") + number + (percent ? "%" : "");
  }).replace(/(\d+月\s*\d+)[号號]/gu, "$1日").replace(/(\d+)([元圆圓])(?:(\d)角(?:0?(\d)分)?|0?(\d)分)/gu,
    (_, amount, unit, jiao, fen, onlyFen) => `${amount}.${jiao || 0}${fen || onlyFen || 0}${unit}`)
    .replace(/(?<=\d)圓/gu, "元");
}

export function qaNumericValues(text) {
  return (normalizeQaQuantities(text).replace(/(?<=\d)-(?=\d)/gu, " ").match(/-?\d+(?:\.\d+)?/gu) || [])
    .map(value => value.replace(/^(-?)0+(?=\d)/u, "$1").replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, ""));
}
