"""P1 + P5 验收：收录闭环与导出恢复测试。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vocab import collector, db, stats  # noqa: E402

WORDS = [
    ("energy", "ˈenədʒi", "n. 能量；精力", "", 1500, 1200),
    ("emerge", "ɪˈmɜːdʒ", "v. 浮现；出现", "", 3000, 2800),
    ("emergency", "ɪˈmɜːdʒənsi", "n. 紧急情况", "", 2500, 2400),
    ("apple", "ˈæpl", "n. 苹果", "s:apples", 3000, 3000),
    ("apply", "əˈplaɪ", "v. 应用", "d:applied/p:applied", 2000, 2000),
    ("complement", "ˈkɒmplɪment", "n. 补充物 v. 补充", "", 8000, 8000),
    ("compliment", "ˈkɒmplɪmənt", "n. 赞美 v. 赞美", "", 9000, 9000),
]


class Base(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init_db(self.conn)
        for w, ph, tr, ex, bnc, frq in WORDS:
            self.conn.execute(
                """INSERT INTO dictionary (word, phonetic, translation, example,
                   exchange, bnc, frq, collins, tag, wlen)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (w, ph, tr, "This is a sample sentence.", ex, bnc, frq, 0, "",
                 len(w)))
        self.conn.commit()

    def tearDown(self):
        self.conn.close()


class TestCollect(Base):
    def test_collect_energy(self):
        """收录 energy: 音标/词义/例句/同根词字段齐全, 状态 NEW"""
        r = collector.collect(self.conn, "energy")
        self.assertTrue(r["ok"])
        e = r["entry"]
        self.assertEqual(e["phonetic"], "ˈenədʒi")
        self.assertIn("能量", e["translation"])
        self.assertEqual(e["status"], "NEW")
        self.assertTrue(db.notebook_exists(self.conn, "energy"))

    def test_duplicate_rejected(self):
        """重复收录不产生重复行"""
        collector.collect(self.conn, "energy")
        r = collector.collect(self.conn, "Energy")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "duplicate")
        self.assertEqual(len(db.notebook_all(self.conn)), 1)

    def test_not_found_suggestions(self):
        """xyzqwe 应返回候选或空列表, 不崩溃"""
        r = collector.collect(self.conn, "xyzqwe")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "not_found")
        self.assertIsInstance(r["suggestions"], list)

    def test_typo_suggests(self):
        """拼写错误 energe -> 建议 energy"""
        r = collector.collect(self.conn, "energe")
        self.assertFalse(r["ok"])
        words = [s["word"] for s in r["suggestions"]]
        self.assertIn("energy", words)

    def test_clean_input(self):
        """' Apple ' 归一化为 apple"""
        w, err = collector.clean_input(" Apple ")
        self.assertIsNone(err)
        self.assertEqual(w, "apple")
        _, err = collector.clean_input("hello world")
        self.assertIsNotNone(err)

    def test_complement_compliment(self):
        """complement 的形近词必须出现 compliment（P2 验收）"""
        r = collector.collect(self.conn, "complement")
        self.assertTrue(r["ok"])
        words = [c["word"] for c in r["entry"]["confusables"]]
        self.assertIn("compliment", words)

    def test_energy_emerge(self):
        """energy 的形近词必须出现 emerge/emergency（P2 验收）"""
        r = collector.collect(self.conn, "energy")
        self.assertTrue(r["ok"])
        words = [c["word"] for c in r["entry"]["confusables"]]
        self.assertTrue(set(words) & {"emerge", "emergency"})


class TestExportRoundtrip(Base):
    def test_json_roundtrip(self):
        """导出 JSON 清空后恢复, 往返无损（P5 验收）"""
        from vocab import scheduler
        for w in ("energy", "apple", "complement"):
            collector.collect(self.conn, w)
        scheduler.apply_grade(self.conn, "energy", "know", "2026-08-17")
        import tempfile
        fd, path = tempfile.mkstemp(suffix="_export.json")
        os.close(fd)
        stats.export_json(self.conn, path)
        before = [dict(r) for r in db.notebook_all(self.conn)]
        before_log = self.conn.execute(
            "SELECT COUNT(*) AS c FROM review_log").fetchone()["c"]

        stats.import_json(self.conn, path)
        after = [dict(r) for r in db.notebook_all(self.conn)]
        after_log = self.conn.execute(
            "SELECT COUNT(*) AS c FROM review_log").fetchone()["c"]
        self.assertEqual(before, after)
        self.assertEqual(before_log, after_log)


if __name__ == "__main__":
    unittest.main()
