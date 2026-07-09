import { useState, useEffect, useCallback, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { ArrowUp } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getSettings, getSettingsWithDefaults, loadSettings, saveSettings, applyThemeMode, applyFont } from "@/lib/settings";
import { applyTheme } from "@/lib/themes";
import { OpenFolder, CheckFFmpegInstalled, DownloadFFmpeg, EnsureLibraryFolder, GetLibraryFolders, GetDefaults } from "../wailsjs/go/main/App";
import { EventsOn, EventsOff, Quit } from "../wailsjs/runtime/runtime";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar, type PageType } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { SearchBar, hasCachedSearchResults } from "@/components/SearchBar";
import { TrackInfo } from "@/components/TrackInfo";
import { AlbumInfo } from "@/components/AlbumInfo";
import { PlaylistInfo } from "@/components/PlaylistInfo";
import { ArtistInfo } from "@/components/ArtistInfo";
import { DownloadQueue, QueuePage } from "@/components/DownloadQueue";
import { DownloadProgressToast } from "@/components/DownloadProgressToast";
import { CooldownBanner } from "@/components/CooldownBanner";
import { AudioAnalysisPage } from "@/components/AudioAnalysisPage";
import { AudioConverterPage } from "@/components/AudioConverterPage";
import { AudioResamplerPage } from "@/components/AudioResamplerPage";
import { FileManagerPage } from "@/components/FileManagerPage";
import { LibraryPage } from "@/components/LibraryPage";
import { PlaylistSyncPage } from "@/components/PlaylistSyncPage";
import { LyricsManagerPage } from "@/components/LyricsManagerPage";
import { SettingsPage } from "@/components/SettingsPage";
import { DebugLoggerPage } from "@/components/DebugLoggerPage";
import { PlayerBar } from "@/components/PlayerBar";
import { usePlayer } from "@/lib/player";
import { useDownload } from "@/hooks/useDownload";
import { useMetadata } from "@/hooks/useMetadata";
import { useLyrics } from "@/hooks/useLyrics";
import { useCover } from "@/hooks/useCover";
import { useAvailability } from "@/hooks/useAvailability";
import { ensureApiStatusCheckStarted } from "@/lib/api-status";
import { useDownloadQueueDialog } from "@/hooks/useDownloadQueueDialog";
import { useDownloadProgress } from "@/hooks/useDownloadProgress";
import { buildPlaylistFolderName } from "@/lib/playlist";
function App() {
    const [currentPage, setCurrentPage] = useState<PageType>("library");
    const contentScrollRef = useRef<HTMLDivElement | null>(null);
    const playlistSyncOriginRef = useRef<PageType | null>(null);
    const [spotifyUrl, setSpotifyUrl] = useState("");
    const [selectedTracks, setSelectedTracks] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [sortBy, setSortBy] = useState<string>("default");
    const [currentListPage, setCurrentListPage] = useState(1);
    const [isSearchMode, setIsSearchMode] = useState(false);
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [hasUnsavedSettings, setHasUnsavedSettings] = useState(false);
    const [pendingPageChange, setPendingPageChange] = useState<PageType | null>(null);
    const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] = useState(false);
    const [resetSettingsFn, setResetSettingsFn] = useState<(() => void) | null>(null);
    const ITEMS_PER_PAGE = 50;
    const download = useDownload();
    const metadata = useMetadata();
    const playerState = usePlayer();
    const playerActive = playerState.queue.length > 0;
    const lyrics = useLyrics();
    const cover = useCover();
    const availability = useAvailability();
    const downloadQueue = useDownloadQueueDialog();
    const downloadProgress = useDownloadProgress();
    // Auto-update: startup check against GitHub Releases.
    const [updateInfo, setUpdateInfo] = useState<{ available: boolean; current_version: string; latest_version: string; release_url: string; asset_url: string } | null>(null);
    const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
    useEffect(() => {
        const t = window.setTimeout(async () => {
            try {
                if (getSettings().autoCheckUpdates === false) return;
                const info = await (window as any)["go"]["main"]["App"]["CheckForUpdate"]();
                if (info?.available) setUpdateInfo(info);
            } catch { /* offline or rate-limited — try again next launch */ }
        }, 6000);
        return () => window.clearTimeout(t);
    }, []);
    const applyUpdate = async () => {
        if (!updateInfo?.asset_url || isApplyingUpdate) return;
        setIsApplyingUpdate(true);
        try {
            const message = await (window as any)["go"]["main"]["App"]["ApplyUpdate"](updateInfo.asset_url);
            toast.info(message || "Update ready");
            // On Windows/Linux the app quits itself and relaunches updated.
        } catch (err) {
            toast.error(`Update failed: ${err}`);
            setIsApplyingUpdate(false);
        }
    };
    const [isFFmpegInstalled, setIsFFmpegInstalled] = useState<boolean | null>(null);
    const [isInstallingFFmpeg, setIsInstallingFFmpeg] = useState(false);
    const [ffmpegInstallProgress, setFfmpegInstallProgress] = useState(0);
    const [ffmpegInstallStatus, setFfmpegInstallStatus] = useState("");
    useLayoutEffect(() => {
        const savedSettings = getSettings();
        if (savedSettings) {
            applyThemeMode(savedSettings.themeMode);
            applyTheme(savedSettings.theme);
            applyFont(savedSettings.fontFamily, savedSettings.customFonts);
        }
    }, []);
    useEffect(() => {
        const initSettings = async () => {
            const settings = await loadSettings();
            applyThemeMode(settings.themeMode);
            applyTheme(settings.theme);
            applyFont(settings.fontFamily, settings.customFonts);
            if (!settings.downloadPath) {
                const settingsWithDefaults = await getSettingsWithDefaults();
                await saveSettings(settingsWithDefaults);
            }
            // Downloads and library are one thing. If the user never picked a
            // download location (it's empty or still the system default), it
            // follows the FIRST library folder they added.
            try {
                const norm = (p: string) => (p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
                const folders = (await GetLibraryFolders().catch(() => [])) || [];
                if (folders.length > 0) {
                    const first = [...folders].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))[0];
                    let sysDefault = "";
                    try { sysDefault = ((await GetDefaults()) as any).downloadPath || ""; } catch { /* ignore */ }
                    const cur = getSettings().downloadPath;
                    if ((!cur || norm(cur) === norm(sysDefault)) && norm(cur) !== norm(first.path)) {
                        await saveSettings({ ...getSettings(), downloadPath: first.path });
                    }
                }
            } catch { /* library not ready */ }
            // Wherever downloads land must be part of the library.
            const dl = getSettings().downloadPath;
            if (dl)
                EnsureLibraryFolder(dl).catch(() => { });
        };
        initSettings();
        const checkFFmpeg = async () => {
            try {
                const installed = await CheckFFmpegInstalled();
                setIsFFmpegInstalled(installed);
            }
            catch (err) {
                console.error("Failed to check FFmpeg:", err);
                setIsFFmpegInstalled(false);
            }
        };
        checkFFmpeg();
        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        const handleChange = () => {
            const currentSettings = getSettings();
            if (currentSettings.themeMode === "auto") {
                applyThemeMode("auto");
                applyTheme(currentSettings.theme);
            }
        };
        mediaQuery.addEventListener("change", handleChange);
        ensureApiStatusCheckStarted();
        return () => {
            mediaQuery.removeEventListener("change", handleChange);
        };
    }, []);
    useEffect(() => {
        const contentElement = contentScrollRef.current;
        if (!contentElement) {
            return;
        }
        const handleScroll = () => {
            setShowScrollTop(contentElement.scrollTop > 300);
        };
        handleScroll();
        contentElement.addEventListener("scroll", handleScroll, { passive: true });
        return () => {
            contentElement.removeEventListener("scroll", handleScroll);
        };
    }, []);
    const scrollToTop = useCallback(() => {
        contentScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }, []);
    useEffect(() => {
        contentScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
        setShowScrollTop(false);
    }, [currentPage]);
    useEffect(() => {
        setSelectedTracks([]);
        setSearchQuery("");
        download.resetDownloadedTracks();
        lyrics.resetLyricsState();
        cover.resetCoverState();
        availability.clearAvailability();
        setSortBy("default");
        setCurrentListPage(1);
    }, [metadata.metadata]);
    const handleInstallFFmpeg = async () => {
        setIsInstallingFFmpeg(true);
        setFfmpegInstallProgress(0);
        setFfmpegInstallStatus("starting");
        try {
            EventsOn("ffmpeg:progress", (progress: number) => {
                setFfmpegInstallProgress(progress);
                if (progress >= 100) {
                    setFfmpegInstallStatus("extracting");
                }
                else {
                    setFfmpegInstallStatus("downloading");
                }
            });
            EventsOn("ffmpeg:status", (status: string) => {
                setFfmpegInstallStatus(status);
            });
            const response = await DownloadFFmpeg();
            EventsOff("ffmpeg:progress");
            EventsOff("ffmpeg:status");
            if (response.success) {
                toast.success("FFmpeg installed successfully!");
                setIsFFmpegInstalled(true);
            }
            else {
                toast.error(`Failed to install FFmpeg: ${response.error}`);
            }
        }
        catch (error) {
            console.error("Error installing FFmpeg:", error);
            toast.error(`Error during FFmpeg installation: ${error}`);
        }
        finally {
            setIsInstallingFFmpeg(false);
            setFfmpegInstallProgress(0);
            setFfmpegInstallStatus("");
        }
    };
    const handleFetchMetadata = async () => {
        const updatedUrl = await metadata.handleFetchMetadata(spotifyUrl);
        if (updatedUrl) {
            setSpotifyUrl(updatedUrl);
        }
    };
    // Bridge from other pages (e.g. a "This Is â€¦" playlist on a library
    // artist page): switch to the Download page and fetch the URL.
    useEffect(() => {
        const onFetch = (e: Event) => {
            const url = (e as CustomEvent<string>).detail;
            if (!url) return;
            setCurrentPage("main");
            setIsSearchMode(false);
            setSpotifyUrl(url);
            void metadata.handleFetchMetadata(url);
        };
        window.addEventListener("spindle:fetch-url", onFetch);
        // Remember which page pushed a playlist open so its back button can
        // return there instead of the synced-playlists list.
        const onOpenPlaylistSync = () => {
            setCurrentPage((cur) => {
                if (cur !== "playlist-sync")
                    playlistSyncOriginRef.current = cur;
                return "playlist-sync";
            });
        };
        const onPlaylistSyncBack = () => {
            const origin = playlistSyncOriginRef.current;
            playlistSyncOriginRef.current = null;
            if (origin)
                setCurrentPage(origin);
        };
        const onOpenLibrary = () => setCurrentPage("library");
        window.addEventListener("spindle:open-playlist-sync", onOpenPlaylistSync);
        window.addEventListener("spindle:playlist-sync-back", onPlaylistSyncBack);
        window.addEventListener("spindle:open-library", onOpenLibrary);
        return () => {
            window.removeEventListener("spindle:fetch-url", onFetch);
            window.removeEventListener("spindle:open-playlist-sync", onOpenPlaylistSync);
            window.removeEventListener("spindle:playlist-sync-back", onPlaylistSyncBack);
            window.removeEventListener("spindle:open-library", onOpenLibrary);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const handleSearchChange = (value: string) => {
        setSearchQuery(value);
        setCurrentListPage(1);
    };
    const toggleTrackSelection = (id: string) => {
        setSelectedTracks((prev) => prev.includes(id) ? prev.filter((prevId) => prevId !== id) : [...prev, id]);
    };
    const toggleSelectAll = (tracks: any[]) => {
        const tracksWithId = tracks.filter((track) => track.spotify_id).map((track) => track.spotify_id || "");
        if (tracksWithId.length === 0)
            return;
        const allSelected = tracksWithId.every(id => selectedTracks.includes(id));
        if (allSelected) {
            setSelectedTracks(prev => prev.filter(id => !tracksWithId.includes(id)));
        }
        else {
            setSelectedTracks(prev => Array.from(new Set([...prev, ...tracksWithId])));
        }
    };
    const selectTrackRange = (ids: string[], select: boolean) => {
        const validIds = ids.filter(Boolean);
        if (validIds.length === 0)
            return;
        if (select) {
            setSelectedTracks((prev) => Array.from(new Set([...prev, ...validIds])));
        }
        else {
            const removeSet = new Set(validIds);
            setSelectedTracks((prev) => prev.filter((id) => !removeSet.has(id)));
        }
    };
    const handleOpenFolder = async () => {
        const settings = getSettings();
        if (!settings.downloadPath) {
            toast.error("Download path not set");
            return;
        }
        try {
            await OpenFolder(settings.downloadPath);
        }
        catch (error) {
            console.error("Error opening folder:", error);
            toast.error(`Error opening folder: ${error}`);
        }
    };
    // Back from a fetched item: when the metadata stack empties and there are
    // cached search results, return to them instead of the bare fetch view.
    const handleMetadataBack = () => {
        const landedOn = metadata.goBack();
        if (!landedOn && hasCachedSearchResults()) {
            setIsSearchMode(true);
        }
    };
    const renderMetadata = () => {
        if (!metadata.metadata)
            return null;
        if ("track" in metadata.metadata) {
            const { track } = metadata.metadata;
            const trackId = track.spotify_id || "";
            return (<TrackInfo track={track} isDownloading={download.isDownloading} downloadingTrack={download.downloadingTrack} isDownloaded={download.downloadedTracks.has(trackId)} isFailed={download.failedTracks.has(trackId)} isSkipped={download.skippedTracks.has(trackId)} downloadingLyricsTrack={lyrics.downloadingLyricsTrack} downloadedLyrics={lyrics.downloadedLyrics.has(track.spotify_id || "")} failedLyrics={lyrics.failedLyrics.has(track.spotify_id || "")} skippedLyrics={lyrics.skippedLyrics.has(track.spotify_id || "")} checkingAvailability={availability.checkingTrackId === track.spotify_id} availability={availability.availabilityMap.get(track.spotify_id || "")} downloadingCover={cover.downloadingCoverTrack === (track.spotify_id || `${track.name}-${track.artists}`)} downloadedCover={cover.downloadedCovers.has(track.spotify_id || `${track.name}-${track.artists}`)} failedCover={cover.failedCovers.has(track.spotify_id || `${track.name}-${track.artists}`)} skippedCover={cover.skippedCovers.has(track.spotify_id || `${track.name}-${track.artists}`)} onDownload={download.handleDownloadTrack} onDownloadLyrics={(spotifyId, name, artists, albumName, albumArtist, releaseDate, discNumber) => lyrics.handleDownloadLyrics(spotifyId, name, artists, albumName, undefined, undefined, albumArtist, releaseDate, discNumber)} onDownloadCover={(coverUrl, trackName, artistName, albumName, _playlistName, _position, trackId, albumArtist, releaseDate, discNumber) => cover.handleDownloadCover(coverUrl, trackName, artistName, albumName, undefined, undefined, trackId, albumArtist, releaseDate, discNumber)} onCheckAvailability={availability.checkAvailability} onOpenFolder={handleOpenFolder} onAlbumClick={metadata.handleAlbumClick} onArtistClick={async (artist) => {
                    const artistUrl = await metadata.handleArtistClick(artist);
                    if (artistUrl) {
                        setSpotifyUrl(artistUrl);
                    }
                }} onBack={handleMetadataBack}/>);
        }
        if ("album_info" in metadata.metadata) {
            const { album_info, track_list } = metadata.metadata;
            return (<AlbumInfo albumInfo={album_info} trackList={track_list} searchQuery={searchQuery} sortBy={sortBy} selectedTracks={selectedTracks} downloadedTracks={download.downloadedTracks} failedTracks={download.failedTracks} skippedTracks={download.skippedTracks} downloadingTrack={download.downloadingTrack} isDownloading={download.isDownloading} bulkDownloadType={download.bulkDownloadType} downloadProgress={download.downloadProgress} downloadRemainingCount={download.downloadRemainingCount} currentDownloadInfo={download.currentDownloadInfo} currentPage={currentListPage} itemsPerPage={ITEMS_PER_PAGE} downloadedLyrics={lyrics.downloadedLyrics} failedLyrics={lyrics.failedLyrics} skippedLyrics={lyrics.skippedLyrics} downloadingLyricsTrack={lyrics.downloadingLyricsTrack} checkingAvailabilityTrack={availability.checkingTrackId} availabilityMap={availability.availabilityMap} downloadedCovers={cover.downloadedCovers} failedCovers={cover.failedCovers} skippedCovers={cover.skippedCovers} downloadingCoverTrack={cover.downloadingCoverTrack} isBulkDownloadingCovers={cover.isBulkDownloadingCovers} isBulkDownloadingLyrics={lyrics.isBulkDownloadingLyrics} isMetadataLoading={metadata.loading} onSearchChange={handleSearchChange} onSortChange={setSortBy} onToggleTrack={toggleTrackSelection} onToggleSelectAll={toggleSelectAll} onSelectTrackRange={selectTrackRange} onDownloadTrack={download.handleDownloadTrack} onDownloadLyrics={(spotifyId, name, artists, albumName, _folderName, _isArtistDiscography, position, albumArtist, releaseDate, discNumber) => lyrics.handleDownloadLyrics(spotifyId, name, artists, albumName, album_info.name, position, albumArtist, releaseDate, discNumber, true)} onDownloadCover={(coverUrl, trackName, artistName, albumName, _folderName, _isArtistDiscography, position, trackId, albumArtist, releaseDate, discNumber) => cover.handleDownloadCover(coverUrl, trackName, artistName, albumName, album_info.name, position, trackId, albumArtist, releaseDate, discNumber, true)} onCheckAvailability={availability.checkAvailability} onDownloadAllLyrics={() => lyrics.handleDownloadAllLyrics(track_list, album_info.name, undefined, true)} onDownloadAllCovers={() => cover.handleDownloadAllCovers(track_list, album_info.name, true)} onDownloadAll={() => download.handleDownloadAll(track_list, album_info.name, true)} onDownloadSelected={() => download.handleDownloadSelected(selectedTracks, track_list, album_info.name, true)} onStopDownload={download.handleStopDownload} onOpenFolder={handleOpenFolder} onPageChange={setCurrentListPage} onBack={handleMetadataBack} onArtistClick={async (artist) => {
                    const pendingArtistUrl = artist.external_urls.replace(/\/$/, "") + "/discography/all";
                    setSpotifyUrl(pendingArtistUrl);
                    const artistUrl = await metadata.handleArtistClick(artist);
                    if (artistUrl) {
                        setSpotifyUrl(artistUrl);
                    }
                }} onTrackClick={async (track) => {
                    if (track.external_urls) {
                        setSpotifyUrl(track.external_urls);
                        await metadata.handleFetchMetadata(track.external_urls);
                    }
                }}/>);
        }
        if ("playlist_info" in metadata.metadata) {
            const { playlist_info, track_list } = metadata.metadata;
            const settings = getSettings();
            const playlistFolderName = buildPlaylistFolderName(playlist_info.owner.name, playlist_info.owner.display_name, settings.playlistOwnerFolderName);
            return (<PlaylistInfo playlistInfo={playlist_info} trackList={track_list} searchQuery={searchQuery} sortBy={sortBy} selectedTracks={selectedTracks} downloadedTracks={download.downloadedTracks} failedTracks={download.failedTracks} skippedTracks={download.skippedTracks} downloadingTrack={download.downloadingTrack} isDownloading={download.isDownloading} bulkDownloadType={download.bulkDownloadType} downloadProgress={download.downloadProgress} downloadRemainingCount={download.downloadRemainingCount} currentDownloadInfo={download.currentDownloadInfo} currentPage={currentListPage} itemsPerPage={ITEMS_PER_PAGE} downloadedLyrics={lyrics.downloadedLyrics} failedLyrics={lyrics.failedLyrics} skippedLyrics={lyrics.skippedLyrics} downloadingLyricsTrack={lyrics.downloadingLyricsTrack} checkingAvailabilityTrack={availability.checkingTrackId} availabilityMap={availability.availabilityMap} downloadedCovers={cover.downloadedCovers} failedCovers={cover.failedCovers} skippedCovers={cover.skippedCovers} downloadingCoverTrack={cover.downloadingCoverTrack} isBulkDownloadingCovers={cover.isBulkDownloadingCovers} isBulkDownloadingLyrics={lyrics.isBulkDownloadingLyrics} isMetadataLoading={metadata.loading} onSearchChange={handleSearchChange} onSortChange={setSortBy} onToggleTrack={toggleTrackSelection} onToggleSelectAll={toggleSelectAll} onSelectTrackRange={selectTrackRange} onDownloadTrack={download.handleDownloadTrack} onDownloadLyrics={(spotifyId, name, artists, albumName, _folderName, _isArtistDiscography, position, albumArtist, releaseDate, discNumber) => lyrics.handleDownloadLyrics(spotifyId, name, artists, albumName, playlistFolderName, position, albumArtist, releaseDate, discNumber)} onDownloadCover={(coverUrl, trackName, artistName, albumName, _folderName, _isArtistDiscography, position, trackId, albumArtist, releaseDate, discNumber) => cover.handleDownloadCover(coverUrl, trackName, artistName, albumName, playlistFolderName, position, trackId, albumArtist, releaseDate, discNumber)} onCheckAvailability={availability.checkAvailability} onDownloadAllLyrics={() => lyrics.handleDownloadAllLyrics(track_list, playlistFolderName)} onDownloadAllCovers={() => cover.handleDownloadAllCovers(track_list, playlistFolderName)} onDownloadAll={() => download.handleDownloadAll(track_list, playlistFolderName)} onDownloadSelected={() => download.handleDownloadSelected(selectedTracks, track_list, playlistFolderName)} onStopDownload={download.handleStopDownload} onOpenFolder={handleOpenFolder} onPageChange={setCurrentListPage} onBack={handleMetadataBack} onAlbumClick={metadata.handleAlbumClick} onArtistClick={async (artist) => {
                    const pendingArtistUrl = artist.external_urls.replace(/\/$/, "") + "/discography/all";
                    setSpotifyUrl(pendingArtistUrl);
                    const artistUrl = await metadata.handleArtistClick(artist);
                    if (artistUrl) {
                        setSpotifyUrl(artistUrl);
                    }
                }} onTrackClick={async (track) => {
                    if (track.external_urls) {
                        setSpotifyUrl(track.external_urls);
                        await metadata.handleFetchMetadata(track.external_urls);
                    }
                }}/>);
        }
        if ("artist_info" in metadata.metadata) {
            const { artist_info, album_list, track_list } = metadata.metadata;
            return (<ArtistInfo artistInfo={artist_info} albumList={album_list} trackList={track_list} searchQuery={searchQuery} sortBy={sortBy} selectedTracks={selectedTracks} downloadedTracks={download.downloadedTracks} failedTracks={download.failedTracks} skippedTracks={download.skippedTracks} downloadingTrack={download.downloadingTrack} isDownloading={download.isDownloading} bulkDownloadType={download.bulkDownloadType} downloadProgress={download.downloadProgress} downloadRemainingCount={download.downloadRemainingCount} currentDownloadInfo={download.currentDownloadInfo} currentPage={currentListPage} itemsPerPage={ITEMS_PER_PAGE} downloadedLyrics={lyrics.downloadedLyrics} failedLyrics={lyrics.failedLyrics} skippedLyrics={lyrics.skippedLyrics} downloadingLyricsTrack={lyrics.downloadingLyricsTrack} checkingAvailabilityTrack={availability.checkingTrackId} availabilityMap={availability.availabilityMap} downloadedCovers={cover.downloadedCovers} failedCovers={cover.failedCovers} skippedCovers={cover.skippedCovers} downloadingCoverTrack={cover.downloadingCoverTrack} isBulkDownloadingCovers={cover.isBulkDownloadingCovers} isBulkDownloadingLyrics={lyrics.isBulkDownloadingLyrics} isMetadataLoading={metadata.loading} onSearchChange={handleSearchChange} onSortChange={setSortBy} onToggleTrack={toggleTrackSelection} onToggleSelectAll={toggleSelectAll} onSelectTrackRange={selectTrackRange} onDownloadTrack={download.handleDownloadTrack} onDownloadLyrics={(spotifyId, name, artists, albumName, _folderName, _isArtistDiscography, position, albumArtist, releaseDate, discNumber) => lyrics.handleDownloadLyrics(spotifyId, name, artists, albumName, artist_info.name, position, albumArtist, releaseDate, discNumber)} onDownloadCover={(coverUrl, trackName, artistName, albumName, _folderName, _isArtistDiscography, position, trackId, albumArtist, releaseDate, discNumber) => cover.handleDownloadCover(coverUrl, trackName, artistName, albumName, artist_info.name, position, trackId, albumArtist, releaseDate, discNumber)} onCheckAvailability={availability.checkAvailability} onDownloadAllLyrics={() => lyrics.handleDownloadAllLyrics(track_list, artist_info.name)} onDownloadAllCovers={() => cover.handleDownloadAllCovers(track_list, artist_info.name)} onDownloadAll={() => download.handleDownloadAll(track_list, artist_info.name)} onDownloadSelected={() => download.handleDownloadSelected(selectedTracks, track_list, artist_info.name)} onStopDownload={download.handleStopDownload} onOpenFolder={handleOpenFolder} onAlbumClick={metadata.handleAlbumClick} onBack={handleMetadataBack} onArtistClick={async (artist) => {
                    const pendingArtistUrl = artist.external_urls.replace(/\/$/, "") + "/discography/all";
                    setSpotifyUrl(pendingArtistUrl);
                    const artistUrl = await metadata.handleArtistClick(artist);
                    if (artistUrl) {
                        setSpotifyUrl(artistUrl);
                    }
                }} onPageChange={setCurrentListPage} onTrackClick={async (track) => {
                    if (track.external_urls) {
                        setSpotifyUrl(track.external_urls);
                        await metadata.handleFetchMetadata(track.external_urls);
                    }
                }}/>);
        }
        return null;
    };
    const handlePageChange = (page: PageType) => {
        if (currentPage === "settings" && hasUnsavedSettings && page !== "settings") {
            setPendingPageChange(page);
            setShowUnsavedChangesDialog(true);
            return;
        }
        // Clicking Library while already in it returns to the root view.
        if (page === "library" && currentPage === "library") {
            window.dispatchEvent(new CustomEvent("spindle:library-home"));
            return;
        }
        setCurrentPage(page);
    };
    const handleDiscardChanges = () => {
        setShowUnsavedChangesDialog(false);
        if (resetSettingsFn) {
            resetSettingsFn();
        }
        const savedSettings = getSettings();
        applyThemeMode(savedSettings.themeMode);
        applyTheme(savedSettings.theme);
        applyFont(savedSettings.fontFamily, savedSettings.customFonts);
        if (pendingPageChange) {
            setCurrentPage(pendingPageChange);
            setPendingPageChange(null);
        }
    };
    const handleCancelNavigation = () => {
        setShowUnsavedChangesDialog(false);
        setPendingPageChange(null);
    };
    const renderPage = () => {
        switch (currentPage) {
            case "settings":
                return <SettingsPage onUnsavedChangesChange={setHasUnsavedSettings} onResetRequest={setResetSettingsFn}/>;
            case "debug":
                return <DebugLoggerPage />;
            case "audio-analysis":
                return <AudioAnalysisPage />;
            case "audio-converter":
                return <AudioConverterPage />;
            case "audio-resampler":
                return <AudioResamplerPage />;
            case "file-manager":
                return <FileManagerPage />;
            case "library":
                return <LibraryPage />;
            case "playlist-sync":
                return <PlaylistSyncPage />;
            case "queue":
                return <QueuePage />;
            case "lyrics-manager":
                return <LyricsManagerPage />;
            default:
                return (<>
                    {/* The big brand header only shows while searching/landing —
                        item pages need the vertical space. */}
                    {!(metadata.metadata && !isSearchMode) && <Header />}




                    <SearchBar url={spotifyUrl} loading={metadata.loading} onUrlChange={setSpotifyUrl} onFetch={handleFetchMetadata} onFetchUrl={async (url) => {
                        setSpotifyUrl(url);
                        const updatedUrl = await metadata.handleFetchMetadata(url);
                        if (updatedUrl) {
                            setSpotifyUrl(updatedUrl);
                        }
                    }} hasResult={!!metadata.metadata} searchMode={isSearchMode} onSearchModeChange={setIsSearchMode}/>

                    {!isSearchMode && metadata.metadata && renderMetadata()}
                </>);
        }
    };
    return (<TooltipProvider>
        <div className="h-screen overflow-hidden bg-background">
            <TitleBar />
            <Sidebar currentPage={currentPage} onPageChange={handlePageChange}/>


            <div ref={contentScrollRef} className={`fixed top-10 right-0 left-14 overflow-x-hidden ${playerActive ? "bottom-[88px]" : "bottom-0"} ${currentPage === "library" ? "overflow-y-hidden" : "overflow-y-auto"}`}>
                {currentPage === "library" ? (
                    renderPage()
                ) : (
                    <div className="p-4 md:p-8">
                        <div className="max-w-4xl mx-auto space-y-6">
                            {renderPage()}
                        </div>
                    </div>
                )}
            </div>

            <PlayerBar />

            <DownloadProgressToast onClick={downloadQueue.openQueue}/>

            <CooldownBanner />


            <DownloadQueue isOpen={downloadQueue.isOpen} onClose={downloadQueue.closeQueue}/>


            {showScrollTop && (<Button onClick={scrollToTop} className="fixed bottom-6 right-6 z-50 h-10 w-10 rounded-full shadow-lg" size="icon">
                <ArrowUp className="h-5 w-5"/>
            </Button>)}



            <Dialog open={showUnsavedChangesDialog} onOpenChange={setShowUnsavedChangesDialog}>
                <DialogContent className="sm:max-w-106.25 [&>button]:hidden">
                    <DialogHeader>
                        <DialogTitle>Unsaved Changes</DialogTitle>
                        <DialogDescription>
                            You have unsaved changes in Settings. Are you sure you want to leave? Your changes will be lost.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={handleCancelNavigation}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDiscardChanges}>
                            Discard Changes
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!updateInfo} onOpenChange={(open) => { if (!open && !isApplyingUpdate) setUpdateInfo(null); }}>
                <DialogContent className="sm:max-w-106.25">
                    <DialogHeader>
                        <DialogTitle>Update Available</DialogTitle>
                        <DialogDescription>
                            Spindle v{updateInfo?.latest_version} is out — you're on v{updateInfo?.current_version}.
                            {isApplyingUpdate ? " Downloading the update…" : " Update now? The app restarts by itself."}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" disabled={isApplyingUpdate} onClick={() => setUpdateInfo(null)}>
                            Later
                        </Button>
                        <Button disabled={isApplyingUpdate} onClick={applyUpdate}>
                            {isApplyingUpdate ? "Updating…" : "Update now"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={metadata.showVpnAdviceDialog} onOpenChange={metadata.setShowVpnAdviceDialog}>
                <DialogContent className="max-w-md [&>button]:hidden">
                    <DialogHeader>
                        <DialogTitle>Fetch Failed</DialogTitle>
                        <DialogDescription className="space-y-3">
                            {metadata.fetchFailureReason && (
                                <span className="block rounded-md border border-border bg-muted/50 p-2 font-mono text-xs text-foreground break-words">
                                    {metadata.fetchFailureReason}
                                </span>
                            )}
                            <span className="block">
                                If this looks like a region or network block, a high-quality VPN
                                (Surfshark, ExpressVPN, Proton VPN, â€¦) on a location such as the
                                USA, UK, Germany, Netherlands or Singapore can help â€” otherwise
                                just retry.
                            </span>
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button onClick={() => metadata.setShowVpnAdviceDialog(false)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isFFmpegInstalled === false} onOpenChange={() => { }}>
                <DialogContent className="max-w-112.5 [&>button]:hidden p-6 gap-5">
                    <DialogHeader className="space-y-2">
                        <DialogTitle className="text-lg font-bold tracking-tight">
                            FFmpeg Required
                        </DialogTitle>
                        <DialogDescription className="text-sm text-foreground/70 leading-relaxed font-normal">
                            Spindle checks your system for FFmpeg and FFprobe first.
                            If they are not available, the required binaries will be downloaded from GitHub.
                            This setup downloads about <span className="text-foreground font-semibold">30-40MB</span> of data.
                        </DialogDescription>
                    </DialogHeader>

                    {isInstallingFFmpeg && (<div className="space-y-4">
                            {ffmpegInstallStatus === "extracting" ? (<div className="flex flex-col items-center justify-center py-2 animate-in fade-in duration-500">
                                    <div className="flex items-center gap-3">
                                        <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin"/>
                                        <span className="text-sm font-bold tracking-tight">Extracting...</span>
                                    </div>
                                    <span className="text-[10px] text-muted-foreground uppercase tracking-[0.2em] font-bold mt-2">Finalizing setup</span>
                                </div>) : (<div className="space-y-3">
                                    <div className="flex justify-between text-[11px] font-bold">
                                        <div className="flex flex-col gap-0.5">
                                            <span className="text-muted-foreground uppercase tracking-wider">Downloading...</span>
                                            {downloadProgress.is_downloading && downloadProgress.mb_downloaded > 0 && (<span className="text-primary font-mono tabular-nums">
                                                    {downloadProgress.mb_downloaded.toFixed(1)}MB
                                                    {downloadProgress.speed_mbps > 0 && ` @ ${downloadProgress.speed_mbps.toFixed(1)}MB/s`}
                                                </span>)}
                                        </div>
                                        <span className="text-xl font-bold tracking-tighter text-primary">{ffmpegInstallProgress}%</span>
                                    </div>
                                    <div className="h-1.5 w-full bg-secondary/30 rounded-full overflow-hidden">
                                        <div className="h-full bg-primary transition-all duration-300 shadow-[0_0_10px_rgba(var(--primary),0.3)]" style={{ width: `${ffmpegInstallProgress}%` }}/>
                                    </div>
                                </div>)}
                        </div>)}

                    <DialogFooter className="flex-row gap-3 pt-2">
                        {!isInstallingFFmpeg && (<Button variant="outline" className="flex-1 h-11 text-sm font-bold transition-colors" onClick={() => Quit()}>
                                Exit
                            </Button>)}
                        <Button className={`${isInstallingFFmpeg ? 'w-full' : 'flex-1'} h-11 text-sm font-bold shadow-lg shadow-primary/10`} onClick={handleInstallFFmpeg} disabled={isInstallingFFmpeg}>
                                {isInstallingFFmpeg ? "Installing..." : "Install now"}
                            </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    </TooltipProvider>);
}
export default App;
