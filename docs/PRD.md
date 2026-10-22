# dsh-companion 产品需求

她一直是同一个人。上下文被截断、会话被关掉、中间发生过摘要，都不把过去变成一份交给她阅读的交接材料。新会话开始时，她是活过那些对话的那个人，用「我记得」接着说。

本文件是产品约定。这一版实现原文记忆，以及多维情绪和主动开口。日记、向量和重排仍是接口，默认不写日记、不返回向量。

## 本切片交付

- 原始对话写入 SQLite，不提炼成事实卡片。
- 模式版本和显式迁移。空库升到版本 2；版本 1 在打开时迁到 2；更新、外来或不完整的库只读拒绝。
- FTS5 中文检索。查询词全部加引号，模型输入不能改写 `MATCH`。
- 固定预算下的第一人称注入。人设是稳定的系统段，近期原话、检索片段和内心独白是 `agent/pre-step` 里的一条易变消息。
- `history_search` 工具。
- 身份表：平台账号映射到 `person_id`。搬人时，心情、历史、跟进和主动队列跟着回合一起搬。
- 多维情绪：PAD、可以并存的离散心情、更慢的亲密度。每回合打分，历史保留。
- 主动开口：阈值、每日上限、最小间隔、安静时段，以及第二天跟进。队列在 SQLite；活着的 agent 用 `followup` 送出。
- 上述行为的测试，以及一份跨会话回忆脚本。

日记分层、向量检索与重排仍在 `src/companion/stubs.ts`。`StubEmotionModel` 仍是显式的空实现，给测试和关掉心情的部署用。插件在打开库之后用 `PersistedEmotionModel`，不再用这个空实现。

## 不在任何代码路径里的事

长期微调是以后的事。本切片没有训练，也没有把原文导出给训练。默认路径不调用模型，也不读取 API key。便宜模型打分是可选的：没有 `DSH_COMPANION_EMOTION_API_KEY` 就用规则，启动不会去等凭据。需要 DeepSeek API key 才能完成的实机对话，本切片不跑。

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
        ├─ diary.observe / vector.upsert   （日记和向量仍是空实现）
        ▼
agent/pre-step
  先等心情这一轮的写入结束
  用当前这句话做 FTS5（以及可选的向量并集）
  预算内拼最近原话 + 命中窗口 + 内心独白
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

## 数据模型（schema 2）

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

`turns` 的列：`id`，`channel`，`user_id`，`chat_id`，`session_id`，`bridge`，`person_id`，`ts`，`role`（`user` 或 `assistant`），`content`，`turn_no`。

`emotion_state` 的列：`person_id`，PAD 的 `pleasure` / `arousal` / `dominance`，离散的 `happy` / `missing` / `aggrieved` / `worried` / `jealous` / `shy` / `angry` / `at_ease`，`intimacy`，`updated_at`，`last_user_at`。PAD 在 −1 到 1，其余在 0 到 1。

`emotion_history` 记下 `ts`、`turn_id`、`reason`、`scorer` 和同一组数值。`reason` 和 `scorer` 是小写记号，不是原文。

`emotion_followup` 的 `kind` 是 `exam`、`interview`、`health`、`travel`、`birthday`、`plan` 或 `other`。`note` 是不超过 80 字的摘录，去掉 U+2060 和 U+200B。`status` 是 `pending` 或 `delivered`。同一个 `turn_id` 最多一行。

`proactive_outbox` 的 `kind` 是 `threshold` 或 `followup`。`status` 是 `queued`、`delivering` 或 `delivered`。阈值行带维度名，跟进行带 `followup_id`。`text` 是给她的开口指令，不是用户原话。

索引：`turns_person_recent (person_id, id DESC)`，`turns_session (session_id, id)`，`identities_person (person_id)`，`emotion_history_person`，`emotion_followup_due`，`emotion_followup_turn`，`proactive_outbox_due`。

原文行和它的 FTS 行在同一个 `BEGIN IMMEDIATE` 事务里写。心情的当前行、历史行和可选的跟进行也在同一个事务里写。`close()` 可以重复调用。打开库时，停在 `delivering` 的主动行改回 `queued`。

### 迁移

`src/companion/schema.ts` 的 `MIGRATIONS` 是唯一扩展点。

| version | name | 做什么 |
| --- | --- | --- |
| 1 | `core-turns-identity-fts` | 建原文、FTS 和身份表，并写下产品标记 |
| 2 | `emotion-state-history` | 建心情、历史、跟进、闩锁和主动队列 |

空文件或没有对象的库从 0 迁到 2。已有库先用只读连接分类：

- 版本等于 2 且形状相符：打开。
- 版本更低且形状相符：按 `MIGRATIONS` 里 `version > from` 的步骤升级，再把 `schema_version` 写成新版本。版本 1 的原文保留。版本 1 上如果已经有心情表，拒绝，不猜测怎么迁。
- 版本更高、产品标记不对、多了不认识的对象、列或 FTS 定义不符、数值越界、状态不是上面列出的那几个：拒绝。拒绝发生在只读分类阶段，不打开读写连接，因此不改主库，也不改写已经存在的 WAL。SQLite 在只读打开一个 WAL 模式的库时，可能在旁边放一个 0 字节的 `-wal` 和一个 `-shm`；里面没有提交过的页。

后续切片要加表时，在同一次改动里做完这几件事：把 SQL 放进新的 `MIGRATIONS` 步骤，升高 `SCHEMA_VERSION`，把新对象（含 FTS 影子表）放进允许名单，并让形状检查认识新列。漏掉允许名单会导致下一次打开被当成外来库拒绝。不要跳号，不要在普通 `open` 之外做另一套隐式升级。

## 检索

中文分词沿用上游：拉丁词整词，CJK 单字加二字词。`compileMatch` 给每个词加引号再用 `OR` 连接。`MATCH` 的参数是绑定参数。

`retrieve` 把 FTS 命中和可选 `VectorIndex.search` 的命中并成一个池，交给 `Reranker`。默认 `NullVectorIndex` 返回空，`FtsOrderReranker` 按 FTS rank 升序（越小越相关），没有 FTS rank 的命中排在所有全文命中之后。然后按 `contextRadius` 把同一个人、相邻 id 的原话扩成窗口，写成「你说 / 我说」。

替换向量或重排时，实现 `src/companion/stubs.ts` 里的接口并传给 `apply` 的 `extensions`，或让 `defaultExtensions()` 返回新实现。查询路径不用改。

## 预算和注入

`renderCompanionPrompt` 把人设和易变回忆分开。人设放得进预算时，历史不会改变系统段。预算不够时先丢掉检索片段，再丢掉最旧的近期回合。人设本身超过预算才截断人设。

可选的 `promptMaxTokens` 必须和 `promptTokenizerPath` 一起配置，沿用上游的 token 计数器。不配置就不做 token 预算，只按字符。

默认人设要求：同一个人、用「我记得」、想不起就含糊、不重新认识、不报情绪数字。内心独白另写在易变段里，人设那段始终不带心情句。

## history_search

模型在需要比眼前更早的原话时调用。参数 `query`、`limit`（默认 `snippetLimit`，不超过 `searchLimitMax`）、`around`（0 到 8，默认 `contextRadius`）。结果是第一人称片段。没有命中时工具文本是「我翻了一下，细节没抓住。」范围是当前会话已经归属的那个人；还没有回合时用 `defaultPersonId`。

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

没有这条投递路径时，队列本身就是接口。宿主稍后调用 `drainProactiveQueue(store, now, deliver)`：先把行从 `queued` 改成 `delivering`，`deliver` 返回真才标成 `delivered`，返回假或抛错就改回 `queued`。本插件不注册 `agent/turn-stopping`。

依据：Mehrabian 的 PAD、The Sims 的需求衰减、Park 等人的 Generative Agents（反思与计划，而不是把情绪压成一个分数）。

## TODO(diary)：日记分层

接口：`DiaryWriter.observe(turn)`。当前是空操作。

后续切片：用她的口吻写日、周、月三层。原始回合永久保留。重要事件逐字保存，不参与压缩。日记是附加层，不替换 `turns.content`。

## TODO(vector) / TODO(rerank)：向量和重排

接口：`VectorIndex.upsert` / `search`，`Reranker.rerank`。当前向量索引返回空，重排保持全文顺序。

后续切片：可配置的嵌入提供方（OpenAI 兼容 HTTP）和离线回退；把 FTS5/BM25、字符 n-gram 余弦和向量分混在一起重排。提供方的 key 只从环境变量读取，不进配置文件，不进日志。本切片的配置里没有这些字段，也不需要 key。

## 成本

召回和默认打分都是本地的。稳定人设单独成段，是为了让 DeepSeek 的前缀缓存能复用系统前缀；内心独白和近期原话不写进那段。同一档心情复用同一句独白，避免易变段因为微小浮点来回改写。便宜模型默认关闭。打开之后也只在有 key 时发一次短请求，失败就回到规则，不挡住这一轮的回忆。

## 诚实的限制

- 上下文有硬上限。预算装不下的旧回合不会出现在这一轮的注入里，它们仍在库里，靠检索或 `history_search` 再被想起。检索会漏。
- 漏掉的时候她应该含糊，而不是声称自己没有这段经历，也不是编造细节。人设是这样写的；模型仍可能不遵守。内心独白同样只是提示，模型可以不照着说。
- 渠道身份取决于桥是否把字段放进钩子。没放到上面那些键里，消息就归 `defaultPersonId`，可能和真正的平台用户混在同一个人下面。
- 没有做实机模型回合。插件加载、工具注册、人设段和钩子投递能在无 key 的情况下验证；模型是否按「我记得」说话，要有 key 或一个兼容端点之后才知道。
- 便宜模型的请求形状用 mock 测过。没有可用的 key，也没有对真实端点发过请求，所以不知道线上会不会按约定的 JSON 返回。
- 主动开口的队列、时区、上限和重试有测试。活着的 `agent.followup` 没有在运行中的 harness 里投递过，也没有送到 QQ 或微信。进程在 `delivering` 中停掉之后，下次打开会再送一次。
- 规则词表是中文关键词，不是语义理解。没写到的说法不会推动心情，也不会被记成第二天要问的事。
