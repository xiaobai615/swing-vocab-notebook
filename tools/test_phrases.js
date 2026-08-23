// 词组翻译离线验证
const fs = require("fs");
const path = require("path");
const HTML = path.join(__dirname, "..", "生词本-单文件版.html");
const src = fs.readFileSync(HTML, "utf8");

const window = { ARTICLES: [] };
let p = 0;
while ((p = src.indexOf("window.DICT=window.DICT||{};", p)) >= 0) {
  const le = src.indexOf("\n", p);
  eval(src.slice(p, le)); p = le;
}
// 外刊语料也挂上（若有）
try { eval(src.slice(src.indexOf("window.ARTICLES="), src.indexOf("\n", src.indexOf("window.ARTICLES=")))); } catch (e) {}

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
eval([extractVar("ZH_STOP"), extractVar("ZH_POS_RE"), extractFn("zhGlosses"),
  extractFn("letterOf"), extractFn("esc"), extractFn("escAttr"),
  extractVar("PHR_CORPUS"), extractFn("phraseCorpus"),
  extractVar("PHR_PREPS"), extractVar("PHR_PREP_T"), extractVar("PHR_RESULT"),
  extractFn("computePhrases"), extractFn("phrasesHtml")].join("\n"));

["treat", "deal", "look", "account"].forEach(w => {
  const phrs = computePhrases(w);
  console.log(`\n[${w}] ${phrs.length} 个词组`);
  phrs.forEach(x => console.log(`  ${w} ${x.prep}  →  ${PHR_PREP_T[x.prep] || "?"} · 语料×${x.n}`));
  const html = phrasesHtml(w, phrs);
  console.log("  HTML:", html.slice(0, 220));
});
