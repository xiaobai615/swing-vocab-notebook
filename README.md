# 个人英语生词本

> 双形态同源程序：命令行版（Python + SQLite）和网页版（纯 HTML/CSS/JS，双击即用）

按《英语生词本项目规划.md》开发。仿"不背单词"核心体验：收录、间隔重复复习、形近词/同根词辨析。

## 两种使用方式

### 1. 网页版（推荐，零依赖）

直接双击打开 `web/index.html`，或在浏览器地址栏输入 `web/index.html` 的绝对路径。

- 零依赖：纯 HTML/CSS/JS，双击即用，不装 Python 也不装 Node
- 数据：浏览器 localStorage 持久化
- 界面：仿"不背单词"卡片式 UI（浅色主题）
- 词库：柯林斯 3.6 万词条（音标/多义项/例句/星级）

#### 网页版的几个小限制
- 词库范围是柯林斯覆盖的常用词；少量生僻词查不到（收录时会给拼写候选）
- 形近词/同根词改为**前端分片内按需计算**（与 Python 版算法一致，但池子小很多）
- 已收录词的双向同步需手动用"导出 JSON → 跨版本导入"

### 2. 命令行版（功能完整）

```bash
python main.py
```

完整功能（340 万词条底库 + 柯林斯 3.6 万词条 + 完整 SM-2 调度）。详见 `使用说明.txt`。

## 功能

- **收录**：输入英文单词自动补全 音标/词义/一句例句/同根词/形近词；支持批量导入
- **学习**：出词 → 回忆 → 翻答案 → 三档自评（认识/模糊/不认识），SM-2 简化变体间隔重复
- **复习**：到期词自动排队（凌晨 4 点为日界），模糊/不认识的词会话内 3~5 词间隔复现
- **状态机**：NEW → LEARNING → REVIEWING → MASTERED（间隔 ≥21 天且答对即掌握）
- **统计/导出**：学习统计、薄弱词 Top10、JSON/CSV 备份

## 项目结构

```
vocab-app/
├── main.py              CLI 入口
├── 使用说明.txt         CLI 版使用说明
├── vocab/               命令行版核心模块
│   ├── collector.py     M2 收录 + M4 词条组装
│   ├── confusable.py    M5 形近词
│   ├── roots.py         同根词
│   ├── scheduler.py     M3 SM-2 变体调度
│   ├── db.py            M6 SQLite 存储
│   ├── cli.py           M1 交互界面
│   └── ...
├── data/                词库与数据
│   ├── vocab.db         SQLite 主数据库
│   └── ...
├── tools/               辅助工具
│   ├── mdx_reader.py    纯 Python MDX 解析
│   ├── ingest.py        ECDICT 导入
│   ├── import_mdx.py    柯林斯 + 音标合并
│   ├── build_roots.py   词根词族构建
│   └── export_web.py    数据导出到 web/（轻量级，仅 4 要素）
├── web/                 网页版
│   ├── index.html       主页面
│   ├── style.css        样式
│   ├── app.js           前端逻辑
│   └── data/            词典与生词本数据（双击即可用）
└── tests/               单元测试
```

## 数据来源与许可

- ECDICT（MIT）：340 万词条底库
- 柯林斯高阶英汉双解词典（个人 mdx）：3.6 万词条补释义/例句/星级
- ipa-dict（MIT）：12.6 万词美式音标
- WordRoots：词根词缀表（用于词族构建）
- 全部离线，无需联网

## 测试

```bash
# 命令行版
python -m unittest discover -s tests   # 27 项单元测试
python acceptance.py                   # 24 项端到端验收

# 网页版
# 直接在浏览器中打开 web/index.html 操作
```

## 词库重建

仅当数据损坏或需更新词库时执行（CLI 模式，**生成数据仍需 Python**）：

```bash
python ingest.py        # 导入 ECDICT
python import_mdx.py    # 合并柯林斯与音标
python build_roots.py   # 构建词根词族
python export_web.py    # 导出到 web/data/ 用于网页版
```
