export interface Env {
  DB: D1Database;
  /** Audio chunks. KV rather than R2: R2 needs a card on file, even on the free plan. */
  AUDIO: KVNamespace;
  JOBS: Queue<JobMessage>;
  AI: Ai;
  ASSETS: Fetcher;
  ASR_MODEL: string;
  SUMMARY_MODEL: string;
  FINAL_MODEL: string;
  /** Reads dates and to-dos out of dictated plans. Falls back to FINAL_MODEL. */
  PLAN_MODEL?: string;
  /** Answers questions about past meetings and plans. Falls back to FINAL_MODEL. */
  ASK_MODEL?: string;
  /** Describes and reads text from quick-note photos. Only used when the owner enables it. */
  VISION_MODEL?: string;
  CHINESE_SCRIPT: string;
  FREE_DAILY_NEURONS: string;
  WORKERS_PLAN: string;
  AUDIO_RETENTION_DAYS: string;
  SEGMENT_TARGET_MINUTES: string;
  /** Where this copy asks whether a newer release exists; empty means it never asks. */
  UPDATE_CHANNEL?: string;
  /**
   * NextNote, the owner's own desktop vault, talks to this app with a bearer token. It is one
   * person's setup, not part of what the installer hands out, so the whole feature — the settings
   * row, the token routes and bearer authentication itself — is off unless a deployment says "on".
   */
  NEXTNOTE?: string;
  /** Secret chosen at deploy time; needed once to claim the app, and to recover the owner. */
  SETUP_CODE?: string;
  /**
   * Semantic search over memory_items (src/embed.ts). Optional: this binding doesn't exist in the
   * public one-click-deploy template (Vectorize indexes can't be provisioned by that button), only
   * in a hand-configured copy. Every use checks for it first; absent, search stays full-text only.
   */
  MEMORY_VECTORS?: Vectorize;
  /** Multilingual embedding model for MEMORY_VECTORS. Falls back to bge-m3 (1024 dimensions). */
  EMBED_MODEL?: string;
  /**
   * Permanent copies of the audio (src/audio.ts). Optional, like MEMORY_VECTORS: R2 asks for a card on
   * file, so the one-click template never binds it and its audio stays temporary in KV. A copy that binds
   * it keeps every chunk of a meeting whose keep_audio is 1, and lets the owner play, download or delete it.
   */
  RECORDINGS?: R2Bucket;
  /** Fixes misheard words from the owner's vocabulary after Whisper. Falls back to SUMMARY_MODEL. */
  CORRECT_MODEL?: string;
}

export type JobMessage =
  | { type: "transcribe"; meetingId: string; chunkId: string }
  | { type: "segment"; meetingId: string; segmentId: string }
  // "summarize" is the pre-segment name for the final merge; still accepted so
  // messages already in flight during a deploy are not dropped.
  | { type: "final"; meetingId: string }
  | { type: "summarize"; meetingId: string }
  // Copies a meeting recorded before memory existed into it.
  | { type: "remember"; meetingId: string }
  // Embeds memory rows that are new or whose text changed, into MEMORY_VECTORS.
  | { type: "embed"; ids: string[] }
  // Extracts durable facts (hours, prices, policies, ...) from a meeting's finished note.
  | { type: "facts"; meetingId: string }
  // Describes one already-uploaded WebP attachment; the quick note itself never waits for this.
  | { type: "vision"; captureId: string; attachmentId: string }
  // Copies one chunk's audio from KV into the RECORDINGS bucket, when the upload couldn't.
  | { type: "archive"; meetingId: string; chunkId: string };

export interface MeetingRow {
  id: string;
  title: string;
  template: string;
  language: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  expected_chunks: number | null;
  processed_chunks: number;
  summary_status: string;
  summary_json: string | null;
  summary_markdown: string | null;
  summary_enqueued_at: string | null;
  force_summary: number;
  last_error: string | null;
  /** 1: keep a permanent copy of the audio (when RECORDINGS is bound). 0: temporary only. */
  keep_audio: number;
  created_at: string;
  updated_at: string;
}

export interface ChunkRow {
  id: string;
  meeting_id: string;
  sequence: number;
  /** The audio's key in the AUDIO KV namespace (the column predates the move from R2). */
  r2_key: string;
  mime_type: string;
  duration_ms: number;
  size_bytes: number;
  status: string;
  transcript_text: string | null;
  transcript_json: string | null;
  retry_count: number;
  last_error: string | null;
  /** When the permanent copy was written to RECORDINGS (same key as in KV). */
  archived_at: string | null;
  /** When the owner deleted this chunk's audio; the transcript stays. */
  audio_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SegmentRow {
  id: string;
  meeting_id: string;
  seq: number;
  start_chunk: number;
  end_chunk: number;
  duration_ms: number;
  status: string;
  notes_json: string | null;
  headline: string | null;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
