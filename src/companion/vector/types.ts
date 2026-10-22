/**
 * Shared shapes for hybrid retrieval. Turns, sealed diary pages, and wander
 * experiences are embedded as separate sources so their ids can collide.
 *
 * @module dsh-companion/vector/types
 */

export type EmbedSource = "turn" | "diary" | "experience";

export interface CorpusRow {
  source: EmbedSource;
  id: number;
  personId: string;
  ts: number;
  text: string;
  topics: readonly string[];
}

export interface EmbeddingState {
  source: EmbedSource;
  sourceId: number;
  textHash: string;
  dim: number;
}

export interface StoredVector {
  source: EmbedSource;
  sourceId: number;
  vector: Buffer;
}

export interface VectorNeighbor {
  source: EmbedSource;
  sourceId: number;
  /** Cosine distance from sqlite-vec: lower is nearer. */
  distance: number;
}

export interface ExperienceInput {
  externalId: string;
  personId: string;
  ts: number;
  content: string;
  topics: readonly string[];
  placeId: string;
  placeName: string;
  attribution: string;
  license: string;
  descriptionMode: "" | "metadata" | "vision";
  emotionHint: string;
}

export interface ExperienceRecord {
  id: number;
  externalId: string;
  personId: string;
  source: "dsh-wander";
  kind: "travel";
  ts: number;
  content: string;
  topics: readonly string[];
  placeId: string;
  placeName: string;
  attribution: string;
  license: string;
  descriptionMode: "" | "metadata" | "vision";
  emotionHint: string;
}

export type ExperienceWrite = { status: "unchanged" } | { status: "inserted" | "updated"; record: ExperienceRecord };
