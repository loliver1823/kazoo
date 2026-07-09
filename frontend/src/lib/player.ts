import { useSyncExternalStore } from "react";

// Global music player: one <audio> element streaming from the backend's
// /media/{id} endpoint. Codecs the WebView can't decode natively are retried
// with ?transcode=1 (FFmpeg → FLAC server-side), so every format plays.

export type PlayerTrack = {
    id: number;
    path: string;
    title: string;
    artist: string;
    album: string;
    duration: number; // seconds
    codec?: string;
    // Stable per-queue-entry identity (the same track can be queued twice) —
    // assigned internally when enqueued; used for drag-reorder animation.
    uid?: number;
};

let uidCounter = 1;
function withUids(tracks: PlayerTrack[]): PlayerTrack[] {
    return tracks.map((t) => ({ ...t, uid: uidCounter++ }));
}

export type RepeatMode = "off" | "all" | "one";

type PlayerState = {
    queue: PlayerTrack[];
    index: number; // -1 = nothing loaded
    playing: boolean;
    loading: boolean;
    position: number; // seconds
    duration: number; // seconds (from the element once known)
    volume: number; // 0..1
    shuffle: boolean;
    repeat: RepeatMode;
};

const VOLUME_KEY = "kazoo_player_volume";

let state: PlayerState = {
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: (() => {
        const v = parseFloat(localStorage.getItem(VOLUME_KEY) || "1");
        return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
    })(),
    shuffle: false,
    repeat: "off",
};

const listeners = new Set<() => void>();
function emit() {
    listeners.forEach((l) => l());
}
function set(patch: Partial<PlayerState>) {
    state = { ...state, ...patch };
    emit();
}

export function usePlayer(): PlayerState {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        () => state,
        () => state,
    );
}

// --- audio element ------------------------------------------------------------

const audio = new Audio();
audio.preload = "auto";
audio.volume = state.volume;
let triedTranscode = false;
const history: number[] = []; // indexes played, for prev under shuffle

audio.addEventListener("timeupdate", () => {
    // Avoid re-render storms: only emit when the displayed second changes.
    const pos = audio.currentTime;
    if (Math.floor(pos) !== Math.floor(state.position)) set({ position: pos });
    else state = { ...state, position: pos };
});
audio.addEventListener("durationchange", () => {
    if (Number.isFinite(audio.duration)) set({ duration: audio.duration });
});
audio.addEventListener("play", () => set({ playing: true }));
audio.addEventListener("pause", () => set({ playing: false }));
audio.addEventListener("waiting", () => set({ loading: true }));
audio.addEventListener("canplay", () => set({ loading: false }));
audio.addEventListener("ended", () => {
    if (state.repeat === "one") {
        audio.currentTime = 0;
        void audio.play();
        return;
    }
    next(true);
});
audio.addEventListener("error", () => {
    // Native decode failed (e.g. ALAC in .m4a) — retry via server transcode.
    const t = current();
    if (t && !triedTranscode) {
        triedTranscode = true;
        set({ loading: true });
        audio.src = `/media/${t.id}?transcode=1`;
        void audio.play();
    } else {
        set({ playing: false, loading: false });
    }
});

function current(): PlayerTrack | null {
    return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
}

// Codecs the WebView decodes natively; anything else streams via transcode.
const NATIVE_CODECS = new Set(["mp3", "flac", "wav", "ogg", "oga", "opus", "aac", "m4a", "webm", "mp4"]);

// Warm the transcode cache for the upcoming track so skipping to it is
// instant instead of waiting on a full FFmpeg pass.
function prefetchNext(index: number) {
    const n = state.queue[index + 1];
    if (!n?.codec || NATIVE_CODECS.has(n.codec.toLowerCase())) return;
    fetch(`/media/${n.id}?transcode=1`, { method: "HEAD" }).catch(() => { });
}

function loadAndPlay(index: number) {
    const t = state.queue[index];
    if (!t) return;
    history.push(state.index);
    triedTranscode = false;
    set({ index, position: 0, duration: t.duration, loading: true });
    audio.src = t.codec && !NATIVE_CODECS.has(t.codec.toLowerCase()) ? `/media/${t.id}?transcode=1` : `/media/${t.id}`;
    void audio.play();
    updateMediaSession(t);
    prefetchNext(index);
}

function updateMediaSession(t: PlayerTrack) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: t.album,
    });
}
if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => toggle());
    navigator.mediaSession.setActionHandler("pause", () => toggle());
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
}

// --- public API -----------------------------------------------------------------

// Replace the queue with these tracks and start at startIndex.
export function playQueue(tracks: PlayerTrack[], startIndex = 0) {
    if (!tracks.length) return;
    history.length = 0;
    state = { ...state, queue: withUids(tracks) };
    loadAndPlay(Math.max(0, Math.min(startIndex, tracks.length - 1)));
}

// Append; starts playing if nothing is queued.
export function addToQueue(tracks: PlayerTrack[]) {
    if (!tracks.length) return;
    const wasEmpty = state.queue.length === 0;
    state = { ...state, queue: [...state.queue, ...withUids(tracks)] };
    if (wasEmpty) loadAndPlay(0);
    else emit();
}

// Reorder the queue (drag & drop); the now-playing pointer follows its track.
export function moveInQueue(from: number, to: number) {
    const n = state.queue.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const q = [...state.queue];
    const [moved] = q.splice(from, 1);
    q.splice(to, 0, moved);
    let index = state.index;
    if (from === index) index = to;
    else if (from < index && to >= index) index--;
    else if (from > index && to <= index) index++;
    set({ queue: q, index });
}

export function toggle() {
    if (!current()) return;
    if (audio.paused) void audio.play();
    else audio.pause();
}

export function next(fromEnded = false) {
    const n = state.queue.length;
    if (n === 0) return;
    let ni: number;
    if (state.shuffle && n > 1) {
        do { ni = Math.floor(Math.random() * n); } while (ni === state.index);
    } else {
        ni = state.index + 1;
        if (ni >= n) {
            if (state.repeat === "all") ni = 0;
            else { if (fromEnded) set({ playing: false }); return; }
        }
    }
    loadAndPlay(ni);
}

export function prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const last = history.pop();
    const back = last !== undefined && last >= 0 ? last : state.index - 1;
    if (back >= 0 && back < state.queue.length) {
        history.pop(); // loadAndPlay will re-push
        loadAndPlay(back);
    } else {
        audio.currentTime = 0;
    }
}

export function jumpTo(index: number) {
    if (index >= 0 && index < state.queue.length) loadAndPlay(index);
}

export function removeFromQueue(index: number) {
    if (index < 0 || index >= state.queue.length) return;
    const q = state.queue.filter((_, i) => i !== index);
    if (index === state.index) {
        state = { ...state, queue: q };
        if (q.length === 0) { stop(); return; }
        loadAndPlay(Math.min(index, q.length - 1));
    } else {
        set({ queue: q, index: index < state.index ? state.index - 1 : state.index });
    }
}

export function clearQueue() {
    stop();
}

function stop() {
    audio.pause();
    audio.removeAttribute("src");
    history.length = 0;
    set({ queue: [], index: -1, playing: false, loading: false, position: 0, duration: 0 });
}

export function seekTo(seconds: number) {
    if (!current()) return;
    audio.currentTime = Math.max(0, Math.min(seconds, state.duration || audio.duration || 0));
    set({ position: audio.currentTime });
}

export function seekFrac(frac: number) {
    const d = state.duration || audio.duration || 0;
    if (d > 0) seekTo(frac * d);
}

export function setVolume(v: number) {
    const vol = Math.max(0, Math.min(1, v));
    audio.volume = vol;
    localStorage.setItem(VOLUME_KEY, String(vol));
    set({ volume: vol });
}

export function toggleShuffle() {
    set({ shuffle: !state.shuffle });
}

export function cycleRepeat() {
    set({ repeat: state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off" });
}

// Convenience: map a backend LibraryTrack-shaped object to a PlayerTrack.
export function toPlayerTrack(t: { id: number; path: string; title: string; artist: string; album: string; duration: number; codec?: string }): PlayerTrack {
    return { id: t.id, path: t.path, title: t.title, artist: t.artist, album: t.album, duration: t.duration, codec: t.codec };
}
