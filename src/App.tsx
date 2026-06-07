import { useEffect, useMemo, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables, type DbConnection } from './module_bindings';
import './App.css';

const CAPTURE_MS = 5000; // push a frame every 5s
const FRAME_W = 480; // downscale width for cheap payloads

export default function App() {
  const { isActive, getConnection } = useSpacetimeDB();
  const conn = getConnection() as DbConnection | null;

  const [, setSubscribed] = useState(false);
  const [joined, setJoined] = useState(false);
  const [camName, setCamName] = useState('');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);

  const camIdRef = useRef<string>('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Subscribe to the live state.
  useEffect(() => {
    if (!conn || !isActive) return;
    conn
      .subscriptionBuilder()
      .onApplied(() => setSubscribed(true))
      .subscribe([tables.camera, tables.live_frame, tables.query, tables.answer, tables.hit]);
  }, [conn, isActive]);

  const [cameras] = useTable(tables.camera);
  const [liveFrames] = useTable(tables.live_frame);
  const [queries] = useTable(tables.query);
  const [answers] = useTable(tables.answer);
  const [hits] = useTable(tables.hit);

  // Join: request the webcam, register the camera, start the capture loop.
  const join = async () => {
    if (!conn) return;
    try {
      const id = `cam-${Math.random().toString(36).slice(2, 7)}`;
      camIdRef.current = id;
      const name = camName.trim() || `camera-${id.slice(4)}`;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 } },
        audio: false,
      });
      // Stash the stream; the <video> element isn't mounted until `joined`
      // flips true, so attach it in the effect below (not here).
      streamRef.current = stream;
      conn.reducers.registerCamera({ cameraId: id, name });
      setJoined(true);
    } catch (e) {
      setError((e as Error).message || 'camera access denied');
    }
  };

  // Attach the captured stream once the <video> element has mounted.
  useEffect(() => {
    if (joined && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [joined]);

  // Capture loop → ingest_frame.
  useEffect(() => {
    if (!joined || !conn) return;
    const tick = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v || !c || !v.videoWidth) return;
      const scale = FRAME_W / v.videoWidth;
      c.width = FRAME_W;
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
      const b64 = c.toDataURL('image/jpeg', 0.5).split(',')[1];
      if (b64) conn.reducers.ingestFrame({ cameraId: camIdRef.current, jpegB64: b64 });
    };
    const iv = setInterval(tick, CAPTURE_MS);
    const warmup = setTimeout(tick, 800);
    return () => {
      clearInterval(iv);
      clearTimeout(warmup);
    };
  }, [joined, conn]);

  const ask = () => {
    const t = question.trim();
    if (t && conn) {
      conn.reducers.submitQuery({ text: t });
      setQuestion('');
    }
  };

  // Pair queries with their answers, newest first.
  const conversation = useMemo(() => {
    const ansById = new Map(answers.map((a) => [a.queryId.toString(), a]));
    const hitsById = new Map<string, (typeof hits)[number][]>();
    for (const h of hits) {
      const k = h.queryId.toString();
      const arr = hitsById.get(k);
      if (arr) arr.push(h);
      else hitsById.set(k, [h]);
    }
    return [...queries]
      .sort((a, b) => Number(b.queryId - a.queryId))
      .map((q) => {
        const key = q.queryId.toString();
        const frames = (hitsById.get(key) ?? []).slice().sort((a, b) => b.score - a.score);
        return { q, a: ansById.get(key) ?? null, frames };
      });
  }, [queries, answers, hits]);

  const onlineCount = cameras.filter((c) => c.online).length;
  const totalChunks = cameras.reduce((s, c) => s + (c.chunkCount ?? 0), 0);
  const frameFor = (cameraId: string) =>
    liveFrames.find((f) => f.cameraId === cameraId)?.jpegB64;

  return (
    <div className="app">
      <header className="hdr">
        <span className="brand">
          <span className="dot" /> WATCHMAN
        </span>
        <span className="tag">live multicam · spacetimedb</span>
        <span className="telemetry">
          <b>{onlineCount}/{cameras.length}</b> online · <b>{totalChunks}</b> indexed
        </span>
      </header>

      <main className="main">
        {/* Join / your camera */}
        <section className="panel">
          <div className="label">Your camera</div>
          {!joined ? (
            <div className="join">
              <input
                className="in"
                placeholder="camera name (e.g. front-door)"
                value={camName}
                onChange={(e) => setCamName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && join()}
              />
              <button className="btn" onClick={join} disabled={!isActive}>
                ▶ Join with my camera
              </button>
              {error && <span className="err">{error}</span>}
              {!isActive && <span className="muted">connecting…</span>}
            </div>
          ) : (
            <div className="me">
              <video ref={videoRef} muted playsInline className="mevideo" />
              <span className="rec">● LIVE — streaming to everyone</span>
            </div>
          )}
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </section>

        {/* Everyone's live feeds */}
        <section className="panel">
          <div className="label">Live feeds — {cameras.length}</div>
          {cameras.length === 0 ? (
            <div className="empty">No cameras yet. Join above, or share the link.</div>
          ) : (
            <div className="grid">
              {cameras.map((c) => {
                const jpeg = frameFor(c.cameraId);
                return (
                  <div className="tile" key={c.cameraId}>
                    {jpeg ? (
                      <img src={`data:image/jpeg;base64,${jpeg}`} alt={c.name} />
                    ) : (
                      <div className="nosignal">no signal</div>
                    )}
                    <span className={`badge ${c.online ? 'on' : 'off'}`}>
                      <span className="bdot" /> {c.name}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Ask */}
        <section className="panel">
          <div className="label">Ask the cameras</div>
          <div className="askbar">
            <input
              className="in"
              placeholder="e.g. is there a person in view?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
            />
            <button className="btn" onClick={ask}>Ask</button>
          </div>
          <div className="convo">
            {conversation.map(({ q, a, frames }) => (
              <div className="qa" key={q.queryId.toString()}>
                <div className="q">{q.text}</div>
                {frames.length > 0 && (
                  <div className="hits">
                    {frames.map((h, i) => (
                      <div className="hit" key={h.id.toString()}>
                        <img src={`data:image/jpeg;base64,${h.thumbB64}`} alt={h.cameraId} />
                        <span className="hitmeta">
                          {h.cameraId} · {Math.round(h.score * 100)}%
                        </span>
                        <span className="hitrank">{i + 1}</span>
                      </div>
                    ))}
                  </div>
                )}
                {a ? (
                  <div className="a">
                    {a.text}
                    {a.citations && <div className="cite">{a.citations}</div>}
                  </div>
                ) : (
                  <div className="a pending">
                    <span className="bdot" /> analyzing…
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
