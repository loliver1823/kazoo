import { useState, useRef, useEffect } from "react";
import { getSettings, getAlbumCategoryLabel } from "@/lib/settings";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { getFirstArtist } from "@/lib/utils";
import { logger } from "@/lib/logger";
import type { TrackMetadata } from "@/types/api";

// Downloads are executed by the backend queue runner. This hook only
// enqueues items (with full metadata) and watches the queue to keep the
// per-component UI state (spinners, checkmarks, batch progress) alive.

const App = () => (window as any)["go"]["main"]["App"];

const CreateM3U8File = (playlistName: string, outputDir: string, filePaths: string[]): Promise<void> => App()["CreateM3U8File"](playlistName, outputDir, filePaths);
const CreateLogFile = (fileName: string, outputDir: string, logs: string[]): Promise<void> => App()["CreateLogFile"](fileName, outputDir, logs);

interface EnqueueMeta {
    id: string;
    trackName?: string;
    artistName?: string;
    albumName?: string;
    spotifyId?: string;
    durationMs?: number;
    position?: number;
    albumArtist?: string;
    releaseDate?: string;
    coverUrl?: string;
    trackNumber?: number;
    discNumber?: number;
    totalTracks?: number;
    totalDiscs?: number;
    copyright?: string;
    publisher?: string;
    albumType?: string;
    upc?: string;
    applyFolder: boolean;
}

async function enqueue(meta: EnqueueMeta): Promise<string> {
    const qobuzDirect = meta.id.startsWith("qobuz_");
    const item: Record<string, unknown> = {
        track_name: meta.trackName || "",
        artist_name: meta.artistName || "",
        album_name: meta.albumName || "",
        spotify_id: qobuzDirect ? "" : (meta.spotifyId || meta.id),
        artists: meta.artistName || "",
        album_artist: meta.albumArtist || "",
        release_date: meta.releaseDate || "",
        cover_url: meta.coverUrl || "",
        duration_ms: meta.durationMs || 0,
        track_no: meta.trackNumber || 0,
        disc_no: meta.discNumber || 0,
        total_tracks: meta.totalTracks || 0,
        total_discs: meta.totalDiscs || 0,
        copyright: meta.copyright || "",
        publisher: meta.publisher || "",
        isrc: qobuzDirect ? meta.id : "",
        category: meta.albumType ? getAlbumCategoryLabel(meta.albumType) : "",
        upc: meta.upc || "",
        position: meta.position || 0,
        service: qobuzDirect ? "qobuz" : "",
        apply_folder: meta.applyFolder,
    };
    return App()["EnqueueDownload"](item);
}

type ItemState = { status: string; file: string; error: string };

export function useDownload() {
    const [downloadProgress, setDownloadProgress] = useState<number>(0);
    const [downloadRemainingCount, setDownloadRemainingCount] = useState<number>(0);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadingTrack, setDownloadingTrack] = useState<string | null>(null);
    const [bulkDownloadType, setBulkDownloadType] = useState<"all" | "selected" | null>(null);
    const [downloadedTracks, setDownloadedTracks] = useState<Set<string>>(new Set());
    const [failedTracks, setFailedTracks] = useState<Set<string>>(new Set());
    const [skippedTracks, setSkippedTracks] = useState<Set<string>>(new Set());
    const [currentDownloadInfo, setCurrentDownloadInfo] = useState<{ name: string; artists: string } | null>(null);

    // itemID -> the caller-facing track key (spotify id / qobuz_ pseudo id).
    const trackedRef = useRef<Map<string, string>>(new Map());
    const notifiedRef = useRef<Set<string>>(new Set());
    const batchRef = useRef<{ folderName?: string; total: number } | null>(null);
    const pollRef = useRef<number | null>(null);

    useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

    const finishBatchExtras = async (states: Map<string, ItemState>) => {
        const batch = batchRef.current;
        batchRef.current = null;
        if (!batch?.folderName) return;
        const settings = getSettings();
        const paths: string[] = [];
        const failures: string[] = [];
        for (const [itemID, key] of trackedRef.current) {
            const st = states.get(itemID);
            if (!st) continue;
            if ((st.status === "completed" || st.status === "skipped") && st.file) paths.push(st.file);
            if (st.status === "failed") failures.push(`${key}: ${st.error || "failed"}`);
        }
        if (settings.createM3u8File && paths.length > 0) {
            try {
                await CreateM3U8File(batch.folderName, settings.downloadPath, paths);
                toast.success("M3U8 playlist created");
            } catch (err) {
                logger.error(`failed to create m3u8 playlist: ${err}`);
            }
        }
        if (settings.exportLogsFile && failures.length > 0) {
            const lines = [`Download Report - ${new Date().toLocaleString()}`, "-".repeat(50), "", ...failures];
            try { await CreateLogFile(batch.folderName, settings.downloadPath, lines); } catch { /* ignore */ }
        }
    };

    const stopPolling = () => {
        if (pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
        }
    };

    const ensurePolling = () => {
        if (pollRef.current) return;
        pollRef.current = window.setInterval(async () => {
            const tracked = trackedRef.current;
            if (tracked.size === 0) { stopPolling(); return; }
            let info: any = null;
            try { info = await App()["GetDownloadQueue"](); } catch { return; }
            const states = new Map<string, ItemState>();
            for (const q of info?.queue || []) {
                if (tracked.has(q.id)) states.set(q.id, { status: q.status, file: q.file_path || "", error: q.error_message || "" });
            }
            let done = 0, failed = 0, skipped = 0, downloading: string | null = null, current: { name: string; artists: string } | null = null;
            const nextDownloaded = new Set<string>(), nextFailed = new Set<string>(), nextSkipped = new Set<string>();
            for (const [itemID, key] of tracked) {
                const st = states.get(itemID);
                if (!st) { skipped++; nextSkipped.add(key); continue; } // removed from queue by the user
                switch (st.status) {
                    case "completed":
                        done++; nextDownloaded.add(key);
                        if (!notifiedRef.current.has(itemID)) notifiedRef.current.add(itemID);
                        break;
                    case "skipped": skipped++; nextSkipped.add(key); nextDownloaded.add(key); break;
                    case "failed": failed++; nextFailed.add(key); break;
                    case "downloading": {
                        downloading = key;
                        const q = (info?.queue || []).find((x: any) => x.id === itemID);
                        if (q) current = { name: q.track_name, artists: q.artist_name };
                        break;
                    }
                }
            }
            setDownloadedTracks(nextDownloaded);
            setFailedTracks(nextFailed);
            setSkippedTracks(nextSkipped);
            setDownloadingTrack(downloading);
            setCurrentDownloadInfo(current);
            const total = tracked.size;
            const terminal = done + failed + skipped;
            setDownloadProgress(total > 0 ? Math.round((terminal / total) * 100) : 0);
            setDownloadRemainingCount(Math.max(0, total - terminal));
            if (terminal >= total) {
                setIsDownloading(false);
                setBulkDownloadType(null);
                setDownloadingTrack(null);
                setCurrentDownloadInfo(null);
                stopPolling();
                if (batchRef.current) {
                    const parts = [];
                    if (done > 0) parts.push(`${done} downloaded`);
                    if (skipped > 0) parts.push(`${skipped} skipped`);
                    if (failed > 0) parts.push(`${failed} failed`);
                    if (failed > 0) toast.warning(parts.join(", "));
                    else if (done > 0) toast.success(parts.join(", "));
                    else if (skipped > 0) toast.info(skipped === 1 ? "1 track already exists" : `${skipped} tracks already exist`);
                    await finishBatchExtras(states);
                }
                trackedRef.current = new Map();
                notifiedRef.current = new Set();
            }
        }, 800);
    };

    const trackMetaToEnqueue = (track: TrackMetadata, position: number, applyFolder: boolean): EnqueueMeta => ({
        id: track.spotify_id || "",
        trackName: track.name,
        artistName: track.artists,
        albumName: track.album_name,
        spotifyId: track.spotify_id,
        durationMs: track.duration_ms,
        position,
        albumArtist: track.album_artist,
        releaseDate: track.release_date,
        coverUrl: track.images,
        trackNumber: track.track_number,
        discNumber: track.disc_number,
        totalTracks: track.total_tracks,
        totalDiscs: track.total_discs,
        copyright: track.copyright,
        publisher: track.publisher,
        albumType: track.album_type,
        upc: track.upc,
        applyFolder,
    });

    const handleDownloadTrack = async (id: string, trackName?: string, artistName?: string, albumName?: string, spotifyId?: string, _playlistName?: string, durationMs?: number, position?: number, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string, albumTypeHint?: string, upcHint?: string) => {
        if (!id) {
            toast.error("No ID found for this track");
            return;
        }
        const settings = getSettings();
        const displayArtist = settings.useFirstArtistOnly && artistName ? getFirstArtist(artistName) : artistName;
        logger.info(`queued download: ${trackName} - ${displayArtist}`);
        try {
            const itemID = await enqueue({
                id, trackName, artistName, albumName, spotifyId, durationMs, position,
                albumArtist, releaseDate, coverUrl,
                trackNumber: spotifyTrackNumber, discNumber: spotifyDiscNumber,
                totalTracks: spotifyTotalTracks, totalDiscs: spotifyTotalDiscs,
                copyright, publisher, albumType: albumTypeHint, upc: upcHint,
                applyFolder: false,
            });
            trackedRef.current.set(itemID, id);
            setIsDownloading(true);
            ensurePolling();
        } catch (err) {
            toast.error(`Failed to queue download: ${err}`);
        }
    };

    const enqueueBatch = async (tracks: TrackMetadata[], folderName?: string, kind: "all" | "selected" = "all") => {
        const withIds = tracks.filter((t) => t.spotify_id);
        if (withIds.length === 0) {
            toast.error("No tracks available for download");
            return;
        }
        logger.info(`queueing batch: ${withIds.length} tracks`);
        setBulkDownloadType(kind);
        setIsDownloading(true);
        setDownloadProgress(0);
        setDownloadRemainingCount(withIds.length);
        batchRef.current = { folderName, total: withIds.length };
        for (let i = 0; i < withIds.length; i++) {
            try {
                const itemID = await enqueue(trackMetaToEnqueue(withIds[i], i + 1, true));
                trackedRef.current.set(itemID, withIds[i].spotify_id || "");
            } catch (err) {
                logger.error(`failed to queue ${withIds[i].name}: ${err}`);
            }
        }
        ensurePolling();
        toast.info(`${withIds.length} track${withIds.length === 1 ? "" : "s"} added to the queue`);
    };

    const handleDownloadAll = async (tracks: TrackMetadata[], folderName?: string, _isAlbum?: boolean) => {
        await enqueueBatch(tracks, folderName, "all");
    };

    const handleDownloadSelected = async (selectedTracks: string[], allTracks: TrackMetadata[], folderName?: string, _isAlbum?: boolean) => {
        if (selectedTracks.length === 0) {
            toast.error("No tracks selected");
            return;
        }
        const chosen = selectedTracks
            .map((id) => allTracks.find((t) => t.spotify_id === id))
            .filter((t): t is TrackMetadata => t !== undefined);
        await enqueueBatch(chosen, folderName, "selected");
    };

    const handleStopDownload = () => {
        logger.info("download stopped by user");
        void (async () => {
            try {
                // Drop this hook's still-queued items, then cancel the active one.
                const info = await App()["GetDownloadQueue"]();
                const mineQueued = (info?.queue || [])
                    .filter((q: any) => trackedRef.current.has(q.id) && q.status === "queued")
                    .map((q: any) => q.id);
                if (mineQueued.length > 0) await App()["RemoveDownloadItems"](mineQueued);
                await App()["ForceStopDownloads"]();
            } catch (err) {
                console.error("Failed to stop downloads:", err);
            }
        })();
        toast.info("Stopping download...");
    };

    const resetDownloadedTracks = () => {
        setDownloadedTracks(new Set());
        setFailedTracks(new Set());
        setSkippedTracks(new Set());
    };

    return {
        downloadProgress,
        downloadRemainingCount,
        isDownloading,
        downloadingTrack,
        bulkDownloadType,
        downloadedTracks,
        failedTracks,
        skippedTracks,
        currentDownloadInfo,
        handleDownloadTrack,
        handleDownloadSelected,
        handleDownloadAll,
        handleStopDownload,
        resetDownloadedTracks,
    };
}
