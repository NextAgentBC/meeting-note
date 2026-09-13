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
  CHINESE_SCRIPT: string;
  FREE_DAILY_NEURONS: string;
  WORKERS_PLAN: string;
  AUDIO_RETENTION_DAYS: string;
  SEGMENT_TARGET_MINUTES: string;
  /** Secret chosen at deploy time; needed once to claim the app, and to recover the owner. */
  SETUP_CODE?: string;
}

export type JobMessage =
  | { type: "transcribe"; meetingId: string; chunkId: string }
  | { type: "segment"; meetingId: string; segmentId: string }
  // "summarize" is the pre-segment name for the final merge; still accepted so
  // messages already in flight during a deploy are not dropped.
  | { type: "final"; meetingId: string }
  | { type: "summarize"; meetingId: string }
  // Copies a meeting recorded before memory existed into it.
  | { type: "remember"; meetingId: string };

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
