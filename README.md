# swing 生词本

> 一个"不一样"的英语生词本：**90 篇外刊精读 + 340 万词条词库 + SM-2 间隔复习 + 智能同义词/易混淆词辨析**，全部打包在一个 HTML 文件里，双击即用、完全离线。

## ✨ 核心特性

### 📖 外刊阅读学单词
内置 90 篇外刊文章（AI 原创范文），点词即查、划线即收录。在真实语境里遇见单词，而不是死背列表。

### 🧠 智能同义词 & 易混淆词
- **同义词推荐（严格模式）**：基于全词库倒排索引 + IDF 加权 + 首要释义互证，只推荐真正意思接近的词——`treat → cure / heal / remedy`，而 `fantasy ↔ phenomenon` 这种差距大的绝不硬凑。
- **易混淆词辨析**：形近词 + 同根词自动关联，帮你分清 `adapt / adopt / adept`。

### 📚 完整词典
340 万词条底库（ECDICT），含音标、多义项中文释义、例句、词频、柯林斯星级；常用词组带中文翻译。

### 🔁 SM-2 间隔重复
经典间隔重复算法变体：认识 / 模糊 / 不认识三档自评，到期自动排队，模糊的词会话内复现，直到掌握。

### 📱 多端可用
| 形态 | 入口 | 特点 |
|------|------|------|
| **单文件网页版** | 双击 `生词本-单文件版.html` | 一切功能全内嵌，5.9MB，离线可用 |
| **Android App** | [Releases](../../releases) 下载 APK | WebView 壳 + 离线资源，覆盖安装升级 |
| **命令行版** | `python main.py` | Python + SQLite 完整功能版 |
| **Web 工程版** | `web/index.html` | 前后端分离源码，便于二次开发 |

## 🚀 快速开始

**最简单的方式**：下载或克隆本仓库，直接双击 `生词本-单文件版.html`，无需安装任何东西。

**手机上用**：到 [Releases](../../releases) 页面下载最新 APK 安装即可。

## 📂 项目结构

```
vocab-app/
├── 生词本-单文件版.html   ⭐ 开箱即用的完整应用（词典+文章全内嵌）
├── main.py                CLI 版入口
├── vocab/                 CLI 版核心模块（collector/confusable/scheduler/db/cli...）
├── web/                   Web 工程版源码（index.html + app.js + data/）
├── android-app/           Android WebView 壳工程（Gradle 构建）
├── tools/                 辅助脚本与测试工具（同义词质量抽查等）
├── tests/                 单元测试
├── import_mdx.py          词典数据导入脚本
├── build_single_html.py   单文件版构建脚本
└── export_web.py          数据导出脚本
```

## 🛠️ 从零重建词库（可选）

仓库不含原始数据库文件（体积原因），如需重建：

```bash
# 1. 下载 ECDICT sqlite 版，解压为 data/stardict.db
#    https://github.com/skywind3000/ecdict
python ingest.py        # 导入 ECDICT
python import_mdx.py    # 合并词典数据
python build_roots.py   # 构建词根词族
python build_single_html.py  # 构建单文件版
python export_web.py    # 导出到 web/data/
```

## 📊 数据来源与许可

- [ECDICT](https://github.com/skywind3000/ecdict)（MIT）：英汉词典底库
- [ipa-dict](https://github.com/open-dict-data/ipa-dict)（MIT）：美式音标
- WordRoots：词根词缀表
- 外刊文章：AI 原创范文
- ⚠️ 词库中含部分《牛津高阶》风格的释义数据，仅限个人学习使用，请勿用于商业用途

## 🧪 测试

```bash
python -m unittest discover -s tests   # 单元测试
python acceptance.py                   # 端到端验收
node tools/test_synonyms.js            # 同义词算法测试（Node）
```

## License

[MIT](LICENSE)

## ☁️ 双端互通（v1.3 新增）

手机 App 与电脑网页版可通过坚果云 WebDAV 同步生词与学习进度：

- **手机端**：`我的 → 云同步` 填入坚果云账号和应用密码（坚果云网页版 → 账户信息 → 安全选项 → 添加应用密码），测试连接后即可上传/拉取
- **电脑端**：双击 `start_sync.bat` 启动本地同步助手（自动打开浏览器），同样配置一次即可
- **合并规则**：同一单词保留学习进度更新的版本；复习记录、导入的文章做并集，两端数据都不丢
- 开启「自动同步」后，收录/复习 5 秒内自动上传

> 说明：坚果云 WebDAV 不允许浏览器跨域直连（无 CORS 头），因此电脑端需通过本地助手代理访问；Android 端 WebView 已开启跨域权限可直连。
