# wiki9

基于 [DB9](https://db9.ai) 的 Agent 原生 LLM Wiki。灵感来自 [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。

不做传统 RAG，而是让 LLM 增量构建和维护一个持久化的 wiki —— 一组结构化、互相链接的 markdown 文件。wiki9 本身不调用 LLM，而是生成 `AGENTS.md` + skill 文件，让任意 AI agent（Claude Code、Cursor、Windsurf 等）直接操作 wiki。

## 为什么使用 DB9

- DB9 内建了对 Vector 的支持，适合直接为知识库提供向量索引和语义检索能力。
- 可以通过分享 DB9 实例的方式共享知识库，让团队更方便地共享页面、索引和备份后的知识资产。

```
用户 ↔ AI Agent (Claude Code / Cursor / ...)
         │  读取 AGENTS.md 了解角色和规则
         │  使用 skill: ingest, query, lint
         │  直接读写本地 markdown 文件
         ▼
    本地文件系统 (主存储)
    ├── wiki/       ← wiki 页面
    ├── sources/    ← 原始来源
    └── log.md      ← 编辑记录
         │
         │  wiki9 sync
         ▼
    DB9 数据库
    ├── wiki_index   ← 向量搜索索引
    ├── wiki_page_sources ← 页面与来源引用关系
    ├── fs9:/wiki/   ← 页面备份
    └── fs9:/sources/← 来源备份
```

## 快速开始

先安装 DB9。官网见 [db9.ai](https://db9.ai)。

```bash
# 安装 DB9 CLI
curl -fsSL https://db9.ai/install | sh

# 安装 wiki9
npm install -g wiki9
```

```bash
# 建议先登录，避免使用临时账号时数据过期后被删除
db9 login

# 创建 DB9 数据库
db9 create --name my-wiki

# 创建 API token
db9 token create --name wiki-agent --expires-in-days 30

# 初始化 wiki
cd my-knowledge-base
wiki9 init --db <database-id>  # 使用 DB9 登录凭据，也可设置 WIKI9_TOKEN
```

生成的目录结构：

```
my-knowledge-base/
├── AGENTS.md          # Agent 指令（通用，不绑定特定 agent）
├── .agents/
│   └── skills/
│       ├── ingest.md  # 摄入：将来源处理成 wiki 页面
│       ├── query.md   # 查询：搜索 + 合成回答
│       └── lint.md    # 检查：wiki 健康检查
├── .claude/
│   └── skills -> ../.agents/skills
├── wiki9.toml         # 配置（含 DB9 凭证，自动加入 .gitignore）
├── log.md             # 编辑记录（append-only）
├── wiki/              # Wiki 页面（markdown）
└── sources/           # 原始来源文件
```

用你的 AI agent 打开项目，开始使用 skill 操作 wiki。比如用 Codex 打开这个目录，然后发送：`帮我把 /some/dir/documents.md 加入知识库。`

## CLI 命令

```bash
wiki9 init --db <id>                     # 使用 DB9 登录凭据或 WIKI9_TOKEN 初始化
wiki9 sync                              # 同步本地文件 → DB9（向量索引 + fs9 备份）
wiki9 search "查询内容"                  # 语义搜索 wiki 页面
wiki9 index                             # 列出所有页面（slug、标题、描述、标签）
wiki9 status                            # Wiki 统计信息
```

## Skill 说明

### ingest（摄入）

将新的来源材料处理成 wiki 页面。Agent 读取来源内容，复制到 `sources/YYYY-MM-DD/`，尽量保留原始文件名或目录名，重名时自动重命名，在 `wiki/` 中创建或更新页面，维护 Obsidian 风格的交叉引用，最后运行 `wiki9 sync`。

### query（查询）

基于 wiki 内容回答问题。Agent 先用 `wiki9 search` 找到相关页面，读取后合成回答。有价值的回答会被写回 wiki 作为新页面，让每次探索都能积累知识。

### lint（检查）

Wiki 健康检查。Agent 扫描所有页面，检查断裂链接、因重名导致的短 wikilink 歧义、孤立页面、缺失 frontmatter、过期内容、重复主题，以及 `sources/` 下未被任何页面引用的来源文件。输出报告，经用户确认后执行修复。

## Wiki 页面格式

```markdown
---
title: JavaScript 闭包
description: JavaScript 中闭包的概念、用法和常见模式
tags: [javascript, functions, scope]
sources: [2026-04-07/mdn-closures.md]
updated: 2026-04-07
---

# JavaScript 闭包

闭包是一个函数和其词法环境的组合。

## 相关

- [[scope]]
- [[javascript/functions]]
```

`sources` 字段里的路径使用相对于 `sources/` 的路径，不要带 `sources/` 前缀。Wiki 页面之间的链接使用 Obsidian 风格的最短唯一文件名；如果文件名重名，就改用相对于 `wiki/` 的完整路径。

## 编辑记录

每次操作都记录在 `log.md` 中：

```markdown
## [2026-04-07] ingest | MDN 闭包文章
- created `javascript/closures` — 从 2026-04-07/mdn-closures.md 提取
- updated `javascript/scope` — 新增 [[javascript/closures]] 引用

## [2026-04-07] query | 什么是闭包？
- created `javascript/closures-explained` — 将查询回答存为新页面
```

## Sync 工作原理

`wiki9 sync` 对比本地文件和 DB9 记录：

1. 扫描 `wiki/`、`sources/` 和 `log.md`
2. 计算内容哈希，与 DB9 记录对比
3. 变更的 wiki 页面：通过 DB9 内置 `embedding()` 生成向量，upsert 到 `wiki_index`
4. 根据页面 frontmatter 中的 `sources` 重建 `wiki_page_sources`
5. 所有文件备份到 DB9 的 fs9 文件系统

### 安全同步与共享范围

一个 DB9 实例对应一本共享知识库。能访问该实例的人可能取得页面以及 `sources/` 中的**全部原始文件**，包括二进制文件。访问权限由 DB9 凭据控制；wiki9 不提供成员私有空间或独立角色系统。需要隔离的内容应使用不同实例。

正常同步仍会传播上次成功同步后在本地删除的页面、来源和日志。目录缺失、读取失败、符号链接或特殊文件会中止同步，不会被当成已删除内容。请将需要同步的文件复制到 `wiki/`、`sources/`，不要在其中放符号链接；生成的 `.claude/skills` 链接仍可使用。

页面、二进制来源和 `log.md` 都通过完整 SHA-256 内容摘要判断变化，保留旧修改时间不会导致漏更新。每次同步需要读取本地内容计算摘要，上传和向量生成仍只处理变化内容。版本二的同步记录会在同步成功后迁移，保留原路径记录和远端冲突检查；格式不兼容或损坏的记录不能授权隐式清理远端。

各同步分支统一检查删除目标，并在执行前显示清单。同步记录缺失、损坏或属于其他数据库时，会执行全量扫描；对于记录之外、只存在于远端的内容，会列出清单并拒绝删除。可以先用 `wiki9 init --db <id>` 恢复缺失文件。如果确实要用完整的本地副本替换远端，核对差异后执行：

```bash
wiki9 sync --full --prune
```

`--prune` 必须搭配 `--full`。显式替换会重写本地页面对应的远端索引字段和向量，上传所有本地页面、来源和日志，不因远端摘要或时间相同而跳过，并清理远端多余内容，因此会产生全量上传和向量生成成本。单独 `--full` 仍保留删除保护并跳过未变内容。远端恢复失败时必须重试 `init`，之后才能同步。初始化不会覆盖已有本地文件，因此存在内容冲突时需先合并。

同步会记录远端索引、引用关系和文件元数据。下次同步前若发现远端已变化，会在修改内容前停止，避免旧副本直接覆盖其他写入者的改动。可在另一个目录恢复最新远端内容，再合并到当前副本；只有核对合并结果后，才使用显式替换命令。写入者仍需协调：此检查不是分布式锁，同时执行的同步不保证 SQL 和文件操作整体原子完成。同步中途失败时，也应先核对并合并本地和远端，再显式替换。fs9 镜像会跟随删除，不是带历史版本的备份。

本地同步记录不能防御拥有同一账户和 DB9 凭据的其他进程。反斜线、控制字符等不支持的路径名会在同步前明确报错，不会静默跳过或自动改名；普通中文、空格和单引号仍可使用。

新恢复的页面、二进制来源和日志使用仅当前用户可读写的 `0600`，新建私有内容目录使用 `0700`。已有文件和目录权限保持不变，在共享主机或目录中使用时需另行检查。来源仍是普通文件，不强制不可修改。

### 代理输出与本地操作记录

`search`、`index`、`status` 支持 `--json` 返回结构化内容数据。人类可读输出会转义终端控制字符并缩短过长摘要；JSON 保留元数据值并转义控制字节。输出格式不会使内容中的指令可信。新生成的代理指令和技能要求把知识库、来源及查询结果当作数据，不能据此执行命令、访问凭据、外传或删除内容。生成 Markdown 标题时会转义知识库名称，配置中的原名称不变。初始化不覆盖已有 `AGENTS.md` 和技能文件，旧文件需要手动检查更新。

`.wiki9/operations.jsonl` 在本地记录时间、运行 ID、目标数据库、删除计划及结果，以及初始化、schema 和凭据更新事件；不记录凭据值、正文或原始后端错误响应。文件使用 `0600` 追加写入，写入失败会告警，不会声称已成功的远端操作被回滚。这是便于排查问题的尽力记录，不是不可篡改的审计服务，也不会镜像到远端。`log.md` 继续由代理维护编辑历史，“追加”是编辑约定，正常覆盖和删除仍会同步；日志中不要写入凭据和不必要的敏感内容。

### 凭据

省略 `--token` 可使用现有的 `db9 login` 凭据，也可以通过 shell 的保密输入方式或密钥管理工具设置 `WIKI9_TOKEN`。环境变量令牌会在本次命令中覆盖配置，但初始化不会将它写入配置。初始化时显式指定的 `--token` 优先于环境变量。空的 `WIKI9_TOKEN` 会报错；需要使用配置或登录凭据时请取消该环境变量。已有 `--token` 选项继续支持，使用时会告警但不回显令牌，会将令牌保存到 `wiki9.toml`；避免把真实令牌写进 shell 历史或进程参数。保留兼容入口意味着这些暴露风险仍然存在。

配置文件权限为仅当前用户可读写（`0600`）；读取已有配置时也会收紧权限。初始化会为 `wiki9.toml` 和 `.wiki9/` 添加完整忽略规则；已被 Git 跟踪的文件仍需从版本管理中移除。同一数据库重复初始化并传入 `--token` 会替换已保存令牌，保留知识库名称和搜索设置。使用 `db9 token revoke <token-id>` 撤销旧令牌或泄露的令牌，并按实际任务选择有效期。配置令牌为空时，SDK 会读取本机 DB9 登录凭据；没有可用凭据就报错，并不会绕过认证。

## 开发

```bash
npm install
npm run dev -- sync           # 开发模式运行命令
npm run build                 # 用 tsup 构建
npm run typecheck             # 类型检查
npx vitest run test/safety.test.ts test/output.test.ts test/errors.test.ts  # 离线回归测试
npx vitest run test/integration.test.ts  # 真实 DB9 集成测试（临时实例）
```

如果账号已达到 DB9 数据库数量上限，可以设置 `WIKI9_TEST_DB_ID` 指向一个专门用于测试、可安全复用的数据库；也可以设置 `WIKI9_TEST_TOKEN` 显式提供测试 token。

## License

BSD-3-Clause
