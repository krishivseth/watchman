// Watchman — Gemini connector service
// =============================================================================
// SpacetimeDB reducers can't call external APIs, so this standalone Node
// process is the "brain": it subscribes to the module, embeds incoming frames
// with Gemini, runs brute-force cosine search over chunk embeddings, asks
// Gemini 3.5 Flash to answer over the matched frames, and writes results back
// via the store_chunk / store_answer reducers.
//
// Run:  GEMINI_API_KEY=... npx tsx connector.ts
// =============================================================================

import { DbConnection, tables } from './src/module_bindings';

const HOST = process.env.SPACETIMEDB_HOST || 'wss://maincloud.spacetimedb.com';
const DB = process.env.SPACETIMEDB_DB_NAME || 'watchman-1v356';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const EMBED_MODEL = 'models/gemini-embedding-2-preview';
const CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_FRAMES = 6;

if (!GEMINI_KEY) {
  console.error('Set GEMINI_API_KEY');
  process.exit(1);
}

// In-memory mirror of chunk embeddings (kept in sync via subscription).
type Chunk = { chunkId: string; cameraId: string; tsMicros: bigint; embedding: number[]; thumb: string };
const chunks = new Map<string, Chunk>();

// ─── Gemini helpers ──────────────────────────────────────────────────────────

async function embed(part: object): Promise<number[]> {
  const r = await fetch(`${GEMINI_BASE}/${EMBED_MODEL}:embedContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY! },
    body: JSON.stringify({ model: EMBED_MODEL, content: { parts: [part] } }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d: any = await r.json();
  return d.embedding.values as number[];
}
const embedImage = (jpegB64: string) => embed({ inline_data: { mime_type: 'image/jpeg', data: jpegB64 } });
const embedText = (text: string) => embed({ text });

async function answerOverFrames(question: string, frames: Chunk[]): Promise<string> {
  const parts: any[] = [
    {
      text:
        `You are a security-camera monitoring assistant. Below are recent frames ` +
        `from one or more cameras (most relevant first). Answer the question from ` +
        `what you actually see. Start yes/no questions with YES or NO. If the frames ` +
        `don't show anything matching, say so plainly.\n\nQuestion: "${question}"`,
    },
  ];
  frames.slice(0, MAX_FRAMES).forEach((f, i) => {
    parts.push({ text: `#${i + 1} [${f.cameraId}]` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: f.thumb } });
  });
  const r = await fetch(`${GEMINI_BASE}/models/${CHAT_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY! },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 1024, temperature: 0.2 } }),
  });
  if (!r.ok) throw new Error(`answer ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d: any = await r.json();
  return (d.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('') || '').trim();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

// ─── Connect + process ───────────────────────────────────────────────────────

const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB)
  .onConnect((c, identity) => {
    console.log('connector online as', identity.toHexString().slice(0, 12));
    c.subscriptionBuilder()
      .onApplied(() => console.log('subscribed'))
      .subscribe([tables.pending_frame, tables.chunk, tables.query, tables.answer, tables.search, tables.search_hit]);
  })
  .onConnectError((_c, e) => console.error('connect error', e))
  .build();

// Keep the chunk-embedding cache in sync.
conn.db.chunk.onInsert((_ctx, row: any) => {
  chunks.set(row.chunkId, {
    chunkId: row.chunkId,
    cameraId: row.cameraId,
    tsMicros: row.ts.microsSinceUnixEpoch,
    embedding: row.embedding,
    thumb: row.thumbB64,
  });
});
conn.db.chunk.onDelete((_ctx, row: any) => chunks.delete(row.chunkId));

// Embed each pending frame, then store it as a chunk.
const embedding = new Set<bigint>();
conn.db.pending_frame.onInsert(async (_ctx, pf: any) => {
  if (embedding.has(pf.id)) return;
  embedding.add(pf.id);
  try {
    const vec = await embedImage(pf.jpegB64);
    const chunkId = `${pf.cameraId}:${pf.id.toString()}`;
    conn.reducers.storeChunk({ pendingId: pf.id, chunkId, embedding: vec, caption: undefined });
    console.log('embedded', chunkId, `(${vec.length}d)`);
  } catch (e) {
    console.error('embed failed', (e as Error).message);
  } finally {
    embedding.delete(pf.id);
  }
});

// Answer each new query.
const answering = new Set<string>();
conn.db.query.onInsert(async (_ctx, q: any) => {
  const key = q.queryId.toString();
  if (q.answered || answering.has(key)) return;
  answering.add(key);
  try {
    const qvec = await embedText(q.text);
    const top = [...chunks.values()]
      .map((c) => ({ c, s: cosine(qvec, c.embedding) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_FRAMES);
    // Write the matched frames as visual search results.
    for (const x of top) {
      conn.reducers.storeHit({ queryId: q.queryId, cameraId: x.c.cameraId, thumbB64: x.c.thumb, score: x.s });
    }
    const text = top.length
      ? await answerOverFrames(q.text, top.map((x) => x.c))
      : 'No camera footage indexed yet.';
    const cites = [...new Set(top.map((x) => x.c.cameraId))].join(', ');
    conn.reducers.storeAnswer({ queryId: q.queryId, text, citations: cites });
    console.log('answered', key, '→', text.slice(0, 60));
  } catch (e) {
    console.error('answer failed', (e as Error).message);
    conn.reducers.storeAnswer({ queryId: q.queryId, text: `Error: ${(e as Error).message}`, citations: '' });
  } finally {
    answering.delete(key);
  }
});

// Retrieval-only search (the explicit RAG step — no LLM answer, just ranked frames).
const SEARCH_K = 12;
const searching = new Set<string>();
conn.db.search.onInsert(async (_ctx, s: any) => {
  const key = s.searchId.toString();
  if (searching.has(key)) return;
  searching.add(key);
  try {
    const qvec = await embedText(s.text);
    const top = [...chunks.values()]
      .map((c) => ({ c, score: cosine(qvec, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_K);
    for (const x of top) {
      conn.reducers.storeSearchHit({ searchId: s.searchId, cameraId: x.c.cameraId, thumbB64: x.c.thumb, score: x.score });
    }
    console.log('searched', key, '→', top.length, 'hits');
  } catch (e) {
    console.error('search failed', (e as Error).message);
  } finally {
    searching.delete(key);
  }
});

console.log(`Watchman connector → ${DB} @ ${HOST} (embed=${EMBED_MODEL}, chat=${CHAT_MODEL})`);
