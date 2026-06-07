// Watchman — SpacetimeDB module
// =============================================================================
// Realtime store for a browser-based multi-camera Video RAG system.
//
// Browsers (Path B) capture their webcam, call `ingest_frame`, and subscribe to
// `camera` / `live_frame` / `answer`. A Gemini connector service (which holds
// the API key — reducers can't call external APIs) subscribes to
// `pending_frame` + `query`, embeds/answers via Gemini, and writes results back
// through `store_chunk` / `store_answer`. Similarity search is brute-force
// cosine done in the connector over the `chunk` embeddings.
// =============================================================================

import { schema, table, t, SenderError } from 'spacetimedb/server';

// ─── Tables ──────────────────────────────────────────────────────────────────

// One row per connected camera.
const camera = table(
  { name: 'camera', public: true },
  {
    camera_id: t.string().primaryKey(),
    owner: t.identity(),
    name: t.string(),
    online: t.bool(),
    last_seen: t.timestamp(),
    chunk_count: t.u32(),
  }
);

// Latest frame per camera — drives the live grid (overwritten each ingest).
const live_frame = table(
  { name: 'live_frame', public: true },
  {
    camera_id: t.string().primaryKey(),
    jpeg_b64: t.string(),
    ts: t.timestamp(),
  }
);

// Frames awaiting embedding by the connector. Deleted once embedded.
const pending_frame = table(
  { name: 'pending_frame', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    camera_id: t.string(),
    jpeg_b64: t.string(),
    ts: t.timestamp(),
  }
);

// Indexed chunks — the searchable memory. `embedding` is the Gemini vector.
const chunk = table(
  { name: 'chunk', public: true },
  {
    chunk_id: t.string().primaryKey(),
    camera_id: t.string().index('btree'),
    ts: t.timestamp(),
    embedding: t.array(t.f32()),
    caption: t.option(t.string()),
    thumb_b64: t.string(),
  }
);

// Natural-language questions from users.
const query = table(
  { name: 'query', public: true },
  {
    query_id: t.u64().primaryKey().autoInc(),
    asker: t.identity(),
    text: t.string(),
    ts: t.timestamp(),
    answered: t.bool(),
  }
);

// Synthesized answers, keyed by the query they answer.
const answer = table(
  { name: 'answer', public: true },
  {
    query_id: t.u64().primaryKey(),
    text: t.string(),
    citations: t.string(),
    ts: t.timestamp(),
  }
);

// Matched frames per query — the visual "search results" the connector
// surfaces so the UI can show which frames an answer is based on.
const hit = table(
  { name: 'hit', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    query_id: t.u64().index('btree'),
    camera_id: t.string(),
    thumb_b64: t.string(),
    score: t.f32(),
  }
);

const spacetimedb = schema({ camera, live_frame, pending_frame, chunk, query, answer, hit });
export default spacetimedb;

// ─── Camera lifecycle ────────────────────────────────────────────────────────

// Wipe the AI's working set (indexed chunks, pending frames, Q&A) so each new
// joiner starts the agent from a clean slate. Live feeds (camera/live_frame)
// are left intact.
function clearAiInputs(ctx: any) {
  for (const c of [...ctx.db.chunk.iter()]) ctx.db.chunk.chunk_id.delete(c.chunk_id);
  for (const p of [...ctx.db.pending_frame.iter()]) ctx.db.pending_frame.id.delete(p.id);
  for (const q of [...ctx.db.query.iter()]) ctx.db.query.query_id.delete(q.query_id);
  for (const a of [...ctx.db.answer.iter()]) ctx.db.answer.query_id.delete(a.query_id);
  for (const h of [...ctx.db.hit.iter()]) ctx.db.hit.id.delete(h.id);
  for (const cam of [...ctx.db.camera.iter()]) {
    if (cam.chunk_count !== 0) ctx.db.camera.camera_id.update({ ...cam, chunk_count: 0 });
  }
}

export const register_camera = spacetimedb.reducer(
  { camera_id: t.string(), name: t.string() },
  (ctx, { camera_id, name }) => {
    if (!camera_id) throw new SenderError('camera_id required');

    // Reset the AI agent's inputs whenever a NEW person joins.
    const existing = ctx.db.camera.camera_id.find(camera_id);
    if (!existing) clearAiInputs(ctx);

    if (existing) {
      ctx.db.camera.camera_id.update({
        ...existing,
        name,
        online: true,
        last_seen: ctx.timestamp,
      });
    } else {
      ctx.db.camera.insert({
        camera_id,
        owner: ctx.sender,
        name,
        online: true,
        last_seen: ctx.timestamp,
        chunk_count: 0,
      });
    }
  }
);

// Manual reset (clears all AI inputs without needing a new camera).
export const reset_agent = spacetimedb.reducer((ctx) => clearAiInputs(ctx));

// Browser pushes a captured frame (~ every 5s). Updates the live tile and
// enqueues the frame for embedding by the connector.
export const ingest_frame = spacetimedb.reducer(
  { camera_id: t.string(), jpeg_b64: t.string() },
  (ctx, { camera_id, jpeg_b64 }) => {
    if (!jpeg_b64) throw new SenderError('empty frame');

    const cam = ctx.db.camera.camera_id.find(camera_id);
    if (cam) {
      ctx.db.camera.camera_id.update({ ...cam, online: true, last_seen: ctx.timestamp });
    }

    const live = ctx.db.live_frame.camera_id.find(camera_id);
    if (live) {
      ctx.db.live_frame.camera_id.update({ ...live, jpeg_b64, ts: ctx.timestamp });
    } else {
      ctx.db.live_frame.insert({ camera_id, jpeg_b64, ts: ctx.timestamp });
    }

    ctx.db.pending_frame.insert({ id: 0n, camera_id, jpeg_b64, ts: ctx.timestamp });
  }
);

// ─── Connector callbacks (Gemini service writes results back) ────────────────

// Called by the connector after it embeds a pending frame. Stores the chunk,
// removes the pending frame, and bumps the camera's chunk count.
export const store_chunk = spacetimedb.reducer(
  {
    pending_id: t.u64(),
    chunk_id: t.string(),
    embedding: t.array(t.f32()),
    caption: t.option(t.string()),
  },
  (ctx, { pending_id, chunk_id, embedding, caption }) => {
    const pf = ctx.db.pending_frame.id.find(pending_id);
    if (!pf) return; // already processed / evicted

    if (!ctx.db.chunk.chunk_id.find(chunk_id)) {
      ctx.db.chunk.insert({
        chunk_id,
        camera_id: pf.camera_id,
        ts: pf.ts,
        embedding,
        caption,
        thumb_b64: pf.jpeg_b64,
      });
      const cam = ctx.db.camera.camera_id.find(pf.camera_id);
      if (cam) {
        ctx.db.camera.camera_id.update({ ...cam, chunk_count: cam.chunk_count + 1 });
      }
    }
    ctx.db.pending_frame.id.delete(pending_id);
  }
);

export const submit_query = spacetimedb.reducer(
  { text: t.string() },
  (ctx, { text }) => {
    if (!text) throw new SenderError('empty query');
    ctx.db.query.insert({
      query_id: 0n,
      asker: ctx.sender,
      text,
      ts: ctx.timestamp,
      answered: false,
    });
  }
);

// Called by the connector for each matched frame (visual search results).
export const store_hit = spacetimedb.reducer(
  { query_id: t.u64(), camera_id: t.string(), thumb_b64: t.string(), score: t.f32() },
  (ctx, { query_id, camera_id, thumb_b64, score }) => {
    ctx.db.hit.insert({ id: 0n, query_id, camera_id, thumb_b64, score });
  }
);

// Called by the connector once it has synthesized an answer for a query.
export const store_answer = spacetimedb.reducer(
  { query_id: t.u64(), text: t.string(), citations: t.string() },
  (ctx, { query_id, text, citations }) => {
    const q = ctx.db.query.query_id.find(query_id);
    if (!q) return;
    if (!ctx.db.answer.query_id.find(query_id)) {
      ctx.db.answer.insert({ query_id, text, citations, ts: ctx.timestamp });
    }
    ctx.db.query.query_id.update({ ...q, answered: true });
  }
);

// ─── Connection lifecycle ────────────────────────────────────────────────────

export const init = spacetimedb.init(_ctx => {});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  // Mark this sender's cameras offline (best-effort).
  for (const cam of [...ctx.db.camera.iter()].filter(c => c.owner.equals(ctx.sender))) {
    ctx.db.camera.camera_id.update({ ...cam, online: false });
  }
});
