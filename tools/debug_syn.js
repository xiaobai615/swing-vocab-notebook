// 调试：查看同义词算法内部打分
const fs = require("fs");
const path = require("path");
const HTML = path.join(__dirname, "..", "生词本-单文件版.html");
const src = fs.readFileSync(HTML, "utf8");

const window = {};
let p = 0, cnt = 0;
while ((p = src.indexOf("window.DICT=window.DICT||{};", p)) >= 0) {
  const le = src.indexOf("\n", p);
  eval(src.slice(p, le)); cnt++; p = le;
}
const DICT = window.DICT;

function extractFn(name) {
  const key = "function " + name + "(";
  const i = src.indexOf(key);
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
  extractVar("SYN_CACHE"), extractFn("synCache")].join("\n"));

const C = synCache();
console.log("n =", C.n);
["帮助", "治疗", "治愈", "医治", "表示", "处理", "对待", "康复"].forEach(t => {
  console.log(`df["${t}"] =`, C.df[t] || 0, " tokIdx:", C.tokIdx[t] ? C.tokIdx[t].length : "无");
});
["治", "疗", "助", "帮", "的", "表"].forEach(ch => {
  console.log(`charDF["${ch}"] =`, C.charDF[ch] || 0);
});

// 手动跑一遍 computeSynonyms 的打分逻辑看 help 的候选
eval(extractFn("computeSynonyms"));
const helpRow = DICT.h.help;
console.log("\nhelp srcToks:", zhGlosses(helpRow.t).slice(0, 10));
const syns = computeSynonyms("help", helpRow.t);
console.log("help 结果:", syns.map(s => s.word + "(" + s.gloss + ")").join(", "));

// cure 相对 treat 的原始分
const treatRow = DICT.t.treat;
const srcToks = zhGlosses(treatRow.t);
console.log("\ntreat srcToks:", srcToks);
const srcChars = {};
srcToks.forEach(t => { for (const ch of t) if (C.charIdx[ch]) srcChars[ch] = 1; });
console.log("treat srcChars:", Object.keys(srcChars).join(" "));
const cureToks = C.g["cure"];
console.log("cure toks:", cureToks);
cureToks.forEach(tok => {
  if (srcToks.indexOf(tok) >= 0) { console.log(`  ${tok}: 强匹配`); return; }
  let best = 0, hit = "";
  for (const ch of tok) {
    if (srcChars[ch]) {
      const sc = Math.max(1, Math.min(Math.round((C.n / C.charDF[ch]) * 1.2), 30));
      if (sc > best) { best = sc; hit = ch; }
    }
  }
  console.log(`  ${tok}: wscore(max)=${best} via "${hit}"`);
});
