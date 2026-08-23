// 检查用户点名的词 + 一批随机词的同义词质量
const fs = require("fs");
const path = require("path");
const HTML = path.join(__dirname, "..", "生词本-单文件版.html");
const src = fs.readFileSync(HTML, "utf8");

const window = {};
let p = 0;
while ((p = src.indexOf("window.DICT=window.DICT||{};", p)) >= 0) {
  const le = src.indexOf("\n", p);
  eval(src.slice(p, le)); p = le;
}
const DICT = window.DICT;

function extractFn(name) {
  const i = src.indexOf("function " + name + "(");
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
}
function extractVar(v) {
  const i = src.indexOf("var " + v + " =");
  return src.slice(i, src.indexOf(";", i) + 1);
}
eval([extractFn("letterOf"), extractFn("dlDistance"), extractFn("stemOf"),
  extractVar("ZH_STOP"), extractVar("ZH_POS_RE"), extractFn("zhGlosses"),
  extractVar("SYN_CACHE"), extractFn("synCache"), extractFn("computeSynonyms"),
  extractVar("SYN_SEED")].join("\n"));

["fantasy", "phenomenon", "democracy", "telescope", "philosophy",
 "economy", "mountain", "computer", "justice", "gravity"].forEach(w => {
  const shard = DICT[letterOf(w)] || {};
  const row = shard[w];
  if (!row || !row.t) { console.log(`[${w}] 无释义`); return; }
  const syns = computeSynonyms(w, row.t);
  console.log(`\n[${w}] ${(row.t || "").split("\n")[0].slice(0, 36)}`);
  syns.forEach((s, i) => console.log(`  ${i + 1}. ${s.word} — ${s.gloss}`));
});
