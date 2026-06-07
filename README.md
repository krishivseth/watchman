# Watchman — live multicam Video RAG (SpacetimeDB)

**Anyone, any laptop, no install — open a URL, grant your camera, and you're a live camera in a shared, searchable multi-camera feed.** Ask questions in plain English and get answers grounded in what the cameras actually see.

Built on **SpacetimeDB** (realtime store + sync) with **Google Gemini** for embeddings and answers.

## Architecture

```
Browser (getUserMedia)  ──WebSocket──▶  SpacetimeDB module (maincloud: watchman-1v356)
  • capture frame / ~5s                   Tables: camera, live_frame, pending_frame,
  • ingest_frame() reducer                        chunk (embedding 3072), query, answer
  • submit_query() reducer                Reducers: register_camera, ingest_frame,
  • subscribes: camera / live_frame /              submit_query, store_chunk, store_answer
    query / answer                               ▲
        ▲ renders live grid + chat               │ subscribes + writes back
        └─────────────────────────────  Gemini connector (Node, server-side key)
                                          • pending_frame → Gemini embed → store_chunk
                                          • query → embed + cosine search → Gemini answer → store_answer
```

Reducers can't call external APIs, so the **connector** (a Node process holding the Gemini key) does all embedding, brute-force cosine search over the chunk embeddings, and answer synthesis, writing results back through reducers. Browsers only ever talk to SpacetimeDB.

## Layout

```
spacetimedb/src/index.ts   SpacetimeDB module (tables + reducers)
src/                       React browser client (capture + live grid + chat)
src/module_bindings/       generated SpacetimeDB client bindings
connector.ts               Gemini connector service (Node)
```

## Run it

```sh
npm install
spacetime login                      # one-time, for maincloud

# 1) Publish the module (already live as watchman-1v356; republish after edits):
spacetime publish --module-path spacetimedb watchman-1v356 -y
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb -y

# 2) Connector — the "brain" (keep running; holds the Gemini key):
GEMINI_API_KEY=your_key npx tsx connector.ts

# 3) Browser client:
npm run dev                          # open the printed URL → "Join with my camera"
```

`GEMINI_MODEL` defaults to `gemini-3.5-flash`. Embeddings use `gemini-embedding-2-preview`.

## Make it public ("anyone can join")

- Build the client (`npm run build`) and host `dist/` anywhere static (Vercel/Netlify/Railway). It points at the maincloud module via `.env.local`.
- Run the **connector** on a server (Railway/VM) with `GEMINI_API_KEY` set — it must stay running for frames to be embedded and questions answered.
- Share the URL. Each visitor who grants camera access becomes a live camera; everyone sees every feed and can query across all of them.

## Notes

- One Gemini call per frame per camera (continuous) — cost scales with cameras; cap framerate for public use.
- Brute-force cosine search runs in the connector (fine for demo scale; not millions of chunks).
- Frames go to your connector and to Google (embedding + answering) — not a private/on-device setup.
