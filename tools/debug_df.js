// 调试：泛化词元的 df 值 + gravity 重复条目原因
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
eval([extractFn("letterOf"), extractVar("ZH_STOP"), extractVar("ZH_POS_RE"),
  extractFn("zhGlosses"), extractVar("SYN_CACHE"), extractFn("synCache")].join("\n"));
const C = synCache();
console.log("n =", C.n);

["大量", "国家", "计算机", "人或事物", "庄严", "严肃", "缩短", "治疗", "想象", "幻想", "公正"].forEach(t => {
  console.log(`df["${t}"] =`, C.df[t] || 0);
});

console.log("\nphenomenon srcToks:", zhGlosses(DICT.p.phenomenon.t));
console.log("\ngravity srcToks:", zhGlosses(DICT.g.gravity.t));

// gravity 的候选是否有大小写/空白变体
const hits = {};
zhGlosses(DICT.g.gravity.t).forEach(t => {
  const arr = C.tokIdx[t];
  if (arr && (t === "严肃" || t === "庄严")) console.log(`tokIdx["${t}"]:`, JSON.stringify(arr));
});
