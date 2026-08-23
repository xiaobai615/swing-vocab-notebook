// 同义词算法离线验证：从单文件 HTML 中提取真实词库与算法函数，跑测试用例
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "..", "生词本-单文件版.html");
const src = fs.readFileSync(HTML, "utf8");

// ---- 提取全部 window.DICT 分片赋值行并求值 ----
const window = {};
let p = 0, dictCount = 0;
while ((p = src.indexOf("window.DICT=window.DICT||{};", p)) >= 0) {
  const lineEnd = src.indexOf("\n", p);
  eval(src.slice(p, lineEnd));
  dictCount++;
  p = lineEnd;
}
if (!dictCount) { console.error("DICT not found"); process.exit(1); }
console.error(`已加载 ${dictCount} 个字母分片`);
const DICT = window.DICT;

// ---- 用括号计数提取函数源码 ----
function extractFn(name) {
  const key = "function " + name + "(";
  const i = src.indexOf(key);
  if (i < 0) throw new Error("fn not found: " + name);
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error("unbalanced: " + name);
}
function extractVar(varName) {
  const key = "var " + varName + " =";
  const i = src.indexOf(key);
  if (i < 0) throw new Error("var not found: " + varName);
  const end = src.indexOf(";", i);
  return src.slice(i, end + 1);
}

const code = [
  extractFn("letterOf"),
  extractFn("dlDistance"),
  extractFn("stemOf"),
  extractVar("ZH_STOP"),
  extractVar("ZH_POS_RE"),
  extractFn("zhGlosses"),
  extractVar("SYN_CACHE"),
  extractFn("synCache"),
  extractFn("computeSynonyms"),
  extractVar("SYN_SEED")
].join("\n");
eval(code);

// ---- 测试用例 ----
function show(word) {
  const shard = DICT[letterOf(word)] || {};
  const row = shard[word];
  if (!row) { console.log(`\n[${word}] 不在词库`); return; }
  const t0 = Date.now();
  const syns = computeSynonyms(word, row.t || "", shard);
  const ms = Date.now() - t0;
  console.log(`\n[${word}] 释义: ${(row.t || "").split("\n")[0].slice(0, 40)}...  (${ms}ms)`);
  if (!syns.length) console.log("  暂无同义词");
  syns.forEach((s, i) => console.log(`  ${i + 1}. ${s.word}  — ${s.gloss || "(无释义标签)"}`));
}

["treat", "cure", "heal", "happy", "big", "help", "damage", "destroy"].forEach(show);

// 噪音检查：treat 的结果里不应出现 to/thing 类功能词
const treatShard = DICT["t"] || {};
const treatSyns = computeSynonyms("treat", (treatShard.treat || {}).t || "", treatShard);
const bad = treatSyns.filter(s => ["to", "thing", "the", "of", "and"].includes(s.word));
console.log("\n噪音检查:", bad.length ? "❌ 混入功能词: " + bad.map(s => s.word).join(",") : "✅ 无功能词混入");
const hasCure = treatSyns.some(s => s.word === "cure") || treatSyns.some(s => s.word === "heal");
console.log("cure/heal 是否进入 treat 的同义词:", hasCure ? "✅" : "❌ 未找到");
