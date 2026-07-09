import { useEffect, useRef, useState } from "react";
import { fetchSpotifyMetadata } from "@/lib/api";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { logger } from "@/lib/logger";
import { SearchSpotifyByType } from "../../wailsjs/go/main/App";
import { EventsOff, EventsOn } from "../../wailsjs/runtime/runtime";
import type { SpotifyMetadataResponse } from "@/types/api";
export function useMetadata() {
    const [loading, setLoading] = useState(false);
    const [metadata, setMetadata] = useState<SpotifyMetadataResponse | null>(null);
    const [showVpnAdviceDialog, setShowVpnAdviceDialog] = useState(false);
    const [fetchFailureReason, setFetchFailureReason] = useState("");
    const loadingToastId = useRef<string | number | null>(null);
    const fetchedCount = useRef(0);
    const currentName = useRef("");
    // Back stack: drilling Track → Album → Artist pushes each view so Back
    // returns to the previous one instead of dumping to home.
    const metadataRef = useRef<SpotifyMetadataResponse | null>(null);
    const viewStack = useRef<SpotifyMetadataResponse[]>([]);
    useEffect(() => {
        metadataRef.current = metadata;
    }, [metadata]);
    const pushView = (view: SpotifyMetadataResponse | null) => {
        if (!view) return;
        viewStack.current.push(view);
        if (viewStack.current.length > 20) viewStack.current.shift();
    };
    const showFetchFailureAdvice = (errorMsg: string) => {
        setFetchFailureReason(errorMsg);
        setShowVpnAdviceDialog(true);
    };
    const resolveArtistUrlBySearch = async (artistName: string): Promise<string | null> => {
        const query = artistName.trim();
        if (!query) {
            return null;
        }
        const results = await SearchSpotifyByType({
            query,
            search_type: "artist",
            limit: 1,
            offset: 0,
        });
        return results[0]?.external_urls || null;
    };
    useEffect(() => {
        if (loading) {
            fetchedCount.current = 0;
            currentName.current = "";
            loadingToastId.current = toast.silentInfo("fetching metadata...", {
                duration: Infinity,
                description: "please wait while we retrieve the information"
            });
            return;
        }
        if (loadingToastId.current) {
            toast.dismiss(loadingToastId.current);
            loadingToastId.current = null;
        }
    }, [loading]);
    useEffect(() => {
        const handler = (data: any) => {
            if (!data) {
                return;
            }
            if (Array.isArray(data)) {
                fetchedCount.current += data.length;
                if (loadingToastId.current && currentName.current) {
                    toast.silentInfo(`fetching tracks for ${currentName.current.toLowerCase()}...`, {
                        id: loadingToastId.current,
                        description: `${fetchedCount.current.toLocaleString()} tracks fetched`
                    });
                }
            }
            else {
                const baseInfo = data;
                const name = "artist_info" in baseInfo ? baseInfo.artist_info.name :
                    "album_info" in baseInfo ? baseInfo.album_info.name :
                        "playlist_info" in baseInfo ? (baseInfo.playlist_info.name || baseInfo.playlist_info.owner.name) : "";
                if (name) {
                    currentName.current = name;
                    if (loadingToastId.current) {
                        toast.silentInfo(`fetching tracks for ${name.toLowerCase()}...`, {
                            id: loadingToastId.current,
                            description: `${fetchedCount.current.toLocaleString()} tracks fetched`
                        });
                    }
                }
            }
            setMetadata(prev => {
                if (Array.isArray(data)) {
                    if (!prev || !("track_list" in prev)) {
                        return prev;
                    }
                    return {
                        ...prev,
                        track_list: [...prev.track_list, ...data]
                    };
                }
                if (prev && "track_list" in prev && prev.track_list.length > 0) {
                    return prev;
                }
                const baseInfo = data;
                if (!("track_list" in baseInfo)) {
                    baseInfo.track_list = [];
                }
                return baseInfo;
            });
        };
        EventsOn("metadata-stream", handler);
        return () => EventsOff("metadata-stream");
    }, []);
    const getUrlType = (url: string): string => {
        if (url.includes("/track/"))
            return "track";
        if (url.includes("/album/"))
            return "album";
        if (url.includes("/playlist/"))
            return "playlist";
        if (url.includes("/artist/"))
            return "artist";
        return "unknown";
    };
    const fetchMetadataDirectly = async (url: string) => {
        const urlType = getUrlType(url);
        logger.info(`fetching ${urlType} metadata...`);
        logger.debug(`url: ${url}`);
        const previousView = metadataRef.current;
        setLoading(true);
        // Metadata must be nulled here: streamed track chunks append to whatever
        // view is current, so the old view can't stay up during a streaming fetch.
        setMetadata(null);
        try {
            const startTime = Date.now();
            const timeout = urlType === "artist" ? 60 : 300;
            const data = await fetchSpotifyMetadata(url, true, 1.0, timeout);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            if ("playlist_info" in data) {
                const playlistInfo = data.playlist_info;
                if (!playlistInfo.owner.name && playlistInfo.tracks.total === 0 && data.track_list.length === 0) {
                    logger.warning("playlist appears to be empty or private");
                    toast.error("Playlist not found or may be private");
                    setMetadata(null);
                    return;
                }
            }
            else if ("album_info" in data) {
                const albumInfo = data.album_info;
                if (!albumInfo.name && albumInfo.total_tracks === 0 && data.track_list.length === 0) {
                    logger.warning("album appears to be empty or not found");
                    toast.error("Album not found or may be private");
                    setMetadata(null);
                    return;
                }
            }
            pushView(previousView);
            setMetadata(data);
            if ("track" in data) {
                logger.success(`fetched track: ${data.track.name} - ${data.track.artists}`);
                logger.debug(`duration: ${data.track.duration_ms}ms`);
            }
            else if ("album_info" in data) {
                logger.success(`fetched album: ${data.album_info.name}`);
                logger.debug(`${data.track_list.length} tracks, released: ${data.album_info.release_date}`);
            }
            else if ("playlist_info" in data) {
                logger.success(`fetched playlist: ${data.track_list.length} tracks`);
                logger.debug(`by ${data.playlist_info.owner.display_name || data.playlist_info.owner.name}`);
            }
            else if ("artist_info" in data) {
                logger.success(`fetched artist: ${data.artist_info.name}`);
                logger.debug(`${data.album_list.length} albums, ${data.track_list.length} tracks`);
            }
            logger.info(`fetch completed in ${elapsed}s`);
            toast.success("Metadata fetched successfully");
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Failed to fetch metadata";
            logger.error(`fetch failed: ${errorMsg}`);
            toast.error(errorMsg);
            showFetchFailureAdvice(errorMsg);
        }
        finally {
            setLoading(false);
        }
    };
    const handleFetchMetadata = async (url: string) => {
        if (!url.trim()) {
            logger.warning("empty url provided");
            toast.error("Please enter a Spotify URL");
            return;
        }
        let urlToFetch = url.trim();
        if (urlToFetch.includes("/artist/") && !urlToFetch.includes("/discography")) {
            urlToFetch = urlToFetch.replace(/\/$/, "") + "/discography/all";
            logger.debug("converted to discography url");
        }
        await fetchMetadataDirectly(urlToFetch);
        return urlToFetch;
    };
    const handleAlbumClick = async (album: {
        id: string;
        name: string;
        external_urls: string;
    }) => {
        const albumUrl = album.external_urls;
        if (!albumUrl) {
            toast.error("Album link unavailable");
            return "";
        }
        logger.info(`fetching album: ${album.name}...`);
        logger.debug(`url: ${albumUrl}`);
        setLoading(true);
        // Keep the current view visible while the album loads, then swap to it —
        // nulling metadata here blanks to the home screen and causes a flash.
        try {
            const startTime = Date.now();
            const data = await fetchSpotifyMetadata(albumUrl);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            if ("album_info" in data) {
                const albumInfo = data.album_info;
                if (!albumInfo.name && albumInfo.total_tracks === 0 && data.track_list.length === 0) {
                    logger.warning("album appears to be empty or not found");
                    toast.error("Album not found or may be private");
                    setMetadata(null);
                    return albumUrl;
                }
            }
            pushView(metadataRef.current);
            setMetadata(data);
            if ("album_info" in data) {
                logger.success(`fetched album: ${data.album_info.name}`);
                logger.debug(`${data.track_list.length} tracks, released: ${data.album_info.release_date}`);
            }
            logger.info(`fetch completed in ${elapsed}s`);
            return albumUrl;
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Failed to fetch album metadata";
            logger.error(`fetch failed: ${errorMsg}`);
            toast.error(errorMsg);
            showFetchFailureAdvice(errorMsg);
            return "";
        }
        finally {
            setLoading(false);
        }
    };
    const handleArtistClick = async (artist: {
        id: string;
        name: string;
        external_urls: string;
    }) => {
        logger.debug(`artist clicked: ${artist.name}`);
        const resolvedArtistUrl = artist.external_urls.trim() || (await resolveArtistUrlBySearch(artist.name)) || "";
        if (!resolvedArtistUrl) {
            toast.error(`Artist not found: ${artist.name}`);
            return "";
        }
        const artistUrl = resolvedArtistUrl.includes("/discography")
            ? resolvedArtistUrl
            : resolvedArtistUrl.replace(/\/$/, "") + "/discography/all";
        await fetchMetadataDirectly(artistUrl);
        return resolvedArtistUrl;
    };
    // Pops the previous view off the back stack; lands on home once it's
    // empty. Returns the view landed on (null = back at the search page).
    const goBack = () => {
        const previous = viewStack.current.pop() || null;
        setMetadata(previous);
        return previous;
    };
    return {
        loading,
        metadata,
        showVpnAdviceDialog,
        setShowVpnAdviceDialog,
        fetchFailureReason,
        handleFetchMetadata,
        handleAlbumClick,
        handleArtistClick,
        goBack,
        resetMetadata: () => {
            viewStack.current = [];
            setMetadata(null);
        },
    };
}
