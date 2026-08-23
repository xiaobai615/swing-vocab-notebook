#!/usr/bin/env python3
"""纯 Python 的 MDict(.mdx) 读取器（依据公开的 MDX 文件格式规范实现）。

支持：header 解析、key block info（zlib/明文）、key block（zlib/明文）、
record block（zlib/明文）。如遇 LZO 压缩块会给出明确错误提示。
仅用于把本地词典一次性导入 SQLite，最终程序不依赖此模块。

用法:
    from mdx_reader import MDX
    mdx = MDX(path)
    print(mdx.header)          # dict, 如 {'Encoding': 'UTF-8', ...}
    print(len(mdx))            # 词条数
    for key, html in mdx.items():
        ...
"""
import re
import struct
import zlib
from io import BytesIO


# ---------- RIPEMD-128（公开算法规范实现，用于 MDX 内置加密解密） ----------

def _f(j, x, y, z):
    if j < 16:
        return x ^ y ^ z
    if j < 32:
        return (x & y) | (z & ~x)
    if j < 48:
        return (x | (~y & 0xFFFFFFFF)) ^ z
    return (x & z) | (y & ~z)


def _K(j):
    return (0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC)[j // 16]


def _Kp(j):
    return (0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x00000000)[j // 16]


_R = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
      3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
      1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2]
_RP = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
       6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
       15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
       8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14]
_S = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
      7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
      11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
      11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12]
_SP = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
       9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
       9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
       15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8]


def _rol(s, x):
    return ((x << s) | (x >> (32 - s))) & 0xFFFFFFFF


def _ripemd128(message):
    """RIPEMD-128 摘要（标准算法，用于 MDX fast-encrypt 的密钥派生）。"""
    origlen = len(message)
    padlength = 64 - ((origlen - 56) % 64)
    msg = message + b"\x80" + b"\x00" * (padlength - 1) \
        + struct.pack("<Q", origlen * 8)
    h0, h1, h2, h3 = (0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476)
    for off in range(0, len(msg), 64):
        X = [struct.unpack("<L", msg[off + j * 4: off + j * 4 + 4])[0]
             for j in range(16)]
        A, B, C, D = h0, h1, h2, h3
        Ap, Bp, Cp, Dp = h0, h1, h2, h3
        for j in range(64):
            T = _rol(_S[j], (A + _f(j, B, C, D) + X[_R[j]] + _K(j)) & 0xFFFFFFFF)
            A, D, C, B = D, C, B, T
            T = _rol(_SP[j], (Ap + _f(63 - j, Bp, Cp, Dp)
                              + X[_RP[j]] + _Kp(j)) & 0xFFFFFFFF)
            Ap, Dp, Cp, Bp = Dp, Cp, Bp, T
        T = (h1 + C + Dp) & 0xFFFFFFFF
        h1 = (h2 + D + Ap) & 0xFFFFFFFF
        h2 = (h3 + A + Bp) & 0xFFFFFFFF
        h3 = (h0 + B + Cp) & 0xFFFFFFFF
        h0 = T
    return struct.pack("<LLLL", h0, h1, h2, h3)


def _fast_decrypt(data, key):
    """MDX 内置 fast-encrypt 解密。"""
    b = bytearray(data)
    key = bytearray(key)
    previous = 0x36
    for i in range(len(b)):
        t = ((b[i] >> 4) | (b[i] << 4)) & 0xFF
        t ^= previous ^ (i & 0xFF) ^ key[i % len(key)]
        previous = b[i]
        b[i] = t
    return bytes(b)


def _mdx_decrypt_key_block_info(comp_block):
    """解密 key block info（无需注册码，密钥由块内校验值派生）。"""
    key = _ripemd128(comp_block[4:8] + struct.pack("<L", 0x3695))
    return comp_block[0:8] + _fast_decrypt(comp_block[8:], key)


class MDXError(Exception):
    pass


class MDX:
    def __init__(self, fname, encoding="", passcode=None):
        self._fname = fname
        self._encoding = encoding.upper()
        self._passcode = passcode
        self.header = self._read_header()
        self._key_list = self._read_keys()
        self._num_entries = len(self._key_list)

    def __len__(self):
        return self._num_entries

    # ---------- 基础工具 ----------

    def _read_header(self):
        f = open(self._fname, "rb")
        try:
            header_bytes_size = struct.unpack(">I", f.read(4))[0]
            header_bytes = f.read(header_bytes_size)
            adler32 = struct.unpack("<I", f.read(4))[0]
            if adler32 != (zlib.adler32(header_bytes) & 0xFFFFFFFF):
                raise MDXError("header adler32 校验失败，文件可能损坏")
            self._key_block_offset = f.tell()
        finally:
            f.close()

        # 头部文本为 UTF-16，以 \x00\x00 结尾
        header_text = header_bytes[:-2].decode("utf-16", errors="replace")
        tag = dict(re.findall(r'(\w+)="(.*?)"', header_text, re.DOTALL))
        if not self._encoding:
            enc = tag.get("Encoding", "UTF-8")
            if enc in ("GBK", "GB2312"):
                enc = "GB18030"
            self._encoding = enc
        enc_flag = tag.get("Encrypted", "No")
        if enc_flag in ("No", "0"):
            self._encrypt = 0
        elif enc_flag == "Yes":
            self._encrypt = 1
        else:
            self._encrypt = int(enc_flag)
        self._version = float(tag.get("GeneratedByEngineVersion", "1.2"))
        self._number_width = 8 if self._version >= 2.0 else 4
        self._number_format = ">Q" if self._version >= 2.0 else ">I"
        return tag

    def _read_number(self, f):
        return struct.unpack(self._number_format, f.read(self._number_width))[0]

    # ---------- key block info ----------

    def _decode_key_block_info(self, data):
        if self._version >= 2.0:
            if data[:4] != b"\x02\x00\x00\x00":
                raise MDXError("key block info 头部标记异常")
            if self._encrypt & 0x02:
                data = _mdx_decrypt_key_block_info(data)
            info = zlib.decompress(data[8:])
            adler32 = struct.unpack(">I", data[4:8])[0]
            if adler32 != (zlib.adler32(info) & 0xFFFFFFFF):
                raise MDXError("key block info adler32 校验失败")
        else:
            info = data
        return self._parse_key_block_info(info)

    def _parse_key_block_info(self, info):
        byte_format = ">H" if self._version >= 2.0 else ">B"
        byte_width = 2 if self._version >= 2.0 else 1
        text_term = 1 if self._version >= 2.0 else 0
        utf16 = self._encoding == "UTF-16"
        block_list = []
        i, n = 0, len(info)
        while i < n:
            # 当前 key block 内词条数
            i += self._number_width
            # text head
            head_size = struct.unpack(byte_format, info[i:i + byte_width])[0]
            i += byte_width
            i += (head_size + text_term) * (2 if utf16 else 1)
            # text tail
            tail_size = struct.unpack(byte_format, info[i:i + byte_width])[0]
            i += byte_width
            i += (tail_size + text_term) * (2 if utf16 else 1)
            comp = struct.unpack(self._number_format,
                                 info[i:i + self._number_width])[0]
            i += self._number_width
            decomp = struct.unpack(self._number_format,
                                   info[i:i + self._number_width])[0]
            i += self._number_width
            block_list.append((comp, decomp))
        return block_list

    # ---------- key block ----------

    def _decode_key_block(self, data, block_list):
        keys = []
        i = 0
        for comp_size, decomp_size in block_list:
            chunk = data[i:i + comp_size]
            btype = chunk[:4]
            adler32 = struct.unpack(">I", chunk[4:8])[0]
            if btype == b"\x00\x00\x00\x00":
                block = chunk[8:]
            elif btype == b"\x02\x00\x00\x00":
                block = zlib.decompress(chunk[8:])
            elif btype == b"\x01\x00\x00\x00":
                raise MDXError("key block 使用 LZO 压缩，纯 Python 版本不支持；"
                               "请换用 zlib 压缩的词典")
            else:
                raise MDXError(f"未知 key block 压缩类型: {btype!r}")
            if adler32 != (zlib.adler32(block) & 0xFFFFFFFF):
                raise MDXError("key block adler32 校验失败")
            keys.extend(self._split_key_block(block))
            i += comp_size
        return keys

    def _split_key_block(self, block):
        utf16 = self._encoding == "UTF-16"
        delim = b"\x00\x00" if utf16 else b"\x00"
        width = 2 if utf16 else 1
        keys = []
        pos = 0
        n = len(block)
        while pos < n:
            key_id = struct.unpack(self._number_format,
                                   block[pos:pos + self._number_width])[0]
            pos += self._number_width
            end = pos
            while end < n and block[end:end + width] != delim:
                end += 1
            key_text = block[pos:end].decode(self._encoding, errors="ignore")
            pos = end + width
            keys.append((key_id, key_text))
        return keys

    # ---------- 读取入口 ----------

    def _read_keys(self):
        f = open(self._fname, "rb")
        try:
            f.seek(self._key_block_offset)
            num_bytes = 8 * 5 if self._version >= 2.0 else 4 * 4
            block = f.read(num_bytes)
            if self._encrypt & 0x01:
                raise MDXError("该词典 record block 已加密，需要注册码，无法解析")
            sf = BytesIO(block)
            num_key_blocks = self._read_number(sf)
            self._num_entries = self._read_number(sf)
            if self._version >= 2.0:
                self._read_number(sf)  # key block info 解压后大小
            info_size = self._read_number(sf)
            key_block_size = self._read_number(sf)
            if self._version >= 2.0:
                f.read(4)  # adler32
            info = f.read(info_size)
            block_list = self._decode_key_block_info(info)
            if num_key_blocks != len(block_list):
                raise MDXError("key block 数量不一致")
            key_block_data = f.read(key_block_size)
            self._record_block_offset = f.tell()
            return self._decode_key_block(key_block_data, block_list)
        finally:
            f.close()

    def items(self):
        """生成 (key_text, html) 序列。"""
        f = open(self._fname, "rb")
        try:
            f.seek(self._record_block_offset)
            num_blocks = self._read_number(f)
            num_entries = self._read_number(f)
            info_size = self._read_number(f)
            record_block_size = self._read_number(f)
            infos = []
            for _ in range(num_blocks):
                c = self._read_number(f)
                d = self._read_number(f)
                infos.append((c, d))
            offset = 0
            i = 0
            for comp_size, decomp_size in infos:
                chunk = f.read(comp_size)
                btype = chunk[:4]
                adler32 = struct.unpack(">I", chunk[4:8])[0]
                if btype == b"\x00\x00\x00\x00":
                    rec = chunk[8:]
                elif btype == b"\x02\x00\x00\x00":
                    rec = zlib.decompress(chunk[8:])
                elif btype == b"\x01\x00\x00\x00":
                    raise MDXError("record block 使用 LZO 压缩，纯 Python 版本不支持")
                else:
                    raise MDXError(f"未知 record block 压缩类型: {btype!r}")
                if adler32 != (zlib.adler32(rec) & 0xFFFFFFFF):
                    raise MDXError("record block adler32 校验失败")
                while i < len(self._key_list):
                    start, key_text = self._key_list[i]
                    if start - offset >= len(rec):
                        break
                    end = self._key_list[i + 1][0] if i < len(self._key_list) - 1 \
                        else len(rec) + offset
                    i += 1
                    data = rec[start - offset:end - offset]
                    html = data.decode(self._encoding, errors="ignore") \
                        .strip("\x00")
                    yield key_text, html
                offset += len(rec)
        finally:
            f.close()
