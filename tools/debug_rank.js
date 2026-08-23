// 查看 treat 的完整得分排名（前 20），定位 cure/heal 的位置
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
  extractVar("SYN_CACHE"), extractFn("synCache")].join("\n"));
// 复制 computeSynonyms 但输出完整排名
eval(extractFn("computeSynonyms").replace(
  /var out = \[\];[\s\S]*?return out;/,
  `var dbg = list.slice(0, 20).map(function(h){
     var own = (window.DICT[letterOf(h.w)] || {})[h.w];
     var c = own ? (own.c || 0) : 0;
     var tks = (C.g[h.w] || []).length;
     return h.w + " | s=" + Math.round(h.s) + (h.strong ? " 强" : " 弱") + " 义项词元=" + tks + " 星=" + c + " gloss=" + h.g;
   });
   console.log(dbg.join("\\n"));
   var idx = list.findIndex(function(h){ return h.w === "cure"; });
   console.log("cure 排名:", idx >= 0 ? idx + 1 : "未入围", idx >= 0 ? "s=" + Math.round(list[idx].s) : "");
   return [];`));

const treatRow = DICT.t.treat;
console.log("=== treat 完整排名 ===");
computeSynonyms("treat", treatRow.t);
