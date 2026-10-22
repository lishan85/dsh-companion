# dsh-companion

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的长期陪伴插件。她答应的是：她一直是同一个人。上下文溢出或摘要不会把过去变成一份交接材料；新会话继续时，她用自己的口吻想起原文。

这一版做的是这条承诺的骨架：

- 原始发言进 SQLite，不提炼成事实卡片。
- FTS5 中文检索（拉丁词加 CJK 单字和二字词）。
- 固定预算内，用第一人称注入最近的原话和检索到的上下文。
- `history_search`。
- 平台账号到同一个人的身份表。

情绪、主动开口、分层日记、向量检索和重排都是接口，默认什么都不做。约定写在 [docs/PRD.md](docs/PRD.md)，接口在 `src/companion/stubs.ts`。

## 和 dsh-ltm 的关系

检索和预算的做法来自 [tr1v3r/dsh-ltm](https://github.com/tr1v3r/dsh-ltm)。那个项目把跨会话的**事实**放进 SQLite，用 FTS5 和混合重排管理记忆卡片。本仓库保留它的引擎和 `dsh-ltm` 命令，许可证仍是 MIT，版权归 tr1v3r。

陪伴插件是另一份库、另一条产品：

| | dsh-ltm | dsh-companion |
| --- | --- | --- |
| 库 | `memory/ltm.db` | `companion/companion.db` |
| 存什么 | 提炼过的事实 | 原始发言 |
| 入口 | `dsh-ltm` 命令，以及仍可单独引用的记忆插件模块 | 本包的 Cordis 入口 `src/index.ts` |

`dsh-ltm` 不会读写陪伴库。陪伴插件也不会把原文蒸馏进事实库。

## 安装

需要 Node `^22.19.0 || >=24.0.0`。本切片不需要 API key。

包名是 `dsh-companion`。发布到 npm 之前，在 profile 目录里把本仓库当作本地依赖安装：

```sh
dsh plugin --profile <profile> add /path/to/dsh-companion
```

`dsh plugin` 会把参数交给该 profile 的 pnpm。安装使用包里的 `cordis.patch.yml`，把插件挂到 `dshHomePath('companion/companion.db')`。换成你的 profile 名后重启该 profile。

只想构建和测试：

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
node scripts/companion-session-sim.mjs
node probe/boot-probe.mjs
```

`node:sqlite` 在受支持的 Node 上可能打印 ExperimentalWarning，这是预期的。

## 配置

`path` 必填，没有代码内默认值。其余字段有默认值。未知字段被忽略；本切片不读取嵌入地址、便宜模型或主动开口的配置。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `path` | 无 | SQLite 文件。bundle 里是 `dshHomePath('companion/companion.db')` |
| `persona` | 内置中文人设 | 稳定系统段。历史不会改写它 |
| `recentTurns` | 12 | 注入里保留的最近原文条数 |
| `contextRadius` | 2 | 命中前后各带几句 |
| `snippetLimit` | 3 | 一次注入或默认搜索的片段数 |
| `promptMaxChars` | 6000 | 人设加易变回忆的字符预算 |
| `promptMaxTokens` | 不设 | 和 `promptTokenizerPath` 必须成对出现 |
| `promptOrder` | 12 | 人设段在系统提示中的顺序 |
| `defaultPersonId` | `primary` | 没有渠道身份时的那个人 |
| `searchLimitMax` | 20 | `history_search` 的 `limit` 上限 |

`promptTokenizerPath` 沿用 dsh-ltm 的可选分词器资产，需要安装 optional 依赖 `@huggingface/tokenizers@0.2.0`。

## 架构

人设放在系统段 `companion:persona`，好让前缀缓存复用。最近原话和检索片段在 `agent/pre-step` 里前置成一条用户消息，正文以 U+2060 开头，`source` 为 `{ kind: "dsh-companion", form: "recall" }`，因此不会被再次记入原文。

`session/event` 记录 `user/message` 和 `assistant/message`。`turn/end` 没有正文。助手消息沿用本会话上一条的渠道字段。

模式版本 1。更旧的库要靠 `MIGRATIONS` 里显式的下一步升级；更新、外来或不完整的文件在只读阶段拒绝，不改主库。怎么加下一步写在 PRD 里。

## 情绪、日记、向量

这三块现在没有行为：

- `EmotionModel` 不返回心情，也不主动开口。
- `DiaryWriter` 不写日、周、月。
- `VectorIndex` 不建向量。默认重排保持 FTS5 的顺序，向量命中会排在全文命中之后，方便下一个实现接上。

PRD 里写了它们要做成什么样，包括 PAD、离散情绪、衰减和主动开口的上限。那是后续切片的活。

## 多渠道

QQ、微信和其他社区桥把消息送进 dsh 会话。本插件只在 dsh 钩子里记 `channel`、`user_id`、`chat_id`、`session_id`、`bridge`、时间和正文。它不连接那些平台。

桥的 README 没有说明钩子上看得到哪些字段。代码只在几个可能的位置找，找不到就留空，然后归到 `defaultPersonId`。不要把它理解成已经核对过的协议。

## 限制

- 预算装不下的旧回合不会出现在这一轮注入里。它们还在库里，检索也可能漏。
- 人设要求想不起时含糊，不要编造，也不要宣布「没有这段经历」。模型不一定照做。
- 身份字段缺失时，不同平台用户可能被记成同一个人。
- 本切片没有实机模型回合。加载、注册工具、人设和钩子可以不靠 API key 验证；她实际怎么说，要等有 key 或一个兼容的模型端点。

## 路线

1. 情绪、衰减、亲密度，以及带上限和安静时段的主动开口。
2. 她口吻的日、周、月日记。原文永久保留，重要事件不压缩。
3. 可配置嵌入、离线回退，以及和 FTS5 混在一起的重排。
4. 更长期的微调。现在没有这条代码路径。

## 开发

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm build
```

改了插件接线之后，用 `node probe/boot-probe.mjs` 做一次真实的 Cordis 启动。`--dump-config` 不会加载插件模块。探针默认使用本机已安装的 `@deepseek-ai/dsh`（环境变量 `DSH_NODE_MODULES` 指向其 `node_modules`）。

`dsh-ltm --help` 仍然是上游事实记忆库的命令，和陪伴库无关。

## 许可证

MIT。版权归 tr1v3r。见 [LICENSE](LICENSE)。
