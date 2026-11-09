export function translationOutputIssue(value) {
  const text = String(value || "").trim();
  if (!text) return "empty_translation";
  if (/(?:^|\n)\s*(?:[#*>-]+\s*)?(?:非译文说明|非译文备注|译者说明|翻译说明)\s*(?:[（(][^\n]*?[）)])?\s*[：:]|原文件查阅失败|(?:未能|无法|不能|未成功)[^\n。]{0,40}(?:读取|查阅)[^\n。]{0,60}(?:风格指南|指南原件)|<\/?(?:think|analysis)>/iu.test(text)) return "invalid_translation";
  return "";
}

export function translationRetryReason(segment) {
  if (segment.selected === false || segment.accepted) return "";
  if (["error", "failed"].includes(segment.status)) return segment.error || "翻译失败";
  if (segment.status !== "done" && !String(segment.translation || "").trim()) return "";
  const issue = translationOutputIssue(segment.translation);
  return issue === "empty_translation" ? "未返回译文" : issue ? "译文包含非译文说明，需要重新翻译" : "";
}
