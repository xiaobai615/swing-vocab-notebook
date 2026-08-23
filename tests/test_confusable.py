"""P2 验收：形近词算法测试（规划 3.4 / P2 验收标准）。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vocab import confusable, db  # noqa: E402


class TestDLDistance(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(confusable.dl_distance("energy", "energy"), 0)
        self.assertEqual(confusable.dl_distance("energy", "emerge"), 2)  # 换 2 字母
        self.assertEqual(confusable.dl_distance("cat", "car"), 1)
        self.assertEqual(confusable.dl_distance("cat", "cats"), 1)
        self.assertEqual(confusable.dl_distance("ab", "ba"), 1)  # 相邻交换=1

    def test_threshold(self):
        self.assertGreater(confusable.dl_distance("apple", "zebra", 2), 2)


class TestPrefix(unittest.TestCase):
    def test_lcp(self):
        self.assertEqual(confusable.common_prefix_len("complement", "compliment"), 5)
        self.assertEqual(confusable.common_prefix_len("energy", "emerge"), 1)


class TestExchangeExclusion(unittest.TestCase):
    """词形变化排除：apples 不应出现在 apple 的形近词中。"""

    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init_db(self.conn)
        words = [
            # word, phonetic, translation, exchange, bnc, frq
            ("apple", "ˈæpl", "n. 苹果", "s:apples", 3000, 3000),
            ("apples", "", "n. apple 的复数", "0:apple/1:s", 0, 0),
            ("apply", "əˈplaɪ", "v. 应用；申请", "d:applied/p:applied/i:applying/3:applies", 2000, 2000),
            ("applied", "", "adj. 应用的", "0:apply/1:d", 2500, 2500),
            ("ample", "ˈæmpl", "adj. 充足的", "", 9000, 9000),
            ("appel", "", "n. （击剑）顿足", "", 50000, 50000),
        ]
        for w, ph, tr, ex, bnc, frq in words:
            self.conn.execute(
                """INSERT INTO dictionary (word, phonetic, translation, example,
                   exchange, bnc, frq, collins, tag, wlen)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (w, ph, tr, "", ex, bnc, frq, 0, "", len(w)))
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def test_plural_excluded(self):
        row = db.dict_query(self.conn, "apple")
        result = confusable.find_confusables(self.conn, "apple", row)
        words = [c["word"] for c in result]
        self.assertNotIn("apples", words, "复数不应算形近词")
        self.assertNotIn("apple", words, "自身不应算形近词")

    def test_inflected_excluded(self):
        row = db.dict_query(self.conn, "apply")
        result = confusable.find_confusables(self.conn, "apply", row)
        words = [c["word"] for c in result]
        self.assertNotIn("applied", words, "过去式/同 lemma 变形不应算形近词")

    def test_real_confusable_found(self):
        row = db.dict_query(self.conn, "apple")
        result = confusable.find_confusables(self.conn, "apple", row)
        words = [c["word"] for c in result]
        self.assertIn("ample", words)  # 距离 2，真实易混词


if __name__ == "__main__":
    unittest.main()
