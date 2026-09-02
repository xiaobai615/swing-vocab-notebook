/* ==================== 英语发音（Web Speech API，离线可用；失败时自动降级在线词典音频） ==================== */
(function () {
  var currentU = null;      // 保持引用，防止 Chrome GC 掉正在朗读的 utterance（长句中断 bug）
  var watchdog = null;      // 看门狗：TTS 静默失败（如微信内置浏览器无语音内核）时自动降级

  function pickVoice(u) {
    try {
      var vs = speechSynthesis.getVoices(), en = null;
      for (var i = 0; i < vs.length; i++) {
        if (/^en([-_]|$)/i.test(vs[i].lang)) { en = vs[i]; if (/en[-_]US/i.test(vs[i].lang)) break; }
      }
      if (en) u.voice = en;
    } catch (e) {}
  }

  function onlineFallback(text) {
    try {
      var a = new Audio("https://dict.youdao.com/dictvoice?type=2&audio=" + encodeURIComponent(text));
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  window.speakText = function (text, rate) {
    text = (text || "").trim();
    if (!text) return;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    var canTTS = false;
    try { canTTS = ("speechSynthesis" in window) && typeof SpeechSynthesisUtterance !== "undefined"; } catch (e) {}
    if (!canTTS) { onlineFallback(text); return; }
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      currentU = u;
      u.lang = "en-US"; u.rate = rate || 0.92;
      pickVoice(u);
      var started = false;
      u.onstart = function () {
        started = true;
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      };
      u.onerror = function () { if (!started) onlineFallback(text); };
      // 看门狗：1.6s 内未真正开口（部分内核 cancel 后不触发任何事件）→ 在线发音兜底
      watchdog = setTimeout(function () {
        if (!started) {
          try { speechSynthesis.cancel(); } catch (e) {}
          onlineFallback(text);
        }
        watchdog = null;
      }, 1600);
      // cancel() 后立刻 speak() 会被部分内核吞掉 → 延迟 60ms 再开口
      setTimeout(function () {
        try { speechSynthesis.speak(u); } catch (e) { onlineFallback(text); }
      }, 60);
    } catch (e) {
      onlineFallback(text);
    }
  };
  // 事件委托（捕获阶段）：拦截朗读按钮，避免触发卡片翻转/列表项点击
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    while (t && t !== document) {
      if (t.classList && t.classList.contains("speak-btn")) {
        ev.stopPropagation();
        if (ev.preventDefault) ev.preventDefault();
        window.speakText(t.getAttribute("data-w") || "", parseFloat(t.getAttribute("data-rate")) || 0.92);
        return;
      }
      t = t.parentNode;
    }
  }, true);
  // 预热语音列表（部分浏览器首次调用为空）
  try { speechSynthesis.getVoices(); } catch (e) {}
})();

/* 英语生词本 Web APP - 纯前端实现（SM-2 简化变体，与 Python 版算法一致） */
(function () {
  "use strict";

  // 兜底剥离行首全大写英文 POS 代码（N-COUNT / PHR-MODAL / VERB 等）
  var POS_STRIP = /^[A-Z][A-Z-]{1,14}\s+/;

  // 已知 POS/词性标签集合（大小写不敏感，用于行首剥离）
  // 覆盖 ECDICT 中常见的全写/缩写/含连字符/复合形式
  var POS_LABELS = {
    n:1, v:1, vt:1, vi:1, adj:1, adv:1, prep:1, conj:1, pron:1, interj:1,
    art:1, num:1, aux:1, int:1, abbr:1, pl:1, sg:1, vbl:1, c:1, t:1, d:1,
    "aux.":1, "abbr.":1, "vbl.":1,
    noun:1, verb:1, adjective:1, adverb:1, preposition:1, conjunction:1,
    pronoun:1, interjection:1, article:1, numeral:1, auxiliary:1,
    "linking verb":1, "modal verb":1, "phrasal verb":1,
    "transitive verb":1, "intransitive verb":1,
    "past tense":1, "past participle":1, "present participle":1,
    "plural":1, "singular":1, "comparative":1, "superlative":1,
    "see also":1, "short for":1,
    // 词性+次类组合（柯林斯字典常见前缀）
    "n-count":1, "n-count.":1, "n-counts":1,
    "n-uncount":1, "n-uncount.":1, "n-uncounts":1,
    "n-sing":1, "n-plur":1, "n-mass":1,
    "v-int":1, "v-tr":1, "v-t":1, "v-i":1,
    "phr-v":1, "phr-v.":1, "phr-modal":1, "phr-mod":1,
    "adj-comp":1, "adj-comp.":1, "adj-super":1, "adj-super.":1,
    "n-count-pl":1, "n-singular":1, "n-plural":1,
    "v-pass":1, "v-active":1,
    // 中文词性（ECDICT 中文翻译常用前缀）
    "动词":1, "形容词":1, "副词":1, "名词":1, "介词":1, "连词":1,
    "代词":1, "冠词":1, "数词":1, "助词":1, "叹词":1, "感叹词":1,
    "量词":1, "拟声词":1, "前缀":1, "后缀":1, "词缀":1, "缩写":1,
    "及物动词":1, "不及物动词":1, "及物":1, "不及物":1,
    "助动词":1, "情态动词":1, "系动词":1
  };

  // 剥除每一行开头的 POS 标记（最多连续剥 2 个 token，如 "linking verb"）
  function stripPosLines(trans) {
    // 中英文 POS 标签都支持；regex 用 Unicode 转义覆盖汉字（U+4E00-U+9FFF）
    var RE_TOK = /^(\s*)([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\-]*\.?)/;
    return (trans || "").split("\n").map(function (line) {
      var s = line;
      for (var i = 0; i < 2; i++) {
        var m = s.match(RE_TOK);
        if (!m) break;
        var tok = m[2].toLowerCase().replace(/\.$/, "");
        // 复合标签（两个 token）：如 "linking verb"—— 探查 "前两 token 是否在白名单"
        if (i === 0) {
          var probe = s.match(/^\s*([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\-]*)\s+([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z\-]*\.?)/);
          if (probe) {
            var pair = (probe[1] + " " + probe[2]).toLowerCase().replace(/\.$/, "");
            if (POS_LABELS[pair]) {
              s = s.slice(probe[0].length);
              continue;
            }
          }
        }
        if (POS_LABELS[tok]) s = s.slice(m[0].length);
        else break;
      }
      return s.trim();
    }).filter(function (l) { return l; }).join("\n");
  }

  // ==================== 存储层 ====================
  var KEY = "vocab-web-v1";

  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (raw) {
      try {
        var s = JSON.parse(raw);
        s.settings = s.settings || {};
        s.settings.newQuota = s.settings.newQuota || 20;
        s.settings.dayBoundary = s.settings.dayBoundary === undefined ? 4 : s.settings.dayBoundary;
        s.settings.articleThreshold = s.settings.articleThreshold || 10;
        s.settings.readLevel = s.settings.readLevel || "cet6";
        s.settings.mixQuestions = s.settings.mixQuestions === undefined ? true : !!s.settings.mixQuestions;
        s.articles = s.articles || [];
        return s;
      } catch (e) {}
    }
    // 首次运行：迁移 Python 版导出的生词本
    var notebook = {};
    var arr = (window.NOTEBOOK || []);
    arr.forEach(function (r) {
      var roots = r.roots;
      var conf = r.confusables;
      if (typeof roots === "string") {
        try { roots = JSON.parse(roots); } catch (e) { roots = []; }
      } else if (!Array.isArray(roots)) roots = [];
      if (typeof conf === "string") {
        try { conf = JSON.parse(conf); } catch (e) { conf = []; }
      } else if (!Array.isArray(conf)) conf = [];
      notebook[r.word] = {
        word: r.word,
        phonetic: r.phonetic || "",
        translation: stripPosLines(r.translation),  // 剥离旧柯林斯 POS 代码
        example: r.example || "",
        roots: roots,
        confusables: conf,
        status: r.status || "NEW",
        repetition: r.repetition || 0,
        interval_days: r.interval_days || 0,
        ef: r.ef || 2.5,
        next_review: r.next_review || "",
        added_at: r.added_at || "",
        last_reviewed: r.last_reviewed || "",
        total_reviews: r.total_reviews || 0,
        fuzzy_count: r.fuzzy_count || 0
      };
    });
    return { notebook: notebook, log: [], articles: [],
             settings: { newQuota: 20, dayBoundary: 4, articleThreshold: 10, readLevel: "cet6", mixQuestions: true } };
  }

  var state = loadState();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    scheduleAutoSync(); // 数据变化后防抖自动上传（云同步模块）
  }

  // ==================== 工具 ====================
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function todayStr(now) {
    now = now || new Date();
    var d = new Date(now);
    if (d.getHours() < state.settings.dayBoundary) d.setDate(d.getDate() - 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function addDays(dateStr, days) {
    var parts = dateStr.split("-");
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2] + days);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function firstLine(t) { t = t || ""; var i = t.indexOf("\n"); return i >= 0 ? t.slice(0, i) : t; }

  function esc(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) {
    return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // 朗读按钮（SVG 喇叭图标，不用 emoji）
  var SPK = '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg>';
  function spkBtn(word, cls) {
    return '<button class="speak-btn' + (cls ? " " + cls : "") + '" data-w="' +
      escAttr(word) + '" title="朗读"><i class="spk-w">' + SPK + "</i></button>";
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ==================== 记忆算法（SM-2 简化变体，与 scheduler.py 一致） ====================
  var EF_MIN = 1.3, EF_MAX = 2.8, INTERVAL_MAX = 180, MASTERY = 21;

  function gradeWord(row, grade, today) {
    var rep = row.repetition, interval = row.interval_days,
        ef = row.ef || 2.5, status = row.status || "NEW", fuzzyDelta = 0;
    if (grade === "know") {
      rep += 1;
      if (rep === 1) interval = 1;
      else if (rep === 2) interval = 3;
      else interval = Math.round(interval * ef);
      ef = Math.min(EF_MAX, ef + 0.05);
    } else if (grade === "fuzzy") {
      interval = interval > 0 ? Math.max(1, Math.round(interval * 0.5)) : 1;
      ef = Math.max(EF_MIN, ef - 0.15);
      fuzzyDelta = 1;
    } else if (grade === "unknown") {
      rep = 0; interval = 0;
      ef = Math.max(EF_MIN, ef - 0.20);
    }
    interval = Math.min(INTERVAL_MAX, interval);
    if (status === "NEW") status = "LEARNING";
    if (grade === "know") {
      if (status === "LEARNING" && rep >= 2) status = "REVIEWING";
      if (interval >= MASTERY) status = "MASTERED";
    } else if (grade === "unknown" && status === "MASTERED") {
      status = "REVIEWING";
    }
    var next = grade === "unknown" ? addDays(today, 1) : addDays(today, interval);
    return {
      status: status, repetition: rep, interval_days: interval,
      ef: Math.round(ef * 100) / 100, next_review: next, fuzzyDelta: fuzzyDelta
    };
  }

  function applyGrade(word, grade, today) {
    var row = state.notebook[word];
    if (!row) return null;
    var upd = gradeWord(row, grade, today);
    row.status = upd.status; row.repetition = upd.repetition;
    row.interval_days = upd.interval_days; row.ef = upd.ef;
    row.next_review = upd.next_review;
    row.last_reviewed = new Date().toISOString().slice(0, 19).replace("T", " ");
    row.total_reviews += 1;
    row.fuzzy_count += upd.fuzzyDelta;
    state.log.push({ word: word, at: new Date().toISOString(), grade: grade,
                     interval: upd.interval_days });
    if (state.log.length > 20000) state.log.splice(0, state.log.length - 20000);
    save();
    return upd;
  }

  // ==================== 学习会话（主队列 + 复现队列） ====================
  // 每日无上限，按 10 个一组自动切批；复现词穿插其中
  function buildDailyQueue() {
    var today = todayStr();
    var due = [], nw = [];
    Object.keys(state.notebook).forEach(function (w) {
      var r = state.notebook[w];
      if (r.status === "MASTERED") return;
      if (r.next_review && r.next_review <= today) due.push(r);
      else if (r.status === "NEW") nw.push(r);
    });
    due.sort(function (a, b) { return a.next_review < b.next_review ? -1 : 1; });
    return due.concat(nw);
  }

  function Session() {
    var all = buildDailyQueue();
    this.batches = [];
    for (var i = 0; i < all.length; i += 10) this.batches.push(all.slice(i, i + 10));
    this.batchIdx = 0;
    this.main = this.batches[0] || [];
    this.pending = {};           // word -> {row, dueAt}
    this.requeueCount = {};
    this.served = 0;
    this.current = null;
    this.pendingGrade = null;    // 自评暂存，等选择题后再落定
    this.fromPending = false;
    this.results = { know: 0, fuzzy: 0, unknown: 0 };
    this.servedWords = [];
    this.totalAll = all.length;
    this.batchSize = this.main.length;
  }
  Session.prototype.nextWord = function () {
    var self = this;
    for (var w in this.pending) {
      if (this.served >= this.pending[w].dueAt) {
        var it = this.pending[w]; delete this.pending[w];
        this.current = it.row; this.fromPending = true;
        this.servedWords.push(it.row.word);
        return this.current;
      }
    }
    if (this.main.length) {
      this.current = this.main.shift(); this.served += 1;
      this.fromPending = false;
      this.servedWords.push(this.current.word);
      return this.current;
    }
    // 当前批空了 → 自动进入下一批
    if (this.batchIdx + 1 < this.batches.length) {
      this.batchIdx++;
      this.main = this.batches[this.batchIdx];
      this.batchSize = this.main.length;
      this.served = 0;
      return this.nextWord();
    }
    // 残留 pending 也尝试出
    for (var w2 in this.pending) {
      var it2 = this.pending[w2]; delete this.pending[w2];
      this.current = it2.row; this.fromPending = true;
      this.servedWords.push(it2.row.word);
      return this.current;
    }
    this.current = null; return null;
  };
  Session.prototype.submitGrade = function (grade) {
    if (!this.current) return false;
    this.results[grade] += 1;
    var word = this.current.word;
    var count = this.requeueCount[word] || 0;
    if (grade === "unknown") {
      this.pending[word] = { row: this.current,
        dueAt: this.served + (3 + Math.floor(Math.random() * 3)) };
      this.requeueCount[word] = count + 1;
      return true;
    }
    if (grade === "fuzzy" && count === 0) {
      this.pending[word] = { row: this.current,
        dueAt: this.served + (3 + Math.floor(Math.random() * 3)) };
      this.requeueCount[word] = count + 1;
      return true;
    }
    return false;
  };
  Session.prototype.remaining = function () {
    return this.main.length + Object.keys(this.pending).length;
  };

  // ==================== 词典（分片懒加载） ====================
  var DICT_LOADED = {};
  var DICT_PENDING = {};

  function letterOf(word) {
    var c = word.charAt(0).toLowerCase();
    return (c >= "a" && c <= "z") ? c : "other";
  }

  function loadShard(letter, cb) {
    // 分片已内联/已加载则直接回调（单文件版与在线版均适用）
    if (window.DICT && window.DICT[letter]) {
      DICT_LOADED[letter] = true;
      cb && cb();
      return;
    }
    if (DICT_LOADED[letter]) { cb && cb(); return; }
    if (DICT_PENDING[letter]) { DICT_PENDING[letter].push(cb || function(){}); return; }
    DICT_PENDING[letter] = [cb || function(){}];
    var s = document.createElement("script");
    s.src = "data/dict_" + letter + ".js";
    s.onload = function () {
      DICT_LOADED[letter] = true;
      (DICT_PENDING[letter] || []).forEach(function (f) { f(); });
      DICT_PENDING[letter] = [];
    };
    s.onerror = function () {
      DICT_LOADED[letter] = true; // 该分片缺失视为空
      (DICT_PENDING[letter] || []).forEach(function (f) { f(); });
      DICT_PENDING[letter] = [];
    };
    document.head.appendChild(s);
  }

  function dictLookup(word) {
    var shard = window.DICT && window.DICT[letterOf(word)];
    return shard ? (shard[word] || null) : null;
  }

  // ==================== 前缀联想（近似搜索） ====================
  // 输入 com → 下拉列出 com 开头的词（按词频排序，不足时补充含 com 的词）
  // onPick 为空时仅回填输入框；否则回填后执行 onPick
  function attachSuggest(input, onPick) {
    var box = document.createElement("div");
    box.className = "ac-list hidden";
    input.parentNode.appendChild(box);
    var activeIdx = -1;

    function hide() { box.classList.add("hidden"); activeIdx = -1; }
    function items() { return Array.prototype.slice.call(box.querySelectorAll(".ac-item")); }

    function pick(el) {
      if (!el) return;
      input.value = el.getAttribute("data-w");
      hide();
      input.focus();
      if (onPick) onPick();
    }

    function render(cands, shard) {
      if (!cands.length) { hide(); return; }
      box.innerHTML = "";
      cands.forEach(function (w) {
        var d = shard[w] || {};
        var el = document.createElement("div");
        el.className = "ac-item";
        el.setAttribute("data-w", w);
        el.innerHTML = '<span class="ac-word">' + esc(w) + "</span>" +
          '<span class="ac-trans">' + esc(firstLine(d.t || "").slice(0, 30)) + "</span>";
        el.onmousedown = function (e) { e.preventDefault(); pick(el); };
        box.appendChild(el);
      });
      box.classList.remove("hidden");
    }

    input.addEventListener("input", function () {
      var q = (input.value || "").trim().toLowerCase().replace(/\u2019/g, "'");
      if (!/^[a-z']{1,}$/.test(q)) { hide(); return; }
      loadShard(letterOf(q), function () {
        var shard = (window.DICT && window.DICT[letterOf(q)]) || {};
        var pre = [], contain = [];
        Object.keys(shard).forEach(function (k) {
          if (k === q) return;
          if (k.indexOf(q) === 0) pre.push(k);
          else if (q.length >= 3 && k.indexOf(q) > 0) contain.push(k);
        });
        function byFreq(a, b) {
          return ((shard[b].c || 0) - (shard[a].c || 0)) || (a < b ? -1 : 1);
        }
        pre.sort(byFreq); contain.sort(byFreq);
        var cands = pre.slice(0, 8);
        if (cands.length < 8) cands = cands.concat(contain.slice(0, 8 - cands.length));
        render(cands, shard);
      });
    });

    input.addEventListener("keydown", function (e) {
      var list = items();
      if (!list.length) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = e.key === "ArrowDown"
          ? (activeIdx + 1) % list.length
          : (activeIdx - 1 + list.length) % list.length;
        list.forEach(function (el, i) { el.classList.toggle("active", i === activeIdx); });
        list[activeIdx].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        if (activeIdx >= 0 && activeIdx < list.length) {
          e.preventDefault();
          pick(list[activeIdx]);
        }
        // activeIdx<0 时走原有回车逻辑（查询/收录输入框原值）
      } else if (e.key === "Escape") {
        hide();
      }
    });

    input.addEventListener("blur", function () { setTimeout(hide, 150); });
  }

  // ==================== 收录 ====================
  function cleanInput(text) {
    var w = (text || "").trim().toLowerCase().replace(/\u2019/g, "'");
    if (!w) return null;
    if (!/^[a-z]+(['-][a-z]+)*$/.test(w)) return null;
    return w;
  }

  function collectWord(word, cb) {
    word = cleanInput(word);
    if (!word) { cb({ ok: false, reason: "invalid" }); return; }
    if (state.notebook[word]) { cb({ ok: false, reason: "duplicate", word: word }); return; }
    loadShard(letterOf(word), function () {
      var d = dictLookup(word);
      if (!d) {
        cb({ ok: false, reason: "not_found", word: word, shard: letterOf(word) });
        return;
      }
      var shard = window.DICT[letterOf(word)] || {};
      var roots = d.r || computeRoots(word, shard);
      var confusables = d.x || computeConfusables(word, shard);
      var now = new Date().toISOString().slice(0, 19).replace("T", " ");
      state.notebook[word] = {
        word: word, phonetic: d.p || "", translation: d.t || "",
        example: d.e || "", roots: roots, confusables: confusables,
        status: "NEW", repetition: 0, interval_days: 0, ef: 2.5,
        next_review: "", added_at: now, last_reviewed: "",
        total_reviews: 0, fuzzy_count: 0
      };
      save();
      cb({ ok: true, word: word, entry: state.notebook[word] });
    });
  }

  function suggestFromShard(word, shard) {
    // 简单候选：同一分片内编辑距离 <= 3 的词（最多 3 个）
    var pool = window.DICT[shard] || {};
    var cands = [];
    var w = word;
    Object.keys(pool).forEach(function (k) {
      if (cands.length >= 6) return;
      if (Math.abs(k.length - w.length) > 2) return;
      if (dlDistance(w, k, 3) <= 3) cands.push(k);
    });
    cands.sort();
    return cands.slice(0, 3).map(function (k) {
      return { word: k, trans: firstLine(pool[k].t).slice(0, 30) };
    });
  }

  function dlDistance(a, b, threshold) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > threshold) return threshold + 1;
    var prev = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      var cur = [i];
      for (j = 1; j <= lb; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          cur[j] = Math.min(cur[j], prev[j - 2] + 1);
        }
      }
      prev = cur;
    }
    return prev[lb];
  }

  function lcp(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  // ---------- 前端按需计算：同根词 / 形近词（分片内局部计算，毫秒级） ----------
  var SUFFIXES = ["ization", "isation", "ational", "ation", "ition", "ution",
    "sion", "tion", "ness", "ment", "ity", "ety", "ive", "ous", "ious", "eous",
    "ful", "less", "able", "ible", "ally", "ly", "er", "or", "ator", "etic",
    "ist", "ism", "al", "ic", "ing", "ed", "es", "s", "est", "y"];
  SUFFIXES.sort(function (a, b) { return b.length - a.length; });
  var PREFIXES = ["anti", "auto", "circum", "contra", "counter", "dis", "en",
    "em", "fore", "in", "im", "inter", "intra", "mis", "non", "over", "out",
    "post", "pre", "pro", "re", "semi", "sub", "super", "sur", "trans",
    "ultra", "un", "under", "up", "ab", "ad", "com", "con", "col", "cor",
    "de", "ex", "extra", "hyper", "hypo", "mono", "multi", "per", "poly",
    "tele", "tri", "uni", "be", "bi", "co"];

  function stemOf(w) {
    w = w.toLowerCase();
    for (var i = 0; i < SUFFIXES.length; i++) {
      var suf = SUFFIXES[i];
      if (w.length - suf.length >= 3 && w.slice(-suf.length) === suf) {
        return w.slice(0, w.length - suf.length);
      }
    }
    for (var j = 0; j < PREFIXES.length; j++) {
      var pre = PREFIXES[j];
      if (w.length - pre.length >= 4 && w.indexOf(pre) === 0) {
        return w.slice(pre.length);
      }
    }
    return null;
  }

  function computeConfusables(word, shard) {
    shard = shard || {};
    var hits = [];
    var keys = Object.keys(shard);
    for (var i = 0; i < keys.length; i++) {
      var cand = keys[i];
      if (cand === word) continue;
      if (Math.abs(cand.length - word.length) > 2) continue;
      var d = dlDistance(word, cand, 3);
      if (d <= 2) {
        hits.push({ d: d, w: cand, t: firstLine(shard[cand].t).slice(0, 40) });
      } else if (d <= 3 && word.length >= 5 && cand.length >= 5 && lcp(word, cand) >= 4) {
        hits.push({ d: d, w: cand, t: firstLine(shard[cand].t).slice(0, 40) });
      }
    }
    hits.sort(function (a, b) { return a.d - b.d || (a.w < b.w ? -1 : 1); });
    if (hits.length < 3) {
      // 不足 3 个时放宽到距离 3（重扫一次）
      for (var k = 0; k < keys.length; k++) {
        var c2 = keys[k];
        if (c2 === word || hits.some(function (h) { return h.w === c2; })) continue;
        if (Math.abs(c2.length - word.length) > 3) continue;
        var d2 = dlDistance(word, c2, 3);
        if (d2 === 3) hits.push({ d: d2, w: c2, t: firstLine(shard[c2].t).slice(0, 40) });
      }
      hits.sort(function (a, b) { return a.d - b.d || (a.w < b.w ? -1 : 1); });
    }
    return hits.slice(0, 6).map(function (h) { return { word: h.w, trans: h.t }; });
  }

  function computeRoots(word, shard) {
    shard = shard || {};
    var stem = stemOf(word);
    if (!stem) return [];
    var found = [];
    var keys = Object.keys(shard);
    for (var i = 0; i < keys.length; i++) {
      var cand = keys[i];
      if (cand === word) continue;
      var cs = stemOf(cand);
      if (cs && (cs === stem ||
          (cs.length >= 4 && (stem.indexOf(cs) === 0 || cs.indexOf(stem) === 0)))) {
        found.push(cand);
      }
    }
    found.sort(function (a, b) { return (shard[b].c || 0) - (shard[a].c || 0); });
    return found.slice(0, 8);
  }

  // ==================== 卡片渲染 ====================
  // 释义行拆分：先剥 POS 代码（用增强规则），再按首个空格切 [词性, 释义]；无空格整行视为释义
  function splitTrans(trans) {
    var lines = [];
    (trans || "").split("\n").forEach(function (rawLine) {
      // 用 stripPosLines 处理单行
      var line = stripPosLines(rawLine).trim();
      if (!line) return;
      var sp = line.indexOf(" ");
      if (sp > 0) {
        lines.push({ pos: line.slice(0, sp).trim(), meaning: line.slice(sp + 1).trim() });
      } else {
        lines.push({ pos: "", meaning: line });
      }
    });
    return lines;
  }

  // 释义 HTML：词性（灰小字）与释义分离，拉开间距
  function transHtml(trans) {
    return splitTrans(trans).map(function (l) {
      return '<div class="trans-line">' +
        (l.pos ? '<span class="trans-pos">' + esc(l.pos) + "</span>" : "") +
        '<span class="trans-meaning">' + esc(l.meaning) + "</span></div>";
    }).join("");
  }

  // 纯释义文本（拼写巩固模式：隐藏词性）
  function transText(trans) {
    return splitTrans(trans).map(function (l) { return l.meaning; }).join("\n");
  }

  // 同根词/易混淆词渲染为可点击链接（点击进入该词详细页）
  function linkify(word) {
    return word.replace(/'/g, "\\'");
  }

  function rootsHtml(roots) {
    if (!roots || !roots.length) return "暂无同根词";
    return roots.map(function (r) {
      return '<a class="root-link" href="javascript:void(0)" ' +
             'onclick="window.openWordDetail(\'' + linkify(r) + '\')">' +
             esc(r) + "</a>";
    }).join(" ");
  }

  function confsHtml(confusables) {
    if (!confusables || !confusables.length) return "暂无形近词";
    return confusables.map(function (c) {
      return '<div class="conf-item"><a class="conf-link" ' +
             'href="javascript:void(0)" onclick="window.openWordDetail(\'' +
             linkify(c.word) + '\')">' + esc(c.word) + "</a><span>" +
             esc(c.trans || "") + "</span></div>";
    }).join("");
  }

  function renderCardBody(row) {
    var html = "";
    html += '<div class="card-sec"><div class="sec-title">词义</div><div class="sec-body">' +
            transHtml(row.translation) + "</div></div>";
    html += '<div class="card-sec"><div class="sec-title">例句</div><div class="sec-body">' +
            esc(row.example || "暂无例句") + "</div></div>";
    html += '<div class="card-sec"><div class="sec-title">同根词</div><div class="sec-body">' +
            rootsHtml(row.roots) + "</div></div>";
    html += '<div class="card-sec"><div class="sec-title">易混淆</div><div class="sec-body">' +
            confsHtml(row.confusables) + "</div></div>";
    return html;
  }

  // 词典详情内容（查词弹窗与点击跳转共用）：音标/词义/例句/同根词/易混淆（均可点击跳转）
  function renderDictDetail(word, d) {
    var ph = d.p || "";
    if (ph && ph.charAt(0) !== "/") ph = "/" + ph + "/";
    var stars = d.c || 0;
    var shard = window.DICT[letterOf(word)] || {};
    var roots = d.r || computeRoots(word, shard);
    var conf = d.x || computeConfusables(word, shard);
    return '<div class="word-card detail-card">' +
      '<div class="word-front"><div class="word-word">' + esc(word) +
      spkBtn(word) + "</div>" +
      '<div class="word-phonetic">' + esc(ph) + "</div>" +
      (stars ? '<div class="stars">' + "★".repeat(stars) + "</div>" : "") + "</div>" +
      '<div class="word-back">' +
      '<div class="card-sec"><div class="sec-title">词义</div><div class="sec-body">' +
      transHtml(d.t) + "</div></div>" +
      '<div class="card-sec"><div class="sec-title">例句</div><div class="sec-body">' +
      esc(d.e || "暂无例句") + "</div></div>" +
      '<div class="card-sec"><div class="sec-title">同根词</div><div class="sec-body">' +
      rootsHtml(roots) + "</div></div>" +
      '<div class="card-sec"><div class="sec-title">易混淆</div><div class="sec-body">' +
      confsHtml(conf) + "</div></div>" +
      "</div></div>";
  }

  function showDetail(word) {
    var row = state.notebook[word];
    if (!row) return;
    var ph = row.phonetic || "";
    if (ph && ph.charAt(0) !== "/") ph = "/" + ph + "/";
    var body = document.createElement("div");
    body.innerHTML =
      '<div class="word-card detail-card">' +
      '<div class="word-front">' +
      '<div class="word-word">' + esc(row.word) + spkBtn(row.word) + "</div>" +
      '<div class="word-phonetic">' + esc(ph) + "</div></div>" +
      '<div class="word-back">' + renderCardBody(row) + "</div></div>";
    openModal(body);
  }

  function openModal(el) {
    $("#modalBody").innerHTML = "";
    var x = document.createElement("button");
    x.className = "modal-x";
    x.innerHTML = "&times;";
    x.setAttribute("aria-label", "关闭");
    x.onclick = closeModal;
    $("#modalBody").appendChild(x);
    $("#modalBody").appendChild(el);
    $("#modal").classList.remove("hidden");
  }
  function closeModal() { $("#modal").classList.add("hidden"); }

  // ==================== 学习流程 UI（翻卡自评 + 选择题/挖空混排） ====================
  var session = null;

  function startStudy() {
    session = new Session();
    if (!session.batches.length) {
      alert("今日没有任务，先添加一些生词吧！");
      session = null;
      return;
    }
    $("#studyHome").classList.add("hidden");
    $("#studyCard").classList.remove("hidden");
    $("#studySummary").classList.add("hidden");
    nextCard();
  }

  // ---------- 题型选择 ----------
  // 首次出词按 40% 翻卡 / 30% 选择 / 30% 挖空 混排；复现词固定翻卡自评
  function decideQType(row, fromPending) {
    if (!state.settings.mixQuestions) return "flip";
    if (fromPending) return "flip";
    var canChoice = !!(row.translation || "").trim();
    var canCloze = exampleHasWord(row);
    var r = Math.random();
    if (canChoice && canCloze) return r < 0.4 ? "flip" : (r < 0.7 ? "choice" : "cloze");
    if (canChoice) return r < 0.5 ? "flip" : "choice";
    if (canCloze) return r < 0.5 ? "flip" : "cloze";
    return "flip";
  }

  // 例句中是否出现目标词（含词形变体），决定能否出挖空题
  function exampleHasWord(row) {
    var ex = (row.example || "").toLowerCase();
    if (!ex) return false;
    var vs = wordVariants(row.word);
    for (var i = 0; i < vs.length; i++) {
      if (new RegExp("\\b" + escRe(vs[i]) + "\\b").test(ex)) return true;
    }
    return false;
  }

  // 定位例句中目标词首次出现的位置，返回前后两段
  function clozeParts(row) {
    var ex = row.example || "";
    var lower = ex.toLowerCase();
    var vs = wordVariants(row.word);
    for (var i = 0; i < vs.length; i++) {
      var m = new RegExp("\\b(" + escRe(vs[i]) + ")\\b").exec(lower);
      if (m) return { before: ex.slice(0, m.index), after: ex.slice(m.index + m[0].length) };
    }
    return null;
  }

  function shuffleArr(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // 选择题：干扰项优先取形近词释义，不足时从同分片随机补
  function buildChoice(row) {
    var correct = firstLine(row.translation).slice(0, 60);
    if (!correct) return null;
    var shard = window.DICT[letterOf(row.word)] || {};
    var opts = [correct], seen = [correct];
    (row.confusables || []).forEach(function (c) {
      if (opts.length >= 4) return;
      var t = firstLine(c.trans || "").slice(0, 60);
      if (!t || seen.indexOf(t) >= 0) return;
      seen.push(t); opts.push(t);
    });
    if (opts.length < 4) {
      var keys = Object.keys(shard), guard = 0;
      while (opts.length < 4 && guard++ < 300) {
        var d = shard[keys[Math.floor(Math.random() * keys.length)]];
        if (!d || !d.t) continue;
        var t2 = firstLine(d.t).slice(0, 60);
        if (!t2 || seen.indexOf(t2) >= 0) continue;
        seen.push(t2); opts.push(t2);
      }
    }
    if (opts.length < 4) return null;
    return { kind: "choice", correct: correct, options: shuffleArr(opts.slice()) };
  }

  // 挖空题：干扰项优先取形近词，不足时从同分片按长度相近随机补
  function buildCloze(row) {
    var parts = clozeParts(row);
    if (!parts) return null;
    var shard = window.DICT[letterOf(row.word)] || {};
    var word = row.word;
    var banned = {}; banned[word] = 1;
    wordVariants(word).forEach(function (v) { banned[v] = 1; });
    var opts = [word];
    (row.confusables || []).forEach(function (c) {
      if (opts.length >= 4 || !c.word) return;
      if (banned[c.word] || !/^[a-z][a-z'-]*$/.test(c.word)) return;
      banned[c.word] = 1; opts.push(c.word);
    });
    if (opts.length < 4) {
      var keys = Object.keys(shard), guard = 0;
      while (opts.length < 4 && guard++ < 400) {
        var k = keys[Math.floor(Math.random() * keys.length)];
        if (!k || banned[k] || Math.abs(k.length - word.length) > 3) continue;
        if (!shard[k].t) continue;
        banned[k] = 1; opts.push(k);
      }
    }
    if (opts.length < 4) return null;
    return { kind: "cloze", before: parts.before, after: parts.after,
             hint: firstLine(row.translation).slice(0, 60),
             correct: word, options: shuffleArr(opts.slice()) };
  }

  function updateStudyProgress() {
    if (!session) return;
    var batchSize = session.batches[session.batchIdx] ? session.batches[session.batchIdx].length : 0;
    var batchDone = batchSize - session.main.length;
    $("#studyProgressText").textContent = batchDone + "/" + batchSize;
    $("#studyProgressBar").style.width = (batchSize ? batchDone / batchSize * 100 : 0) + "%";
    var totalBatch = session.batches.length;
    if (totalBatch > 1) {
      $("#studyBatchText").textContent = " · 第 " + (session.batchIdx + 1) + " 批 / 共 " + totalBatch + " 批（每批 10 词）";
    } else {
      $("#studyBatchText").textContent = " · 共 " + batchSize + " 词";
    }
  }

  function fillWordCard(row) {
    var ph = (row.phonetic || "").trim();
    var phDisplay = ph ? (ph.charAt(0) === "/" ? ph : "/" + ph + "/") : "暂无音标";
    $("#cardWord").textContent = row.word;
    $("#cardPhonetic").textContent = phDisplay;
    $("#cardPhonetic").classList.toggle("no-phonetic", !ph);
    $("#cardSpeakBtn").setAttribute("data-w", row.word);
    $("#cardBackWord").textContent = row.word;
    var bp = $("#cardBackPhonetic");
    if (bp) {
      bp.textContent = phDisplay;
      bp.classList.toggle("no-phonetic", !ph);
    }
    var bs = $("#cardBackSpeakBtn");
    if (bs) bs.setAttribute("data-w", row.word);
    $("#cardTrans").innerHTML = transHtml(row.translation) ||
      '<span class="no-phonetic">（此词暂无中文释义，可在「查词典」面板手动补充）</span>';
    $("#cardExample").textContent = row.example || "暂无例句";
    $("#cardRoots").innerHTML = rootsHtml(row.roots) ||
      '<span class="no-phonetic">（暂无同根词数据）</span>';
    $("#cardConf").innerHTML = confsHtml(row.confusables) ||
      '<span class="no-phonetic">（暂无易混淆词数据）</span>';
    var stars = row.collins || 0;
    $("#cardStars").textContent = stars ? "★".repeat(stars) : "";
  }

  function renderFlip(row) {
    updateStudyProgress();
    $("#quizCard").classList.add("hidden");
    $("#wordCard").classList.remove("hidden");
    fillWordCard(row);
    var card = $("#wordCard");
    card.classList.remove("flipped");
    card.classList.remove("flip-in");
    void card.offsetWidth; // 重启动画
    card.classList.add("flip-in");
    $("#gradeRow").classList.add("hidden");
  }

  function renderQuiz(row, q) {
    updateStudyProgress();
    $("#wordCard").classList.add("hidden");
    $("#gradeRow").classList.add("hidden");
    var quiz = $("#quizCard");
    quiz.classList.remove("hidden");
    quiz.classList.remove("flip-in");
    void quiz.offsetWidth;
    quiz.classList.add("flip-in");
    var ph = row.phonetic || "";
    if (ph && ph.charAt(0) !== "/") ph = "/" + ph + "/";
    if (q.kind === "choice") {
      $("#quizKicker").textContent = "看单词，选出正确词义";
      $("#quizWord").textContent = row.word;
      $("#quizWord").classList.remove("hidden");
      $("#quizPhonetic").textContent = ph;
      $("#quizPhonetic").classList.remove("hidden");
      $("#quizSentence").classList.add("hidden");
      $("#quizHint").classList.add("hidden");
    } else {
      $("#quizKicker").textContent = "根据词义，选择补全例句的单词";
      $("#quizWord").classList.add("hidden");
      $("#quizPhonetic").classList.add("hidden");
      $("#quizSentence").classList.remove("hidden");
      $("#quizSentence").innerHTML = esc(q.before) +
        '<span class="quiz-blank">______</span>' + esc(q.after);
      $("#quizHint").classList.remove("hidden");
      $("#quizHint").textContent = "词义提示：" + q.hint;
    }
    var box = $("#quizOptions");
    box.innerHTML = "";
    var answered = false;
    q.options.forEach(function (opt) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "quiz-opt";
      b.textContent = opt;
      b.onclick = function () {
        if (answered) return;
        answered = true;
        var correct = opt === q.correct;
        $$("#quizOptions .quiz-opt").forEach(function (el) {
          el.disabled = true;
          if (el.textContent === q.correct) el.classList.add("correct");
        });
        b.classList.add(correct ? "correct" : "wrong");
        answerQuiz(row, correct);
      };
      box.appendChild(b);
    });
    $("#quizFeedback").classList.add("hidden");
    $("#btnQuizNext").classList.add("hidden");
  }

  // 巩固题作答：选对保留自评，选错降级为不认识
  function answerQuiz(row, correct) {
    var selfGrade = session ? session.pendingGrade : "fuzzy";
    finalizeWithQuiz(row, selfGrade, correct);
  }

  function nextCard() {
    if (!session) return;
    var row = session.nextWord();
    if (!row) {
      finishStudy();
      return;
    }
    // 新流程：先翻面自评，再做选择题客观检验
    renderFlip(row);
  }

  function reveal() {
    if (!$("#quizCard").classList.contains("hidden")) return; // 题型卡进行中不响应翻卡
    $("#wordCard").classList.add("flipped");
    $("#gradeRow").classList.remove("hidden");
  }

  function submitGrade(grade) {
    if (!session || !session.current) return;
    // 不立即落定分数，先暂存自评，进入选择题环节做客观确认
    session.pendingGrade = grade;
    $("#gradeRow").classList.add("hidden");
    showFollowUpQuiz(session.current, grade);
  }

  function gradeLabel(g) {
    return g === "know" ? "认识" : g === "fuzzy" ? "模糊" : "不认识";
  }

  // 翻面自评后的巩固选择题（看英文选词义）
  function showFollowUpQuiz(row, selfGrade) {
    loadShard(letterOf(row.word), function () {
      if (!session || session.current !== row) return;
      var q = buildChoice(row);
      if (!q) {
        // 凑不出选择题，直接接受自评分数
        finalizeWithQuiz(row, selfGrade, true);
        return;
      }
      renderQuiz(row, q);
      $("#quizKicker").textContent = "巩固题（你刚自评「" + gradeLabel(selfGrade) + "」）";
    });
  }

  // 选择题作答：客观检验；选对则保留自评，选错则降级为"不认识"
  function finalizeWithQuiz(row, selfGrade, quizCorrect) {
    var finalGrade = quizCorrect ? selfGrade : "unknown";
    applyGrade(row.word, finalGrade, todayStr());
    session.submitGrade(finalGrade);
    fillWordCard(row);
    var card = $("#wordCard");
    card.classList.remove("hidden");
    card.classList.add("flipped");
    var fb = $("#quizFeedback");
    fb.classList.remove("hidden");
    fb.className = "quiz-feedback " + (quizCorrect ? "ok" : "no");
    fb.innerHTML = quizCorrect
      ? "✓ 巩固正确（自评「" + gradeLabel(selfGrade) + "」）"
      : "✗ 巩固出错，已记为「不认识」";
    $("#btnQuizNext").classList.remove("hidden");
    fb.scrollIntoView({ block: "nearest" });
  }

  function showStudySummary(title, detail) {
    var el = $("#studySummary");
    el.innerHTML = "<b>" + esc(title) + "</b><span>" + esc(detail) + "</span>";
    el.classList.remove("hidden");
  }

  function finishStudy() {
    var r = session.results;
    var done = session.totalAll;
    var totalBatches = session.batches.length;
    session = null;
    $("#studyCard").classList.add("hidden");
    $("#studyHome").classList.remove("hidden");
    refreshStudyHome();
    showStudySummary("本次完成 " + done + " 词" + (totalBatches > 1 ? "（" + totalBatches + " 组）" : ""),
      "认识 " + r.know + " · 模糊 " + r.fuzzy + " · 不认识 " + r.unknown);
    refreshList(); refreshStats();
  }

  function stopStudy() {
    session = null;
    $("#studyCard").classList.add("hidden");
    $("#studyHome").classList.remove("hidden");
    refreshStudyHome();
    refreshList(); refreshStats();
  }

  // ==================== 拼写巩固（看中文拼英文） ====================
  // 规则：错的单词要拼对为止（最多 5 次），通过后计入完成
  var spell = null; // {queue, idx, correct, wrong, done, attempts, checked}

  function todaySpellWords() {
    var today = todayStr();
    var words = [];
    state.log.forEach(function (l) {
      if ((l.at || "").slice(0, 10) === today && state.notebook[l.word]) {
        words.push(l.word);
      }
    });
    return words;
  }

  function startSpell(words) {
    var seen = {}, list = [];
    (words || []).forEach(function (w) {
      if (w && state.notebook[w] && !seen[w]) { seen[w] = 1; list.push(w); }
    });
    if (!list.length) {
      alert("暂无可用单词：先学完一批生词再来拼写巩固吧！");
      return;
    }
    spell = {
      queue: list.slice(), idx: 0, correct: 0, wrong: 0,
      done: {}, attempts: {}, checked: false
    };
    $("#studyHome").classList.add("hidden");
    $("#studyCard").classList.add("hidden");
    $("#spellCard").classList.remove("hidden");
    spellNext();
  }

  function spellDoneCount() {
    return Object.keys(spell.done).length;
  }

  function spellNext() {
    var s = spell;
    if (!s) return;
    // 跳过已完成的
    while (s.idx < s.queue.length && s.done[s.queue[s.idx]]) {
      s.idx++;
    }
    if (s.idx >= s.queue.length) {
      spellFinish();
      return;
    }
    var row = state.notebook[s.queue[s.idx]];
    $("#spellCn").textContent = transText(row.translation) || "暂无释义";
    var stars = row.collins || 0;
    $("#spellStars").textContent = stars ? "★".repeat(stars) : "";
    $("#spellFeedback").classList.add("hidden");
    $("#spellFeedback").className = "spell-feedback hidden";
    $("#spellHint").textContent = "";
    var inp = $("#spellInput");
    inp.value = ""; inp.classList.remove("correct", "wrong"); inp.disabled = false;
    $("#btnSpellCheck").textContent = "检查";
    $("#btnSpellCheck").className = "btn btn-primary";
    s.checked = false;
    var done = spellDoneCount();
    $("#spellProgressText").textContent = done + "/" + s.queue.length;
    $("#spellProgressBar").style.width = (s.queue.length ? done / s.queue.length * 100 : 0) + "%";
    setTimeout(function () { inp.focus(); }, 60);
  }

  function checkSpell() {
    if (!spell) return;
    var s = spell;
    var target = s.queue[s.idx];
    var answer = ($("#spellInput").value || "").trim().toLowerCase();
    var fb = $("#spellFeedback");

    // 已通过本题 → 「下一题」按钮触发
    if (s.checked) {
      var inp = $("#spellInput");
      inp.disabled = false; inp.classList.remove("correct", "wrong");
      s.checked = false; spellNext();
      return;
    }

    if (answer === target) {
      s.correct += 1;
      if (!s.attempts[target]) s.correctFirstTry = (s.correctFirstTry || 0) + 1;
      s.done[target] = 1;
      $("#spellInput").classList.add("correct");
      $("#spellInput").disabled = true;
      $("#btnSpellCheck").textContent = "下一题 →";
      $("#btnSpellCheck").className = "btn btn-primary";
      fb.classList.remove("hidden");
      fb.className = "spell-feedback fb-ok";
      fb.innerHTML = "✓ 拼写正确！";
      s.checked = true;
      // 即时更新进度
      var done = spellDoneCount();
      $("#spellProgressText").textContent = done + "/" + s.queue.length;
      $("#spellProgressBar").style.width = (s.queue.length ? done / s.queue.length * 100 : 0) + "%";
    } else {
      s.wrong += 1;
      s.attempts[target] = (s.attempts[target] || 0) + 1;
      fb.classList.remove("hidden");
      fb.className = "spell-feedback fb-no";
      if (s.attempts[target] >= 5) {
        // 5 次都没拼对，本题放过，计入"完成"
        s.done[target] = 1;
        $("#spellInput").classList.add("wrong");
        $("#spellInput").disabled = true;
        $("#btnSpellCheck").textContent = "下一题 →";
        $("#btnSpellCheck").className = "btn btn-primary";
        fb.innerHTML = "✗ 5 次都没拼对，跳过本词<br><span class='fb-answer'>正确答案：" + esc(target) + "</span>";
        s.checked = true;
        var done2 = spellDoneCount();
        $("#spellProgressText").textContent = done2 + "/" + s.queue.length;
        $("#spellProgressBar").style.width = (s.queue.length ? done2 / s.queue.length * 100 : 0) + "%";
      } else {
        // 错的！要让用户拼对为止，清空输入框并提示首字母
        $("#spellInput").classList.remove("wrong");
        $("#spellInput").value = "";
        $("#spellInput").focus();
        fb.innerHTML = "✗ 拼错了，请再试一次（第 " + s.attempts[target] + " 次 / 共 5 次）<br>" +
          "<span class='fb-answer'>首字母：" + esc(target.charAt(0).toUpperCase()) + "</span>";
        $("#btnSpellCheck").textContent = "再检查";
      }
    }
  }

  function spellNext() {
    var s = spell;
    if (s.idx >= s.queue.length) { spellFinish(); return; }
    var row = state.notebook[s.queue[s.idx]];
    $("#spellCn").textContent = transText(row.translation) || "暂无释义";
    var stars = row.collins || 0;
    $("#spellStars").textContent = stars ? "★".repeat(stars) : "";
    $("#spellFeedback").classList.add("hidden");
    $("#spellFeedback").className = "spell-feedback hidden";
    $("#spellHint").textContent = "";
    var inp = $("#spellInput");
    inp.value = ""; inp.classList.remove("correct", "wrong"); inp.disabled = false;
    $("#btnSpellCheck").textContent = "检查";
    $("#btnSpellCheck").className = "btn btn-primary";
    s.checked = false;
    $("#spellProgressText").textContent = s.idx + "/" + s.queue.length;
    $("#spellProgressBar").style.width = (s.idx / s.queue.length * 100) + "%";
    setTimeout(function () { inp.focus(); }, 60);
  }

  function checkSpell() {
    if (!spell) return;
    var s = spell;
    if (s.checked) {  // 已检查过 -> 推进到下一题
      s.idx += 1;
      spellNext();
      return;
    }
    var target = s.queue[s.idx];
    var answer = ($("#spellInput").value || "").trim().toLowerCase();
    var fb = $("#spellFeedback");
    fb.classList.remove("hidden");
    if (answer === target) {
      s.correct += 1;
      $("#spellInput").classList.add("correct");
      fb.className = "spell-feedback fb-ok";
      fb.innerHTML = "✓ 拼写正确！";
    } else {
      s.wrong += 1;
      $("#spellInput").classList.add("wrong");
      fb.className = "spell-feedback fb-no";
      fb.innerHTML = "✗ 再记一下<br><span class='fb-answer'>正确答案：" +
        esc(target) + "</span>";
    }
    s.checked = true;
    $("#spellInput").disabled = true;
    $("#btnSpellCheck").textContent = "下一题 →";
    $("#btnSpellCheck").className = "btn btn-primary";
  }

  function spellHint() {
    if (!spell || spell.checked) return;
    var target = spell.queue[spell.idx];
    $("#spellHint").innerHTML = "首字母提示：<b>" + esc(target.charAt(0).toUpperCase()) +
      "</b>（点击收起 <button class='hint-btn' onclick='window.__hideHint && window.__hideHint()'>×</button>）";
  }

  function spellFinish() {
    var s = spell;
    var passRate = s.queue.length ? Math.round(spellDoneCount() / s.queue.length * 100) : 0;
    spell = null;
    $("#spellCard").classList.add("hidden");
    $("#studyHome").classList.remove("hidden");
    refreshStudyHome();
    showStudySummary("拼写完成 " + passRate + "%",
      "首次拼对 " + (s.correctFirstTry || 0) + " · 共 " + s.queue.length + " 词 · 尝试 " +
      (s.correct + s.wrong) + " 次");
    refreshList(); refreshStats();
  }

  function spellQuit() {
    spell = null;
    $("#spellCard").classList.add("hidden");
    $("#studyHome").classList.remove("hidden");
    refreshStudyHome();
  }

  function refreshStudyHome() {
    var today = todayStr();
    var due = 0, nw = 0;
    Object.keys(state.notebook).forEach(function (w) {
      var r = state.notebook[w];
      if (r.status === "MASTERED") return;
      if (r.next_review && r.next_review <= today) due += 1;
      else if (r.status === "NEW") nw += 1;
    });
    var total = due + nw;  // 每日数量不限制
    $("#taskNum").textContent = total;
    $("#taskDetail").textContent = "到期复习 " + due + " · 新词 " + nw +
      (total > 10 ? "（每 10 词一组）" : "");
    if (total === 0) $("#btnStartStudy").textContent = "今日已完成，休息一下吧";
    else $("#btnStartStudy").textContent = "开始学习";
    // 外刊阈值提示
    var tip = document.getElementById("articleTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "articleTip";
      tip.className = "article-tip";
      $("#studyHome").insertBefore(tip, $("#btnSpellHome"));
    }
    var nwAll = Object.keys(state.notebook).length;
    var thr = state.settings.articleThreshold || 10;
    if (nwAll >= thr && (window.ARTICLES || []).length) {
      tip.innerHTML = '已积累 <b>' + nwAll + '</b> 个生词，去 <a href="javascript:void(0)" onclick="window.switchView(\'articles\')">外刊</a> 智能推荐：收获新词 + 巩固记忆';
      tip.style.display = "block";
    } else {
      tip.style.display = "none";
    }
  }

  // ==================== 生词本列表 ====================
  function refreshList(filter) {
    var q = (filter == null ? $("#searchBox").value : filter).trim().toLowerCase();
    var words = Object.keys(state.notebook).filter(function (w) {
      return !q || w.indexOf(q) >= 0;
    }).sort();
    $("#listCount").textContent = words.length + " 词";
    var box = $("#wordList");
    if (!words.length) {
      box.innerHTML = '<div class="word-list-empty">' +
        (q ? "没有匹配的单词" : "生词本为空，去「收录」添加吧") + "</div>";
      return;
    }
    box.innerHTML = "";
    words.forEach(function (w) {
      var r = state.notebook[w];
      var item = document.createElement("div");
      item.className = "word-item";
      item.innerHTML =
        '<span class="wi-word">' + esc(w) + spkBtn(w, "sm") + "</span>" +
        '<span class="wi-trans">' + esc(firstLine(r.translation).slice(0, 26)) + "</span>" +
        '<span class="wi-status st-' + r.status + '">' + statusText(r.status) + "</span>";
      item.onclick = function () { showDetail(w); };
      box.appendChild(item);
    });
  }

  function statusText(s) {
    return { NEW: "待学", LEARNING: "学习中", REVIEWING: "复习中", MASTERED: "已掌握" }[s] || s;
  }

  // ==================== 统计 ====================
  function refreshStats() {
    var counts = { NEW: 0, LEARNING: 0, REVIEWING: 0, MASTERED: 0 };
    Object.keys(state.notebook).forEach(function (w) {
      var s = state.notebook[w].status;
      counts[s] = (counts[s] || 0) + 1;
    });
    var total = Object.keys(state.notebook).length;
    var today = todayStr();
    var todayDone = state.log.filter(function (l) {
      return (l.at || "").slice(0, 10) === today;
    }).length;
    var days = {};
    state.log.forEach(function (l) { days[(l.at || "").slice(0, 10)] = 1; });
    var streak = calcStreak(Object.keys(days));

    $("#statsGrid").innerHTML =
      statCard("acc", total, "总词数") +
      statCard("", counts.NEW, "待学") +
      statCard("", counts.LEARNING, "学习中") +
      statCard("", counts.REVIEWING, "复习中") +
      statCard("acc", counts.MASTERED, "已掌握") +
      statCard("", todayDone, "今日完成");

    var weak = Object.keys(state.notebook)
      .filter(function (w) { return state.notebook[w].fuzzy_count > 0; })
      .sort(function (a, b) {
        return state.notebook[b].fuzzy_count - state.notebook[a].fuzzy_count;
      }).slice(0, 10);
    var html = '<div class="extra-row"><span>连续学习</span><b>' + streak + " 天</b></div>";
    if (weak.length) {
      html += '<div class="extra-row" style="margin-top:6px;"><span>薄弱词 Top' +
        Math.min(weak.length, 10) + "</span></div>" + weak.map(function (w) {
          return '<div class="extra-row weak"><span>' + esc(w) +
            "</span><span>模糊 " + state.notebook[w].fuzzy_count + " 次</span></div>";
        }).join("");
    }
    $("#statsExtra").innerHTML = html;
  }

  function statCard(cls, num, label) {
    return '<div class="stat-card ' + cls + '"><div class="stat-num">' + num +
      '</div><div class="stat-label">' + label + "</div></div>";
  }

  function calcStreak(days) {
    if (!days.length) return 0;
    var set = {};
    days.forEach(function (d) { set[d] = 1; });
    var cur = new Date();
    var ds = todayStr(cur);
    if (!set[ds]) { cur.setDate(cur.getDate() - 1); ds = todayStr(cur); }
    if (!set[ds]) return 0;
    var n = 0;
    while (set[ds]) { n += 1; cur.setDate(cur.getDate() - 1); ds = todayStr(cur); }
    return n;
  }

  // ==================== 收录 UI ====================
  function renderReport(okList, dupList, missList) {
    var box = $("#addReport");
    var html = '<div class="report">';
    if (okList.length) html += '<div class="r-ok">新收录 ' + okList.length +
      "：" + esc(okList.join("、")) + "</div>";
    if (dupList.length) html += '<div class="r-dup">已在生词本 ' + dupList.length +
      "：" + esc(dupList.join("、")) + "</div>";
    if (missList.length) {
      html += '<div class="r-miss">未找到 ' + missList.length + "：</div>";
      missList.forEach(function (m) {
        html += '<div class="r-miss">' + esc(m.word) + " → 候选：" +
          esc(m.cands.map(function (c) { return c.word; }).join("、") || "无") + "</div>";
      });
    }
    html += "</div>";
    box.innerHTML = html;
    box.classList.remove("hidden");
  }

  function addOne() {
    var word = $("#addInput").value;
    if (!word.trim()) return;
    collectWord(word, function (r) {
      if (r.ok) {
        renderReport([word], [], []);
        refreshList(); refreshStats(); refreshStudyHome();
        $("#addInput").value = "";
      } else if (r.reason === "duplicate") {
        renderReport([], [word], []);
      } else if (r.reason === "invalid") {
        alert("输入无效，仅允许英文字母、连字符与撇号。");
      } else {
        loadShard(r.shard, function () {
          var cands = suggestFromShard(r.word, r.shard);
          renderReport([], [], [{ word: r.word, cands: cands }]);
        });
      }
    });
  }

  function addBulk() {
    var text = $("#bulkInput").value;
    var raw = text.split(/[\s,，;；]+/).filter(function (x) { return x; });
    if (!raw.length) return;
    var seen = {}, list = [];
    raw.forEach(function (x) {
      var w = cleanInput(x);
      if (w && !seen[w]) { seen[w] = 1; list.push(w); }
    });
    var ok = [], dup = [], miss = [];
    var i = 0;
    function next() {
      if (i >= list.length) {
        renderReport(ok, dup, miss);
        refreshList(); refreshStats(); refreshStudyHome();
        return;
      }
      var w = list[i++];
      collectWord(w, function (r) {
        if (r.ok) ok.push(w);
        else if (r.reason === "duplicate") dup.push(w);
        else {
          loadShard(r.shard, function () {
            miss.push({ word: w, cands: suggestFromShard(w, r.shard) });
            next();
          });
          return;
        }
        next();
      });
    }
    next();
  }

  // ==================== 查词典（详细释义，可选加入生词本） ====================
  function lookupWord() {
    var word = cleanInput($("#lookupInput").value);
    if (!word) { alert("请输入有效的英文单词。"); return; }
    loadShard(letterOf(word), function () {
      var d = dictLookup(word);
      if (!d) {
        var cands = suggestFromShard(word, letterOf(word));
        var html = '<div class="word-card detail-card">' +
          '<div class="word-front"><div class="word-word">' + esc(word) + spkBtn(word) + "</div></div>" +
          '<div class="word-back"><div class="card-sec"><div class="sec-title">查询结果</div>' +
          '<div class="sec-body">词库（牛津高阶常用词）中未收录该词。</div></div>';
        if (cands.length) {
          html += '<div class="card-sec"><div class="sec-title">相近拼写</div><div class="sec-body">' +
            confsHtml(cands) + "</div></div>";
        }
        html += "</div></div>";
      var b1 = document.createElement("div");
      b1.innerHTML = html;
      openModal(b1);
      return;
    }
    // 详细释义：完整义项 + 例句 + 同根词 + 形近词 + 星级（均可点击跳转）
    showDictDetail(word, d);
  });
  }

  // 词典详细页弹窗（查词 / 点击混淆词、同根词、文章生词跳转共用）
  // onCollected(word)：收录成功后的回调（如文章内高亮该词）
  function showDictDetail(word, d, onCollected) {
    var inBook = !!state.notebook[word];
    var body = document.createElement("div");
    body.innerHTML = renderDictDetail(word, d);
    var addBtn = document.createElement("button");
    addBtn.className = "btn btn-primary";
    addBtn.style.width = "100%";
    addBtn.textContent = inBook ? "已在生词本中 ✓" : "加入生词本";
    addBtn.disabled = inBook;
    addBtn.onclick = function () {
      collectWord(word, function (r) {
        if (r.ok) {
          addBtn.textContent = "已加入生词本 ✓"; addBtn.disabled = true;
          refreshList(); refreshStats(); refreshStudyHome();
          if (onCollected) onCollected(word);
        } else if (r.reason === "duplicate") {
          addBtn.textContent = "已在生词本中 ✓"; addBtn.disabled = true;
        }
      });
    };
    body.appendChild(addBtn);
    openModal(body);
  }

  // 点击混淆词/同根词：打开该词的详细页（词库查不到则显示相近词）
  function openWordDetail(word) {
    word = (word || "").trim().toLowerCase();
    if (!word) return;
    loadShard(letterOf(word), function () {
      var d = dictLookup(word);
      if (d) { showDictDetail(word, d); return; }
      var cands = suggestFromShard(word, letterOf(word));
      var html = '<div class="word-card detail-card">' +
        '<div class="word-front"><div class="word-word">' + esc(word) + spkBtn(word) + "</div></div>" +
        '<div class="word-back"><div class="card-sec"><div class="sec-title">查询结果</div>' +
        '<div class="sec-body">词库（牛津高阶常用词）中未收录该词。</div></div>';
      if (cands.length) {
        html += '<div class="card-sec"><div class="sec-title">相近拼写</div><div class="sec-body">' +
          confsHtml(cands) + "</div></div>";
      }
      html += "</div></div>";
      var body = document.createElement("div");
      body.innerHTML = html;
      openModal(body);
    });
  }

  // ==================== 设置 ====================
  function saveSettings() {
    var q = parseInt($("#setQuota").value, 10);
    var b = parseInt($("#setBoundary").value, 10);
    var t = parseInt($("#setArtThreshold").value, 10);
    if (isNaN(q) || q < 5 || q > 100) { alert("每日新词配额需在 5~100 之间"); return; }
    if (isNaN(b) || b < 0 || b > 23) { alert("日界时刻需在 0~23 之间"); return; }
    if (isNaN(t) || t < 5 || t > 50) { alert("外刊匹配阈值需在 5~50 之间"); return; }
    state.settings.newQuota = q;
    state.settings.dayBoundary = b;
    state.settings.articleThreshold = t;
    state.settings.readLevel = $("#setReadLevel").value;
    state.settings.mixQuestions = $("#setMixQ").checked;
    save();
    refreshStudyHome();
    alert("设置已保存。");
  }

  function exportData() {
    var blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vocab-backup-" + todayStr() + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data.notebook) throw new Error("bad");
        state = data;
        save();
        alert("导入成功，共 " + Object.keys(state.notebook).length + " 词。");
        refreshAll();
      } catch (e) { alert("文件格式不正确。"); }
    };
    reader.readAsText(file);
  }

  // 导入外刊文章（JSON 数组，字段：id/title/source/level/topic/content/summary/structure/key_words/hard）
  function importArticles(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var list = Array.isArray(data) ? data : (data.articles || []);
        if (!list.length) throw new Error("empty");
        var ok = 0;
        list.forEach(function (a) {
          if (a && a.id && a.title && a.content) {
            if (!a.level || !LEVEL_ORDER[a.level]) a.level = "cet6";
            if (!a.word_count) a.word_count = a.content.split(/\s+/).length;
            a._user = true;
            ok++;
          }
        });
        state.articles = (state.articles || []).concat(list);
        ART_INDEX = null; // 文章库变化，推荐索引需重建
        save();
        alert("导入成功 " + ok + " 篇文章。");
        renderArticleHome();
      } catch (e) { alert("文章文件格式不正确（需为 JSON 数组，含 id/title/content）。"); }
    };
    reader.readAsText(file);
  }

  function resetData() {
    if (!confirm("确定清空全部生词与学习进度？此操作不可恢复（建议先导出备份）。")) return;
    state.notebook = {}; state.log = [];
    save();
    refreshAll();
    alert("已清空。");
  }

  // ==================== 导航 ====================
  function switchView(name) {
    $$(".view").forEach(function (v) { v.classList.remove("active"); });
    $("#view-" + name).classList.add("active");
    $$(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === name);
    });
    if (name === "list") refreshList();
    if (name === "mine") { refreshStats(); loadSettingsUI(); }
    if (name === "study") refreshStudyHome();
    if (name === "articles") renderArticleHome();
  }

  window.switchView = switchView;

  function loadSettingsUI() {
    $("#setQuota").value = state.settings.newQuota || 20;
    $("#setBoundary").value = state.settings.dayBoundary || 4;
    $("#setArtThreshold").value = state.settings.articleThreshold || 10;
    $("#setReadLevel").value = state.settings.readLevel || "cet6";
    $("#setMixQ").checked = state.settings.mixQuestions !== false;
  }

  function refreshAll() {
    refreshStudyHome(); refreshList(); refreshStats(); refreshStreak();
  }

  // ==================== 事件绑定 ====================
  function bind() {
    $$(".tab").forEach(function (t) {
      t.onclick = function () { switchView(t.getAttribute("data-view")); };
    });
    $("#tabFab").onclick = function () { switchView("add"); };
    $("#btnStartStudy").onclick = startStudy;
    $("#btnSpellHome").onclick = function () { startSpell(todaySpellWords()); };
    $("#btnSpellCheck").onclick = checkSpell;
    $("#btnSpellQuit").onclick = spellQuit;
    $("#spellInput").onkeydown = function (e) { if (e.key === "Enter") checkSpell(); };
    window.__hideHint = function () { $("#spellHint").textContent = ""; };
    window.openWordDetail = openWordDetail;
    $("#wordCard").onclick = reveal;
    $("#btnStopStudy").onclick = stopStudy;
    $("#btnQuizNext").onclick = function () { if (session) nextCard(); };
    $$(".btn-grade").forEach(function (b) {
      b.onclick = function (e) { e.stopPropagation(); submitGrade(b.getAttribute("data-grade")); };
    });
    $("#searchBox").oninput = function () { refreshList(this.value); };
    $("#btnLookup").onclick = lookupWord;
    $("#lookupInput").onkeydown = function (e) { if (e.key === "Enter") lookupWord(); };
    $("#btnAdd").onclick = addOne;
    $("#addInput").onkeydown = function (e) { if (e.key === "Enter") addOne(); };
    // 前缀联想：查词典（选中即查询）与添加生词（选中仅填入，回车/按钮确认收录）
    attachSuggest($("#lookupInput"), function () { lookupWord(); });
    attachSuggest($("#addInput"), null);
    $("#btnBulk").onclick = addBulk;
    $("#btnSaveSettings").onclick = saveSettings;
    $("#btnExportData").onclick = exportData;
    $("#btnImportData").onclick = function () { $("#fileImport").click(); };
    $("#fileImport").onchange = function () {
      if (this.files && this.files[0]) importData(this.files[0]);
      this.value = "";
    };
    $("#btnResetData").onclick = resetData;
    $("#btnImportArticles").onclick = function () { $("#fileArticles").click(); };
    $("#fileArticles").onchange = function () {
      if (this.files && this.files[0]) importArticles(this.files[0]);
      this.value = "";
    };
    // 文章正文：已高亮生词点击弹注释；普通单词点击查词典并可收录
    $("#articleRoot").addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.tagName === "MARK") {
        e.stopPropagation();
        showArticleKw(t.getAttribute("data-w"), t.textContent);
        return;
      }
      if (t && t.classList && t.classList.contains("aw")) {
        e.stopPropagation();
        articleWordTap(t.getAttribute("data-t"));
        return;
      }
      if (t && t.classList && t.classList.contains("aw-known")) {
        e.stopPropagation();
        articleWordTap(t.getAttribute("data-t"));
      }
    });
    $("#modalMask").onclick = closeModal;
  }

  // ==================== 外刊匹配引擎 ====================
  var LEVEL_META = {
    cet4: { cn: "四级", short: "CET-4" },
    cet6: { cn: "六级", short: "CET-6" },
    kaoyan: { cn: "考研", short: "Kaoyan" }
  };
  var LEVEL_ORDER = { cet4: 1, cet6: 2, kaoyan: 3 };

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // 词形变体（规则还原：复数/时态/ing 等，用于匹配文章中的变形）
  function wordVariants(word) {
    var v = [word];
    if (word.length < 3) return v;
    if (word.endsWith("y")) {
      v.push(word.slice(0, -1) + "ies", word.slice(0, -1) + "ied");
    }
    if (word.endsWith("e")) {
      v.push(word.slice(0, -1) + "ing", word.slice(0, -1) + "ed");
    }
    v.push(word + "s", word + "es", word + "ed", word + "ing", word + "er", word + "est");
    if (/[bdfgklmnprt]$/.test(word)) {
      v.push(word + word.slice(-1) + "ing", word + word.slice(-1) + "ed");
    }
    return v.filter(function (x, i) { return v.indexOf(x) === i; });
  }

  function allArticles() {
    return (window.ARTICLES || []).concat(state.articles || []);
  }

  // ==================== 智能推荐引擎（收获导向） ====================
  // 思路：不再问"哪篇文章包含我已收录的词"（生词本小则命中必然低），
  // 而是问"哪篇文章能让我学到最多值得学的新词 + 顺便巩固快忘的生词"。
  // 第一步预扫描文章库建索引（与生词本无关，可缓存）；第二步结合生词本实时排序。

  var ART_INDEX = null; // { lemma: {token -> 原形}, counts: {articleId -> {word -> 次数}} }

  function buildArtIndex(onProgress, done) {
    if (ART_INDEX) { done(); return; }
    var arts = allArticles();
    if (!arts.length) { done(); return; }
    var uniq = {};
    arts.forEach(function (a) {
      (a.content || "").toLowerCase().match(/[a-z][a-z'-]*/g).forEach(function (t) {
        if (t.length >= 3 && !STOPWORDS[t]) uniq[t] = 1;
      });
    });
    var tokens = Object.keys(uniq);
    var letters = [];
    tokens.forEach(function (t) {
      var L = letterOf(t);
      if (letters.indexOf(L) < 0) letters.push(L);
    });
    var li = 0;
    (function nextLetter() {
      if (li >= letters.length) { finishIndex(arts, tokens, done); return; }
      onProgress && onProgress("正在加载词库分片（" + (li + 1) + "/" + letters.length + "）…");
      loadShard(letters[li++], nextLetter);
    })();
  }

  function finishIndex(arts, tokens, done) {
    // 词元 -> 词典原形（词典可查且有释义才算有效候选）
    var lemma = {};
    tokens.forEach(function (t) {
      var d0 = dictLookup(t);
      if (d0 && d0.t) { lemma[t] = t; return; }
      var forms = lemmaForms(t);
      for (var i = 1; i < forms.length; i++) {
        var e = dictLookup(forms[i]);
        if (e && e.t) { lemma[t] = forms[i]; return; }
      }
    });
    // 每篇文章的候选词频统计
    var counts = {};
    arts.forEach(function (a) {
      var c = {};
      (a.content || "").toLowerCase().match(/[a-z][a-z'-]*/g).forEach(function (t) {
        if (t.length < 3 || STOPWORDS[t]) return;
        var w = lemma[t];
        if (w) c[w] = (c[w] || 0) + 1;
      });
      counts[a.id] = c;
    });
    ART_INDEX = { lemma: lemma, counts: counts };
    done();
  }

  // 目标等级 -> 可视为"收获词"的最高柯林斯星级（星级越高越常用，超上限视为已会）
  var LEVEL_MAX_STAR = { cet4: 2, cet6: 3, kaoyan: 5 };

  function rankArticles() {
    var today = todayStr();
    var maxStar = LEVEL_MAX_STAR[state.settings.readLevel || "cet6"] || 3;
    var words = Object.keys(state.notebook);
    var vs = {};
    words.forEach(function (w) { vs[w] = wordVariants(w); });
    var results = [];
    allArticles().forEach(function (a) {
      var text = " " + (a.content || "").toLowerCase() + " ";
      // 已收录生词命中（含变形）；快到期的加权更高
      var hits = [], dueHits = 0;
      words.forEach(function (w) {
        var list = vs[w], found = false;
        for (var i = 0; i < list.length; i++) {
          if (new RegExp("\\b" + escRe(list[i]) + "\\b").test(text)) { found = true; break; }
        }
        if (!found) return;
        hits.push(w);
        var r = state.notebook[w];
        if (r.status !== "MASTERED" && r.next_review && r.next_review <= today) dueHits += 1;
      });
      // 收获词：未收录 + 星级不超目标等级上限
      var c = (ART_INDEX && ART_INDEX.counts[a.id]) || {};
      var news = [];
      for (var w2 in c) {
        if (state.notebook[w2]) continue;
        var d = dictLookup(w2);
        if ((d ? (d.c || 0) : 0) > maxStar) continue;
        news.push(w2);
      }
      news.sort(function (x, y) { return c[y] - c[x] || (x < y ? -1 : 1); });
      var score = news.length + dueHits * 3 + (hits.length - dueHits);
      if (score <= 0) return;
      results.push({ article: a, news: news, hits: hits, dueHits: dueHits, score: score });
    });
    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  }

  function artRecommend() {
    $("#articleRoot").innerHTML =
      '<div class="art-home"><div class="art-loading">正在分析文章库与词库…</div></div>';
    buildArtIndex(function (msg) {
      var el = $("#articleRoot .art-loading");
      if (el) el.textContent = msg;
    }, function () {
      var results = rankArticles();
      artState.results = results;
      if (!results.length) {
        alert("没有可推荐的文章：可尝试调高「阅读目标等级」，或导入更多文章。");
        renderArticleHome();
        return;
      }
      renderArticleList(results);
    });
  }

  // ==================== 外刊 UI ====================
  var artState = { results: null };

  function artBadge(level) {
    var m = LEVEL_META[level] || { cn: level };
    var cls = { cet4: "lv-cet4", cet6: "lv-cet6", kaoyan: "lv-kaoyan" }[level] || "lv-cet4";
    return '<span class="art-badge ' + cls + '">' + m.cn + "</span>";
  }

  function renderArticleHome() {
    var n = Object.keys(state.notebook).length;
    var thr = state.settings.articleThreshold || 10;
    var pct = Math.min(100, Math.round(n / thr * 100));
    var tip = n >= thr
      ? '<div class="art-tip ok">已积累 ' + n + " 个生词，推荐会优先巩固它们！</div>"
      : '<div class="art-tip">已积累 <b>' + n + "</b> 个生词，越多推荐越能巩固</div>";
    $("#articleRoot").innerHTML =
      '<div class="art-home">' +
      '<div class="art-progress-card"><div class="art-num">' + n + "</div>" +
      '<div class="art-label">已积累生词 · 阈值 ' + thr + "</div>" +
      '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' + tip + "</div>" +
      '<button class="btn btn-primary btn-big art-btn" onclick="window.artRecommend()">智能推荐 · 收获新词 + 巩固生词</button>' +
      '<button class="btn btn-spell-home art-btn" onclick="window.openExtract()">从文章提取生词（粘贴即用）</button>' +
      '<div class="art-desc">按「预计收获新词数 + 快忘生词巩固」综合排序；' +
      "星级高于目标等级的常见词不计入收获，生词命中不设门槛。</div>" +
      "</div>";
  }

  function renderArticleList(results) {
    var n = Object.keys(state.notebook).length;
    var cards = results.map(function (r) {
      var a = r.article;
      var newsHtml = r.news.slice(0, 8).map(function (w) {
        return '<a class="art-hit hv" href="javascript:void(0)" onclick="event.stopPropagation();window.openWordDetail(\'' +
               w.replace(/'/g, "\\'") + '\')">' + esc(w) + "</a>";
      }).join(" ") +
        (r.news.length > 8 ? '<span class="art-more">等 ' + r.news.length + " 词</span>" : "");
      var hitsHtml = r.hits.map(function (h) {
        return '<a class="art-hit" href="javascript:void(0)" onclick="event.stopPropagation();window.openWordDetail(\'' +
               h.replace(/'/g, "\\'") + '\')">' + esc(h) + "</a>";
      }).join(" ");
      var consolidate = r.hits.length
        ? " · 巩固 <b>" + r.hits.length + "</b> 个生词" +
          (r.dueHits ? '（<b class="due">' + r.dueHits + "</b> 个已到期）" : "")
        : "";
      return '<div class="art-card" onclick="window.openArticle(\'' + a.id + '\')">' +
        '<div class="art-card-head"><div class="art-title">' + esc(a.title) + "</div>" +
        artBadge(a.level) + "</div>" +
        '<div class="art-meta">' + esc(a.source) + " · " + esc(a.topic) + "</div>" +
        '<div class="art-yield">预计收获 <b>' + r.news.length + "</b> 个新词" + consolidate + "</div>" +
        (newsHtml ? '<div class="art-hits">' + newsHtml + "</div>" : "") +
        (hitsHtml ? '<div class="art-hits mine">已收录命中：' + hitsHtml + "</div>" : "") +
        "</div>";
    }).join("");
    $("#articleRoot").innerHTML =
      '<div class="art-list-head">' +
      '<button class="btn btn-ghost" onclick="window.artBackHome()">← 返回</button>' +
      '<span class="art-plan-name">智能推荐</span></div>' +
      '<div class="art-sum">共 ' + results.length + " 篇可推荐 · 生词 " + n + " 个 · 按综合价值排序</div>" +
      (results.length ? cards : '<div class="word-list-empty">没有符合条件的文章</div>');
  }

  function renderArticleReader(a, hits, news) {
    var kw = a.key_words || [];
    var kwHtml = kw.length ? kw.map(function (k) {
      return '<div class="kw-item"><a class="kw-link" href="javascript:void(0)" ' +
             'onclick="event.stopPropagation();window.openWordDetail(\'' +
             linkify(k.w) + '\')"><b>' + esc(k.w) + "</b></a> <i>" + esc(k.p || "") +
        "</i> <span>" + esc(k.t || "") + '</span><div class="kw-s">' + esc(k.s || "") + "</div></div>";
    }).join("") : '<div class="art-none">暂无重点词汇注释</div>';
    var hardHtml = (a.hard || []).map(function (h, i) {
      return '<div class="hard-item"><div class="hard-no">长难句 ' + (i + 1) + "</div>" +
        '<div class="hard-s">' + esc(h.s) + "</div>" +
        '<div class="hard-t">译：' + esc(h.t) + "</div>" +
        '<div class="hard-a">析：' + esc(h.a) + "</div></div>";
    }).join("") || '<div class="art-none">暂无长难句解析</div>';
    var structHtml = (a.structure || []).map(function (s, i) {
      return '<div class="struct-item"><span class="struct-no">' + (i + 1) + "</span>" +
        "<b>" + esc(s.part) + "</b><p>" + esc(s.summary) + "</p></div>";
    }).join("") || '<div class="art-none">暂无篇章结构</div>';
    var transHtml = a.translation
      ? '<details class="art-trans"><summary>中文翻译</summary><div class="art-trans-body">' +
        esc(a.translation) + "</div></details>"
      : "";
    $("#articleRoot").innerHTML =
      '<div class="art-list-head"><button class="btn btn-ghost" onclick="window.artBackList()">← 返回列表</button></div>' +
      '<div class="art-reader">' +
      '<h2 class="art-reader-title">' + esc(a.title) + "</h2>" +
      '<div class="art-meta">' + esc(a.source) + " · " + artBadge(a.level) +
      " · " + esc(a.topic) + " · " + (a.word_count || "") + " 词" +
      (a.pubDate ? " · " + esc(a.pubDate) : "") +
      (a.link ? ' · <a class="art-src" href="' + esc(a.link) + '" target="_blank">原文</a>' : "") +
      "</div>" +
      '<div class="art-summary-box">主旨：' + esc(a.summary || "") + "</div>" +
      transHtml +
      '<div class="art-legend"><span class="lg mine">我的生词</span>' +
      '<span class="lg hv">推荐新词</span><span class="lg kw">文章重点词</span>' +
      "<i>点击任意单词可查看并收录</i></div>" +
      '<div class="art-content" id="artContent">' + highlightContent(a, hits, news) + "</div>" +
      '<h3 class="art-sec-title">重点词汇（' + kw.length + "，点击查义）</h3>" + kwHtml +
      '<h3 class="art-sec-title">长难句解析（' + (a.hard || []).length + "）</h3>" + hardHtml +
      '<h3 class="art-sec-title">篇章结构</h3>' + structHtml +
      "</div>";
  }

  // 正文高亮：我的生词（黄）/ 推荐新词（蓝）/ 文章重点词（青）三类 mark，
  // 其余所有单词包 <span class="aw">，点击可查词典并直接收录（阅读→收录闭环）
  function highlightContent(a, hits, news) {
    var text = a.content || "";
    var marks = [];
    var vs = [];
    var words = {};
    (hits || []).forEach(function (w) { words[w] = "art-mark"; });
    (news || []).forEach(function (w) { if (!words[w]) words[w] = "art-mark art-mark-hv"; });
    (a.key_words || []).forEach(function (k) { if (!words[k.w]) words[k.w] = "art-mark art-mark-kw"; });
    Object.keys(words).forEach(function (w) {
      wordVariants(w).forEach(function (v) { vs.push({ w: w, v: v, cls: words[w] }); });
    });
    vs.sort(function (x, y) { return y.v.length - x.v.length; });
    var n = 0;
    vs.forEach(function (it) {
      var re = new RegExp("\\b(" + escRe(it.v) + ")\\b", "gi");
      text = text.replace(re, function (m) {
        marks[n] = { w: it.w, orig: m, cls: it.cls };
        return "\u0001" + n + "\u0001";
      });
      n = marks.length;
    });
    // 单词 token 统一包可点击 span（占位符为控制字符，不会被匹配）
    text = text.replace(/[A-Za-z][A-Za-z'\u2019-]*/g, function (tok) {
      return '<span class="aw" data-t="' +
        tok.toLowerCase().replace(/\u2019/g, "'") + '">' + esc(tok) + "</span>";
    });
    marks.forEach(function (mk, i) {
      text = text.split("\u0001" + i + "\u0001")
        .join('<mark class="' + mk.cls + '" data-w="' + mk.w + '">' + esc(mk.orig) + "</mark>");
    });
    return text;
  }

  // 词形还原候选（点击文章变形词时定位原形，如 emerged -> emerge）
  var LEMMA_RULES = [
    [/ies$/, function (w) { return [w.slice(0, -3) + "y"]; }],
    [/ied$/, function (w) { return [w.slice(0, -3) + "y"]; }],
    [/ing$/, function (w) { return [w.slice(0, -3), w.slice(0, -3) + "e"]; }],
    [/ed$/, function (w) { return [w.slice(0, -2), w.slice(0, -1)]; }],
    [/es$/, function (w) { return [w.slice(0, -2)]; }],
    [/s$/, function (w) { return [w.slice(0, -1)]; }]
  ];
  function lemmaForms(token) {
    var out = [token];
    function add(x) {
      if (!x || x.length < 3 || out.indexOf(x) >= 0 || !/^[a-z]+(['-][a-z]+)*$/.test(x)) return;
      out.push(x);
      var m = x.match(/([bdfgklmnprt])\1$/); // 去后缀后以双写辅音结尾：running -> runn -> run
      if (m) {
        var y = x.slice(0, -1);
        if (y.length >= 3 && out.indexOf(y) < 0) out.push(y);
      }
    }
    LEMMA_RULES.forEach(function (rule) {
      if (rule[0].test(token)) {
        rule[1](token).forEach(add);
      }
    });
    return out;
  }

  // 文章内点击任意单词：已收录→详情卡；词典可查→详情卡+收录按钮（收录后正文同步高亮）
  function articleWordTap(token) {
    var word = cleanInput(token);
    if (!word) return;
    if (state.notebook[word]) { showDetail(word); return; }
    loadShard(letterOf(word), function () {
      var lemma = word, d = dictLookup(word);
      if (!d) {
        var forms = lemmaForms(word);
        for (var i = 1; i < forms.length; i++) {
          if (dictLookup(forms[i])) { lemma = forms[i]; d = dictLookup(lemma); break; }
        }
      }
      if (d) {
        showDictDetail(lemma, d, function (w) { markArticleWord(w); });
        return;
      }
      // 词库未收：给出相近拼写候选（与 openWordDetail 一致）
      var cands = suggestFromShard(word, letterOf(word));
      var html = '<div class="word-card detail-card">' +
        '<div class="word-front"><div class="word-word">' + esc(word) + spkBtn(word) + "</div></div>" +
        '<div class="word-back"><div class="card-sec"><div class="sec-title">查询结果</div>' +
        '<div class="sec-body">词库（牛津高阶常用词）中未收录该词。</div></div>';
      if (cands.length) {
        html += '<div class="card-sec"><div class="sec-title">相近拼写</div><div class="sec-body">' +
          confsHtml(cands) + "</div></div>";
      }
      html += "</div></div>";
      var body = document.createElement("div");
      body.innerHTML = html;
      openModal(body);
    });
  }

  // 收录成功后：把正文中该词（含变形）的 span 标为已知（样式同生词高亮）
  function markArticleWord(word) {
    $$(".aw").forEach(function (el) {
      var t = el.getAttribute("data-t");
      if (!t) return;
      if (t === word || lemmaForms(t).indexOf(word) >= 0) el.classList.add("aw-known");
    });
  }

  // 外刊正文/重点词点击：一律走完整词典详情（与生词本详情一致：音标/义项/例句/同根词/易混淆 + 加入生词本）
  function showArticleKw(word, orig) {
    openWordDetail(word);
  }

  function artBackHome() { renderArticleHome(); }

  function artBackList() {
    if (artState.results) renderArticleList(artState.results);
    else renderArticleHome();
  }

  function openArticle(id) {
    var all = allArticles();
    var a = null;
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { a = all[i]; break; } }
    if (!a) return;
    var hits = [], news = [];
    if (artState.results) {
      for (var j = 0; j < artState.results.length; j++) {
        if (artState.results[j].article.id === id) {
          hits = artState.results[j].hits;
          news = artState.results[j].news;
          break;
        }
      }
    }
    renderArticleReader(a, hits, news);
  }

  window.artRecommend = artRecommend;
  window.artBackHome = artBackHome;
  window.artBackList = artBackList;
  window.openArticle = openArticle;

  // ==================== 从文章提取生词（粘贴 → 勾选 → 批量收录） ====================
  // 常见虚词/功能词过滤表（这些词几乎不可能是生词）
  var STOPWORDS = {};
  ("the a an and or but if then else when while of at by for with about against between into " +
   "through during before after above below to from up down in out on off over under again " +
   "further once here there all any both each few more most other some such no nor not only " +
   "own same so than too very can will just should now i me my myself we our ours ourselves " +
   "you your yours yourself yourselves he him his himself she her hers herself it its itself " +
   "they them their theirs themselves what which who whom this that these those am is are was " +
   "were be been being have has had having do does did doing would could might must shall may " +
   "also because as until than let get got go goes going went gone come came make made say " +
   "said see saw seen know knew known think thought take took taken way well even much many " +
   "still back us per via mr mrs ms dr okay ok yeah yes never always often sometimes usually")
    .split(/\s+/).forEach(function (w) { STOPWORDS[w] = 1; });

  function openExtractModal() {
    var wrap = document.createElement("div");
    wrap.className = "extract-box";
    wrap.innerHTML =
      '<h3 class="ext-title">从文章提取生词</h3>' +
      '<div class="ext-desc">粘贴任意英文文章/段落，自动筛掉已收录词与常见虚词，' +
      "勾选不认识的词批量收录（变形词会自动还原为原形）。</div>" +
      '<textarea id="extText" rows="9" placeholder="把外刊文章、课文或任意英文段落粘贴到这里..."></textarea>' +
      '<button class="btn btn-primary btn-big" id="btnExtRun">提取生词</button>' +
      '<div class="ext-status hidden" id="extStatus"></div>' +
      '<div class="ext-list" id="extList"></div>' +
      '<div class="ext-foot hidden" id="extFoot">' +
      '<button class="btn btn-ghost" id="btnExtToggle">全选</button>' +
      '<button class="btn btn-primary" id="btnExtCollect">收录选中 (0)</button></div>';
    openModal(wrap);
    $("#btnExtRun").onclick = runExtract;
    $("#btnExtToggle").onclick = toggleExtAll;
    $("#btnExtCollect").onclick = collectExtract;
  }

  function extStatus(msg) {
    var el = $("#extStatus");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function runExtract() {
    var text = $("#extText").value || "";
    var tokens = text.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
    if (tokens.length < 10) {
      $("#extList").innerHTML = "";
      $("#extFoot").classList.add("hidden");
      extStatus("内容太短，多粘贴一些英文文本再试。");
      return;
    }
    var freq = {};
    tokens.forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    var uniq = Object.keys(freq).filter(function (t) {
      return t.length >= 3 && !STOPWORDS[t] && !state.notebook[t];
    });
    uniq.sort(function (a, b) { return freq[b] - freq[a]; });
    if (!uniq.length) {
      extStatus("没有可提取的单词（可能都已收录）。");
      return;
    }
    // 按首字母聚合，逐片加载词典分片
    var letters = [];
    uniq.forEach(function (t) {
      var L = letterOf(t);
      if (letters.indexOf(L) < 0) letters.push(L);
    });
    var li = 0;
    (function nextLetter() {
      if (li >= letters.length) { finishExtract(uniq, freq); return; }
      extStatus("正在加载词库分片（" + (li + 1) + "/" + letters.length + "）…");
      loadShard(letters[li++], nextLetter);
    })();
  }

  function finishExtract(uniq, freq) {
    var items = [], unknown = 0;
    uniq.forEach(function (t) {
      var forms = lemmaForms(t);
      var lemma = null, d = null;
      for (var i = 0; i < forms.length; i++) {
        var e = dictLookup(forms[i]);
        if (e && e.t) { lemma = forms[i]; d = e; break; }
      }
      if (!lemma) { unknown += 1; return; }        // 词库未收（专名/拼错等）
      if (state.notebook[lemma]) return;           // 原形已收录
      items.push({ word: lemma, token: t, count: freq[t], d: d });
    });
    // 不同变形归并到同一原形
    var seen = {}, list = [];
    items.forEach(function (it) {
      if (seen[it.word]) { seen[it.word].count += it.count; return; }
      seen[it.word] = it; list.push(it);
    });
    list.sort(function (a, b) { return b.count - a.count || (a.word < b.word ? -1 : 1); });
    if (!list.length) {
      $("#extFoot").classList.add("hidden");
      extStatus("没有找到可收录的新单词（词库未收 " + unknown + " 个）。");
      return;
    }
    extStatus("共 " + list.length + " 个候选（按出现次数排序，词库未收 " + unknown +
      " 个已跳过）。勾选不认识的词：");
    var box = $("#extList");
    box.innerHTML = "";
    list.forEach(function (it) {
      var row = document.createElement("label");
      row.className = "ext-item";
      row.innerHTML =
        '<input type="checkbox" data-w="' + it.word + '">' +
        '<span class="ext-word">' + esc(it.word) + "</span>" +
        '<span class="ext-ph">' + esc(it.d.p || "") + "</span>" +
        '<span class="ext-trans">' + esc(firstLine(it.d.t).slice(0, 46)) + "</span>" +
        '<span class="ext-count">×' + it.count + "</span>";
      row.querySelector("input").onchange = updateExtCount;
      box.appendChild(row);
    });
    $("#extFoot").classList.remove("hidden");
    updateExtCount();
  }

  function extBoxes() { return $$("#extList input[type=checkbox]"); }

  function updateExtCount() {
    var n = extBoxes().filter(function (c) { return c.checked; }).length;
    $("#btnExtCollect").textContent = "收录选中 (" + n + ")";
  }

  function toggleExtAll() {
    var boxes = extBoxes().filter(function (c) { return !c.disabled; });
    var allOn = boxes.length && boxes.every(function (c) { return c.checked; });
    boxes.forEach(function (c) { c.checked = !allOn; });
    $("#btnExtToggle").textContent = allOn ? "全选" : "清空";
    updateExtCount();
  }

  function collectExtract() {
    var words = extBoxes().filter(function (c) { return c.checked && !c.disabled; })
      .map(function (c) { return c.getAttribute("data-w"); });
    if (!words.length) { extStatus("请先勾选要收录的单词。"); return; }
    var btn = $("#btnExtCollect");
    btn.disabled = true;
    var ok = 0, dup = 0, miss = 0, i = 0;
    (function next() {
      if (i >= words.length) {
        btn.disabled = false;
        extStatus("收录完成：新增 " + ok + " · 已存在 " + dup + " · 未找到 " + miss);
        refreshList(); refreshStats(); refreshStudyHome();
        extBoxes().forEach(function (c) {
          if (state.notebook[c.getAttribute("data-w")]) {
            c.checked = false; c.disabled = true;
            var row = c.closest(".ext-item");
            if (row) row.classList.add("done");
          }
        });
        updateExtCount();
        return;
      }
      var w = words[i++];
      btn.textContent = "正在收录 " + i + "/" + words.length + "…";
      collectWord(w, function (r) {
        if (r.ok) ok += 1;
        else if (r.reason === "duplicate") dup += 1;
        else miss += 1;
        next();
      });
    })();
  }

  window.openExtract = openExtractModal;

  // ==================== 启动 ====================
  function refreshStreak() {
    var days = {};
    state.log.forEach(function (l) { days[(l.at || "").slice(0, 10)] = 1; });
    var streak = calcStreak(Object.keys(days));
    $("#topStreak").textContent = streak > 0 ? "已连续 " + streak + " 天" : "";
  }

  function init() {
    var now = new Date();
    var week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    $("#topToday").textContent = "周" + week + " " + (now.getMonth() + 1) + "月" +
      now.getDate() + "日";
    bind();
    refreshAll();
    refreshStreak();
    // 注册 Service Worker（需 HTTPS 或 localhost；file:// 下静默跳过）
    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    }
  }

  // ==================== 云同步（坚果云 WebDAV） ====================
  var SYNC_KEY = "vocab-web-sync-v1";
  var SYNC = { url: "https://dav.jianguoyun.com/dav/", user: "", pass: "",
               path: "swing-vocab/backup.json", auto: true };
  (function () {
    try {
      var s = JSON.parse(localStorage.getItem(SYNC_KEY) || "{}");
      for (var k in SYNC) if (s[k] !== undefined) SYNC[k] = s[k];
    } catch (e) {}
  })();
  function saveSyncCfg() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(SYNC)); } catch (e) {}
  }
  function syncReady() { return !!(SYNC.user && SYNC.pass && SYNC.path); }

  // PC 浏览器受 CORS 限制（坚果云不支持跨域），本地助手托管页面时走代理；
  // APK WebView 开启了 UniversalAccess，file:// 下可直连
  function useProxy() {
    return location.protocol === "http:" &&
      (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  }

  function davRequest(method, body, extraHeaders) {
    var base = (SYNC.url || "https://dav.jianguoyun.com/dav/").replace(/\/?$/, "/");
    var path = (SYNC.path || "").replace(/^\/+/, "");
    var full = base + path;
    if (useProxy()) {
      return fetch("/dav-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: method, url: full, user: SYNC.user,
          pass: SYNC.pass, headers: extraHeaders || null,
          body64: body ? btoa(unescape(encodeURIComponent(body))) : null })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) throw new Error(j.error || ("HTTP " + j.status));
        return { status: j.status,
                 text: j.body64 ? decodeURIComponent(escape(atob(j.body64))) : "" };
      });
    }
    var hdrs = { "Authorization": "Basic " +
      btoa(unescape(encodeURIComponent(SYNC.user + ":" + SYNC.pass))) };
    if (extraHeaders) for (var k in extraHeaders) hdrs[k] = extraHeaders[k];
    return fetch(full, {
      method: method,
      headers: hdrs,
      body: body
    }).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, text: t }; });
    });
  }

  function syncStatus(msg, isErr) {
    var el = $("#syncStatus");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? "#C0392B" : "#0F766E";
  }

  function entryScore(e) {
    return (e.last_reviewed || e.added_at || "0000") + "#" +
      ("00000" + (e.total_reviews || 0)).slice(-6);
  }

  // 智能合并：生词条逐词「新版本胜出」，复习记录/文章做并集
  function mergeState(remote) {
    var added = 0, updated = 0;
    Object.keys(remote.notebook || {}).forEach(function (w) {
      var r = remote.notebook[w], l = state.notebook[w];
      if (!l) { state.notebook[w] = r; added++; }
      else if (entryScore(r) > entryScore(l)) { state.notebook[w] = r; updated++; }
    });
    var seen = {};
    state.log.forEach(function (x) {
      seen[(x.word || "") + "|" + (x.at || "") + "|" + (x.grade || "")] = 1;
    });
    var logAdd = 0;
    (remote.log || []).forEach(function (x) {
      var k = (x.word || "") + "|" + (x.at || "") + "|" + (x.grade || "");
      if (!seen[k]) { state.log.push(x); logAdd++; }
    });
    var ids = {};
    (state.articles || []).forEach(function (a) { if (a) ids[a.id] = 1; });
    var artAdd = 0;
    (remote.articles || []).forEach(function (a) {
      if (a && a.id && !ids[a.id]) { state.articles.push(a); artAdd++; }
    });
    ART_INDEX = null;
    save();
    refreshAll();
    return { added: added, updated: updated, logAdd: logAdd, artAdd: artAdd };
  }

  function cloudUpload(silent) {
    if (!syncReady()) { if (!silent) syncStatus("请先填写同步配置", true); return; }
    if (!silent) syncStatus("上传中...");
    var payload = JSON.stringify({ app: "swing-vocab", ver: 2,
      exported_at: new Date().toISOString(), state: state });
    var doPut = function () {
      return davRequest("PUT", payload).then(function (r) {
        if (r.status >= 300) throw new Error("HTTP " + r.status +
          (r.status === 401 ? "（账号或应用密码错误）" : ""));
        syncStatus("✓ 已上传（" + Object.keys(state.notebook).length + " 词）" +
          new Date().toLocaleTimeString("zh-CN", { hour12: false }));
      });
    };
    // 首次上传时父目录不存在会返回 409/404，先建目录再重试一次
    return doPut().catch(function (e1) {
      var code = String(e1.message);
      if (code.indexOf("409") < 0 && code.indexOf("404") < 0) throw e1;
      var bak = SYNC.path;
      SYNC.path = bak.replace(/^\/+/, "").split("/").slice(0, -1).join("/");
      return davRequest("MKCOL").catch(function () {})
        .then(function () { SYNC.path = bak; return doPut(); })
        .catch(function (e2) { SYNC.path = bak; throw e2; });
    }).catch(function (e) {
      syncStatus("上传失败：" + e.message + (useProxy() ? "" : "（PC 端请用同步助手打开）"), true);
    });
  }

  function cloudDownload(silent) {
    if (!syncReady()) { if (!silent) syncStatus("请先填写同步配置", true); return; }
    if (!silent) syncStatus("拉取中...");
    return davRequest("GET").then(function (r) {
      if (r.status === 404) { syncStatus("云端还没有备份文件"); return; }
      var data = JSON.parse(r.text);
      var remote = data.state || data;
      if (!remote.notebook) throw new Error("格式不正确");
      var m = mergeState(remote);
      syncStatus("✓ 已合并：新增 " + m.added + " 词，更新 " + m.updated +
        " 词；复习记录 +" + m.logAdd + "，文章 +" + m.artAdd);
    }).catch(function (e) {
      syncStatus("拉取失败：" + e.message + (useProxy() ? "" : "（PC 端请用同步助手打开）"), true);
    });
  }

  function cloudTest() {
    if (!syncReady()) { syncStatus("请先填写账号与应用密码", true); return; }
    syncStatus("测试连接中...");
    davRequest("PROPFIND", '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>', { "Depth": "0" })
      .then(function (r) {
        if (r.status === 404) { syncStatus("✓ 连接正常，云端目录将在首次上传时创建"); return; }
        if (r.status < 300) { syncStatus("✓ 连接正常，已找到云端备份"); return; }
        throw new Error("HTTP " + r.status + (r.status===401?"（账号或应用密码错误）":""));
      }).catch(function (e) {
        syncStatus("连接失败：" + e.message + (useProxy() ? "" : "（PC 端请用同步助手打开）"), true);
      });
  }

  function loadSyncUI() {
    $("#syncUrl").value = SYNC.url;
    $("#syncUser").value = SYNC.user;
    $("#syncPass").value = SYNC.pass;
    $("#syncPath").value = SYNC.path;
    $("#setSyncAuto").checked = SYNC.auto !== false;
    if (useProxy()) $("#syncEnvTip").textContent = "当前环境：本地助手代理模式（PC）";
    else if (location.protocol === "file:") $("#syncEnvTip").textContent = "当前环境：App 直连模式";
    else $("#syncEnvTip").textContent = "⚠ 当前环境无法直连 WebDAV（CORS），请双击 start_sync.bat 用助手打开";
  }

  function bindSync() {
    $("#btnSyncSave").addEventListener("click", function () {
      SYNC.url = $("#syncUrl").value.trim() || SYNC.url;
      SYNC.user = $("#syncUser").value.trim();
      SYNC.pass = $("#syncPass").value.trim();
      SYNC.path = $("#syncPath").value.trim().replace(/^\/+/, "");
      SYNC.auto = $("#setSyncAuto").checked;
      saveSyncCfg();
      syncStatus("配置已保存" + (SYNC.user ? "，可点击「测试连接」验证" : ""));
    });
    $("#btnSyncTest").addEventListener("click", cloudTest);
    $("#btnSyncUp").addEventListener("click", function () { cloudUpload(false); });
    $("#btnSyncDown").addEventListener("click", function () { cloudDownload(false); });
  }

  // 自动同步防抖：数据变化 5 秒后静默上传
  var _syncTimer = null;
  function scheduleAutoSync() {
    if (!SYNC || !SYNC.auto || !syncReady()) return;
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(function () { cloudUpload(true); }, 5000);
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindSync();
  });

  document.addEventListener("DOMContentLoaded", init);
})();
