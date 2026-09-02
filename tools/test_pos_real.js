// 真实数据抽样验证 stripPosLines
var POS_LABELS = {
  "n":1,"v":1,"vt":1,"vi":1,"adj":1,"adv":1,"prep":1,"conj":1,"pron":1,"interj":1,
  "art":1,"num":1,"aux":1,"int":1,"abbr":1,"pl":1,"sg":1,"vbl":1,"c":1,"t":1,"d":1,
  "aux.":1,"abbr.":1,"vbl.":1,
  "noun":1,"verb":1,"adjective":1,"adverb":1,"preposition":1,"conjunction":1,
  "pronoun":1,"interjection":1,"article":1,"numeral":1,"auxiliary":1,
  "linking verb":1,"modal verb":1,"phrasal verb":1,
  "transitive verb":1,"intransitive verb":1,
  "past tense":1,"past participle":1,"present participle":1,
  "plural":1,"singular":1,"comparative":1,"superlative":1,
  "see also":1,"short for":1,
  "n-count":1,"n-uncount":1,"n-sing":1,"n-plur":1,"n-mass":1,
  "v-int":1,"v-tr":1,"v-t":1,"v-i":1,
  "phr-v":1,"phr-modal":1,
  "动词":1,"形容词":1,"副词":1,"名词":1,"介词":1,"连词":1,
  "代词":1,"冠词":1,"数词":1,"助词":1,"叹词":1,"感叹词":1,
  "量词":1,"及物动词":1,"不及物动词":1,"及物":1,"不及物":1
};
function stripPosLines(trans) {
  var RE_TOK = /^(\s*)([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\-]*\.?)/;
  return (trans || "").split("\n").map(function (line) {
    var s = line;
    for (var i = 0; i < 2; i++) {
      var m = s.match(RE_TOK);
      if (!m) break;
      var tok = m[2].toLowerCase().replace(/\.$/, "");
      if (i === 0) {
        var probe = s.match(/^\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\-]*)\s+([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\-]*\.?)/);
        if (probe) {
          var pair = (probe[1] + " " + probe[2]).toLowerCase().replace(/\.$/, "");
          if (POS_LABELS[pair]) { s = s.slice(probe[0].length); continue; }
        }
      }
      if (POS_LABELS[tok]) s = s.slice(m[0].length);
      else break;
    }
    return s.trim();
  }).filter(function (l) { return l; }).join("\n");
}
var samples = [
  "linking verb （提供名称或信息时用）\nlinking verb 有；存在\n动词 位于；在（某处）",
  "动词 对…评价过高；高估",
  "形容词 冷峻的；表情严肃的",
  "linking verb （被认为或看作）是；被算作\nlinking verb 组成；构成"
];
samples.forEach(function (s, i) {
  console.log("==样本 " + (i + 1) + "==");
  console.log("原文:", s);
  console.log("剥离:", stripPosLines(s));
  console.log("");
});