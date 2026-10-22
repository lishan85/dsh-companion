# dsh-companion

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的长期陪伴插件。她答应的是：她一直是同一个人。上下文溢出或摘要不会把过去变成一份交接材料；新会话继续时，她用自己的口吻想起原文。

这一版做的是这条承诺的骨架：

- 原始发言进 SQLite，不提炼成事实卡片。
- FTS5 中文检索（拉丁词加 CJK 单字和二字词）。
- 固定预算内，用第一人称注入最近的原话、检索到的上下文、她写过的日记，以及她自己出去看过的地方。
- `history_search`。原话、已封日记和她的经历一起查。全文和向量融合，仍卡在原来的预算里。
- 平台账号到同一个人的身份表。
- 多维情绪：PAD 加一组可以并存的离散心情，以及更慢的亲密度。注入的是一两句内心独白，不是数字。
- 主动开口：阈值、每日上限、最小间隔、安静时段，以及第二天跟进记得的事。停在送出中的一行不会再发第二次。
- 她口吻的日、周、月日记。原文不删，重要事件不压缩。
- 混合检索。默认是本地哈希，不需要 key；也可以接到任何 OpenAI 兼容的 `/embeddings`。可选的 sqlite-vec 做近邻，加载失败就扫 BLOB。
- 摄入 [lishan85/dsh-wander](https://github.com/lishan85/dsh-wander) 的出行，记成她自己的经历。

约定写在 [docs/PRD.md](docs/PRD.md)。`src/companion/stubs.ts` 里的空实现仍留给测试和显式关掉某一层的部署。

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

需要 Node `^22.19.0 || >=24.0.0`。默认路径不需要 API key。心情和日记的便宜模型、HTTP 嵌入和 HTTP 重排都是可选的，没有 key 就用规则、确定性正文、离线哈希或本地融合，启动不会去等凭据。

`sqlite-vec@0.1.9` 是 optionalDependencies，带预编译扩展，没有安装脚本。装不上或加载失败时，向量仍写在 SQLite 的 BLOB 里，检索改为进程内余弦。`@huggingface/tokenizers@0.2.0` 只在配置了 `promptTokenizerPath` 时需要。

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

`path` 必填，没有代码内默认值。其余字段有默认值。未知字段被忽略。key 不进配置文件，只在调用时从环境变量读取。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `path` | 无 | SQLite 文件。bundle 里是 `dshHomePath('companion/companion.db')` |
| `persona` | 内置中文人设 | 稳定系统段。历史不会改写它 |
| `recentTurns` | 12 | 注入里保留的最近原文条数 |
| `contextRadius` | 2 | 命中前后各带几句 |
| `snippetLimit` | 3 | 一次注入或默认搜索的片段数 |
| `promptMaxChars` | 6000 | 人设加易变回忆的字符预算 |
| `promptMaxTokens` | 不设 | 和 `promptTokenizerPath` 必须成对出现 |
| `promptTokenizerPath` | 不设 | 可选的 token 计数器资产。和 `promptMaxTokens` 必须成对出现 |
| `promptOrder` | 12 | 人设段在系统提示中的顺序 |
| `defaultPersonId` | `primary` | 没有渠道身份时的那个人 |
| `searchLimitMax` | 20 | `history_search` 的 `limit` 上限 |
| `emotionEnabled` | `true` | 关掉之后不打分、不写心情、不注入内心独白 |
| `proactiveEnabled` | `true` | 关掉之后不排队、不调用 `followup` |
| `proactiveDailyCap` | `2` | 同一个人、同一个本地日，最多几条主动消息 |
| `proactiveMinGapMs` | `21600000`（6 小时） | 两条主动消息的最小间隔 |
| `proactiveQuietTimeZone` | `Asia/Shanghai` | 安静时段和「第二天」用的 IANA 时区 |
| `proactiveQuietStart` / `proactiveQuietEnd` | `23:00` / `08:00` | 这段时间只排队，不送出。起止相同表示没有安静时段 |
| `proactiveFollowUpHour` | `9` | 记住的事，第二天这个钟点之后才跟 |
| `proactiveFollowUpMinute` | `0` | 跟进钟点的分钟 |
| `proactiveIntervalMs` | `900000`（15 分钟） | 后台再评估一次。`0` 表示没有定时器，仍会在每回合之后评估 |
| `thresholdMissing` | `0.72` | 想念超过该值才主动开口 |
| `thresholdWorried` | `0.75` | 担心超过该值才主动开口 |
| `thresholdAggrieved` | `0.7` | 委屈超过该值才主动开口 |
| `thresholdJealous` | `0.68` | 嫉妒超过该值才主动开口 |
| `thresholdAngry` | `0.7` | 生气超过该值才主动开口 |
| `emotionModelEnabled` | `false` | 打开后才尝试便宜模型。必须同时给 `http(s)` 的 `emotionModelBaseUrl` |
| `emotionModelBaseUrl` | 不设 | 便宜模型的 OpenAI 兼容地址。开关关掉时可以不填 |
| `emotionModelName` | `deepseek-chat` | 便宜模型的模型名 |
| `emotionModelTimeoutMs` | `800` | 超时或失败就改用规则打分，不卡住回合 |
| `diaryEnabled` | `true` | 关掉之后不写日记、不标重要事件 |
| `diaryTimeZone` | `Asia/Shanghai` | 日、周、月的本地日历 |
| `diaryIntervalMs` | `900000`（15 分钟） | 没有新回合时也检查要不要封页。`0` 表示没有定时器，换日和空闲仍会封 |
| `diaryModelEnabled` | `false` | 打开后才尝试用便宜模型写日记。必须同时给 `http(s)` 的 `diaryModelBaseUrl` |
| `diaryModelBaseUrl` | 不设 | 写日记的 OpenAI 兼容地址。开关关掉时可以不填 |
| `diaryModelName` | `deepseek-chat` | 写日记用的模型名 |
| `diaryModelTimeoutMs` | `4000` | 超时或失败就改用确定性正文。封页不在回合的热路径上 |
| `embeddingProvider` | `offline` | `offline` 或 `openai`。`openai` 表示任何 OpenAI 兼容的 `/embeddings`，必须同时给 `http(s)` 的 `embeddingBaseUrl` |
| `embeddingBaseUrl` | 不设 | 嵌入地址。没有以 `/embeddings` 结尾时会补上。离线模式可以不填 |
| `embeddingModel` | 空 | 空字符串表示离线用 `offline-hash-v1`，HTTP 用 `text-embedding-3-small` |
| `embeddingDimensions` | `128` | 8 到 4096。换维度会另存一组向量，不和旧空间混用 |
| `embeddingTimeoutMs` | `4000` | HTTP 嵌入超时。失败的行留到下一次补嵌入 |
| `embeddingApiKeyEnv` | `DSH_COMPANION_EMBEDDING_KEY` | 读 key 的环境变量名，必须是大写加下划线 |
| `rerankProvider` | `deterministic` | `deterministic` 或 `http`。`http` 必须同时给 `http(s)` 的 `rerankBaseUrl` |
| `rerankBaseUrl` | 不设 | 重排地址。没有以 `/rerank` 结尾时会补上 |
| `rerankModel` | 空 | 空字符串表示请求里用 `rerank` |
| `rerankTimeoutMs` | `2000` | HTTP 重排超时。失败就留下本地融合 |
| `rerankApiKeyEnv` | `DSH_COMPANION_RERANK_KEY` | 读重排 key 的环境变量名 |
| `rrfK` | `60` | 倒数排名融合的常数，1 到 1000 |
| `timeBoost` | `0.15` | 越近的命中乘得越多。0 到 5 |
| `timeHalfLifeDays` | `30` | 时间加权的半衰期，天数，(0, 3650] |
| `personBoost` | `0.1` | 当前这个人的原话和日记加权。经历不降权。0 到 5 |
| `topicBoost` | `0.2` | 经历的话题和查询有共同分词时加权。0 到 5 |
| `vectorMinScore` | `0.2` | 余弦低于这个值的向量命中不进入候选。0 到 1 |
| `vectorScanLimit` | `4096` | sqlite-vec 的 `k` 至少扫这么多行；小库则扫全部 |
| `wanderExperiencesPath` | 空 | dsh-wander 的 `experiences.jsonl`。空着就看环境变量 |

bundle 的 `cordis.patch.yml` 写了 `embeddingProvider: offline`，所以装上去的默认路径不发嵌入请求。

## 环境变量

| 变量 | 谁读 | 没有它的时候 |
| --- | --- | --- |
| `DSH_COMPANION_EMOTION_API_KEY` | 心情便宜模型 | 用规则打分，不发请求 |
| `DSH_COMPANION_DIARY_API_KEY` | 日记便宜模型 | 用确定性正文，不发请求 |
| `DSH_COMPANION_EMBEDDING_KEY` | HTTP 嵌入。名字可用 `embeddingApiKeyEnv` 换 | 用离线哈希，不发请求 |
| `DSH_COMPANION_RERANK_KEY` | HTTP 重排。名字可用 `rerankApiKeyEnv` 换 | 留下 RRF 和时间 / 人 / 话题加权 |
| `DSH_WANDER_EXPERIENCES` | 没配 `wanderExperiencesPath` 时，经历文件的路径 | 不读文件 |
| `DSH_WANDER_DATA_DIR` | 上面两个都空时，读这个目录下的 `experiences.jsonl` | 不读文件 |
| `DSH_NODE_MODULES` | 只给 `probe/boot-probe.mjs`，指向已安装的 dsh `node_modules` | 探针改去找全局的 `@deepseek-ai/dsh` |

key 不进配置、不进日志、不进库。401 或 403 只保留状态码，然后这个进程剩下的时间改用离线哈希。

## 架构

人设放在系统段 `companion:persona`，好让前缀缓存复用。最近原话和检索片段在 `agent/pre-step` 里前置成一条用户消息，正文以 U+2060 开头，`source` 为 `{ kind: "dsh-companion", form: "recall" }`，因此不会被再次记入原文。

`session/event` 记录 `user/message` 和 `assistant/message`。`turn/end` 没有正文。助手消息沿用本会话上一条的渠道字段。

模式版本 4。版本 1、2、3 的库在打开时按 `MIGRATIONS` 升到 4，原文保留。更新、外来或不完整的文件在只读阶段拒绝，不改主库。版本不到 4 却已经有向量或经历表时同样拒绝。

## 情绪和主动开口

每一维都有基线、按时间的衰减和惯性。想念会在人不在的时候往上长，其他维度往自己的基线回。亲密度用更慢的衰减和更高的惯性，单独走。每回合先衰减，再吃这一句的增量：配置了便宜模型并且环境变量 `DSH_COMPANION_EMOTION_API_KEY` 有值时先问模型，没有 key、超时、HTTP 错误或 JSON 不合规格，就用确定性的规则。key 不进配置、不进日志、不进库。

注入只取最强的两三维，写成一句第一人称内心独白，放在易变的那条回忆里。人设那段不动，所以系统前缀还能复用。心情落在同一档里时，这句话保持不变。

主动消息进 `proactive_outbox`。超过阈值，或第二天到了该跟进的事（考试、面试、身体、出行、生日、约定），才排队。安静时段、每日上限和最小间隔都会把 `due_at` 推后。送出时，如果这个会话还有活着的 agent，就调用它的 `followup`：正文是让她自己开口的一句指令，`source.kind` 为 `dsh-companion`，开头有 U+2060，因此不会被记成用户说的话。没有活着的 agent 时，行留在 `queued`。宿主可以之后调用 `drainProactiveQueue(store, now, deliver)`。`deliverViaFollowup(agent, text)` 是跟 harness 对齐的那一种 deliver。`deliver` 明确说没送成（返回假或抛错）时，行回到 `queued`，可以再试。进程如果停在 `delivering`，下次打开把这一行收成 `delivered`，不再送。这是至多一次：崩溃若发生在真正调用 `followup` 之前，这一条就不会补发。

## 日记

她按本地日写一页第一人称日记，再收成周和月。原始回合一直留着。考试、约定、承诺、点名这类重要事件整句保存，周页和月页可以把普通日子写短，但这些原话会附在页尾，注入时也不会被缩掉。

封页发生在换日（包括重启后的下一句）、agent 空闲，或定时器。同一个人的同一天、同一周、同一个月只写一次。正在过的今天不封。便宜模型用 `DSH_COMPANION_DIARY_API_KEY`；没有 key 就用确定性正文。日记和原话一起进 FTS，命中之后用「我翻到自己写过的……」放进同一条易变回忆，和原话共用字符（以及可选的 token）预算。装不下时先丢掉检索片段，再丢掉最旧的近期原话。人设那段不动。

`StubDiaryWriter` 还在，给测试和显式关掉日记的部署用。插件自己的默认实现会落库。

## 混合检索

插件打开库之后用 `SqliteVectorIndex` 和 `HybridReranker`。`NullVectorIndex` 和 `FtsOrderReranker` 还在，给测试用；直接调用 `retrieve` 且不传入向量时，行为仍是「全文在前，只有向量的命中在后」。

每条新原话会嵌入。已经写过的原话、封好的日记页和经历由 `backfill` 补上，启动、回合、搜索和 `pre-step` 都会补。同一种模型、同一维度、正文没变，就不再嵌一次。

融合是 RRF：FTS5 bm25、向量余弦、字符 n-gram 余弦，再乘时间、当前的人、话题。可选的 HTTP 重排失败时留下这个分数。预算仍然在 `renderCompanionPrompt`：装不下时先丢掉检索片段，再丢掉最旧的近期原话。人设不动。

离线哈希能找回词表里的同义说法，例如「英短」对「宠物小猫」，即使两边没有共同的 FTS 词。它找不回词表以外、又没有共同字符的释义。无关句子的余弦接近 0，默认 0.2 以下不进入候选。这不是神经网络的召回质量。

`StubEmotionModel` 还在，给测试和显式关掉心情的部署用。插件自己的默认实现是会落库的那一个。

## dsh-wander

[lishan85/dsh-wander](https://github.com/lishan85/dsh-wander) 在一次出行之后追加 `experiences.jsonl`，并发出 `wander/trip`。本插件两个都收，按 `id` 去重，记成她自己的经历，不按对方的 `person_id` 过滤。`descriptionMode: metadata` 的片段会说明她没有把画面交给视觉模型。坏行跳过。路径见上面的配置和环境变量。没有 wander 时，这两处都空着，插件照常启动。

## 多渠道

QQ、微信和其他社区桥把消息送进 dsh 会话。本插件只在 dsh 钩子里记 `channel`、`user_id`、`chat_id`、`session_id`、`bridge`、时间和正文。它不连接那些平台。

桥的 README 没有说明钩子上看得到哪些字段。代码只在几个可能的位置找，找不到就留空，然后归到 `defaultPersonId`。不要把它理解成已经核对过的协议。

## 限制

- 预算装不下的旧回合不会出现在这一轮注入里。它们还在库里，检索也可能漏。
- 人设要求想不起时含糊，不要编造，也不要宣布「没有这段经历」。模型不一定照做。
- 身份字段缺失时，不同平台用户可能被记成同一个人。
- 本仓库没有实机模型回合，也没有拿真实的 DeepSeek key 打过分。心情和日记的便宜模型请求形状都用 mock 测过；它们在真的端点上会不会按约定回，没有验证。
- 主动开口依赖活着的 `agent.followup`。本环境没有跑通一次真实的 harness 投递，也没有把消息送到 QQ 或微信。队列和 `drainProactiveQueue` 是接入点。停在 `delivering` 的行不会再送一次。
- 日记的重要事件是关键词，不是语义理解。已经封好的页不会因为事后又补进一句而改写；那一句仍在原文里，注入时会把缺的原话补上。
- 渠道桥的钩子字段仍未对照过它们的实现。
- 离线嵌入只覆盖内置同义词簇和字符 n-gram。簇外的释义会漏。HTTP 嵌入和 HTTP 重排只用 mock 测过，没有对真实端点发过请求。
- sqlite-vec 在本机 Node 22、linux-x64 上加载过。其他平台和 Node 24 要等 CI。加载失败时走 BLOB，这条有测试。
- wander 的摄入按公开的版本 1 对象测过，没有和正在跑的 wander 进程联调。

## 路线

1. 情绪、衰减、亲密度，以及带上限和安静时段的主动开口。这一步已经接上。
2. 她口吻的日、周、月日记。原文永久保留，重要事件不压缩。这一步已经接上。
3. 可配置嵌入、离线回退，以及和 FTS5 混在一起的重排。这一步已经接上。
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
