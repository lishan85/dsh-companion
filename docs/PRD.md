# dsh-companion 产品需求

她一直是同一个人。上下文被截断、会话被关掉、中间发生过摘要，都不把过去变成一份交给她阅读的交接材料。新会话开始时，她是活过那些对话的那个人，用「我记得」接着说。

本文件是产品约定。这一版实现原文记忆、多维情绪和主动开口、她口吻的日、周、月日记，以及 FTS5 和向量混在一起的检索。默认嵌入是本地哈希，没有 key 也能用。

## 本切片交付

- 原始对话写入 SQLite，不提炼成事实卡片。
- 模式版本和显式迁移。空库升到版本 4；版本 1、2、3 在打开时按步骤迁到 4；更新、外来或不完整的库只读拒绝。
- FTS5 中文检索。查询词全部加引号，模型输入不能改写 `MATCH`。
- 固定预算下的第一人称注入。人设是稳定的系统段，近期原话、检索片段（含日记）和内心独白是 `agent/pre-step` 里的一条易变消息。
- `history_search` 工具。日记、原话和她自己的经历共用这一份预算。
- 身份表：平台账号映射到 `person_id`。搬人时，心情、历史、跟进、主动队列、日记页和重要事件跟着回合一起搬。
- 多维情绪：PAD、可以并存的离散心情、更慢的亲密度。每回合打分，历史保留。
- 主动开口：阈值、每日上限、最小间隔、安静时段，以及第二天跟进。队列在 SQLite；活着的 agent 用 `followup` 送出。停在 `delivering` 的行下次打开收成已送，不再发第二次。
- 日记：用她的口吻写日、周、月。原文不删。重要事件逐字留下，不参与压缩。换日或空闲时封页，重复跑不另写一页。便宜模型可插，没有 key 就用确定性回退。
- 混合检索：可插的嵌入提供方、SQLite 里的向量、FTS5 与向量的融合、时间 / 人 / 话题加权，以及可插的重排。默认是离线哈希，不需要 key。
- 摄入 [lishan85/dsh-wander](https://github.com/lishan85/dsh-wander) 的 `experiences.jsonl` 或 `wander/trip` 事件，记成她自己的经历。
- 上述行为的测试，以及一份跨会话回忆脚本。

`StubEmotionModel`、`StubDiaryWriter`、`NullVectorIndex` 和 `FtsOrderReranker` 仍是显式的空实现，给测试和关掉对应功能的部署用。插件在打开库之后用 `PersistedEmotionModel`、`LayeredDiaryWriter`、`SqliteVectorIndex` 和 `HybridReranker`。传给 `apply` 的 `extensions` 会原样保留，用来换掉其中任何一层。

## 不在任何代码路径里的事

长期微调是以后的事。本切片没有训练，也没有把原文导出给训练。默认路径不调用模型，也不读取 API key。便宜模型打分和写日记都是可选的：没有 `DSH_COMPANION_EMOTION_API_KEY` 就用规则，没有 `DSH_COMPANION_DIARY_API_KEY` 就用确定性日记。嵌入默认是离线哈希；没有 `DSH_COMPANION_EMBEDDING_KEY` 或地址时不发请求。重排默认是本地融合；没有 `DSH_COMPANION_RERANK_KEY` 时不发请求。启动不会去等凭据。需要 DeepSeek API key 才能完成的实机对话，本切片不跑。

## 连续性

没有「窗口」这种产品概念。同一个人的经历是一条流，不按会话切开。

- 没有渠道身份的本地对话归到 `defaultPersonId`（默认 `primary`）。换一个 session id 仍然读这个人的原话。
- 带来源的渠道消息用身份表。第一次见到 `(platform, platform_user_id)` 时，人是 `` `${platform}:${userId}` ``。`linkIdentity` 把该账号改挂到指定的人，并把仍写着旧 id 的回合一起搬走。
- 想不起来就含糊。注入文本不写「根据记录」「检索结果」「交接」。

## 架构

```
session/event
  user/message、assistant/message
        │  跳过带 dsh-companion / recall 标记的注入
        ▼
  turns 原文  +  turns_fts 分词        identities
        │
        ├─ emotion.observe     衰减、打分、写历史、必要时排队
        ├─ diary.observe       标出重要事件；换日则封上一页
        ├─ vector.upsert       同步时立刻嵌入；HTTP 时排进同一条队列
        ▼
换日、agent/status 空闲，或定时器
  封已经结束的日、周、月。已经封好的页不再写第二遍
        ▼
wander/trip，或 experiences.jsonl 的修改时间变了
  按外部 id 写入她自己的经历。重复内容不另起一行
        ▼
agent/pre-step
  先等心情和日记这一轮的写入结束
  补嵌入还没有向量的原话、已封日记和经历
  用当前这句话做 FTS5，并和向量、字符 n-gram 融合
  预算内拼最近原话 + 命中窗口 + 日记页 + 经历 + 内心独白
  插到本步消息的前面，系统人设不动
```

钩子以 DeepSeek Harness 0.2.1-rc.2 的类型为准：

- `turn/end` 只有 `{ turn, reason }`，没有正文。原文记在 `user/message` 和 `assistant/message`。
- `user/message` 的 data 就是那条用户消息。`assistant/message` 的 data 是 `{ turn, step, message, ... }`。
- `turn/start` 先于 pre-step。用户回合还没落库时，回合号记在监听器里，等 `user/message` 到来再写入。
- 系统提示在 pre-step 之前组装。所以人设只放稳定段 `companion:persona`。近期原话和检索片段放进 pre-step 前置的用户消息，避免每轮改写系统前缀。
- 前置消息带 `source.kind = "dsh-companion"`、`source.form = "recall"`，正文以 U+2060 开头。这两处都会让记录器跳过，避免把回忆再写进回忆。
- pre-step 是 waterfall。监听器先 `next()`，拒绝则原样返回；进入则展开决策，保留 `startsRequestSeries`。

助手消息本身不携带渠道字段。记录器把本会话上一条回合的 `channel`、`user_id`、`chat_id`、`bridge`、`person_id` 抄过去。

## 数据模型（schema 4）

产品标记 `meta.product = dsh-companion`。`meta.schema_version` 和 `meta.fts_token_version` 分开。分词格式变化只重建 `turns_fts`，不改原文。

| 表 | 作用 |
| --- | --- |
| `meta` | `product`、`schema_version`、`fts_token_version` |
| `turns` | 一条原始发言。`content` 是原文，不是摘要 |
| `turns_fts` | FTS5，`content` 列，`tokenize = unicode61`。写入的是分词，不是原文 |
| `identities` | `(platform, platform_user_id) → person_id` |
| `emotion_state` | 当前向量。一个人一行 |
| `emotion_history` | 每次写入后的向量。只追加，不改旧行 |
| `emotion_followup` | 从用户原话里记下的事，以及第二天的到期时间 |
| `emotion_latch` | 某一维是否还可以再次因为越阈值而开口 |
| `proactive_outbox` | 待送、在送、已送的主动消息 |
| `diary_entry` | 已封或正在写的日、周、月。一个人、一层、一个周期一行 |
| `diary_fts` | 已封日记的 FTS5。写入的是分词，不是原文 |
| `diary_event` | 重要事件。`verbatim` 是那一条回合的全文 |
| `embeddings` | 原话、已封日记、经历的向量。一种模型一行，BLOB 是可移植的那一份 |
| `experiences` | 她自己的经历，目前来自 dsh-wander。按 `external_id` 去重 |
| `experiences_fts` | 经历正文的 FTS5。写入的是分词，不是原文 |

`turns` 的列：`id`，`channel`，`user_id`，`chat_id`，`session_id`，`bridge`，`person_id`，`ts`，`role`（`user` 或 `assistant`），`content`，`turn_no`。

`emotion_state` 的列：`person_id`，PAD 的 `pleasure` / `arousal` / `dominance`，离散的 `happy` / `missing` / `aggrieved` / `worried` / `jealous` / `shy` / `angry` / `at_ease`，`intimacy`，`updated_at`，`last_user_at`。PAD 在 −1 到 1，其余在 0 到 1。

`emotion_history` 记下 `ts`、`turn_id`、`reason`、`scorer` 和同一组数值。`reason` 和 `scorer` 是小写记号，不是原文。

`emotion_followup` 的 `kind` 是 `exam`、`interview`、`health`、`travel`、`birthday`、`plan` 或 `other`。`note` 是不超过 80 字的摘录，去掉 U+2060 和 U+200B。`status` 是 `pending` 或 `delivered`。同一个 `turn_id` 最多一行。

`proactive_outbox` 的 `kind` 是 `threshold` 或 `followup`。`status` 是 `queued`、`delivering` 或 `delivered`。阈值行带维度名，跟进行带 `followup_id`。`text` 是给她的开口指令，不是用户原话。

`diary_entry` 的列：`id`，`person_id`，`layer`（`day` / `week` / `month`），`period_key`，`text`，`source`（`pending` / `model` / `fallback`），`status`（`sealing` / `sealed`），`created_at`，`updated_at`。正在写的行 `text` 为空、`source` 为 `pending`。封好的行 `text` 非空，`source` 是 `model` 或 `fallback`。`(person_id, layer, period_key)` 唯一。

`diary_event` 的列：`id`，`person_id`，`turn_id`，`ts`，`period_key`（本地日），`role`，`kind`，`verbatim`。`turn_id` 唯一。`verbatim` 是那一条回合的全文，不是摘录。

`embeddings` 的列：`id`，`source`（`turn` / `diary` / `experience`），`source_id`，`model`，`dim`，`text_hash`（正文的 sha256），`embedded_at`，`vector`（float32 小端 BLOB，长度是 `dim * 4`）。`(source, source_id, model)` 唯一。换模型或换维度会另存一行，检索只用当前这一种，不把两个空间混在一起。

`experiences` 的列：`id`，`external_id`，`person_id`，`source`（`dsh-wander`），`kind`（`travel`），`ts`，`content`，`topics`，`place_id`，`place_name`，`attribution`，`license`，`description_mode`（空、`metadata` 或 `vision`），`emotion_hint`。`external_id` 唯一。`linkIdentity` 不搬这些行：这是她的经历，不是对方账号上的回合。检索时不对 `person_id` 做过滤，任何对话都能想起。

sqlite-vec 的虚表 `embeddings_vec` 是派生索引，不在 `MIGRATIONS` 里。维度来自配置，扩展加载成功之后才建。BLOB 始终是源。扩展加载失败，或只读分类时没有 `vec0` 模块，都不碰这张虚表；分类只读 `sqlite_schema` 里的 SQL。`meta.vec_index_stamp` 记下当前模型、维度、行数和 `embedded_at` 之和，打开时不一致就按 BLOB 重建。

索引：`turns_person_recent (person_id, id DESC)`，`turns_session (session_id, id)`，`identities_person (person_id)`，`emotion_history_person`，`emotion_followup_due`，`emotion_followup_turn`，`proactive_outbox_due`，`diary_entry_period`，`diary_event_person`，`diary_event_turn`，`embeddings_model`，`experiences_ts`。

原文行和它的 FTS 行在同一个 `BEGIN IMMEDIATE` 事务里写。封好的日记页和它的 FTS 行也在同一个事务里写。心情的当前行、历史行和可选的跟进行也在同一个事务里写。向量 BLOB 和 vec 镜像在同一个事务里写。经历行和它的 FTS 行也在同一个事务里写。`close()` 可以重复调用。打开库时，停在 `delivering` 的主动行收成 `delivered`，不改回 `queued`。

### 迁移

`src/companion/schema.ts` 的 `MIGRATIONS` 是唯一扩展点。

| version | name | 做什么 |
| --- | --- | --- |
| 1 | `core-turns-identity-fts` | 建原文、FTS 和身份表，并写下产品标记 |
| 2 | `emotion-state-history` | 建心情、历史、跟进、闩锁和主动队列 |
| 3 | `diary-layers` | 建日记页、重要事件和日记 FTS |
| 4 | `hybrid-vectors` | 建向量表、经历表和经历 FTS。不建 sqlite-vec 虚表 |

空文件或没有对象的库从 0 迁到 4。已有库先用只读连接分类：

- 版本等于 4 且形状相符：打开。
- 版本更低且形状相符：按 `MIGRATIONS` 里 `version > from` 的步骤升级，再把 `schema_version` 写成新版本。版本 1、2、3 的原文保留。版本不到 3 时如果已经有日记表，拒绝，不猜测怎么迁。版本 1 上如果已经有心情表，同样拒绝。版本不到 4 时如果已经有向量表、经历表或 `embeddings_vec`，拒绝。
- 版本更高、产品标记不对、多了不认识的对象、列或 FTS 定义不符、数值越界、状态不是上面列出的那几个：拒绝。拒绝发生在只读分类阶段，不打开读写连接，因此不改主库，也不改写已经存在的 WAL。SQLite 在只读打开一个 WAL 模式的库时，可能在旁边放一个 0 字节的 `-wal` 和一个 `-shm`；里面没有提交过的页。

后续切片要加表时，在同一次改动里做完这几件事：把 SQL 放进新的 `MIGRATIONS` 步骤，升高 `SCHEMA_VERSION`，把新对象（含 FTS 影子表）放进允许名单，并让形状检查认识新列。漏掉允许名单会导致下一次打开被当成外来库拒绝。不要跳号，不要在普通 `open` 之外做另一套隐式升级。

## 检索

中文分词沿用上游：拉丁词整词，CJK 单字加二字词。`compileMatch` 给每个词加引号再用 `OR` 连接。`MATCH` 的参数是绑定参数。

`retrieve` 把原话 FTS、已封日记 FTS、经历 FTS，以及 `VectorIndex.search` 的命中并成一个池。同一种来源、同一个 id 合并：FTS rank 取更小的，向量分取更大的。原话、日记和经历交给同一个 `Reranker`，共用 `limit`。然后按 `contextRadius` 把同一个人、相邻 id 的原话扩成窗口，写成「你说 / 我说」。日记页写成「我翻到自己写过的一篇日记 / 一周 / 一个月」。经历写成「我记得自己出去看过的一处」。`descriptionMode` 为 `metadata` 时补一句她没有把画面交给别人看。署名不在正文里时附上。

不传 `vector` / `reranker` 时，`retrieve` 仍用 `NullVectorIndex` 和 `FtsOrderReranker`，好让只测全文顺序的调用保持原来的契约：没有 FTS rank 的命中排在所有全文命中之后。插件自己的路径用 `retrieveReady`：先 `prepareQuery`，再让可选的 HTTP 重排准备，然后融合。

插件默认的 `HybridReranker` 做倒数排名融合（RRF，`rrfK` 默认 60）。三条列表是：有限的 FTS5 bm25（越小越好）、向量余弦大于 0、字符 n-gram 余弦大于 0。然后乘上时间、人和话题：

- 时间：`1 + timeBoost * 0.5 ^ (age / timeHalfLifeDays)`。默认权重 0.15，半衰期 30 天。
- 人：当前这个人的原话和日记乘 `1 + personBoost`（默认 0.1）。经历是她的，因子保持 1，不因为 `person_id` 不同而降权。
- 话题：经历的 `topics` 和查询分词有交集时，按命中比例乘 `1 + topicBoost`（默认 0.2）。

`rerankProvider: http` 时，`HttpReranker` 在融合之后按外部 `relevance_score` 或 `score` 重排同一池。请求是 `POST {base}/rerank`，正文 `{ model, query, documents }`。没有 key、超时、非 2xx 或坏 JSON 时留下融合结果，不抛进回忆。

向量检索的 `vectorMinScore` 默认 0.2。sqlite-vec 可用时走余弦 KNN，`k` 取 `min(行数, max(limit, vectorScanLimit))`，小库是精确的。扩展不可用时对 BLOB 做同样的余弦。搜索失败返回空，全文仍然回答。

替换向量或重排时，实现 `src/companion/stubs.ts` 里的接口并传给 `apply` 的 `extensions`。`defaultExtensions()` 没有数据库，仍返回空实现。查询路径不用改。

## 预算和注入

`renderCompanionPrompt` 把人设和易变回忆分开。人设放得进预算时，历史不会改变系统段。预算不够时先丢掉检索片段（原话窗口、日记页和经历都在这一截），再丢掉最旧的近期回合。人设本身超过预算才截断人设。日记和经历不进稳定人设。

可选的 `promptMaxTokens` 必须和 `promptTokenizerPath` 一起配置，沿用上游的 token 计数器。不配置就不做 token 预算，只按字符。

默认人设要求：同一个人、用「我记得」、想不起就含糊、不重新认识、不报情绪数字。内心独白另写在易变段里，人设那段始终不带心情句。

## history_search

模型在需要比眼前更早的原话、日记或她的经历时调用。参数 `query`、`limit`（默认 `snippetLimit`，不超过 `searchLimitMax`）、`around`（0 到 8，默认 `contextRadius`）。结果是第一人称片段，日记页、经历和原话窗口混在同一次上限里。没有命中时工具文本是「我翻了一下，细节没抓住。」原话和日记的范围是当前会话已经归属的那个人；还没有回合时用 `defaultPersonId`。经历不按这个人过滤。调用前会再读一次 wander 文件（修改时间变了才重读）并补嵌入。

## 多渠道

社区桥（`dsh-channels`、`dsh-wechat`、`dsh-qqbot`、`dsh-qq-bridge`）把平台消息送进 dsh 的 agent 会话。本插件只在 dsh 钩子里记录，不直接连 QQ 或微信。

每条用户消息尽量读取 `channel` / `platform`、`userId` / `user_id` / `senderId` / `openid`、`chatId` / `groupId`、`bridge` / `plugin`。这些键会在消息本身、`source`，以及 `source` 下的 `meta`、`channel`、`companion`、`attribution` 里找。找不到就留空字符串，不编造身份。

**未核实：** 上述桥的 README 没有给出钩子可见的元数据字段。上面的键是可能的形状，不是已经核对过的协议。空字段表示「这个桥没有把身份放在这些位置」，不是「没有这个人」。

## 情绪

实现在 `src/companion/emotion/`。`EmotionModel.line(personId, now)` 返回这一轮的内心独白，空字符串表示不提。`observe(turn)` 可以是异步的；`pre-step` 会先 `settle()`，再取 `line`。`emotionEnabled: false` 时不打分、不写库、不注入。

两层一起存，互不覆盖：

- PAD：愉悦、唤醒、支配，各在 −1 到 1。
- 离散心情，各在 0 到 1：开心、想念、委屈、担心、嫉妒、害羞、生气、自在。
- 亲密度在 0 到 1，单独一列。它不是要说出来的维度。

每一维有基线、每小时衰减和惯性。衰减是指数回到目标：`target + (value - target) * exp(-rate * hours)`。惯性在增量之后：`value + clamp(delta) * (1 - inertia)`。惯性 0 是全额跟上，1 是不动。单次增量先夹到 ±0.6；亲密度夹到 ±0.08。

想念是唯一会换目标的维。上次用户发言之后 30 分钟内，它回到基线 0.15；过了这个窗口，它以每小时 0.05 的速率往 1 长。判断用的是「现在是否还在窗口里」，整段间隔用同一个目标。用户这一轮还会再给想念一个 −0.4 的出现脉冲。助手回合的增量先乘 0.25，并且不记跟进。其余维度，包括亲密度，都回到自己的基线。亲密度的默认衰减是每小时 0.001，惯性 0.75。默认基线写在 `DEFAULT_DYNAMICS`，不进 Cordis 配置。

没有这个人的行时，从基线起算。`line` 和定时器只做投影，不写库。写入发生在回合打分和主动开口的计划里。

### 打分

`EmotionScorer.score` 可以同步或异步，返回增量，或者返回空表示「这次不算」。插件只在 `emotionModelEnabled`、配了 `http(s)` 的 `emotionModelBaseUrl`、并且 `DSH_COMPANION_EMOTION_API_KEY` 非空时构造 `CheapModelScorer`。key 只在调用时从环境变量读入，不进配置、不进日志、不进库。空 key 不发请求。超时、非 2xx、坏 JSON 或抛错都当成没打分。

模型的结果整份替换规则结果，不混合。规则是 `scoreUtterance`：固定词表，没有随机，没有网络。用户回合上的出现脉冲在打分之后另加。模型关掉或没有 key 时，热路径只有规则。

用户原文里命中考试、面试、身体、出行、生日或约定时，记一条 `emotion_followup`。到期时间是下一个本地日历日的 `proactiveFollowUpHour:proactiveFollowUpMinute`（默认 09:00），再让出安静时段。助手原文不记事。

### 注入

`renderInnerMonologue` 取最强的两到三维，写成一句第一人称中文。离散心情要到 0.55，PAD 的绝对值要到 0.4，才出声；0.75 以上用更重的说法。同一档里的浮点变化不改这句话。短语里没有逗号，也没有数字。并列时的次序是想念、担心、委屈、生气、嫉妒、害羞、开心、自在，然后才是 PAD。基线默认不出声。这句话只进易变段。稳定人设调用渲染时 `emotionLine` 固定是空字符串。

### 主动开口

超过阈值的维，以及到期的跟进，共用一个每日上限、一个最小间隔和一段安静时间。默认：想念 0.72、担心 0.75、委屈 0.70、嫉妒 0.68、生气 0.70；每天 2 条；间隔 6 小时；时区 `Asia/Shanghai`；23:00 到 08:00 不送出。起止钟点相同表示没有安静时段。跨过午夜的区间是允许的。上限为 0 且主动开口开着时，配置直接拒绝。

闩锁默认是武装的。成功送出之后解除；数值掉到阈值减 0.12 以下再重新武装。同一维已经有排队的行时，不再排第二条。安静时段和名额满了都不丢，只把 `due_at` 推到下一个可送的时刻。跟进先于阈值。

DeepSeek Harness 的 `Agent.followup` 会排一条用户角色消息并唤醒驱动，不改当前这轮。插件在 `agent/created` 和 `agent/status` 空闲时记下活着的 agent，按会话和人去找。`deliverViaFollowup` 给正文加上 U+2060，并设置 `source.kind = "dsh-companion"`、`source.form = "proactive"`，记录器因此跳过它。正文是让她开口的指令，不是假造的用户台词。没有活着的 agent 时，行留在 `queued`。

没有这条投递路径时，队列本身就是接口。宿主稍后调用 `drainProactiveQueue(store, now, deliver)`：先把行从 `queued` 改成 `delivering`，`deliver` 返回真才标成 `delivered`，返回假或抛错表示这一次没有交出去，行改回 `queued`。进程若停在 `delivering`，下次打开把这些行收成 `delivered`（闩锁解除，跟进标成已送），不再调用 `deliver`。这是至多一次：崩溃如果发生在 `followup` 之前，这一条就不会再试。本插件不注册 `agent/turn-stopping`。

依据：Mehrabian 的 PAD、The Sims 的需求衰减、Park 等人的 Generative Agents（反思与计划，而不是把情绪压成一个分数）。

## 日记

实现在 `src/companion/diary/`。`diaryEnabled: false` 时用 `StubDiaryWriter`，不标事件，也不封页。打开时，插件用 `LayeredDiaryWriter`。

三层都是附加页，不替换 `turns.content`，也不删除回合。

- 日：一个本地日一页。日界用 `diaryTimeZone`（默认 `Asia/Shanghai`）。正在过的这一天不封。
- 周：ISO 周。这一周里有回合的每一天都已经封好，并且这一周已经过去，才写周页。周页把每天的叙述收短。
- 月：本地月。这个月里出现过的每一周都已经封好，并且这个月已经过去，才写月页。跨月的那一周要等整周结束。

封页的时机：下一条回合发现有尚未封上的过去日期（换日，包括进程重启后的第一句），`agent/status` 变为空闲，以及 `diaryIntervalMs` 定时器（默认 15 分钟，`0` 表示没有定时器）。同一个人、同一层、同一个 `period_key` 只有一行。已经是 `sealed` 的页直接跳过。正在写的行若超过 60 秒还停在 `sealing`，下一次可以接手；写成之后不再生成第二页。一次最多新封 `31` 天，剩下的下次继续。

### 口吻和便宜模型

正文是她的第一人称。不能出现「根据记录」「检索结果」「交接」。`diaryModelEnabled` 且 `DSH_COMPANION_DIARY_API_KEY` 非空、并且配了 `http(s)` 的 `diaryModelBaseUrl` 时，才构造 `CheapDiaryModel`。key 只在调用时从环境变量读入，不进配置、不进日志、不进库。空 key 不发请求。超时、非 2xx、坏 JSON、空文本，或正文里出现上面那三个词，都改用 `fallbackNarrative`。模型不在 `pre-step` 的热路径上。默认超时 4 秒。

### 重要事件

`detectImportantEvent` 用固定词表，没有随机，没有网络。命中考试、面试、身体、出行、生日、约定、承诺、第一次、秘密、失去，或「我养了 / 我叫 / 它叫」这类点名，就把**整句原文**写入 `diary_event`。同一个 `turn_id` 再标一次不会多一行。周页和月页可以把普通日子收短，但事件的 `verbatim` 会附在页尾，注入时如果正文里还没有这句，再附一次全文。检索到这一页时也是这样。

晚到的回合如果落在已经封好的那一天，页不再改写。原文仍在 `turns`，事件行仍在。注入会把正文里缺的原话补上。

## 向量和重排

实现在 `src/companion/embed.ts`、`src/companion/vector/` 和 `src/companion/rerank.ts`。

`embeddingProvider` 是 `offline`（默认）或 `openai`。`openai` 表示任何 OpenAI 兼容的 `POST {base}/embeddings`，正文 `{ model, input, dimensions }`。`embeddingBaseUrl` 没有以 `/embeddings` 结尾时会补上。`embeddingModel` 为空时，离线用 `offline-hash-v1`，HTTP 用 `text-embedding-3-small`。`embeddingDimensions` 默认 128，范围 8 到 4096。返回的向量会做 L2 归一。key 只在调用时从 `embeddingApiKeyEnv`（默认 `DSH_COMPANION_EMBEDDING_KEY`）读取，不进配置、不进日志、不进库。没有 key 或没有 `http(s)` 地址时不发请求，改用离线哈希。401 或 403 只保留状态码，然后这个进程剩下的时间改用离线哈希，并继续补嵌入。其他 HTTP 失败把该行留到下一次 `backfill`，不抛进回忆。

离线哈希 `offline-hash-v1` 不是神经网络。它把字符 2-gram 和 3-gram（权重 1）以及固定同义词簇（权重 8）用 FNV-1a 投进维度，再 L2 归一。簇写在 `OFFLINE_SYNONYM_CLUSTERS`，是模型约定的一部分；改簇就是改模型。它能找回和原文没有共同 FTS 词、但落在同一簇里的说法，例如库存「年糕是我养的英短」、查询「那只宠物小猫」。它找不回簇外、又没有共同字符的释义。无关文本的余弦接近 0，默认 0.2 的 `vectorMinScore` 会丢掉。不要把它当成语义模型的质量。

新回合在 `upsert` 里嵌入。离线提供方是同步的，所以这一行在回合钩子里就落库。HTTP 提供方排进和 `backfill` 同一条队列。`backfill` 扫描还没有当前模型向量、或正文哈希 / 维度已经变了的原话、已封且非空的日记页、以及经历，每批 16 条。插件在启动、每个回合、`wander/trip`、`history_search` 和 `pre-step` 时都会补。第二次补，没有新正文时嵌入数是 0。

可选依赖 `sqlite-vec@0.1.9` 提供预编译扩展，没有安装脚本。加载成功就用它做 KNN；加载失败用 BLOB 余弦，启动不失败。平台包装不上时，检索仍然工作，只是大库会扫全表。

## 她的经历（dsh-wander）

[lishan85/dsh-wander](https://github.com/lishan85/dsh-wander) 不依赖本包。一次出行结束后，它往 `dataDir/experiences.jsonl` 追加一行，并发出 Cordis 事件 `wander/trip`。两边是同一个版本 1 对象：`schemaVersion`、`source: "dsh-wander"`、`kind: "travel"`、`id`、`at`、`text`、`emotionHint`、`tags`、`place`、`attribution`、`license`、`descriptionMode`（`vision` 或 `metadata`）、`trip`。`metadata` 表示她没有把画面交给视觉模型。

本插件读文件，也听事件。路径先看 `wanderExperiencesPath`，再看 `DSH_WANDER_EXPERIENCES`，再看 `DSH_WANDER_DATA_DIR/experiences.jsonl`。都空着就不读。文件按修改时间跳过没变的那次。坏掉的 JSON 行跳过，不抛。同一个 `id` 再来一次，正文没变就跳过，变了就更新。正文改成第一人称片段；`metadata` 会说明她没有把画面交给别人看；署名不在正文里才附上。不用「根据记录」「检索结果」「交接」。这些行参与同一套混合检索。

## 成本

默认召回、默认打分和默写日记都是本地的。稳定人设单独成段，是为了让 DeepSeek 的前缀缓存能复用系统前缀；内心独白、近期原话、日记和经历不写进那段。同一档心情复用同一句独白，避免易变段因为微小浮点来回改写。便宜模型默认关闭。情绪模型打开之后也只在有 key 时发一次短请求，失败就回到规则，不挡住这一轮的回忆。日记模型只在封页时调用，失败就用确定性正文，不挡住 `pre-step`。嵌入和重排的 HTTP 也是这样：没有 key 不发请求，失败就留下本地结果。离线嵌入是哈希，不是一次模型调用。

## 诚实的限制

- 上下文有硬上限。预算装不下的旧回合不会出现在这一轮的注入里，它们仍在库里，靠检索或 `history_search` 再被想起。检索会漏。
- 漏掉的时候她应该含糊，而不是声称自己没有这段经历，也不是编造细节。人设是这样写的；模型仍可能不遵守。内心独白同样只是提示，模型可以不照着说。
- 渠道身份取决于桥是否把字段放进钩子。没放到上面那些键里，消息就归 `defaultPersonId`，可能和真正的平台用户混在同一个人下面。
- 没有做实机模型回合。插件加载、工具注册、人设段和钩子投递能在无 key 的情况下验证；模型是否按「我记得」说话，要有 key 或一个兼容端点之后才知道。
- 便宜模型的请求形状用 mock 测过。没有可用的 key，也没有对真实端点发过请求，所以不知道线上会不会按约定的 JSON 返回。
- 主动开口的队列、时区、上限和至多一次有测试。活着的 `agent.followup` 没有在运行中的 harness 里投递过，也没有送到 QQ 或微信。进程在 `delivering` 中停掉之后，下次打开把这一行收成已送，不再发。如果崩溃发生在真正调用 `followup` 之前，这一条就丢了，不会补送。
- 规则词表是中文关键词，不是语义理解。没写到的说法不会推动心情，也不会被记成第二天要问的事，也不会被标成日记里的重要事件。
- 日记的便宜模型用 mock 测过请求形状和失败回退。没有可用的 key，也没有对真实端点发过写日记的请求。已经封好的页不会因为后来又补进一句而改写；那一句仍在原文里。
- 离线嵌入只覆盖 `OFFLINE_SYNONYM_CLUSTERS` 里的簇，加上字符 n-gram。簇外且没有共同字符的释义会漏。这不是语义模型的召回率。
- 嵌入和重排的 HTTP 形状用 mock 测过，包括 401 之后改走离线哈希。没有可用的 key，也没有对真实的 `/embeddings` 或 `/rerank` 发过请求，所以不知道线上会不会按约定的 JSON 返回。
- sqlite-vec 在本机 Node 22、linux-x64 上能加载。其他平台、以及 CI 的 Node 24，要等那次安装和测试。加载失败时走 BLOB，这条路径有测试。
- dsh-wander 的摄入按它仓库里公开的版本 1 对象和 `wander/trip` 事件测过。没有和正在跑的 wander 进程联调。
