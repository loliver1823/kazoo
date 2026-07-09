import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, ListMusic, X, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLayoutEffect } from "react";
import { usePlayer, toggle, next, prev, seekFrac, setVolume, toggleShuffle, cycleRepeat, jumpTo, removeFromQueue, clearQueue, moveInQueue } from "@/lib/player";
import { GetTrackWaveform, GetTrackAudioInfo } from "../../wailsjs/go/main/App";
import { backend } from "../../wailsjs/go/models";

function fmtAudioInfo(info: backend.TrackAudioInfo): string {
    const parts: string[] = [];
    if (info.codec) parts.push(info.codec.toUpperCase());
    const spec: string[] = [];
    if (info.bitDepth > 0) spec.push(`${info.bitDepth}-bit`);
    if (info.sampleRate > 0) spec.push(`${(info.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`);
    if (spec.length) parts.push(spec.join("/"));
    if (info.bitrate > 0) parts.push(`${info.bitrate.toLocaleString()} kbps`);
    return parts.join(" · ");
}

function fmtTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Waveform seek bar. Hover shows a playhead line + timestamp bubble; click
// and drag scrubs a live preview (fill follows the cursor) and the actual
// seek commits on release, so audio doesn't stutter mid-drag. Falls back to
// a flat bar when no waveform is available (e.g. FFmpeg missing).
function WaveformSeek({ trackId, progress, duration }: { trackId: number; progress: number; duration: number }) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [peaks, setPeaks] = useState<number[] | null>(null);
    const [hoverFrac, setHoverFrac] = useState<number | null>(null);
    const [dragFrac, setDragFrac] = useState<number | null>(null);
    const dragging = dragFrac !== null;

    useEffect(() => {
        let alive = true;
        setPeaks(null);
        GetTrackWaveform(trackId).then((p) => { if (alive) setPeaks(p && p.length ? p : []); }).catch(() => { if (alive) setPeaks([]); });
        return () => { alive = false; };
    }, [trackId]);

    const fracFromClientX = (clientX: number) => {
        const el = canvasRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    // While dragging, track the cursor window-wide so the scrub keeps working
    // even when the pointer leaves the bar; seek once on release.
    useEffect(() => {
        if (!dragging) return;
        const move = (e: MouseEvent) => setDragFrac(fracFromClientX(e.clientX));
        const up = (e: MouseEvent) => {
            seekFrac(fracFromClientX(e.clientX));
            setDragFrac(null);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    }, [dragging]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (w === 0 || h === 0) return;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const styles = getComputedStyle(canvas);
        const accent = styles.getPropertyValue("--primary").trim() || "#6366f1";
        const muted = styles.getPropertyValue("--muted-foreground").trim() || "#888";
        const fg = styles.getPropertyValue("--foreground").trim() || "#fff";
        // Fill shows playback progress — or the scrub target while dragging.
        const fill = dragFrac ?? progress;
        const marker = dragFrac ?? hoverFrac;

        if (peaks && peaks.length > 0) {
            const n = peaks.length;
            const barW = w / n;
            const mid = h / 2;
            for (let i = 0; i < n; i++) {
                const frac = i / n;
                const amp = Math.max(peaks[i], 0.04);
                const bh = amp * (h - 2);
                ctx.fillStyle = frac <= fill ? accent : muted;
                ctx.globalAlpha = frac <= fill ? 1 : 0.35;
                ctx.fillRect(i * barW, mid - bh / 2, Math.max(barW - 0.6, 0.6), bh);
            }
            ctx.globalAlpha = 1;
        } else {
            const y = h / 2 - 2;
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = muted;
            ctx.fillRect(0, y, w, 4);
            ctx.globalAlpha = 1;
            ctx.fillStyle = accent;
            ctx.fillRect(0, y, w * fill, 4);
        }
        // Playhead marker where the seek would land.
        if (marker !== null) {
            ctx.fillStyle = fg;
            ctx.fillRect(marker * w - 0.75, 0, 1.5, h);
        }
    }, [peaks, progress, hoverFrac, dragFrac]);

    const marker = dragFrac ?? hoverFrac;
    return (
        <div className="relative w-full">
            <canvas
                ref={canvasRef}
                className={`w-full h-8 ${dragging ? "cursor-grabbing" : "cursor-pointer"}`}
                onMouseDown={(e) => { e.preventDefault(); setDragFrac(fracFromClientX(e.clientX)); }}
                onMouseMove={(e) => { if (!dragging) setHoverFrac(fracFromClientX(e.clientX)); }}
                onMouseLeave={() => setHoverFrac(null)}
            />
            {marker !== null && duration > 0 && (
                <div className="absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 rounded border bg-popover text-popover-foreground text-[10px] tabular-nums pointer-events-none shadow-md whitespace-nowrap"
                    style={{ left: `${marker * 100}%` }}>
                    {fmtTime(marker * duration)}
                </div>
            )}
        </div>
    );
}

function QueuePanel({ onClose }: { onClose: () => void }) {
    const p = usePlayer();
    const ref = useRef<HTMLDivElement | null>(null);
    const currentRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if ((e.target as Element | null)?.closest?.("[data-queue-toggle]")) return;
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [onClose]);
    useEffect(() => {
        currentRef.current?.scrollIntoView({ block: "center" });
    }, []);

    // Big queues render incrementally (window always covers the current
    // track) so opening the panel with thousands queued doesn't stall.
    const Q_CHUNK = 250;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const qSentinel = useRef<HTMLDivElement | null>(null);
    const [visibleQ, setVisibleQ] = useState(() => Math.max(Q_CHUNK, p.index + 50));
    useEffect(() => {
        if (p.index + 20 > visibleQ) setVisibleQ(Math.max(visibleQ, p.index + 50));
    }, [p.index, visibleQ]);
    useEffect(() => {
        const el = qSentinel.current;
        if (!el) return;
        const obs = new IntersectionObserver((es) => {
            if (es[0]?.isIntersecting) setVisibleQ((v) => v + Q_CHUNK);
        }, { root: scrollRef.current, rootMargin: "600px" });
        obs.observe(el);
        return () => obs.disconnect();
    }, [p.queue.length, visibleQ]);

    // Drag-to-reorder with FLIP animation: rows glide aside as you drag a
    // track through the list. Midpoint rule + animation lockout keep it from
    // flip-flopping (same technique as the library pills).
    const [draggingUid, setDraggingUid] = useState<number | null>(null);
    const dragUid = useRef<number | null>(null);
    const rowRefs = useRef(new Map<number, HTMLDivElement>());
    const rectsBefore = useRef<Map<number, DOMRect> | null>(null);
    const lastMove = useRef(0);
    const didDrag = useRef(false);
    const dragOverRow = (targetUid: number, clientY: number) => {
        const from = dragUid.current;
        if (from === null || from === targetUid) return;
        if (performance.now() - lastMove.current < 180) return;
        const targetEl = rowRefs.current.get(targetUid);
        if (!targetEl) return;
        const r = targetEl.getBoundingClientRect();
        const before = clientY < r.top + r.height / 2;
        const fi = p.queue.findIndex((t) => t.uid === from);
        const ti = p.queue.findIndex((t) => t.uid === targetUid);
        if (fi < 0 || ti < 0) return;
        let insert = before ? ti : ti + 1;
        if (fi < insert) insert--;
        if (insert === fi) return;
        lastMove.current = performance.now();
        didDrag.current = true;
        const rects = new Map<number, DOMRect>();
        rowRefs.current.forEach((el, uid) => rects.set(uid, el.getBoundingClientRect()));
        rectsBefore.current = rects;
        moveInQueue(fi, insert);
    };
    useLayoutEffect(() => {
        const before = rectsBefore.current;
        if (!before) return;
        rectsBefore.current = null;
        rowRefs.current.forEach((el, uid) => {
            const old = before.get(uid);
            if (!old) return;
            const now = el.getBoundingClientRect();
            const dy = old.top - now.top;
            if (dy === 0) return;
            el.style.transition = "none";
            el.style.transform = `translateY(${dy}px)`;
            requestAnimationFrame(() => {
                el.style.transition = "transform 160ms ease";
                el.style.transform = "";
            });
        });
    }, [p.queue]);

    return (
        <div ref={ref} className="fixed bottom-24 right-4 z-50 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b">
                <span className="text-sm font-semibold">Queue · {p.queue.length.toLocaleString()}</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { clearQueue(); onClose(); }}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear
                </Button>
            </div>
            <div ref={scrollRef} className="max-h-96 overflow-y-auto py-1">
                {p.queue.slice(0, visibleQ).map((t, i) => (
                    <div key={t.uid ?? `${t.id}-${i}`}
                        ref={(el) => {
                            if (t.uid === undefined) return;
                            if (el) rowRefs.current.set(t.uid, el); else rowRefs.current.delete(t.uid);
                            if (i === p.index) currentRef.current = el;
                        }}
                        draggable
                        onDragStart={(e) => { dragUid.current = t.uid ?? null; setDraggingUid(t.uid ?? null); didDrag.current = false; e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={(e) => { e.preventDefault(); if (t.uid !== undefined) dragOverRow(t.uid, e.clientY); }}
                        onDrop={(e) => e.preventDefault()}
                        onDragEnd={() => { dragUid.current = null; setDraggingUid(null); }}
                        className={`group flex items-center gap-2.5 px-3 py-1.5 cursor-pointer ${draggingUid === t.uid ? "opacity-40" : ""} ${i === p.index ? "bg-primary/10" : "hover:bg-accent"}`}
                        onClick={() => { if (didDrag.current) { didDrag.current = false; return; } jumpTo(i); }}>
                        <span className={`w-5 text-right text-xs tabular-nums ${i === p.index ? "text-primary font-semibold" : "text-muted-foreground"}`}>{i + 1}</span>
                        <div className="min-w-0 flex-1">
                            <div className={`truncate text-sm ${i === p.index ? "text-primary font-medium" : ""}`}>{t.title}</div>
                            <div className="truncate text-xs text-muted-foreground">{t.artist}</div>
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">{fmtTime(t.duration)}</span>
                        <button type="button" className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                            onClick={(e) => { e.stopPropagation(); removeFromQueue(i); }}>
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                ))}
                {visibleQ < p.queue.length && (
                    <div ref={qSentinel} className="py-3 text-center text-xs text-muted-foreground">
                        {(p.queue.length - visibleQ).toLocaleString()} more…
                    </div>
                )}
            </div>
        </div>
    );
}

export function PlayerBar() {
    const p = usePlayer();
    const track = p.index >= 0 ? p.queue[p.index] : null;
    const [coverFailed, setCoverFailed] = useState(false);
    const [queueOpen, setQueueOpen] = useState(false);
    const [audioInfo, setAudioInfo] = useState<backend.TrackAudioInfo | null>(null);
    useEffect(() => { setCoverFailed(false); }, [track?.path]);
    useEffect(() => {
        let alive = true;
        setAudioInfo(null);
        if (track?.id) GetTrackAudioInfo(track.id).then((i) => { if (alive) setAudioInfo(i); }).catch(() => { });
        return () => { alive = false; };
    }, [track?.id]);

    if (!track) return null;
    const dur = p.duration || track.duration || 0;
    const progress = dur > 0 ? p.position / dur : 0;

    // Spotify-style three-zone layout: now-playing left, transport stacked
    // over the seek bar centered, queue/volume right.
    return (
        <div className="fixed bottom-0 left-14 right-0 z-40 h-[88px] border-t bg-background/95 backdrop-blur grid items-center px-4"
            style={{ gridTemplateColumns: "minmax(180px, 30%) 1fr minmax(180px, 30%)" }}>
            {/* now playing */}
            <div className="flex items-center gap-3 min-w-0 pr-4">
                <div className="h-14 w-14 rounded-md overflow-hidden bg-muted shrink-0 shadow">
                    {!coverFailed
                        ? <img src={`/cover?path=${encodeURIComponent(track.path)}&s=128`} alt="" decoding="async" className="h-full w-full object-cover" onError={() => setCoverFailed(true)} />
                        : <div className="h-full w-full flex items-center justify-center text-muted-foreground"><ListMusic className="h-5 w-5" /></div>}
                </div>
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{track.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{track.artist}</div>
                    {audioInfo && fmtAudioInfo(audioInfo) && (
                        <div className="truncate text-[10px] text-muted-foreground/80 tabular-nums mt-0.5">{fmtAudioInfo(audioInfo)}</div>
                    )}
                </div>
            </div>

            {/* center: transport above seek bar */}
            <div className="flex flex-col items-center justify-center gap-1 min-w-0 max-w-2xl w-full mx-auto">
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="icon" className={`h-8 w-8 ${p.shuffle ? "text-primary" : "text-muted-foreground hover:text-foreground"}`} onClick={toggleShuffle} title="Shuffle">
                        <Shuffle className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={prev} title="Previous">
                        <SkipBack className="h-4 w-4 fill-current" />
                    </Button>
                    <Button size="icon" className="h-9 w-9 rounded-full hover:scale-105 transition-transform" onClick={toggle} title={p.playing ? "Pause" : "Play"}>
                        {p.loading ? <Spinner className="h-4 w-4" /> : p.playing ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current ml-0.5" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => next()} title="Next">
                        <SkipForward className="h-4 w-4 fill-current" />
                    </Button>
                    <Button variant="ghost" size="icon" className={`h-8 w-8 ${p.repeat !== "off" ? "text-primary" : "text-muted-foreground hover:text-foreground"}`} onClick={cycleRepeat} title={`Repeat: ${p.repeat}`}>
                        {p.repeat === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
                    </Button>
                </div>
                <div className="flex items-center gap-2 w-full min-w-0">
                    <span className="text-[11px] text-muted-foreground tabular-nums w-9 text-right shrink-0">{fmtTime(p.position)}</span>
                    <div className="flex-1 min-w-0">
                        <WaveformSeek trackId={track.id} progress={progress} duration={dur} />
                    </div>
                    <span className="text-[11px] text-muted-foreground tabular-nums w-9 shrink-0">{fmtTime(dur)}</span>
                </div>
            </div>

            {/* right: queue + volume */}
            <div className="flex items-center justify-end gap-2 pl-4">
                <Button variant="ghost" size="icon" className={`h-8 w-8 ${queueOpen ? "text-primary" : "text-muted-foreground hover:text-foreground"}`} title="Queue" data-queue-toggle
                    onClick={() => setQueueOpen((o) => !o)}>
                    <ListMusic className="h-4 w-4" />
                </Button>
                <button type="button" onClick={() => setVolume(p.volume > 0 ? 0 : 1)} className="text-muted-foreground hover:text-foreground">
                    {p.volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <input type="range" min={0} max={1} step={0.01} value={p.volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    className="w-24 accent-[var(--primary)] cursor-pointer" />
            </div>
            {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
        </div>
    );
}
