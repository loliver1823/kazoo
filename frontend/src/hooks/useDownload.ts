import { useState, useRef } from "react";
import { downloadTrack, fetchSpotifyMetadata } from "@/lib/api";
import { getSettings, parseTemplate, sanitizeAutoOrder, getEffectiveAlbumFilenameTemplate, templateUsesAlbumTrackNumber, getAlbumCategoryLabel, type TemplateData } from "@/lib/settings";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { joinPath, sanitizePath, getFirstArtist } from "@/lib/utils";
import { logger } from "@/lib/logger";
import type { TrackMetadata } from "@/types/api";
function isCooldownMessage(message?: string): boolean {
    if (!message)
        return false;
    const lower = message.toLowerCase();
    return lower.includes("short break") || lower.includes("scheduled") || lower.includes("cooldown");
}
// While the community servers are on their scheduled break, downloads wait
// instead of failing. Primary signal is the backend's shared cooldown state;
// when that was cleared or never set (some source paths only relay the
// server's message), the wait time is parsed from the error text instead.
async function waitOutCooldown(shouldStop: () => boolean, hint?: string): Promise<void> {
    const { GetDownloadQueue } = await import("../../wailsjs/go/main/App");
    let announced = false;
    let fallbackUntil = 0;
    if (hint && isCooldownMessage(hint)) {
        const mins = hint.match(/(\d+)\s*minute/i);
        const secs = hint.match(/(\d+)\s*second/i);
        const ms = mins ? parseInt(mins[1], 10) * 60000 : secs ? parseInt(secs[1], 10) * 1000 : 5 * 60000;
        fallbackUntil = Date.now() + Math.min(ms + 15000, 90 * 60000);
    }
    for (;;) {
        if (shouldStop())
            return;
        let info: any = null;
        try {
            info = await GetDownloadQueue();
        }
        catch { /* backend briefly unavailable — keep waiting on the fallback clock */ }
        const backendActive = !!info?.cooldown && info.cooldown_secs > 0;
        const paused = !!info?.paused;
        if (paused) {
            // Queue paused by the user — hold here until resumed (or stopped).
            await new Promise((r) => setTimeout(r, 1500));
            continue;
        }
        if (!backendActive && Date.now() >= fallbackUntil)
            return;
        const remainingSecs = backendActive
            ? info.cooldown_secs
            : Math.max(1, Math.ceil((fallbackUntil - Date.now()) / 1000));
        if (!announced) {
            announced = true;
            const mins = Math.max(1, Math.ceil(remainingSecs / 60));
            logger.info(`server on a scheduled break — queue waits ~${mins}m and resumes automatically`);
            toast.info(`Servers on a break — downloads resume automatically in ~${mins}m`);
        }
        await new Promise((r) => setTimeout(r, Math.min(remainingSecs, 20) * 1000));
    }
}
function formatSourceSuffix(response: {
    source_url?: string;
    source_label?: string;
}): string {
    const url = response.source_url?.trim();
    const label = response.source_label?.trim();
    if (label && url)
        return ` [source: ${label} → ${url}]`;
    if (url)
        return ` [source: ${url}]`;
    if (label)
        return ` [source: ${label}]`;
    return "";
}
interface CheckFileExistenceRequest {
    spotify_id: string;
    track_name: string;
    artist_name: string;
    album_name?: string;
    album_artist?: string;
    release_date?: string;
    isrc?: string;
    track_number?: number;
    disc_number?: number;
    position?: number;
    use_album_track_number?: boolean;
    filename_format?: string;
    include_track_number?: boolean;
    audio_format?: string;
    relative_path?: string;
}
interface FileExistenceResult {
    spotify_id: string;
    exists: boolean;
    file_path?: string;
    track_name?: string;
    artist_name?: string;
}
const CheckFilesExistence = (outputDir: string, rootDir: string, tracks: CheckFileExistenceRequest[]): Promise<FileExistenceResult[]> => (window as any)["go"]["main"]["App"]["CheckFilesExistence"](outputDir, rootDir, tracks);
const SkipDownloadItem = (itemID: string, filePath: string): Promise<void> => (window as any)["go"]["main"]["App"]["SkipDownloadItem"](itemID, filePath);
const CreateM3U8File = (playlistName: string, outputDir: string, filePaths: string[]): Promise<void> => (window as any)["go"]["main"]["App"]["CreateM3U8File"](playlistName, outputDir, filePaths);
const CreateLogFile = (fileName: string, outputDir: string, logs: string[]): Promise<void> => (window as any)["go"]["main"]["App"]["CreateLogFile"](fileName, outputDir, logs);
const GetTrackISRC = (spotifyId: string): Promise<string> => (window as any)["go"]["main"]["App"]["GetTrackISRC"](spotifyId);
async function resolveTemplateISRC(settings: {
    folderTemplate?: string;
    filenameTemplate?: string;
    existingFileCheckMode?: string;
}, spotifyId?: string): Promise<string> {
    if (!spotifyId) {
        return "";
    }
    const folderTemplate = settings.folderTemplate || "";
    const filenameTemplate = settings.filenameTemplate || "";
    const shouldResolveISRC = settings.existingFileCheckMode === "isrc" ||
        folderTemplate.includes("{isrc}") ||
        filenameTemplate.includes("{isrc}");
    if (!shouldResolveISRC) {
        return "";
    }
    try {
        return await GetTrackISRC(spotifyId);
    }
    catch {
        return "";
    }
}
// Best-quality formats per service; the backend enforces these regardless,
// with automatic fallback when the top tier isn't available.
const BEST_FORMAT: Record<string, string> = {
    tidal: "HI_RES_LOSSLESS",
    qobuz: "27",
    amazon: "24",
    deezer: "flac",
};
// Singles enqueue instantly (visible queue row) and then download one at a
// time through this shared chain — clicking more tracks while one is
// downloading adds them to the queue instead of being ignored or overlapping.
let singleChain: Promise<unknown> = Promise.resolve();
// Fire-and-forget: fetch lyrics next to a freshly downloaded file when the
// auto-download-lyrics setting is on (default on).
function maybeAutoLyrics(settings: any, filePath?: string, spotifyId?: string, trackName?: string, artistName?: string, albumName?: string) {
    if (settings.autoDownloadLyrics === false || !filePath || !spotifyId)
        return;
    try {
        void (window as any)["go"]["main"]["App"]["DownloadLyricsForFile"](filePath, spotifyId, trackName || "", artistName || "", albumName || "").catch(() => { });
    }
    catch { }
}
export function useDownload() {
    const [downloadProgress, setDownloadProgress] = useState<number>(0);
    const [downloadRemainingCount, setDownloadRemainingCount] = useState<number>(0);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadingTrack, setDownloadingTrack] = useState<string | null>(null);
    const [bulkDownloadType, setBulkDownloadType] = useState<"all" | "selected" | null>(null);
    const [downloadedTracks, setDownloadedTracks] = useState<Set<string>>(new Set());
    const [failedTracks, setFailedTracks] = useState<Set<string>>(new Set());
    const [skippedTracks, setSkippedTracks] = useState<Set<string>>(new Set());
    const [currentDownloadInfo, setCurrentDownloadInfo] = useState<{
        name: string;
        artists: string;
    } | null>(null);
    const shouldStopDownloadRef = useRef(false);
    const updateBatchProgress = (completedCount: number, totalCount: number) => {
        const safeTotalCount = Math.max(0, totalCount);
        const safeCompletedCount = Math.min(Math.max(0, completedCount), safeTotalCount);
        setDownloadProgress(safeTotalCount > 0 ? Math.min(100, Math.round((safeCompletedCount / safeTotalCount) * 100)) : 0);
        setDownloadRemainingCount(Math.max(0, safeTotalCount - safeCompletedCount));
    };
    const downloadWithAutoFallback = async (id: string, settings: any, trackName?: string, artistName?: string, albumName?: string, playlistName?: string, position?: number, spotifyId?: string, durationMs?: number, releaseYear?: string, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string, albumTypeHint?: string, upcHint?: string, preItemID?: string) => {
        // Tracks found via direct Qobuz search carry a "qobuz_<id>" pseudo-id:
        // force the qobuz service and pin the exact Qobuz track.
        const qobuzDirect = id.startsWith("qobuz_") ? id : undefined;
        const service = qobuzDirect ? "qobuz" : settings.downloader;
        const query = trackName && artistName ? `${trackName} ${artistName} ` : undefined;
        const os = settings.operatingSystem;
        const customTidalApi = typeof settings.customTidalApi === "string" && settings.customTidalApi.trim().startsWith("https://")
            ? settings.customTidalApi.trim().replace(/\/+$/g, "")
            : undefined;
        const customQobuzApi = typeof settings.customQobuzApi === "string" && settings.customQobuzApi.trim().startsWith("https://")
            ? settings.customQobuzApi.trim().replace(/\/+$/g, "")
            : undefined;
        let outputDir = settings.downloadPath;
        let useAlbumTrackNumber = false;
        const placeholder = "__SLASH_PLACEHOLDER__";
        let finalReleaseDate = releaseDate;
        let finalTrackNumber = spotifyTrackNumber || 0;
        let finalAlbumType = albumTypeHint || "";
        let finalUPC = upcHint || "";
        // Batch metadata usually arrives complete — only pay the per-track
        // Spotify round-trip when something needed is still missing. Playlist
        // and popular-track downloads often lack album artist / release date /
        // track number; backfilling here is what keeps every download landing
        // in the library's Artist\[year] Album\NN - Title structure.
        if (spotifyId && !(finalReleaseDate && finalTrackNumber > 0 && finalAlbumType && albumArtist)) {
            try {
                const trackURL = `https://open.spotify.com/track/${spotifyId}`;
                const trackMetadata = await fetchSpotifyMetadata(trackURL, false, 0, 10);
                if ("track" in trackMetadata && trackMetadata.track) {
                    if (trackMetadata.track.release_date) {
                        finalReleaseDate = trackMetadata.track.release_date;
                    }
                    if (trackMetadata.track.track_number > 0) {
                        finalTrackNumber = trackMetadata.track.track_number;
                    }
                    if (trackMetadata.track.album_type) {
                        finalAlbumType = trackMetadata.track.album_type;
                    }
                    if (trackMetadata.track.upc) {
                        finalUPC = trackMetadata.track.upc;
                    }
                    if (trackMetadata.track.album_artist && !albumArtist) {
                        albumArtist = trackMetadata.track.album_artist;
                    }
                    if (trackMetadata.track.album_name && !albumName) {
                        albumName = trackMetadata.track.album_name;
                    }
                    if (trackMetadata.track.images && !coverUrl) {
                        coverUrl = trackMetadata.track.images;
                    }
                    if (trackMetadata.track.disc_number && !spotifyDiscNumber) {
                        spotifyDiscNumber = trackMetadata.track.disc_number;
                    }
                    if (trackMetadata.track.total_tracks && !spotifyTotalTracks) {
                        spotifyTotalTracks = trackMetadata.track.total_tracks;
                    }
                    if (trackMetadata.track.total_discs && !spotifyTotalDiscs) {
                        spotifyTotalDiscs = trackMetadata.track.total_discs;
                    }
                }
            }
            catch (err) {
            }
        }
        const yearValue = releaseYear || finalReleaseDate?.substring(0, 4);
        const hasSubfolder = settings.folderTemplate && settings.folderTemplate.trim() !== "" && settings.applyFolderToSingleTrack;
        const trackNumberForTemplate = (hasSubfolder && finalTrackNumber > 0) ? finalTrackNumber : (position || 0);
        if (hasSubfolder) {
            useAlbumTrackNumber = true;
        }
        const displayArtist = settings.useFirstArtistOnly && artistName
            ? getFirstArtist(artistName)
            : artistName;
        const displayAlbumArtist = settings.useFirstArtistOnly && albumArtist
            ? getFirstArtist(albumArtist)
            : albumArtist;
        const resolvedTemplateISRC = qobuzDirect || await resolveTemplateISRC(settings, spotifyId || id);
        const templateData: TemplateData = {
            artist: displayArtist?.replace(/\//g, placeholder),
            artists: artistName?.replace(/\//g, placeholder),
            album: albumName?.replace(/\//g, placeholder),
            album_artist: displayAlbumArtist?.replace(/\//g, placeholder) || displayArtist?.replace(/\//g, placeholder),
            title: trackName?.replace(/\//g, placeholder),
            isrc: resolvedTemplateISRC?.replace(/\//g, placeholder),
            track: trackNumberForTemplate,
            total_tracks: spotifyTotalTracks,
            total_discs: spotifyTotalDiscs,
            year: yearValue,
            date: releaseDate,
            playlist: playlistName?.replace(/\//g, placeholder),
        };
        const folderTemplate = settings.folderTemplate || "";
        const useAlbumSubfolder = folderTemplate.includes("{album}") || folderTemplate.includes("{album_artist}") || folderTemplate.includes("{artist}") || folderTemplate.includes("{playlist}");
        if (settings.createPlaylistFolder && playlistName && !useAlbumSubfolder) {
            outputDir = joinPath(os, outputDir, sanitizePath(playlistName.replace(/\//g, " "), os));
        }
        if (settings.folderTemplate && settings.applyFolderToSingleTrack) {
            const folderPath = parseTemplate(settings.folderTemplate, templateData);
            if (folderPath) {
                const parts = folderPath.split("/").filter((p: string) => p.trim());
                for (const part of parts) {
                    const sanitizedPart = part.replace(new RegExp(placeholder, "g"), " ");
                    outputDir = joinPath(os, outputDir, sanitizePath(sanitizedPart, os));
                }
            }
        }
        const serviceForCheck = service === "auto" ? "flac" : (service === "tidal" ? "flac" : (service === "qobuz" ? "flac" : "flac"));
        let fileExists = false;
        if (trackName && artistName) {
            try {
                const checkRequest: CheckFileExistenceRequest = {
                    spotify_id: spotifyId || id,
                    track_name: trackName,
                    artist_name: displayArtist || "",
                    album_name: albumName,
                    album_artist: displayAlbumArtist,
                    release_date: finalReleaseDate || releaseDate,
                    isrc: resolvedTemplateISRC || undefined,
                    track_number: finalTrackNumber || spotifyTrackNumber || 0,
                    disc_number: spotifyDiscNumber || 0,
                    position: trackNumberForTemplate,
                    use_album_track_number: useAlbumTrackNumber,
                    filename_format: settings.filenameTemplate || "",
                    include_track_number: settings.trackNumber || false,
                    audio_format: serviceForCheck,
                };
                const existenceResults = await CheckFilesExistence(outputDir, settings.downloadPath, [checkRequest]);
                if (existenceResults.length > 0 && existenceResults[0].exists) {
                    fileExists = true;
                    if (preItemID) {
                        try {
                            await SkipDownloadItem(preItemID, existenceResults[0].file_path || "");
                        }
                        catch { }
                    }
                    return {
                        success: true,
                        message: "File already exists",
                        file: existenceResults[0].file_path || "",
                        already_exists: true,
                    };
                }
            }
            catch (err) {
                console.warn("File existence check failed:", err);
            }
        }
        let itemID: string | undefined = preItemID;
        if (!fileExists && !itemID) {
            const { AddToDownloadQueue } = await import("../../wailsjs/go/main/App");
            itemID = await AddToDownloadQueue(id, trackName || "", displayArtist || "", albumName || "");
        }
        // Known server break → the item sits "queued" until it ends.
        await waitOutCooldown(() => shouldStopDownloadRef.current);
        if (service === "auto") {
            const order = sanitizeAutoOrder(settings.autoOrder).split("-");
            // Streaming URLs (songlink) are slow and rate-limited — fetch them
            // lazily, only when a tidal/amazon leg is actually reached. When
            // qobuz succeeds first, the call never happens at all.
            let streamingURLs: any = null;
            let streamingURLsFetched = false;
            const ensureStreamingURLs = async () => {
                if (streamingURLsFetched || !spotifyId)
                    return;
                streamingURLsFetched = true;
                try {
                    const { GetStreamingURLs } = await import("../../wailsjs/go/main/App");
                    const urlsJson = await GetStreamingURLs(spotifyId, "");
                    streamingURLs = JSON.parse(urlsJson);
                }
                catch (err) {
                    console.error("Failed to get streaming URLs:", err);
                }
            };
            const durationSeconds = durationMs ? Math.round(durationMs / 1000) : undefined;
            let lastResponse: any = { success: false, error: "No matching services found" };
            const fallbackErrors: string[] = [];
            // Server-break aware: when every source fails with the shared
            // cooldown, wait it out and re-run the chain instead of failing.
            let cooldownRetries = 6;
            for (;;) {
            for (const s of order) {
                if (s === "tidal") {
                    await ensureStreamingURLs();
                    if (streamingURLs?.tidal_url)
                    try {
                        logger.debug(`trying Tidal for: ${trackName} - ${artistName}`);
                        const response = await downloadTrack({
                            service: "tidal",
                            query,
                            track_name: trackName,
                            artist_name: displayArtist,
                            album_name: albumName,
                            album_artist: displayAlbumArtist,
                            release_date: finalReleaseDate || releaseDate,
                            cover_url: coverUrl,
                            output_dir: outputDir,
                            filename_format: settings.filenameTemplate,
                            artists: artistName,
                            category: getAlbumCategoryLabel(finalAlbumType),
                            upc: finalUPC,
                            track_number: settings.trackNumber,
                            position,
                            use_album_track_number: useAlbumTrackNumber,
                            spotify_id: spotifyId,
                            embed_lyrics: settings.embedLyrics,
                            embed_max_quality_cover: settings.embedMaxQualityCover,
                            service_url: streamingURLs?.tidal_url,
                            duration: durationSeconds,
                            item_id: itemID,
                            audio_format: BEST_FORMAT.tidal,
                            tidal_api_url: customTidalApi,
                            spotify_track_number: spotifyTrackNumber,
                            spotify_disc_number: spotifyDiscNumber,
                            spotify_total_tracks: spotifyTotalTracks,
                            spotify_total_discs: spotifyTotalDiscs,
                            isrc: resolvedTemplateISRC || undefined,
                            copyright: copyright,
                            publisher: publisher,
                            use_first_artist_only: settings.useFirstArtistOnly,
                            use_single_genre: settings.useSingleGenre,
                            embed_genre: settings.embedGenre,
                            save_cover: settings.saveCover,
                        });
                        if (response.success) {
                            logger.success(`Tidal: ${trackName} - ${artistName}${formatSourceSuffix(response)}`);
                            return response;
                        }
                        const errMsg = response.error || response.message || "Failed";
                        fallbackErrors.push(`[Tidal] ${errMsg}`);
                        lastResponse = response;
                        logger.warning(`Tidal failed, trying next...`);
                    }
                    catch (err) {
                        logger.error(`Tidal error: ${err}`);
                        fallbackErrors.push(`[Tidal] ${String(err)}`);
                        lastResponse = { success: false, error: String(err) };
                    }
                }
                else if (s === "amazon") {
                    await ensureStreamingURLs();
                    if (streamingURLs?.amazon_url)
                    try {
                        logger.debug(`trying amazon for: ${trackName} - ${artistName}`);
                        const response = await downloadTrack({
                            service: "amazon",
                            query,
                            track_name: trackName,
                            artist_name: displayArtist,
                            album_name: albumName,
                            album_artist: displayAlbumArtist,
                            release_date: finalReleaseDate || releaseDate,
                            cover_url: coverUrl,
                            output_dir: outputDir,
                            filename_format: settings.filenameTemplate,
                            artists: artistName,
                            category: getAlbumCategoryLabel(finalAlbumType),
                            upc: finalUPC,
                            track_number: settings.trackNumber,
                            position,
                            use_album_track_number: useAlbumTrackNumber,
                            spotify_id: spotifyId,
                            embed_lyrics: settings.embedLyrics,
                            embed_max_quality_cover: settings.embedMaxQualityCover,
                            service_url: streamingURLs.amazon_url,
                            item_id: itemID,
                            audio_format: BEST_FORMAT.amazon,
                            spotify_track_number: spotifyTrackNumber,
                            spotify_disc_number: spotifyDiscNumber,
                            spotify_total_tracks: spotifyTotalTracks,
                            spotify_total_discs: spotifyTotalDiscs,
                            isrc: resolvedTemplateISRC || undefined,
                            copyright: copyright,
                            publisher: publisher,
                            use_single_genre: settings.useSingleGenre,
                            embed_genre: settings.embedGenre,
                            save_cover: settings.saveCover,
                        });
                        if (response.success) {
                            logger.success(`amazon: ${trackName} - ${artistName}${formatSourceSuffix(response)}`);
                            return response;
                        }
                        const errMsg = response.error || response.message || "Failed";
                        fallbackErrors.push(`[Amazon] ${errMsg}`);
                        lastResponse = response;
                        logger.warning(`amazon failed, trying next...`);
                    }
                    catch (err) {
                        logger.error(`amazon error: ${err}`);
                        fallbackErrors.push(`[Amazon] ${String(err)}`);
                        lastResponse = { success: false, error: String(err) };
                    }
                }
                else if (s === "qobuz") {
                    try {
                        logger.debug(`trying qobuz for: ${trackName} - ${artistName}`);
                        const response = await downloadTrack({
                            service: "qobuz",
                            query,
                            track_name: trackName,
                            artist_name: displayArtist,
                            album_name: albumName,
                            album_artist: displayAlbumArtist,
                            release_date: finalReleaseDate || releaseDate,
                            cover_url: coverUrl,
                            output_dir: outputDir,
                            filename_format: settings.filenameTemplate,
                            artists: artistName,
                            category: getAlbumCategoryLabel(finalAlbumType),
                            upc: finalUPC,
                            track_number: settings.trackNumber,
                            position: trackNumberForTemplate,
                            use_album_track_number: useAlbumTrackNumber,
                            spotify_id: spotifyId,
                            embed_lyrics: settings.embedLyrics,
                            embed_max_quality_cover: settings.embedMaxQualityCover,
                            item_id: itemID,
                            audio_format: BEST_FORMAT.qobuz,
                            qobuz_api_url: customQobuzApi,
                            spotify_track_number: spotifyTrackNumber,
                            spotify_disc_number: spotifyDiscNumber,
                            spotify_total_tracks: spotifyTotalTracks,
                            spotify_total_discs: spotifyTotalDiscs,
                            isrc: resolvedTemplateISRC || undefined,
                            copyright: copyright,
                            publisher: publisher,
                            use_single_genre: settings.useSingleGenre,
                            embed_genre: settings.embedGenre,
                            save_cover: settings.saveCover,
                        });
                        if (response.success) {
                            logger.success(`qobuz: ${trackName} - ${artistName}${formatSourceSuffix(response)}`);
                            return response;
                        }
                        const errMsg = response.error || response.message || "Failed";
                        fallbackErrors.push(`[Qobuz] ${errMsg}`);
                        lastResponse = response;
                        logger.warning(`qobuz failed, trying next...`);
                    }
                    catch (err) {
                        logger.error(`qobuz error: ${err}`);
                        fallbackErrors.push(`[Qobuz] ${String(err)}`);
                        lastResponse = { success: false, error: String(err) };
                    }
                }
            }
            if ((fallbackErrors.some((e) => isCooldownMessage(e)) || isCooldownMessage(lastResponse?.error)) && cooldownRetries-- > 0 && !shouldStopDownloadRef.current) {
                await waitOutCooldown(() => shouldStopDownloadRef.current, fallbackErrors.find((e) => isCooldownMessage(e)) || lastResponse?.error);
                if (!shouldStopDownloadRef.current) {
                    fallbackErrors.length = 0;
                    continue;
                }
            }
            break;
            }
            if (itemID) {
                const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
                const finalError = fallbackErrors.length > 0 ? fallbackErrors.join(" | ") : (lastResponse.error || "All services failed");
                await MarkDownloadItemFailed(itemID, finalError);
            }
            return lastResponse;
        }
        const durationSecondsForFallback = durationMs ? Math.round(durationMs / 1000) : undefined;
        const audioFormat: string | undefined = BEST_FORMAT[service];
        logger.debug(`trying ${service} for: ${trackName} - ${artistName}`);
        const singleServiceRequest: any = {
            service: service as "tidal" | "qobuz" | "amazon",
            query,
            track_name: trackName,
            artist_name: displayArtist,
            album_name: albumName,
            album_artist: displayAlbumArtist,
            release_date: finalReleaseDate || releaseDate,
            cover_url: coverUrl,
            output_dir: outputDir,
            filename_format: settings.filenameTemplate,
            artists: artistName,
            category: getAlbumCategoryLabel(finalAlbumType),
            upc: finalUPC,
            track_number: settings.trackNumber,
            position: trackNumberForTemplate,
            use_album_track_number: useAlbumTrackNumber,
            spotify_id: spotifyId,
            embed_lyrics: settings.embedLyrics,
            embed_max_quality_cover: settings.embedMaxQualityCover,
            duration: durationSecondsForFallback,
            item_id: itemID,
            audio_format: audioFormat,
            tidal_api_url: service === "tidal" ? customTidalApi : undefined,
            qobuz_api_url: service === "qobuz" ? customQobuzApi : undefined,
            spotify_track_number: spotifyTrackNumber,
            spotify_disc_number: spotifyDiscNumber,
            spotify_total_tracks: spotifyTotalTracks,
            spotify_total_discs: spotifyTotalDiscs,
            isrc: resolvedTemplateISRC || undefined,
            copyright: copyright,
            publisher: publisher,
            use_first_artist_only: settings.useFirstArtistOnly,
            use_single_genre: settings.useSingleGenre,
            embed_genre: settings.embedGenre,
        };
        let singleServiceResponse = await downloadTrack(singleServiceRequest);
        {
            // Server-break aware: wait out the cooldown and retry rather than
            // failing the queue item.
            let cooldownRetries = 6;
            while (!singleServiceResponse.success && isCooldownMessage(singleServiceResponse.error) && cooldownRetries-- > 0 && !shouldStopDownloadRef.current) {
                await waitOutCooldown(() => shouldStopDownloadRef.current, singleServiceResponse.error);
                if (shouldStopDownloadRef.current)
                    break;
                singleServiceResponse = await downloadTrack(singleServiceRequest);
            }
        }
        if (!singleServiceResponse.success && itemID) {
            const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
            await MarkDownloadItemFailed(itemID, singleServiceResponse.error || "Download failed");
        }
        return singleServiceResponse;
    };
    const downloadWithItemID = async (settings: any, itemID: string, trackName?: string, artistName?: string, albumName?: string, folderName?: string, position?: number, spotifyId?: string, durationMs?: number, isAlbum?: boolean, releaseYear?: string, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string, albumTypeHint?: string, upcHint?: string) => {
        settings = { ...settings, filenameTemplate: getEffectiveAlbumFilenameTemplate(settings) };
        // Known server break → the item sits "queued" until it ends.
        await waitOutCooldown(() => shouldStopDownloadRef.current);
        const service = settings.downloader;
        const query = trackName && artistName ? `${trackName} ${artistName}` : undefined;
        const os = settings.operatingSystem;
        const customTidalApi = typeof settings.customTidalApi === "string" && settings.customTidalApi.trim().startsWith("https://")
            ? settings.customTidalApi.trim().replace(/\/+$/g, "")
            : undefined;
        const customQobuzApi = typeof settings.customQobuzApi === "string" && settings.customQobuzApi.trim().startsWith("https://")
            ? settings.customQobuzApi.trim().replace(/\/+$/g, "")
            : undefined;
        let outputDir = settings.downloadPath;
        let useAlbumTrackNumber = false;
        const placeholder = "__SLASH_PLACEHOLDER__";
        let finalReleaseDate = releaseDate;
        let finalTrackNumber = spotifyTrackNumber || 0;
        let finalAlbumType = albumTypeHint || "";
        let finalUPC = upcHint || "";
        // Batch metadata usually arrives complete — only pay the per-track
        // Spotify round-trip when something needed is still missing. Playlist
        // and popular-track downloads often lack album artist / release date /
        // track number; backfilling here is what keeps every download landing
        // in the library's Artist\[year] Album\NN - Title structure.
        if (spotifyId && !(finalReleaseDate && finalTrackNumber > 0 && finalAlbumType && albumArtist)) {
            try {
                const trackURL = `https://open.spotify.com/track/${spotifyId}`;
                const trackMetadata = await fetchSpotifyMetadata(trackURL, false, 0, 10);
                if ("track" in trackMetadata && trackMetadata.track) {
                    if (trackMetadata.track.release_date) {
                        finalReleaseDate = trackMetadata.track.release_date;
                    }
                    if (trackMetadata.track.track_number > 0) {
                        finalTrackNumber = trackMetadata.track.track_number;
                    }
                    if (trackMetadata.track.album_type) {
                        finalAlbumType = trackMetadata.track.album_type;
                    }
                    if (trackMetadata.track.upc) {
                        finalUPC = trackMetadata.track.upc;
                    }
                    if (trackMetadata.track.album_artist && !albumArtist) {
                        albumArtist = trackMetadata.track.album_artist;
                    }
                    if (trackMetadata.track.album_name && !albumName) {
                        albumName = trackMetadata.track.album_name;
                    }
                    if (trackMetadata.track.images && !coverUrl) {
                        coverUrl = trackMetadata.track.images;
                    }
                    if (trackMetadata.track.disc_number && !spotifyDiscNumber) {
                        spotifyDiscNumber = trackMetadata.track.disc_number;
                    }
                    if (trackMetadata.track.total_tracks && !spotifyTotalTracks) {
                        spotifyTotalTracks = trackMetadata.track.total_tracks;
                    }
                    if (trackMetadata.track.total_discs && !spotifyTotalDiscs) {
                        spotifyTotalDiscs = trackMetadata.track.total_discs;
                    }
                }
            }
            catch (err) {
            }
        }
        const yearValue = releaseYear || finalReleaseDate?.substring(0, 4);
        const hasSubfolder = settings.folderTemplate && settings.folderTemplate.trim() !== "";
        const trackNumberForTemplate = (hasSubfolder && finalTrackNumber > 0) ? finalTrackNumber : (position || 0);
        const displayArtist = settings.useFirstArtistOnly && artistName
            ? getFirstArtist(artistName)
            : artistName;
        const displayAlbumArtist = settings.useFirstArtistOnly && albumArtist
            ? getFirstArtist(albumArtist)
            : albumArtist;
        const resolvedTemplateISRC = await resolveTemplateISRC(settings, spotifyId);
        const templateData: TemplateData = {
            artist: displayArtist?.replace(/\//g, placeholder),
            artists: artistName?.replace(/\//g, placeholder),
            album: albumName?.replace(/\//g, placeholder),
            album_artist: displayAlbumArtist?.replace(/\//g, placeholder) || displayArtist?.replace(/\//g, placeholder),
            title: trackName?.replace(/\//g, placeholder),
            isrc: resolvedTemplateISRC?.replace(/\//g, placeholder),
            track: trackNumberForTemplate,
            total_tracks: spotifyTotalTracks,
            total_discs: spotifyTotalDiscs,
            year: yearValue,
            date: releaseDate,
            playlist: folderName?.replace(/\//g, placeholder),
        };
        const folderTemplate = settings.folderTemplate || "";
        const useAlbumSubfolder = folderTemplate.includes("{album}") || folderTemplate.includes("{album_artist}") || folderTemplate.includes("{artist}") || folderTemplate.includes("{playlist}");
        if (settings.createPlaylistFolder && folderName && !useAlbumSubfolder && !isAlbum) {
            outputDir = joinPath(os, outputDir, sanitizePath(folderName.replace(/\//g, " "), os));
        }
        if (settings.folderTemplate) {
            const folderPath = parseTemplate(settings.folderTemplate, templateData);
            if (folderPath) {
                const parts = folderPath.split("/").filter(p => p.trim());
                for (const part of parts) {
                    const sanitizedPart = part.replace(new RegExp(placeholder, "g"), " ");
                    outputDir = joinPath(os, outputDir, sanitizePath(sanitizedPart, os));
                }
            }
        }
        if (service === "auto") {
            const order = sanitizeAutoOrder(settings.autoOrder).split("-");
            // Streaming URLs (songlink) are slow and rate-limited — fetch them
            // lazily, only when a tidal/amazon leg is actually reached. When
            // qobuz succeeds first, the call never happens at all.
            let streamingURLs: any = null;
            let streamingURLsFetched = false;
            const ensureStreamingURLs = async () => {
                if (streamingURLsFetched || !spotifyId)
                    return;
                streamingURLsFetched = true;
                try {
                    const { GetStreamingURLs } = await import("../../wailsjs/go/main/App");
                    const urlsJson = await GetStreamingURLs(spotifyId, "");
                    streamingURLs = JSON.parse(urlsJson);
                }
                catch (err) {
                    console.error("Failed to get streaming URLs:", err);
                }
            };
            const durationSeconds = durationMs ? Math.round(durationMs / 1000) : undefined;
            let lastResponse: any = { success: false, error: "No matching services found" };
            const fallbackErrors: string[] = [];
            // Server-break aware: when every source fails with the shared
            // cooldown, wait it out and re-run the chain instead of failing.
            let cooldownRetries = 6;
            for (;;) {
            for (const s of order) {
                if (s === "tidal") {
                    await ensureStreamingURLs();
                    if (streamingURLs?.tidal_url)
                    try {
                        logger.debug(`trying Tidal for: ${trackName} - ${artistName}`);
                        const response = await downloadTrack({
                            service: "tidal",
                            query,
                            track_name: trackName,
                            artist_name: displayArtist,
                            album_name: albumName,
                            album_artist: displayAlbumArtist,
                            release_date: finalReleaseDate || releaseDate,
                            cover_url: coverUrl,
                            output_dir: outputDir,
                            filename_format: settings.filenameTemplate,
                            artists: artistName,
                            category: getAlbumCategoryLabel(finalAlbumType),
                            upc: finalUPC,
                            track_number: settings.trackNumber,
                            position,
                            use_album_track_number: useAlbumTrackNumber,
                            spotify_id: spotifyId,
                            embed_lyrics: settings.embedLyrics,
                            embed_max_quality_cover: settings.embedMaxQualityCover,
                            service_url: streamingURLs?.tidal_url,
                            duration: durationSeconds,
                            item_id: itemID,
                            audio_format: BEST_FORMAT.tidal,
                            tidal_api_url: customTidalApi,
                            spotify_track_number: spotifyTrackNumber,
                            spotify_disc_number: spotifyDiscNumber,
                            spotify_total_tracks: spotifyTotalTracks,
                            spotify_total_discs: spotifyTotalDiscs,
                            isrc: resolvedTemplateISRC || undefined,
                            copyright: copyright,
                            publisher: publisher,
                            use_first_artist_only: settings.useFirstArtistOnly,
                            use_single_genre: settings.useSingleGenre,
                            embed_genre: settings.embedGenre,
                            save_cover: settings.saveCover,
                        });
                        if (response.success) {
                            logger.success(`Tidal: ${trackName} - ${artistName}${formatSourceSuffix(response)}`);
                            return response;
                        }
                        const errMsg = response.error || response.message || "Failed";
                        fallbackErrors.push(`[Tidal] ${errMsg}`);
                        lastResponse = response;
                        logger.warning(`Tidal failed, trying next...`);
                    }
                    catch (err) {
                        logger.error(`Tidal error: ${err}`);
                        fallbackErrors.push(`[Tidal] ${String(err)}`);
                        lastResponse = { success: false, error: String(err) };
                    }
                }
                else if (s === "amazon") {
                    await ensureStreamingURLs();
                    if (streamingURLs?.amazon_url)
                    try {
                        logger.debug(`trying amazon for: ${trackName} - ${artistName}`);
                        const response = await downloadTrack({
                            service: "amazon",
                            query,
                            track_name: trackName,
                            artist_name: displayArtist,
                            album_name: albumName,
                            album_artist: displayAlbumArtist,
                            release_date: finalReleaseDate || releaseDate,
                            cover_url: coverUrl,
                            output_dir: outputDir,
                            filename_format: settings.filenameTemplate,
                            artists: artistName,
                            category: getAlbumCategoryLabel(finalAlbumType),
                            upc: finalUPC,
                            track_number: settings.trackNumber,
                            position,
                            use_album_track_number: useAlbumTrackNumber,
                            spotify_id: spotifyId,
                            embed_lyrics: settings.embedLyrics,
                            embed_max_quality_cover: settings.embedMaxQualityCover,
                            service_url: streamingURLs.amazon_url,
                            item_id: itemID,
                            spotify_track_number: spotifyTrackNumber,
                            spotify_disc_number: spotifyDiscNumber,
                            spotify_total_tracks: spotifyTotalTracks,
                            spotify_total_discs: spotifyTotalDiscs,
                            isrc: resolvedTemplateISRC || undefined,
                            copyright: copyright,
                            publisher: publisher,
                            use_first_artist_only: settings.useFirstArtistOnly,
                            use_single_genre: settings.useSingleGenre,
                            embed_genre: settings.embedGenre,
                            save_cover: settings.saveCover,
                        });
                        if (response.success) {
                            logger.success(`amazon: ${trackName} - ${artistName}${formatSourceSuffix(response)}`);
                            return response;
                        }
                        const errMsg = response.error || response.message || "Failed";
                        fallbackErrors.push(`[Amazon] ${errMsg}`);
                        lastResponse = response;
                        logger.warning(`amazon failed, trying next...`);
                    }
                    catch (err) {
                        logger.error(`amazon error: ${err}`);
                        fallbackErrors.push(`[Amazon] ${String(err)}`);
                        lastResponse = { success: false, error: String(err) };
                    }
                }
                else if (s === "qobuz") {
                    try {
                        logger.debug(`trying qobuz for: ${trackName} - ${artistName}`);
                        const response = await downloadTrack({
                            service: "qobuz",
                            query,
                            track_name: trackName,
                            artist_name: displayArtist,
                            album_name: albumName,
                            album_artist: displayAlbumArtist,
                            release_date: finalReleaseDate || releaseDate,
                            cover_url: coverUrl,
                            output_dir: outputDir,
                            filename_format: settings.filenameTemplate,
                            artists: artistName,
                            category: getAlbumCategoryLabel(finalAlbumType),
                            upc: finalUPC,
                            track_number: settings.trackNumber,
                            position: trackNumberForTemplate,
                            use_album_track_number: useAlbumTrackNumber,
                            spotify_id: spotifyId,
                            embed_lyrics: settings.embedLyrics,
                            embed_max_quality_cover: settings.embedMaxQualityCover,
                            duration: durationSeconds,
                            item_id: itemID,
                            audio_format: BEST_FORMAT.qobuz,
                            qobuz_api_url: customQobuzApi,
                            spotify_track_number: spotifyTrackNumber,
                            spotify_disc_number: spotifyDiscNumber,
                            spotify_total_tracks: spotifyTotalTracks,
                            spotify_total_discs: spotifyTotalDiscs,
                            isrc: resolvedTemplateISRC || undefined,
                            copyright: copyright,
                            publisher: publisher,
                            use_first_artist_only: settings.useFirstArtistOnly,
                            use_single_genre: settings.useSingleGenre,
                            embed_genre: settings.embedGenre,
                            save_cover: settings.saveCover,
                        });
                        if (response.success) {
                            logger.success(`qobuz: ${trackName} - ${artistName}${formatSourceSuffix(response)}`);
                            return response;
                        }
                        const errMsg = response.error || response.message || "Failed";
                        fallbackErrors.push(`[Qobuz] ${errMsg}`);
                        lastResponse = response;
                        logger.warning(`qobuz failed, trying next...`);
                    }
                    catch (err) {
                        logger.error(`qobuz error: ${err}`);
                        fallbackErrors.push(`[Qobuz] ${String(err)}`);
                        lastResponse = { success: false, error: String(err) };
                    }
                }
            }
            if ((fallbackErrors.some((e) => isCooldownMessage(e)) || isCooldownMessage(lastResponse?.error)) && cooldownRetries-- > 0 && !shouldStopDownloadRef.current) {
                await waitOutCooldown(() => shouldStopDownloadRef.current, fallbackErrors.find((e) => isCooldownMessage(e)) || lastResponse?.error);
                if (!shouldStopDownloadRef.current) {
                    fallbackErrors.length = 0;
                    continue;
                }
            }
            break;
            }
            if (!lastResponse.success && itemID) {
                const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
                const finalError = fallbackErrors.length > 0 ? fallbackErrors.join(" | ") : (lastResponse.error || "All services failed");
                await MarkDownloadItemFailed(itemID, finalError);
            }
            return lastResponse;
        }
        const durationSecondsForFallback = durationMs ? Math.round(durationMs / 1000) : undefined;
        const audioFormat: string | undefined = BEST_FORMAT[service];
        const singleServiceRequest: any = {
            service: service as "tidal" | "qobuz" | "amazon",
            query,
            track_name: trackName,
            artist_name: displayArtist,
            album_name: albumName,
            album_artist: displayAlbumArtist,
            release_date: finalReleaseDate || releaseDate,
            cover_url: coverUrl,
            output_dir: outputDir,
            filename_format: settings.filenameTemplate,
            artists: artistName,
            category: getAlbumCategoryLabel(finalAlbumType),
            upc: finalUPC,
            track_number: settings.trackNumber,
            position: trackNumberForTemplate,
            use_album_track_number: useAlbumTrackNumber,
            spotify_id: spotifyId,
            embed_lyrics: settings.embedLyrics,
            embed_max_quality_cover: settings.embedMaxQualityCover,
            duration: durationSecondsForFallback,
            item_id: itemID,
            audio_format: audioFormat,
            tidal_api_url: service === "tidal" ? customTidalApi : undefined,
            qobuz_api_url: service === "qobuz" ? customQobuzApi : undefined,
            spotify_track_number: spotifyTrackNumber,
            spotify_disc_number: spotifyDiscNumber,
            spotify_total_tracks: spotifyTotalTracks,
            spotify_total_discs: spotifyTotalDiscs,
            isrc: resolvedTemplateISRC || undefined,
            copyright: copyright,
            publisher: publisher,
            use_first_artist_only: settings.useFirstArtistOnly,
            use_single_genre: settings.useSingleGenre,
            embed_genre: settings.embedGenre,
        };
        let singleServiceResponse = await downloadTrack(singleServiceRequest);
        {
            // Server-break aware: wait out the cooldown and retry rather than
            // failing the queue item.
            let cooldownRetries = 6;
            while (!singleServiceResponse.success && isCooldownMessage(singleServiceResponse.error) && cooldownRetries-- > 0 && !shouldStopDownloadRef.current) {
                await waitOutCooldown(() => shouldStopDownloadRef.current, singleServiceResponse.error);
                if (shouldStopDownloadRef.current)
                    break;
                singleServiceResponse = await downloadTrack(singleServiceRequest);
            }
        }
        if (!singleServiceResponse.success && itemID) {
            const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
            await MarkDownloadItemFailed(itemID, singleServiceResponse.error || "Download failed");
        }
        return singleServiceResponse;
    };
    const handleDownloadTrack = async (id: string, trackName?: string, artistName?: string, albumName?: string, spotifyId?: string, playlistName?: string, durationMs?: number, position?: number, albumArtist?: string, releaseDate?: string, coverUrl?: string, spotifyTrackNumber?: number, spotifyDiscNumber?: number, spotifyTotalTracks?: number, spotifyTotalDiscs?: number, copyright?: string, publisher?: string, albumTypeHint?: string, upcHint?: string) => {
        if (!id) {
            toast.error("No ID found for this track");
            return;
        }
        const settings = getSettings();
        const displayArtist = settings.useFirstArtistOnly && artistName ? getFirstArtist(artistName) : artistName;
        // The queue row appears immediately; the shared chain then downloads
        // singles one at a time, so clicks during an active download enqueue.
        const { AddToDownloadQueue, GetQueueItemStatus } = await import("../../wailsjs/go/main/App");
        const preItemID = await AddToDownloadQueue(id, trackName || "", displayArtist || "", albumName || "");
        const run = async () => {
            // Removed from the queue while waiting → don't download it.
            try {
                const st = await GetQueueItemStatus(preItemID);
                if (st === "")
                    return;
            }
            catch { }
            logger.info(`starting download: ${trackName} - ${displayArtist}`);
            setDownloadingTrack(id);
            try {
                const releaseYear = releaseDate?.substring(0, 4);
                const response = await downloadWithAutoFallback(id, settings, trackName, artistName, albumName, playlistName, position, spotifyId, durationMs, releaseYear, albumArtist || "", releaseDate, coverUrl, spotifyTrackNumber, spotifyDiscNumber, spotifyTotalTracks, spotifyTotalDiscs, copyright, publisher, albumTypeHint, upcHint, preItemID);
                if (response.success) {
                    if (response.already_exists) {
                        toast.info(response.message);
                        setSkippedTracks((prev) => new Set(prev).add(id));
                    }
                    else {
                        toast.success(response.message);
                        maybeAutoLyrics(settings, response.file, spotifyId || id, trackName, displayArtist, albumName);
                    }
                    setDownloadedTracks((prev) => new Set(prev).add(id));
                    setFailedTracks((prev) => {
                        const newSet = new Set(prev);
                        newSet.delete(id);
                        return newSet;
                    });
                }
                else {
                    if (isCooldownMessage(response.error)) {
                        toast.info(response.error || "Servers on a scheduled break, try again shortly");
                    }
                    else {
                        toast.error(response.error || "Download failed");
                    }
                    setFailedTracks((prev) => new Set(prev).add(id));
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : "Download failed";
                if (isCooldownMessage(message)) {
                    toast.info(message);
                }
                else {
                    toast.error(message);
                }
                setFailedTracks((prev) => new Set(prev).add(id));
            }
            finally {
                setDownloadingTrack(null);
            }
        };
        const chained = singleChain.then(run, run);
        singleChain = chained;
        await chained;
    };
    const handleDownloadSelected = async (selectedTracks: string[], allTracks: TrackMetadata[], folderName?: string, isAlbum?: boolean) => {
        if (selectedTracks.length === 0) {
            toast.error("No tracks selected");
            return;
        }
        const run = async () => {
        logger.info(`starting batch download: ${selectedTracks.length} selected tracks`);
        const settings = getSettings();
        setIsDownloading(true);
        setBulkDownloadType("selected");
        setDownloadProgress(0);
        setDownloadRemainingCount(selectedTracks.length);
        setCurrentDownloadInfo(null);
        let outputDir = settings.downloadPath;
        const os = settings.operatingSystem;
        // When the folder template already organizes downloads (artist/album
        // style), never prefix the collection name — doing so nested a second
        // artist folder for artist-page downloads (Artist\Artist\[year] Album).
        const tpl = settings.folderTemplate || "";
        const templateOrganizes = ["{album}", "{album_artist}", "{artist}", "{playlist}"].some((tag) => tpl.includes(tag));
        if (settings.createPlaylistFolder && folderName && !templateOrganizes && !isAlbum) {
            outputDir = joinPath(os, outputDir, sanitizePath(folderName.replace(/\//g, " "), os));
        }
        const selectedTrackObjects = selectedTracks
            .map((id) => allTracks.find((t) => t.spotify_id === id))
            .filter((t): t is TrackMetadata => t !== undefined);
        logger.info(`checking existing files in parallel...`);
        const useAlbumTrackNumber = templateUsesAlbumTrackNumber(settings);
        const albumFilenameTemplate = getEffectiveAlbumFilenameTemplate(settings);
        const audioFormat = "flac";
        const existenceChecks = selectedTrackObjects.map((track, index) => {
            const displayArtist = settings.useFirstArtistOnly && track.artists ? getFirstArtist(track.artists) : track.artists;
            const displayAlbumArtist = settings.useFirstArtistOnly && track.album_artist ? getFirstArtist(track.album_artist) : track.album_artist;
            return {
                spotify_id: track.spotify_id || "",
                track_name: track.name || "",
                artist_name: displayArtist || "",
                artists: track.artists || "",
                album_name: track.album_name || "",
                album_artist: displayAlbumArtist || "",
                category: getAlbumCategoryLabel(track.album_type),
                upc: track.upc || "",
                release_date: track.release_date || "",
                track_number: track.track_number || 0,
                disc_number: track.disc_number || 0,
                total_tracks: track.total_tracks || 0,
                total_discs: track.total_discs || 0,
                position: index + 1,
                use_album_track_number: useAlbumTrackNumber,
                filename_format: albumFilenameTemplate || "",
                include_track_number: settings.trackNumber || false,
                audio_format: audioFormat,
            };
        });
        const existenceResults = await CheckFilesExistence(outputDir, settings.downloadPath, existenceChecks);
        const existingSpotifyIDs = new Set<string>();
        const existingFilePaths = new Map<string, string>();
        const finalFilePaths = new Map<string, string>();
        for (const result of existenceResults) {
            if (result.exists) {
                existingSpotifyIDs.add(result.spotify_id);
                existingFilePaths.set(result.spotify_id, result.file_path || "");
                finalFilePaths.set(result.spotify_id, result.file_path || "");
            }
        }
        logger.info(`found ${existingSpotifyIDs.size} existing files`);
        const { AddToDownloadQueue } = await import("../../wailsjs/go/main/App");
        const itemIDs: string[] = [];
        for (const id of selectedTracks) {
            const track = allTracks.find((t) => t.spotify_id === id);
            if (!track)
                continue;
            const trackID = track.spotify_id || id;
            const displayArtist = settings.useFirstArtistOnly && track.artists ? getFirstArtist(track.artists) : track.artists;
            const itemID = await AddToDownloadQueue(trackID, track.name || "", displayArtist || "", track.album_name || "");
            itemIDs.push(itemID);
            if (existingSpotifyIDs.has(trackID)) {
                const filePath = existingFilePaths.get(trackID) || "";
                setTimeout(() => SkipDownloadItem(itemID, filePath), 10);
                setSkippedTracks((prev) => new Set(prev).add(id));
                setDownloadedTracks((prev) => new Set(prev).add(id));
            }
        }
        const tracksToDownload = selectedTrackObjects.filter((track) => {
            const trackID = track.spotify_id || "";
            return !existingSpotifyIDs.has(trackID);
        });
        let successCount = 0;
        let errorCount = 0;
        let skippedCount = existingSpotifyIDs.size;
        const total = selectedTracks.length;
        const failedErrorMessages = new Map<string, string>();
        updateBatchProgress(skippedCount, total);
        for (let i = 0; i < tracksToDownload.length; i++) {
            if (shouldStopDownloadRef.current) {
                toast.info(`Download stopped. ${successCount} tracks downloaded, ${tracksToDownload.length - i} remaining.`);
                break;
            }
            const track = tracksToDownload[i];
            const id = track.spotify_id || "";
            const originalIndex = selectedTracks.indexOf(id);
            const itemID = itemIDs[originalIndex];
            // Removed from the queue while waiting → don't download it.
            {
                const { GetQueueItemStatus } = await import("../../wailsjs/go/main/App");
                const st = itemID ? await GetQueueItemStatus(itemID) : "queued";
                if (st === "") {
                    skippedCount++;
                    updateBatchProgress(skippedCount + successCount + errorCount, total);
                    continue;
                }
            }
            setDownloadingTrack(id);
            const displayArtist = settings.useFirstArtistOnly && track.artists ? getFirstArtist(track.artists) : track.artists;
            setCurrentDownloadInfo({ name: track.name, artists: displayArtist || "" });
            try {
                const releaseYear = track.release_date?.substring(0, 4);
                const response = await downloadWithItemID(settings, itemID, track.name, track.artists, track.album_name, folderName, originalIndex + 1, track.spotify_id, track.duration_ms, isAlbum, releaseYear, track.album_artist || "", track.release_date, track.images, track.track_number, track.disc_number, track.total_tracks, track.total_discs, track.copyright, track.publisher, track.album_type, track.upc);
                if (response.cancelled || shouldStopDownloadRef.current) {
                    toast.info(`Download stopped. ${successCount} tracks downloaded, ${tracksToDownload.length - i} remaining.`);
                    break;
                }
                if (response.success) {
                    if (response.already_exists) {
                        skippedCount++;
                        logger.info(`skipped: ${track.name} - ${displayArtist} (already exists)`);
                        setSkippedTracks((prev) => new Set(prev).add(id));
                    }
                    else {
                        successCount++;
                        logger.success(`downloaded: ${track.name} - ${displayArtist}${formatSourceSuffix(response)}`);
                        maybeAutoLyrics(settings, response.file, track.spotify_id, track.name, displayArtist, track.album_name);
                    }
                    if (response.file) {
                        finalFilePaths.set(id, response.file);
                        finalFilePaths.set(track.spotify_id || id, response.file);
                    }
                    setDownloadedTracks((prev) => new Set(prev).add(id));
                    setFailedTracks((prev) => {
                        const newSet = new Set(prev);
                        newSet.delete(id);
                        return newSet;
                    });
                }
                else {
                    errorCount++;
                    logger.error(`failed: ${track.name} - ${displayArtist}`);
                    failedErrorMessages.set(id, response.error || "Download failed");
                    setFailedTracks((prev) => new Set(prev).add(id));
                    if (isCooldownMessage(response.error)) {
                        const remaining = tracksToDownload.length - i - 1;
                        toast.info(response.error || "Servers on a scheduled break. Pausing downloads.");
                        logger.info(`cooldown detected, pausing queue with ${remaining} track(s) remaining`);
                        updateBatchProgress(skippedCount + successCount + errorCount, total);
                        break;
                    }
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                errorCount++;
                logger.error(`error: ${track.name} - ${err}`);
                failedErrorMessages.set(id, message);
                setFailedTracks((prev) => new Set(prev).add(id));
                if (itemID) {
                    const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
                    await MarkDownloadItemFailed(itemID, message);
                }
                if (isCooldownMessage(message)) {
                    const remaining = tracksToDownload.length - i - 1;
                    toast.info("Servers on a scheduled break. Pausing downloads.");
                    logger.info(`cooldown detected, pausing queue with ${remaining} track(s) remaining`);
                    updateBatchProgress(skippedCount + successCount + errorCount, total);
                    break;
                }
            }
            const completedCount = skippedCount + successCount + errorCount;
            updateBatchProgress(completedCount, total);
        }
        setDownloadingTrack(null);
        setCurrentDownloadInfo(null);
        setIsDownloading(false);
        setBulkDownloadType(null);
        updateBatchProgress(0, 0);
        // Only sweep leftover queued rows when the user explicitly stopped —
        // a finished batch must not cancel restored/parked items.
        const wasStopped = shouldStopDownloadRef.current;
        shouldStopDownloadRef.current = false;
        if (wasStopped) {
            const { CancelAllQueuedItems } = await import("../../wailsjs/go/main/App");
            await CancelAllQueuedItems();
        }
        if (settings.createM3u8File && folderName) {
            const paths = selectedTrackObjects.map((t) => finalFilePaths.get(t.spotify_id || "") || "").filter((p) => p !== "");
            if (paths.length > 0) {
                try {
                    logger.info(`creating m3u8 playlist: ${folderName}`);
                    await CreateM3U8File(folderName, outputDir, paths);
                    toast.success("M3U8 playlist created");
                }
                catch (err) {
                    logger.error(`failed to create m3u8 playlist: ${err}`);
                    toast.error(`Failed to create M3U8 playlist: ${err}`);
                }
            }
        }
        if (settings.exportLogsFile && folderName) {
            const logsToExport: string[] = [];
            logsToExport.push(`Download Report - ${new Date().toLocaleString()}`);
            logsToExport.push("-".repeat(50));
            logsToExport.push("");
            let failedCount = 0;
            selectedTrackObjects.forEach((t) => {
                const spotifyID = t.spotify_id || "";
                const errorMessage = failedErrorMessages.get(spotifyID);
                const isFailed = !!errorMessage;
                const isSkipped = existingSpotifyIDs.has(spotifyID);
                const isSuccess = !!finalFilePaths.get(spotifyID);
                const displayArtist = settings.useFirstArtistOnly && t.artists ? getFirstArtist(t.artists) : t.artists;
                if (isFailed) {
                    failedCount++;
                    logsToExport.push(`${failedCount}. ${t.name} - ${displayArtist}${t.album_name ? ` (${t.album_name})` : ""}`);
                    logsToExport.push(`   Error: ${errorMessage}`);
                    if (spotifyID) {
                        logsToExport.push(`   ID: ${spotifyID}`);
                        logsToExport.push(`   URL: https://open.spotify.com/track/${spotifyID}`);
                    }
                    logsToExport.push("");
                }
                else if (!settings.exportLogsOnlyFailed) {
                    if (isSkipped) {
                        logsToExport.push(`[SKIPPED] ${t.name} - ${displayArtist}`);
                    }
                    else if (isSuccess) {
                        logsToExport.push(`[SUCCESS] ${t.name} - ${displayArtist}`);
                    }
                }
            });
            if (failedCount > 0) {
                try {
                    logger.info(`creating log file: ${folderName}`);
                    await CreateLogFile(folderName, outputDir, logsToExport);
                    toast.success("Download log created");
                }
                catch (err) {
                    logger.error(`failed to create log file: ${err}`);
                }
            }
        }
        logger.info(`batch complete: ${successCount} downloaded, ${skippedCount} skipped, ${errorCount} failed`);
        if (errorCount === 0 && skippedCount === 0) {
            toast.success(`Downloaded ${successCount} tracks successfully`);
        }
        else if (errorCount === 0 && successCount === 0) {
            toast.info(`${skippedCount} tracks already exist`);
        }
        else if (errorCount === 0) {
            toast.info(`${successCount} downloaded, ${skippedCount} skipped`);
        }
        else {
            const parts = [];
            if (successCount > 0)
                parts.push(`${successCount} downloaded`);
            if (skippedCount > 0)
                parts.push(`${skippedCount} skipped`);
            parts.push(`${errorCount} failed`);
            toast.warning(parts.join(", "));
        }
        };
        // Batches join the same chain as singles: starting another download
        // while one is running enqueues it instead of overlapping.
        const chained = singleChain.then(run, run);
        singleChain = chained;
        await chained;
    };
    const handleDownloadAll = async (tracks: TrackMetadata[], folderName?: string, isAlbum?: boolean) => {
        const tracksWithId = tracks.filter((track) => track.spotify_id);
        if (tracksWithId.length === 0) {
            toast.error("No tracks available for download");
            return;
        }
        const run = async () => {
        logger.info(`starting batch download: ${tracksWithId.length} tracks`);
        const settings = getSettings();
        setIsDownloading(true);
        setBulkDownloadType("all");
        setDownloadProgress(0);
        setDownloadRemainingCount(tracksWithId.length);
        setCurrentDownloadInfo(null);
        let outputDir = settings.downloadPath;
        const os = settings.operatingSystem;
        // When the folder template already organizes downloads (artist/album
        // style), never prefix the collection name — doing so nested a second
        // artist folder for artist-page downloads (Artist\Artist\[year] Album).
        const tpl = settings.folderTemplate || "";
        const templateOrganizes = ["{album}", "{album_artist}", "{artist}", "{playlist}"].some((tag) => tpl.includes(tag));
        if (settings.createPlaylistFolder && folderName && !templateOrganizes && !isAlbum) {
            outputDir = joinPath(os, outputDir, sanitizePath(folderName.replace(/\//g, " "), os));
        }
        logger.info(`checking existing files in parallel...`);
        const useAlbumTrackNumber = templateUsesAlbumTrackNumber(settings);
        const albumFilenameTemplate = getEffectiveAlbumFilenameTemplate(settings);
        const audioFormat = "flac";
        const existenceChecks = tracksWithId.map((track, index) => {
            const displayArtist = settings.useFirstArtistOnly && track.artists ? getFirstArtist(track.artists) : track.artists;
            const displayAlbumArtist = settings.useFirstArtistOnly && track.album_artist ? getFirstArtist(track.album_artist) : track.album_artist;
            return {
                spotify_id: track.spotify_id || "",
                track_name: track.name || "",
                artist_name: displayArtist || "",
                artists: track.artists || "",
                album_name: track.album_name || "",
                album_artist: displayAlbumArtist || "",
                category: getAlbumCategoryLabel(track.album_type),
                upc: track.upc || "",
                release_date: track.release_date || "",
                track_number: track.track_number || 0,
                disc_number: track.disc_number || 0,
                total_tracks: track.total_tracks || 0,
                total_discs: track.total_discs || 0,
                position: index + 1,
                use_album_track_number: useAlbumTrackNumber,
                filename_format: albumFilenameTemplate || "",
                include_track_number: settings.trackNumber || false,
                audio_format: audioFormat,
            };
        });
        const existenceResults = await CheckFilesExistence(outputDir, settings.downloadPath, existenceChecks);
        const finalFilePaths: string[] = new Array(tracksWithId.length).fill("");
        const existingSpotifyIDs = new Set<string>();
        const existingFilePaths = new Map<string, string>();
        for (let i = 0; i < existenceResults.length; i++) {
            const result = existenceResults[i];
            if (result.exists) {
                existingSpotifyIDs.add(result.spotify_id);
                existingFilePaths.set(result.spotify_id, result.file_path || "");
                finalFilePaths[i] = result.file_path || "";
            }
        }
        logger.info(`found ${existingSpotifyIDs.size} existing files`);
        const { AddToDownloadQueue } = await import("../../wailsjs/go/main/App");
        const itemIDs: string[] = [];
        for (const track of tracksWithId) {
            const displayArtist = settings.useFirstArtistOnly && track.artists ? getFirstArtist(track.artists) : track.artists;
            const itemID = await AddToDownloadQueue(track.spotify_id || "", track.name || "", displayArtist || "", track.album_name || "");
            itemIDs.push(itemID);
            const trackID = track.spotify_id || "";
            if (existingSpotifyIDs.has(trackID)) {
                const filePath = existingFilePaths.get(trackID) || "";
                setTimeout(() => SkipDownloadItem(itemID, filePath), 10);
                setSkippedTracks((prev: Set<string>) => new Set(prev).add(trackID));
                setDownloadedTracks((prev: Set<string>) => new Set(prev).add(trackID));
            }
        }
        const tracksToDownload = tracksWithId.filter((track) => {
            const trackID = track.spotify_id || "";
            return !existingSpotifyIDs.has(trackID);
        });
        let successCount = 0;
        let errorCount = 0;
        let skippedCount = existingSpotifyIDs.size;
        const total = tracksWithId.length;
        const failedErrorMessages = new Map<string, string>();
        updateBatchProgress(skippedCount, total);
        for (let i = 0; i < tracksToDownload.length; i++) {
            if (shouldStopDownloadRef.current) {
                toast.info(`Download stopped. ${successCount} tracks downloaded, ${tracksToDownload.length - i} remaining.`);
                break;
            }
            const track = tracksToDownload[i];
            const originalIndex = tracksWithId.findIndex((t) => t.spotify_id === track.spotify_id);
            const itemID = itemIDs[originalIndex];
            const trackId = track.spotify_id || "";
            // Removed from the queue while waiting → don't download it.
            {
                const { GetQueueItemStatus } = await import("../../wailsjs/go/main/App");
                const st = itemID ? await GetQueueItemStatus(itemID) : "queued";
                if (st === "") {
                    skippedCount++;
                    updateBatchProgress(skippedCount + successCount + errorCount, total);
                    continue;
                }
            }
            setDownloadingTrack(trackId);
            const displayArtist = settings.useFirstArtistOnly && track.artists ? getFirstArtist(track.artists) : track.artists;
            setCurrentDownloadInfo({ name: track.name || "", artists: displayArtist || "" });
            try {
                const releaseYear = track.release_date?.substring(0, 4);
                const response = await downloadWithItemID(settings, itemID, track.name, track.artists, track.album_name, folderName, originalIndex + 1, track.spotify_id, track.duration_ms, isAlbum, releaseYear, track.album_artist || "", track.release_date, track.images, track.track_number, track.disc_number, track.total_tracks, track.total_discs, track.copyright, track.publisher, track.album_type, track.upc);
                if (response.cancelled || shouldStopDownloadRef.current) {
                    toast.info(`Download stopped. ${successCount} tracks downloaded, ${tracksToDownload.length - i} remaining.`);
                    break;
                }
                if (response.success) {
                    if (response.already_exists) {
                        skippedCount++;
                        logger.info(`skipped: ${track.name} - ${displayArtist} (already exists)`);
                        setSkippedTracks((prev) => new Set(prev).add(trackId));
                    }
                    else {
                        successCount++;
                        logger.success(`downloaded: ${track.name} - ${displayArtist}${formatSourceSuffix(response)}`);
                        maybeAutoLyrics(settings, response.file, track.spotify_id, track.name, displayArtist, track.album_name);
                    }
                    setDownloadedTracks((prev) => new Set(prev).add(trackId));
                    setFailedTracks((prev) => {
                        const newSet = new Set(prev);
                        newSet.delete(trackId);
                        return newSet;
                    });
                    if (response.file) {
                        finalFilePaths[originalIndex] = response.file;
                    }
                }
                else {
                    errorCount++;
                    logger.error(`failed: ${track.name} - ${displayArtist}`);
                    failedErrorMessages.set(trackId, response.error || "Download failed");
                    setFailedTracks((prev) => new Set(prev).add(trackId));
                    if (isCooldownMessage(response.error)) {
                        const remaining = tracksToDownload.length - i - 1;
                        toast.info(response.error || "Servers on a scheduled break. Pausing downloads.");
                        logger.info(`cooldown detected, pausing queue with ${remaining} track(s) remaining`);
                        updateBatchProgress(skippedCount + successCount + errorCount, total);
                        break;
                    }
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                errorCount++;
                logger.error(`error: ${track.name} - ${err}`);
                failedErrorMessages.set(trackId, message);
                setFailedTracks((prev) => new Set(prev).add(trackId));
                const { MarkDownloadItemFailed } = await import("../../wailsjs/go/main/App");
                await MarkDownloadItemFailed(itemID, message);
                if (isCooldownMessage(message)) {
                    const remaining = tracksToDownload.length - i - 1;
                    toast.info("Servers on a scheduled break. Pausing downloads.");
                    logger.info(`cooldown detected, pausing queue with ${remaining} track(s) remaining`);
                    updateBatchProgress(skippedCount + successCount + errorCount, total);
                    break;
                }
            }
            const completedCount = skippedCount + successCount + errorCount;
            updateBatchProgress(completedCount, total);
        }
        setDownloadingTrack(null);
        setCurrentDownloadInfo(null);
        setIsDownloading(false);
        setBulkDownloadType(null);
        updateBatchProgress(0, 0);
        const wasStoppedHere = shouldStopDownloadRef.current;
        shouldStopDownloadRef.current = false;
        if (wasStoppedHere) {
            const { CancelAllQueuedItems: CancelQueued } = await import("../../wailsjs/go/main/App");
            await CancelQueued();
        }
        if (settings.createM3u8File && folderName) {
            try {
                logger.info(`creating m3u8 playlist: ${folderName}`);
                await CreateM3U8File(folderName, outputDir, finalFilePaths.filter(p => p !== ""));
                toast.success("M3U8 playlist created");
            }
            catch (err) {
                logger.error(`failed to create m3u8 playlist: ${err}`);
                toast.error(`Failed to create M3U8 playlist: ${err}`);
            }
        }
        if (settings.exportLogsFile && folderName) {
            const logsToExport: string[] = [];
            logsToExport.push(`Download Report - ${new Date().toLocaleString()}`);
            logsToExport.push("-".repeat(50));
            logsToExport.push("");
            let failedCount = 0;
            tracksWithId.forEach((t, idx) => {
                const spotifyID = t.spotify_id || "";
                const errorMessage = failedErrorMessages.get(spotifyID);
                const isFailed = !!errorMessage;
                const isSkipped = existingSpotifyIDs.has(spotifyID);
                const isSuccess = !!finalFilePaths[idx];
                const displayArtist = settings.useFirstArtistOnly && t.artists ? getFirstArtist(t.artists) : t.artists;
                if (isFailed) {
                    failedCount++;
                    logsToExport.push(`${failedCount}. ${t.name} - ${displayArtist}${t.album_name ? ` (${t.album_name})` : ""}`);
                    logsToExport.push(`   Error: ${errorMessage}`);
                    if (spotifyID) {
                        logsToExport.push(`   ID: ${spotifyID}`);
                        logsToExport.push(`   URL: https://open.spotify.com/track/${spotifyID}`);
                    }
                    logsToExport.push("");
                }
                else if (!settings.exportLogsOnlyFailed) {
                    if (isSkipped) {
                        logsToExport.push(`[SKIPPED] ${t.name} - ${displayArtist}`);
                    }
                    else if (isSuccess) {
                        logsToExport.push(`[SUCCESS] ${t.name} - ${displayArtist}`);
                    }
                }
            });
            if (failedCount > 0) {
                try {
                    logger.info(`creating log file: ${folderName}`);
                    await CreateLogFile(folderName, outputDir, logsToExport);
                    toast.success("Download log created");
                }
                catch (err) {
                    logger.error(`failed to create log file: ${err}`);
                }
            }
        }
        logger.info(`batch complete: ${successCount} downloaded, ${skippedCount} skipped, ${errorCount} failed`);
        if (errorCount === 0 && skippedCount === 0) {
            toast.success(`Downloaded ${successCount} tracks successfully`);
        }
        else if (errorCount === 0 && successCount === 0) {
            toast.info(`${skippedCount} tracks already exist`);
        }
        else if (errorCount === 0) {
            toast.info(`${successCount} downloaded, ${skippedCount} skipped`);
        }
        else {
            const parts = [];
            if (successCount > 0)
                parts.push(`${successCount} downloaded`);
            if (skippedCount > 0)
                parts.push(`${skippedCount} skipped`);
            parts.push(`${errorCount} failed`);
            toast.warning(parts.join(", "));
        }
        };
        // Batches join the same chain as singles: starting another download
        // while one is running enqueues it instead of overlapping.
        const chained = singleChain.then(run, run);
        singleChain = chained;
        await chained;
    };
    const handleStopDownload = () => {
        logger.info("download stopped by user");
        shouldStopDownloadRef.current = true;
        void (async () => {
            try {
                const { ForceStopDownloads } = await import("../../wailsjs/go/main/App");
                await ForceStopDownloads();
            }
            catch (err) {
                console.error("Failed to force stop downloads:", err);
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
