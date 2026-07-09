import { useSyncExternalStore } from "react";
import { GetBestTrackQualities, GetBestAlbumQualitiesByID } from "../../wailsjs/go/main/App";
import { backend } from "../../wailsjs/go/models";

// Auto-probing, cached store for per-track "best available" source quality.
// Components call ensureQualities() for what they render; requests are de-duped,
// batched, and resolved in chunks so badges fill in progressively.

const cache = new Map<string, backend.TrackQuality>();
const listeners = new Set<() => void>();
const pending = new Map<string, string>(); // spotifyId -> isrc
const inflight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function emit() { listeners.forEach((l) => l()); }

export function ensureQualities(items: { spotifyId?: string; isrc?: string }[]): void {
    let added = false;
    for (const it of items) {
        const id = (it.spotifyId || "").trim();
        if (!id || cache.has(id) || inflight.has(id) || pending.has(id)) continue;
        pending.set(id, (it.isrc || "").trim());
        added = true;
    }
    if (added && !timer) timer = setTimeout(flush, 200);
}

async function flush(): Promise<void> {
    timer = null;
    const all = [...pending.entries()].map(([spotifyId, isrc]) => ({ spotifyId, isrc }));
    pending.clear();
    all.forEach((r) => inflight.add(r.spotifyId));
    const CHUNK = 20;
    for (let i = 0; i < all.length; i += CHUNK) {
        const chunk = all.slice(i, i + CHUNK);
        try {
            const res = await GetBestTrackQualities(chunk as backend.QualityRequest[]);
            for (const r of chunk) {
                const q = res?.[r.spotifyId];
                if (q) cache.set(r.spotifyId, q);
                inflight.delete(r.spotifyId);
            }
            emit();
        } catch {
            chunk.forEach((r) => inflight.delete(r.spotifyId));
        }
    }
    if (pending.size > 0 && !timer) timer = setTimeout(flush, 50);
}

export function useTrackQuality(spotifyId?: string): backend.TrackQuality | undefined {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        () => (spotifyId ? cache.get(spotifyId) : undefined),
        () => (spotifyId ? cache.get(spotifyId) : undefined),
    );
}

// --- Album-level quality (discography cards, where per-track data isn't loaded) ---

const albumCache = new Map<string, backend.TrackQuality>();
const albumPending = new Set<string>(); // spotify album ids
const albumInflight = new Set<string>();
let albumTimer: ReturnType<typeof setTimeout> | null = null;

export function ensureAlbumQualities(albumIds: (string | undefined)[]): void {
    let added = false;
    for (const raw of albumIds) {
        const id = (raw || "").trim();
        if (!id || albumCache.has(id) || albumInflight.has(id) || albumPending.has(id)) continue;
        albumPending.add(id);
        added = true;
    }
    if (added && !albumTimer) albumTimer = setTimeout(flushAlbums, 200);
}

async function flushAlbums(): Promise<void> {
    albumTimer = null;
    const all = [...albumPending];
    albumPending.clear();
    all.forEach((id) => albumInflight.add(id));
    const CHUNK = 8;
    for (let i = 0; i < all.length; i += CHUNK) {
        const chunk = all.slice(i, i + CHUNK);
        try {
            const res = await GetBestAlbumQualitiesByID(chunk);
            for (const id of chunk) {
                const q = res?.[id];
                if (q) albumCache.set(id, q);
                albumInflight.delete(id);
            }
            emit();
        } catch {
            chunk.forEach((id) => albumInflight.delete(id));
        }
    }
    if (albumPending.size > 0 && !albumTimer) albumTimer = setTimeout(flushAlbums, 50);
}

export function useAlbumQuality(key?: string): backend.TrackQuality | undefined {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        () => (key ? albumCache.get(key) : undefined),
        () => (key ? albumCache.get(key) : undefined),
    );
}
