#!/usr/bin/env python3
"""把生词本词库导出为纯前端 Web 版可用的 JS 数据文件（APP 运行不依赖 Python）。

输出到 web/data/：
  dict_<letter>.js   柯林斯覆盖词条（音标/词义/例句/星级）
  words.js           当前生词本（notebook 表，供首次迁移）
  meta.js            元信息

形近词/同根词不在导出时预计算（3.6 万词 × 编辑距离会非常慢），
改由前端 app.js 在收录时按分片内局部计算（毫秒级）并缓存。
"""
import json
import os
import re
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from vocab import db  # noqa: E402

OUT_DIR = os.path.join(BASE, "web", "data")
MAX_PHONETIC_LEN = 60


def clean(s, limit=None):
    s = (s or "").strip()
    # 压缩非换行空白，保留 \n 义项分隔（前端按行切分词性/释义）
    s = re.sub(r"[^\S\n]+", " ", s)
    if limit and len(s) > limit:
        s = s[: limit - 1] + "…"
    return s


def export():
    conn = db.connect()
    db.init_db(conn)
    os.makedirs(OUT_DIR, exist_ok=True)

    rows = conn.execute(
        """SELECT word, phonetic, translation, example, collins
           FROM dictionary
           WHERE source = 'oald'
             AND (bnc > 0 OR frq > 0 OR collins > 0)
             AND LENGTH(word) >= 2
           ORDER BY word"""
    ).fetchall()
    print(f"牛津常用词条: {len(rows)}")

    shards = {}
    for r in rows:
        word = r["word"]
        entry = {
            "p": clean(r["phonetic"], MAX_PHONETIC_LEN),
            "t": clean(r["translation"], 300),
            "e": clean(r["example"], 150),
            "c": r["collins"] or 0,
        }
        letter = word[0].lower()
        if not ("a" <= letter <= "z"):
            letter = "other"
        shards.setdefault(letter, {})[word] = entry

    total_size = 0
    for letter, words in sorted(shards.items()):
        path = os.path.join(OUT_DIR, f"dict_{letter}.js")
        with open(path, "w", encoding="utf-8") as f:
            f.write("window.DICT=window.DICT||{};window.DICT[")
            f.write(json.dumps(letter, ensure_ascii=False))
            f.write("]=")
            json.dump(words, f, ensure_ascii=False, separators=(",", ":"))
            f.write(";")
        total_size += os.path.getsize(path)
        print(f"  dict_{letter}.js  {len(words)} 词")
    print(f"词典分片: {len(shards)} 个文件，共 {total_size / 1048576:.1f} MB")

    notebook = []
    for r in conn.execute("SELECT * FROM notebook ORDER BY added_at"):
        d = dict(r)
        d["added_at"] = d["added_at"] or ""
        d["last_reviewed"] = d["last_reviewed"] or ""
        d["next_review"] = d["next_review"] or ""
        # 强制用最新词典数据覆盖旧快照（避免柯林斯旧格式/旧释义残留）
        full = conn.execute(
            "SELECT phonetic, translation, example FROM dictionary WHERE word=?",
            (d["word"],)).fetchone()
        if full:
            d["translation"] = full["translation"] or d["translation"] or ""
            d["example"] = full["example"] or d["example"] or ""
            d["phonetic"] = full["phonetic"] or d["phonetic"] or ""
        # 确保形近词/同根词字段已序列化为数组（DB 存为 JSON 字符串）
        import re
        for f in ("roots", "confusables"):
            v = d.get(f) or "[]"
            if isinstance(v, str):
                try:
                    arr = json.loads(v)
                except Exception:
                    arr = []
            else:
                arr = v
            # 清洗：仅保留纯字母
            arr = [x for x in arr if re.fullmatch(r"[a-z]+", x if isinstance(x, str) else x.get("word", ""))]
            d[f] = arr
        # 限制形近词短释义长度
        for c in d["confusables"]:
            if isinstance(c, dict) and c.get("trans"):
                c["trans"] = c["trans"][:60]
        notebook.append(d)
    with open(os.path.join(OUT_DIR, "words.js"), "w", encoding="utf-8") as f:
        f.write("window.NOTEBOOK=")
        json.dump(notebook, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";")
    print(f"生词本: {len(notebook)} 词（已补全四要素与词族）")

    with open(os.path.join(OUT_DIR, "meta.js"), "w", encoding="utf-8") as f:
        f.write("window.META=")
        json.dump({
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "dict_total": len(rows),
            "shards": sorted(shards.keys()),
        }, f, ensure_ascii=False)
        f.write(";")
    conn.close()
    print("导出完成 -> web/data/")


if __name__ == "__main__":
    export()
