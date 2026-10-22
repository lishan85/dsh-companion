/**
 * Package entry. Cordis loads this module as the companion plugin.
 * The inherited fact-memory engine stays in `memory-plugin.ts` for its tests
 * and the `dsh-ltm` CLI; it is a different database and a different product.
 *
 * @module dsh-companion
 */

export { apply, name, inject, Config, searchHistory } from "./companion/plugin.js";
export type { CompanionApplyOptions } from "./companion/plugin.js";
export { CompanionStore } from "./companion/store.js";
export { runSessionSimulation } from "./companion/simulate.js";
export type { SessionSimulation } from "./companion/simulate.js";
export {
  defaultExtensions,
  FtsOrderReranker,
  NullVectorIndex,
  StubDiaryWriter,
  StubEmotionModel,
} from "./companion/stubs.js";
export type {
  CompanionExtensions,
  DiaryWriter,
  EmotionModel,
  Reranker,
  VectorIndex,
} from "./companion/stubs.js";
export { PersistedEmotionModel, defaultEmotionRuntime } from "./companion/emotion/engine.js";
export { CheapModelScorer } from "./companion/emotion/model-scorer.js";
export type { EmotionScorer, EmotionScoreInput } from "./companion/emotion/model-scorer.js";
export { renderInnerMonologue } from "./companion/emotion/express.js";
export { drainProactiveQueue, deliverViaFollowup } from "./companion/emotion/deliver.js";
export type { ProactiveDeliverer, FollowupTarget } from "./companion/emotion/deliver.js";
export { LayeredDiaryWriter } from "./companion/diary/writer.js";
export type { DiaryRuntime } from "./companion/diary/writer.js";
export { CheapDiaryModel, parseDiary } from "./companion/diary/model.js";
export type { DiaryModel } from "./companion/diary/model.js";
export { detectImportantEvent } from "./companion/diary/events.js";
