# dsh-companion 产品需求

她一直是同一个人。上下文被截断、会话被关掉、中间发生过摘要，都不把过去变成一份交给她阅读的交接材料。新会话开始时，她是活过那些对话的那个人，用「我记得」接着说。

本文件是产品约定。这一版代码只实现下面标明「本切片」的部分。情绪、日记、向量和重排留有接口，由后续改动接上，不在本切片里假装已经工作。

## 本切片交付

- 原始对话写入 SQLite，不提炼成事实卡片。
- 模式版本和显式迁移。空库升到版本 1；更新、外来或不完整的库只读拒绝。
- FTS5 中文检索。查询词全部加引号，模型输入不能改写 `MATCH`。
- 固定预算下的第一人称注入。人设是稳定的系统段，近期原话和检索片段是 `agent/pre-step` 里的一条易变消息。
- `history_search` 工具。
- 身份表：平台账号映射到 `person_id`。
- 上述行为的测试，以及一份跨会话回忆脚本。

情绪与主动开口、日记分层、向量检索与重排都在 `src/companion/stubs.ts`。调用点已经接上，默认实现不产生心情、不写日记、不返回向量。

## 不在任何代码路径里的事

长期微调是以后的事。本切片没有训练、没有数据导出给训练、也没有模型调用。需要 DeepSeek API key 才能完成的实机对话，本切片不跑，也不等待凭据。

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
        ├─ emotion.observe / diary.observe / vector.upsert   （当前是空实现）
        ▼
agent/pre-step
  用当前这句话做 FTS5（以及可选的向量并集）
  预算内拼最近原话 + 命中窗口
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

## 数据模型（schema 1）

产品标记 `meta.product = dsh-companion`。`meta.schema_version` 和 `meta.fts_token_version` 分开。分词格式变化只重建 `turns_fts`，不改原文。

| 表 | 作用 |
| --- | --- |
| `meta` | `product`、`schema_version`、`fts_token_version` |
| `turns` | 一条原始发言。`content` 是原文，不是摘要 |
| `turns_fts` | FTS5，`content` 列，`tokenize = unicode61`。写入的是分词，不是原文 |
| `identities` | `(platform, platform_user_id) → person_id` |

`turns` 的列：`id`，`channel`，`user_id`，`chat_id`，`session_id`，`bridge`，`person_id`，`ts`，`role`（`user` 或 `assistant`），`content`，`turn_no`。

索引：`turns_person_recent (person_id, id DESC)`，`turns_session (session_id, id)`，`identities_person (person_id)`。

原文行和 FTS 行在同一个 `BEGIN IMMEDIATE` 事务里写。`close()` 可以重复调用。

### 迁移

`src/companion/schema.ts` 的 `MIGRATIONS` 是唯一扩展点。当前只有一步：

| version | name | 做什么 |
| --- | --- | --- |
| 1 | `core-turns-identity-fts` | 建上面的表并写下产品标记 |

空文件或没有对象的库从 0 迁到 1。已有库先用只读连接分类：

- 版本等于 1 且形状相符：打开。
- 版本更低：按 `MIGRATIONS` 里 `version > from` 的步骤升级，再把 `schema_version` 写成新版本。版本 1 是当前版本，所以这条路径留给后续切片。
- 版本更高、产品标记不对、多了不认识的对象、列或 FTS 定义不符、出现非法回合：拒绝。拒绝发生在只读分类阶段，不打开读写连接，因此不改主库，也不改写已经存在的 WAL。SQLite 在只读打开一个 WAL 模式的库时，可能在旁边放一个 0 字节的 `-wal` 和一个 `-shm`；里面没有提交过的页。

后续切片要加表时，在同一次改动里做完这几件事：把 SQL 放进新的 `MIGRATIONS` 步骤，升高 `SCHEMA_VERSION`，把新对象（含 FTS 影子表）放进允许名单，并让形状检查认识新列。漏掉允许名单会导致下一次打开被当成外来库拒绝。不要跳号，不要在普通 `open` 里做隐式升级。

## 检索

中文分词沿用上游：拉丁词整词，CJK 单字加二字词。`compileMatch` 给每个词加引号再用 `OR` 连接。`MATCH` 的参数是绑定参数。

`retrieve` 把 FTS 命中和可选 `VectorIndex.search` 的命中并成一个池，交给 `Reranker`。默认 `NullVectorIndex` 返回空，`FtsOrderReranker` 按 FTS rank 升序（越小越相关），没有 FTS rank 的命中排在所有全文命中之后。然后按 `contextRadius` 把同一个人、相邻 id 的原话扩成窗口，写成「你说 / 我说」。

替换向量或重排时，实现 `src/companion/stubs.ts` 里的接口并传给 `apply` 的 `extensions`，或让 `defaultExtensions()` 返回新实现。查询路径不用改。

## 预算和注入

`renderCompanionPrompt` 把人设和易变回忆分开。人设放得进预算时，历史不会改变系统段。预算不够时先丢掉检索片段，再丢掉最旧的近期回合。人设本身超过预算才截断人设。

可选的 `promptMaxTokens` 必须和 `promptTokenizerPath` 一起配置，沿用上游的 token 计数器。不配置就不做 token 预算，只按字符。

默认人设要求：同一个人、用「我记得」、想不起就含糊、不重新认识、不报情绪数字。

## history_search

模型在需要比眼前更早的原话时调用。参数 `query`、`limit`（默认 `snippetLimit`，不超过 `searchLimitMax`）、`around`（0 到 8，默认 `contextRadius`）。结果是第一人称片段。没有命中时工具文本是「我翻了一下，细节没抓住。」范围是当前会话已经归属的那个人；还没有回合时用 `defaultPersonId`。

## 多渠道

社区桥（`dsh-channels`、`dsh-wechat`、`dsh-qqbot`、`dsh-qq-bridge`）把平台消息送进 dsh 的 agent 会话。本插件只在 dsh 钩子里记录，不直接连 QQ 或微信。

每条用户消息尽量读取 `channel` / `platform`、`userId` / `user_id` / `senderId` / `openid`、`chatId` / `groupId`、`bridge` / `plugin`。这些键会在消息本身、`source`，以及 `source` 下的 `meta`、`channel`、`companion`、`attribution` 里找。找不到就留空字符串，不编造身份。

**未核实：** 上述桥的 README 没有给出钩子可见的元数据字段。上面的键是可能的形状，不是已经核对过的协议。空字段表示「这个桥没有把身份放在这些位置」，不是「没有这个人」。

## TODO(emotion)：情绪和主动开口

接口：`EmotionModel.line(personId, now)` 和 `observe(turn)`。`line` 返回空字符串表示这一轮不提心情。当前 `StubEmotionModel` 固定返回空，也不落库。注入逻辑已经会把非空的 `line` 放进易变段，所以后续实现不必改渲染入口。

后续切片要做的模型，而不是本切片已经做了的：

- PAD：愉悦、唤醒、支配，各在 −1 到 1。
- 可以并存的离散情绪，各在 0 到 1：开心、想念、委屈、担心、嫉妒、害羞、生气、自在。
- 每维有基线、衰减和惯性。便宜模型给出增量，离线时用确定性打分。表达是最强的两三维，写成内心独白，不报数字。
- 亲密度走更慢的时钟。
- 主动开口：阈值、每日上限、最小间隔、安静时段，以及第二天的跟进。发送走 `agent.followup`。本切片不注册 `agent/turn-stopping`，也不调用 `followup`。

依据：Mehrabian 的 PAD、The Sims 的需求衰减、Park 等人的 Generative Agents（反思与计划，而不是把情绪压成一个分数）。

## TODO(diary)：日记分层

接口：`DiaryWriter.observe(turn)`。当前是空操作。

后续切片：用她的口吻写日、周、月三层。原始回合永久保留。重要事件逐字保存，不参与压缩。日记是附加层，不替换 `turns.content`。

## TODO(vector) / TODO(rerank)：向量和重排

接口：`VectorIndex.upsert` / `search`，`Reranker.rerank`。当前向量索引返回空，重排保持全文顺序。

后续切片：可配置的嵌入提供方（OpenAI 兼容 HTTP）和离线回退；把 FTS5/BM25、字符 n-gram 余弦和向量分混在一起重排。提供方的 key 只从环境变量读取，不进配置文件，不进日志。本切片的配置里没有这些字段，也不需要 key。

## 成本

本切片的召回是本地的。稳定人设单独成段，是为了让 DeepSeek 的前缀缓存能复用系统前缀；易变的回忆不写进那段。便宜模型只属于上面的 TODO，不在热路径上。

## 诚实的限制

- 上下文有硬上限。预算装不下的旧回合不会出现在这一轮的注入里，它们仍在库里，靠检索或 `history_search` 再被想起。检索会漏。
- 漏掉的时候她应该含糊，而不是声称自己没有这段经历，也不是编造细节。人设是这样写的；模型仍可能不遵守。
- 渠道身份取决于桥是否把字段放进钩子。没放到上面那些键里，消息就归 `defaultPersonId`，可能和真正的平台用户混在同一个人下面。
- 没有做实机模型回合。插件加载、工具注册、人设段和钩子投递能在无 key 的情况下验证；模型是否按「我记得」说话，要有 key 或一个兼容端点之后才知道。
