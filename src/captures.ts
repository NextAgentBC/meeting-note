import { Hono } from "hono";
import { z } from "zod";
import { modelOptions, modelText, parseModelJson, recordUsage, runModel } from "./ai";
import { captureItem, rememberSource, safely } from "./memory";
import { getSetting, setSetting } from "./settings";
import type { Env, JobMessage } from "./types";

// Quick notes and their private WebP attachments. The browser does all resizing and encoding:
// Workers Free gets only a bounded WebP, and the original file (including EXIF/GPS) never leaves
// the owner's device.

export const captureRoutes = new Hono<{ Bindings: Env }>();

const IMAGE_AI_KEY = "image_ai_enabled";
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_THUMB_BYTES = 320 * 1024;
const CATEGORIES = ["inbox", "idea", "journal", "meeting", "plan", "life", "reference"] as const;
type Category = typeof CATEGORIES[number];

interface CaptureRow {
  id: string;
  title: string;
  body: string;
  category: Category;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  capture_id: string;
  image_key: string;
  thumbnail_key: string;
  width: number;
  height: number;
  bytes: number;
  thumbnail_bytes: number;
  status: string;
  caption: string;
  ocr_text: string;
  ai_status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function error(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function category(value: unknown): Category {
  return CATEGORIES.includes(value as Category) ? value as Category : "inbox";
}

function captureTitle(body: string, fallback = "Photo note"): string {
  const first = body.replace(/\s+/g, " ").trim().split(/[.!?。！？\n]/)[0]?.trim() ?? "";
  return (first || fallback).slice(0, 100);
}

async function imageAiEnabled(env: Env): Promise<boolean> {
  return (await getSetting(env.DB, IMAGE_AI_KEY)) === "true";
}

async function findCapture(db: D1Database, id: string): Promise<CaptureRow | null> {
  return db.prepare("SELECT * FROM captures WHERE id = ?").bind(id).first<CaptureRow>();
}

async function findAttachment(db: D1Database, captureId: string, id: string): Promise<AttachmentRow | null> {
  return db.prepare("SELECT * FROM capture_attachments WHERE id = ? AND capture_id = ?")
    .bind(id, captureId).first<AttachmentRow>();
}

async function rememberCapture(env: Env, captureId: string): Promise<void> {
  const capture = await findCapture(env.DB, captureId);
  if (!capture) return;
  const { results } = await env.DB.prepare(
    "SELECT caption, ocr_text FROM capture_attachments WHERE capture_id = ? AND status = 'ready' ORDER BY created_at"
  ).bind(captureId).all<{ caption: string; ocr_text: string }>();
  const imageText = results.flatMap((row) => [
    row.caption ? `Photo: ${row.caption}` : "",
    row.ocr_text ? `Text in photo: ${row.ocr_text}` : ""
  ]).filter(Boolean);
  const item = captureItem(capture, imageText);
  await rememberSource(env, captureId, item ? [item] : []);
}

function attachmentView(row: AttachmentRow) {
  const base = `/api/captures/${encodeURIComponent(row.capture_id)}/images/${encodeURIComponent(row.id)}`;
  return {
    id: row.id,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    status: row.status,
    caption: row.caption,
    ocrText: row.ocr_text,
    aiStatus: row.ai_status,
    imageUrl: `${base}/full`,
    thumbnailUrl: row.thumbnail_bytes > 0 ? `${base}/thumbnail` : `${base}/full`
  };
}

captureRoutes.get("/settings/image-ai", async (c) =>
  c.json({ ok: true, enabled: await imageAiEnabled(c.env) })
);

captureRoutes.put("/settings/image-ai", async (c) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return error("Choose whether new photos may be understood by AI.");
  await setSetting(c.env.DB, IMAGE_AI_KEY, String(parsed.data.enabled));
  return c.json({ ok: true, enabled: parsed.data.enabled });
});

captureRoutes.get("/captures", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM captures ORDER BY occurred_at DESC, id DESC LIMIT 100"
  ).all<CaptureRow>();
  if (!results.length) return c.json({ ok: true, captures: [] });
  const placeholders = results.map(() => "?").join(",");
  const attachments = await c.env.DB.prepare(
    `SELECT * FROM capture_attachments WHERE capture_id IN (${placeholders}) ORDER BY created_at`
  ).bind(...results.map((row) => row.id)).all<AttachmentRow>();
  const byCapture = new Map<string, AttachmentRow[]>();
  for (const row of attachments.results) byCapture.set(row.capture_id, [...(byCapture.get(row.capture_id) ?? []), row]);
  return c.json({
    ok: true,
    captures: results.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      category: row.category,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      attachments: (byCapture.get(row.id) ?? []).map(attachmentView)
    }))
  });
});

const newCapture = z.object({
  body: z.string().trim().max(10_000).default(""),
  title: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORIES).default("inbox"),
  occurredAt: z.string().datetime().optional()
});

captureRoutes.post("/captures", async (c) => {
  const parsed = newCapture.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "That note isn't valid.");
  const id = crypto.randomUUID();
  const now = nowIso();
  const occurredAt = parsed.data.occurredAt ?? now;
  const title = parsed.data.title || captureTitle(parsed.data.body);
  await c.env.DB.prepare(
    "INSERT INTO captures (id, title, body, category, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, title, parsed.data.body, parsed.data.category, occurredAt, now, now).run();
  await safely("remember a quick note", () => rememberCapture(c.env, id));
  return c.json({ ok: true, capture: { id, title, body: parsed.data.body, category: parsed.data.category, occurredAt, attachments: [] } }, 201);
});

const newAttachment = z.object({
  width: z.number().int().min(1).max(12_000),
  height: z.number().int().min(1).max(12_000)
});

captureRoutes.post("/captures/:captureId/images", async (c) => {
  const captureId = c.req.param("captureId");
  if (!(await findCapture(c.env.DB, captureId))) return error("That note no longer exists.", 404);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM capture_attachments WHERE capture_id = ?")
    .bind(captureId).first<{ count: number }>();
  if ((count?.count ?? 0) >= MAX_IMAGES) return error(`A note can contain up to ${MAX_IMAGES} photos.`);
  const parsed = newAttachment.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return error("The photo dimensions aren't valid.");

  const id = crypto.randomUUID();
  const prefix = `images/${captureId}/${id}`;
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO capture_attachments
       (id, capture_id, image_key, thumbnail_key, width, height, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, captureId, `${prefix}.webp`, `${prefix}.thumb.webp`, parsed.data.width, parsed.data.height, now, now).run();
  return c.json({ ok: true, attachment: { id } }, 201);
});

async function webpBody(request: Request, maxBytes: number): Promise<ArrayBuffer | Response> {
  if ((request.headers.get("content-type") ?? "").split(";")[0] !== "image/webp") return error("Photos must be converted to WebP before upload.", 415);
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > maxBytes) return error("The compressed photo is still too large.", 413);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxBytes) return error("The compressed photo is still too large.", 413);
  return bytes;
}

captureRoutes.put("/captures/:captureId/images/:id/full", async (c) => {
  const row = await findAttachment(c.env.DB, c.req.param("captureId"), c.req.param("id"));
  if (!row) return error("That photo no longer exists.", 404);
  const bytes = await webpBody(c.req.raw, MAX_IMAGE_BYTES);
  if (bytes instanceof Response) return bytes;
  await c.env.AUDIO.put(row.image_key, bytes, { metadata: { contentType: "image/webp", captureId: row.capture_id } });
  const enabled = await imageAiEnabled(c.env);
  const aiStatus = enabled ? "queued" : "off";
  await c.env.DB.prepare(
    "UPDATE capture_attachments SET bytes = ?, status = 'ready', ai_status = ?, last_error = NULL, updated_at = ? WHERE id = ?"
  ).bind(bytes.byteLength, aiStatus, nowIso(), row.id).run();
  await safely("remember a photo note", () => rememberCapture(c.env, row.capture_id));
  if (enabled) await c.env.JOBS.send({ type: "vision", captureId: row.capture_id, attachmentId: row.id } satisfies JobMessage);
  return c.json({ ok: true, aiStatus });
});

captureRoutes.put("/captures/:captureId/images/:id/thumbnail", async (c) => {
  const row = await findAttachment(c.env.DB, c.req.param("captureId"), c.req.param("id"));
  if (!row) return error("That photo no longer exists.", 404);
  const bytes = await webpBody(c.req.raw, MAX_THUMB_BYTES);
  if (bytes instanceof Response) return bytes;
  await c.env.AUDIO.put(row.thumbnail_key, bytes, { metadata: { contentType: "image/webp", captureId: row.capture_id } });
  await c.env.DB.prepare("UPDATE capture_attachments SET thumbnail_bytes = ?, updated_at = ? WHERE id = ?")
    .bind(bytes.byteLength, nowIso(), row.id).run();
  return c.json({ ok: true });
});

captureRoutes.get("/captures/:captureId/images/:id/:size", async (c) => {
  const row = await findAttachment(c.env.DB, c.req.param("captureId"), c.req.param("id"));
  if (!row) return error("That photo no longer exists.", 404);
  const key = c.req.param("size") === "thumbnail" && row.thumbnail_bytes > 0 ? row.thumbnail_key : row.image_key;
  const image = await c.env.AUDIO.get(key, "arrayBuffer");
  if (!image) return error("That photo is not available.", 404);
  return new Response(image, {
    headers: {
      "content-type": "image/webp",
      "cache-control": "private, max-age=86400",
      "content-length": String(image.byteLength),
      "x-content-type-options": "nosniff"
    }
  });
});

captureRoutes.delete("/captures/:id", async (c) => {
  const id = c.req.param("id");
  const capture = await findCapture(c.env.DB, id);
  if (!capture) return c.json({ ok: true, removed: false });
  const { results } = await c.env.DB.prepare("SELECT image_key, thumbnail_key FROM capture_attachments WHERE capture_id = ?")
    .bind(id).all<{ image_key: string; thumbnail_key: string }>();
  for (const row of results) {
    await Promise.all([c.env.AUDIO.delete(row.image_key), c.env.AUDIO.delete(row.thumbnail_key)]);
  }
  await c.env.DB.prepare("DELETE FROM captures WHERE id = ?").bind(id).run();
  await safely("forget a quick note", () => rememberSource(c.env, id, []));
  return c.json({ ok: true, removed: true });
});

export interface VisionFields {
  caption: string;
  ocrText: string;
  category: Category;
}

export function normalizeVision(value: unknown, fallbackText = ""): VisionFields {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const caption = typeof object.caption === "string" ? object.caption.trim().slice(0, 1000) : fallbackText.trim().slice(0, 1000);
  const ocrText = typeof object.ocr_text === "string" ? object.ocr_text.trim().slice(0, 4000) : "";
  return { caption, ocrText, category: category(object.category) };
}

/** Queue job: understands one photo without ever blocking saving or displaying the quick note. */
export async function runVision(env: Env, message: Extract<JobMessage, { type: "vision" }>): Promise<void> {
  const row = await findAttachment(env.DB, message.captureId, message.attachmentId);
  if (!row || row.status !== "ready" || row.ai_status === "done" || row.ai_status === "off") return;
  const image = await env.AUDIO.get(row.image_key, "arrayBuffer");
  if (!image) throw new Error("Photo bytes are missing");
  await env.DB.prepare("UPDATE capture_attachments SET ai_status = 'processing', updated_at = ? WHERE id = ?")
    .bind(nowIso(), row.id).run();

  const model = env.VISION_MODEL || "@cf/llava-hf/llava-1.5-7b-hf";
  let result: unknown;
  let raw: string;
  if (model.includes("llava-1.5-7b-hf")) {
    // The zero-setup default does not require a separate license-acceptance request.
    const vision = await runModel(env, model, { image: Array.from(new Uint8Array(image)) });
    await recordUsage(env, null, "vision", model, vision);
    const description = modelText(vision);
    const organizer = env.PLAN_MODEL || env.FINAL_MODEL;
    result = await runModel(env, organizer, {
      prompt: `Organize this private photo description. Preserve any text the vision model says is visible. Do not invent names or sensitive traits. Output JSON only:
{"caption":"one concise sentence in the description's language","ocr_text":"clearly quoted visible text only, or empty","category":"idea|journal|meeting|plan|life|reference|inbox"}

Description:
${description.slice(0, 5000)}`,
      max_tokens: 500,
      temperature: 0.1,
      ...modelOptions(organizer)
    });
    await recordUsage(env, null, "vision", organizer, result);
    raw = modelText(result);
  } else {
    result = await runModel(env, model, {
      image: Array.from(new Uint8Array(image)),
      prompt: `Describe this private personal photo and copy any clearly readable text. Do not identify or guess people's names, ethnicity, health, or other sensitive traits. Output JSON only:
{"caption":"one concise sentence in the language visible in the image, otherwise English","ocr_text":"clearly readable text only, or empty","category":"idea|journal|meeting|plan|life|reference|inbox"}`,
      max_tokens: 700,
      temperature: 0.1
    });
    await recordUsage(env, null, "vision", model, result);
    raw = modelText(result);
  }
  let parsed: unknown = null;
  try { parsed = parseModelJson(raw); } catch { /* keep prose as the caption */ }
  const fields = normalizeVision(parsed, raw);
  const nextCategory = fields.category === "inbox" ? null : fields.category;
  const now = nowIso();
  const statements = [
    env.DB.prepare(
      "UPDATE capture_attachments SET caption = ?, ocr_text = ?, ai_status = 'done', last_error = NULL, updated_at = ? WHERE id = ?"
    ).bind(fields.caption, fields.ocrText, now, row.id)
  ];
  if (nextCategory) {
    statements.push(env.DB.prepare(
      "UPDATE captures SET category = CASE WHEN category = 'inbox' THEN ? ELSE category END, updated_at = ? WHERE id = ?"
    ).bind(nextCategory, now, row.capture_id));
  }
  await env.DB.batch(statements);
  await safely("remember a photo description", () => rememberCapture(env, row.capture_id));
}

export async function markVisionFailed(env: Env, attachmentId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE capture_attachments SET ai_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?"
  ).bind(reason.slice(0, 1000), nowIso(), attachmentId).run();
}
