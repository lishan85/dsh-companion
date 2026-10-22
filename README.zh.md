# dsh-companion

说明的正文在 [README.md](README.md)，是简体中文。这里补情绪、主动开口、日记、混合检索和 dsh-wander 这几层，避免和正文各写一套。

## 情绪

心情有两层，一起存，不互相覆盖：

- PAD：愉悦、唤醒、支配，各在 −1 到 1。
- 离散心情：开心、想念、委屈、担心、嫉妒、害羞、生气、自在，各在 0 到 1。
- 亲密度单独走，衰减更慢，惯性更高。

每一维有基线、按小时的衰减和惯性。人不在的时候，想念往 1 长；其余维度往基线回。每回合之后打一次分。便宜模型是可插的；没有 `DSH_COMPANION_EMOTION_API_KEY`、超时或返回不合规格时，用确定性规则。key 不写进配置，也不写进日志。

注入取最强的两到三维，写成一句第一人称内心独白，不报数字。这句话在易变的回忆里，不进稳定人设，所以前缀缓存还能复用系统段。

## 主动开口

超过阈值，或第二天要跟进一件记得的事，就写入 `proactive_outbox`。默认时区 `Asia/Shanghai`，安静时段 23:00–08:00，每天最多 2 条，两条之间至少 6 小时。

送出走活着的 agent 的 `followup`。没有这个方法，或者当前没有活着的会话时，行保持 `queued`。`deliver` 明确失败时可以再试。进程停在 `delivering` 时，下次打开把这一行收成已送，不再发第二次。接入点是 `drainProactiveQueue` 和 `deliverViaFollowup`。详见 [docs/PRD.md](docs/PRD.md)。

## 日记

她用第一人称写日、周、月。原始回合不删。重要事件整句留下，周和月可以把普通日子写短，但这些原话不压缩。换日或空闲时封页，同一页再跑一次不会多写一页。

便宜模型看环境变量 `DSH_COMPANION_DIARY_API_KEY`。没有 key、超时或正文不合规格，就用确定性正文，也不去等凭据。日记和原话一起检索，放进同一条易变回忆，共用原来的预算。稳定人设不写日记。

## 混合检索

原文、已封日记和她的经历都进同一套检索。FTS5、向量余弦和字符 n-gram 用倒数排名融合，再按时间、当前的人和话题加权。可选的 HTTP 重排失败时留下这个分数。预算不变：装不下先丢掉片段，人设不动。

默认嵌入是离线哈希 `offline-hash-v1`，不需要 key。它不是神经网络，只覆盖 `OFFLINE_SYNONYM_CLUSTERS` 里的同义词簇和字符 n-gram。例如「英短」能对上「宠物小猫」，簇外又没有共同字符的释义会漏。无关句子默认 0.2 以下不进入候选。

要接 OpenAI 兼容的 `/embeddings`，把 `embeddingProvider` 设为 `openai`，并给 `embeddingBaseUrl`。key 放在 `DSH_COMPANION_EMBEDDING_KEY`（名字可用 `embeddingApiKeyEnv` 换）。没有 key 不发请求。401 或 403 之后这个进程改用离线哈希。向量存在 SQLite。装得上 `sqlite-vec` 就用它做近邻，否则扫 BLOB。

重排要接 HTTP 时，`rerankProvider` 设为 `http`，并给 `rerankBaseUrl`。key 是 `DSH_COMPANION_RERANK_KEY`。

## dsh-wander

[lishan85/dsh-wander](https://github.com/lishan85/dsh-wander) 的 `experiences.jsonl` 和 `wander/trip` 事件记成她自己的经历。路径是 `wanderExperiencesPath`，或 `DSH_WANDER_EXPERIENCES`，或 `DSH_WANDER_DATA_DIR/experiences.jsonl`。按外部 id 去重。`metadata` 的片段会说明她没有把画面交给视觉模型。这些经历不按对方的 person id 过滤。没有 wander 时留空即可。

每一项配置和环境变量的表在 [README.md](README.md)。
