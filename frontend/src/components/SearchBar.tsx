import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputWithContext } from "@/components/ui/input-with-context";
import { CloudDownload, XCircle, Link, Search, ChevronDown, ArrowUpDown, Check, } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { SearchSpotify, SearchSpotifyByType, SearchSpotifyProfiles, GetUserPlaylists, SearchQobuzTracks } from "../../wailsjs/go/main/App";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";
import { useDownload } from "@/hooks/useDownload";
import { openSpotifyPlaylistView } from "@/components/PlaylistSyncPage";
import { backend } from "../../wailsjs/go/models";
import { cn } from "@/lib/utils";
import { useHideClean, excludeCleanVariants } from "@/lib/clean";
import { QualityBadge } from "@/components/QualityBadge";
import { useTypingEffect } from "@/hooks/useTypingEffect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
const FETCH_PLACEHOLDERS = [
    "https://open.spotify.com/track/...",
    "https://open.spotify.com/album/...",
    "https://open.spotify.com/playlist/...",
    "https://open.spotify.com/artist/...",
];
const SEARCH_PLACEHOLDERS = [
    "Golden",
    "Taylor Swift",
    "The Weeknd",
    "Starboy",
    "Joji",
    "Die For You",
];
type ResultTab = "tracks" | "albums" | "artists" | "playlists" | "profiles" | "podcasts" | "audiobooks";
const SEARCH_LIMIT = 50;
interface SearchBarProps {
    url: string;
    loading: boolean;
    onUrlChange: (url: string) => void;
    onFetch: () => void;
    onFetchUrl: (url: string) => Promise<void>;
    hasResult: boolean;
    searchMode: boolean;
    onSearchModeChange: (isSearch: boolean) => void;
}

type SearchSource = "spotify" | "qobuz";

// Search state survives page switches (e.g. opening a playlist and coming
// back) — the component unmounts, so results are cached at module level.
let searchCache: {
    query: string;
    lastSearchedQuery: string;
    results: backend.SearchResponse | null;
    profiles: backend.SpotifyProfile[];
    profileView: { profile: backend.SpotifyProfile; items: backend.ProfilePlaylist[] | null } | null;
    activeTab: ResultTab;
    hasMore: Record<ResultTab, boolean>;
    source: SearchSource;
    qobuzTracks: backend.QobuzSearchTrack[];
} | null = null;

// True when there are cached search results to return to — used by the
// back button on fetched items to land on the results instead of fetch mode.
export function hasCachedSearchResults(): boolean {
    if (!searchCache)
        return false;
    const r = searchCache.results;
    return !!(r && (r.tracks?.length || r.albums?.length || r.artists?.length || r.playlists?.length))
        || searchCache.profiles.length > 0
        || searchCache.qobuzTracks.length > 0;
}

export function SearchBar({ url, loading, onUrlChange, onFetch, onFetchUrl, searchMode, onSearchModeChange, }: SearchBarProps) {
    const [searchQuery, setSearchQuery] = useState(searchCache?.query ?? "");
    const [searchResults, setSearchResults] = useState<backend.SearchResponse | null>(searchCache?.results ?? null);
    const [resultFilter, setResultFilter] = useState("");
    const [sortOrders, setSortOrders] = useState<Record<ResultTab, string>>({
        tracks: "default",
        albums: "default",
        artists: "default",
        playlists: "default",
        profiles: "default",
        podcasts: "default",
        audiobooks: "default",
    });
    const [profiles, setProfiles] = useState<backend.SpotifyProfile[]>(searchCache?.profiles ?? []);
    const [profileView, setProfileView] = useState<{ profile: backend.SpotifyProfile; items: backend.ProfilePlaylist[] | null } | null>(searchCache?.profileView ?? null);
    const profileQueryRef = useRef("");
    const [isSearching, setIsSearching] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [lastSearchedQuery, setLastSearchedQuery] = useState(searchCache?.lastSearchedQuery ?? "");
    const [activeTab, setActiveTab] = useState<ResultTab>(searchCache?.activeTab ?? "tracks");
    const [hasMore, setHasMore] = useState<Record<ResultTab, boolean>>(searchCache?.hasMore ?? {
        tracks: false,
        albums: false,
        artists: false,
        playlists: false,
        profiles: false,
        podcasts: false,
        audiobooks: false,
    });
    const [searchSource, setSearchSource] = useState<SearchSource>(searchCache?.source ?? "spotify");
    const [qobuzTracks, setQobuzTracks] = useState<backend.QobuzSearchTrack[]>(searchCache?.qobuzTracks ?? []);
    const [qobuzSort, setQobuzSort] = useState("default");
    const { handleDownloadTrack, downloadingTrack, downloadedTracks } = useDownload();
    const qobuzDisplayed = useMemo(() => {
        let list = [...qobuzTracks];
        const f = resultFilter.toLowerCase();
        if (f) {
            list = list.filter((t) => t.title.toLowerCase().includes(f)
                || (t.artist || "").toLowerCase().includes(f)
                || (t.album || "").toLowerCase().includes(f));
        }
        const q = (t: backend.QobuzSearchTrack) => t.bitDepth * 1000000 + t.sampleRate;
        switch (qobuzSort) {
            case "title-asc": list.sort((a, b) => a.title.localeCompare(b.title)); break;
            case "title-desc": list.sort((a, b) => b.title.localeCompare(a.title)); break;
            case "artist-asc": list.sort((a, b) => (a.artist || "").localeCompare(b.artist || "")); break;
            case "artist-desc": list.sort((a, b) => (b.artist || "").localeCompare(a.artist || "")); break;
            case "year-desc": list.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "")); break;
            case "year-asc": list.sort((a, b) => (a.releaseDate || "").localeCompare(b.releaseDate || "")); break;
            case "duration-desc": list.sort((a, b) => b.durationMs - a.durationMs); break;
            case "duration-asc": list.sort((a, b) => a.durationMs - b.durationMs); break;
            case "quality-desc": list.sort((a, b) => q(b) - q(a)); break;
        }
        return list;
    }, [qobuzTracks, resultFilter, qobuzSort]);
    useEffect(() => {
        searchCache = { query: searchQuery, lastSearchedQuery, results: searchResults, profiles, profileView, activeTab, hasMore, source: searchSource, qobuzTracks };
    }, [searchQuery, lastSearchedQuery, searchResults, profiles, profileView, activeTab, hasMore, searchSource, qobuzTracks]);
    const [showInvalidUrlDialog, setShowInvalidUrlDialog] = useState(false);
    const [invalidUrl, setInvalidUrl] = useState("");
    const hideClean = useHideClean();
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const placeholders = searchMode ? SEARCH_PLACEHOLDERS : FETCH_PLACEHOLDERS;
    const placeholderText = useTypingEffect(placeholders);
    useEffect(() => {
        if (!searchMode || !searchQuery.trim()) {
            return;
        }
        if (searchQuery.trim() === lastSearchedQuery) {
            return;
        }
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }
        searchTimeoutRef.current = setTimeout(async () => {
            setIsSearching(true);
            if (searchSource === "qobuz") {
                try {
                    const r = await SearchQobuzTracks(searchQuery);
                    setQobuzTracks(r || []);
                    setLastSearchedQuery(searchQuery.trim());
                    setResultFilter("");
                }
                catch (error) {
                    console.error("Qobuz search failed:", error);
                    setQobuzTracks([]);
                }
                finally {
                    setIsSearching(false);
                }
                return;
            }
            // Profiles load independently — a slow or failed profile lookup must
            // never delay or break the main search results.
            const q = searchQuery;
            profileQueryRef.current = q;
            setProfiles([]);
            setProfileView(null);
            SearchSpotifyProfiles(q)
                .then((p) => {
                    if (profileQueryRef.current === q)
                        setProfiles(p || []);
                })
                .catch((err) => console.error("Profile search failed:", err));
            try {
                const results = await SearchSpotify({ query: searchQuery, limit: SEARCH_LIMIT });
                setSearchResults(results);
                setResultFilter("");
                setLastSearchedQuery(searchQuery.trim());
                setHasMore({
                    tracks: results.tracks.length === SEARCH_LIMIT,
                    albums: results.albums.length === SEARCH_LIMIT,
                    artists: results.artists.length === SEARCH_LIMIT,
                    playlists: results.playlists.length === SEARCH_LIMIT,
                    profiles: false,
                    podcasts: false,
                    audiobooks: false,
                });
                // Default to the first non-empty tab in display order.
                if (results.artists.length > 0)
                    setActiveTab("artists");
                else if (results.albums.length > 0)
                    setActiveTab("albums");
                else if (results.tracks.length > 0)
                    setActiveTab("tracks");
                else if (results.playlists.length > 0)
                    setActiveTab("playlists");
                else
                    setActiveTab("profiles");
            }
            catch (error) {
                console.error("Search failed:", error);
                setSearchResults(null);
            }
            finally {
                setIsSearching(false);
            }
        }, 400);
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery, searchMode, lastSearchedQuery, searchSource]);
    const handleLoadMore = async () => {
        if (!searchResults || !lastSearchedQuery || isLoadingMore || activeTab === "profiles" || activeTab === "podcasts" || activeTab === "audiobooks")
            return;
        const typeMap: Record<ResultTab, string> = {
            tracks: "track",
            albums: "album",
            artists: "artist",
            playlists: "playlist",
            profiles: "user",
            podcasts: "show",
            audiobooks: "audiobook",
        };
        const currentCount = getTabCount(activeTab);
        setIsLoadingMore(true);
        try {
            const moreResults = await SearchSpotifyByType({
                query: lastSearchedQuery,
                search_type: typeMap[activeTab],
                limit: SEARCH_LIMIT,
                offset: currentCount,
            });
            if (moreResults.length > 0) {
                setSearchResults((prev) => {
                    if (!prev)
                        return prev;
                    const updated = new backend.SearchResponse({
                        tracks: activeTab === "tracks"
                            ? [...prev.tracks, ...moreResults]
                            : prev.tracks,
                        albums: activeTab === "albums"
                            ? [...prev.albums, ...moreResults]
                            : prev.albums,
                        artists: activeTab === "artists"
                            ? [...prev.artists, ...moreResults]
                            : prev.artists,
                        playlists: activeTab === "playlists"
                            ? [...prev.playlists, ...moreResults]
                            : prev.playlists,
                        podcasts: prev.podcasts,
                        audiobooks: prev.audiobooks,
                    });
                    return updated;
                });
            }
            setHasMore((prev) => ({
                ...prev,
                [activeTab]: moreResults.length === SEARCH_LIMIT,
            }));
        }
        catch (error) {
            console.error("Load more failed:", error);
        }
        finally {
            setIsLoadingMore(false);
        }
    };
    const isSpotifyUrl = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed)
            return true;
        const isUrl = /^(https?:\/\/|www\.)/i.test(trimmed) || /^spotify:/i.test(trimmed);
        if (!isUrl)
            return true;
        return (trimmed.includes("spotify.com") ||
            trimmed.includes("spotify.link") ||
            trimmed.startsWith("spotify:"));
    };
    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        if (searchMode)
            return;
        const pastedText = e.clipboardData.getData("text");
        if (pastedText && !isSpotifyUrl(pastedText)) {
            e.preventDefault();
            setInvalidUrl(pastedText);
            setShowInvalidUrlDialog(true);
        }
    };
    const handleFetchWithValidation = () => {
        const trimmed = url.trim();
        if (!trimmed) {
            onFetch();
            return;
        }
        const looksLikeUrl = /^(https?:\/\/|www\.)/i.test(trimmed) || /^spotify:/i.test(trimmed);
        if (!looksLikeUrl) {
            // Plain text isn't a link — treat it as a search query and switch to Search.
            onSearchModeChange(true);
            setSearchQuery(trimmed);
            return;
        }
        if (!isSpotifyUrl(trimmed)) {
            setInvalidUrl(trimmed);
            setShowInvalidUrlDialog(true);
            return;
        }
        onFetch();
    };
    const handleResultClick = (externalUrl: string) => {
        onSearchModeChange(false);
        onFetchUrl(externalUrl);
    };
    // Playlists open as a playlist page (library-matched, missing tracks
    // dulled) — retrieved and cached like other metadata, not auto-synced.
    const syncAndOpen = (plUrl: string, _plName: string) => {
        openSpotifyPlaylistView(plUrl);
    };
    const formatDuration = (ms: number) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };
    const hasAnyResults = (searchResults &&
        (searchResults.tracks.length > 0 ||
            searchResults.albums.length > 0 ||
            searchResults.artists.length > 0 ||
            searchResults.playlists.length > 0)) || profiles.length > 0;
    const getTabCount = (tab: ResultTab): number => {
        if (tab === "profiles")
            return profiles.length;
        if (!searchResults)
            return 0;
        switch (tab) {
            case "tracks":
                return searchResults.tracks.length;
            case "albums":
                return searchResults.albums.length;
            case "artists":
                return searchResults.artists.length;
            case "playlists":
                return searchResults.playlists.length;
            case "podcasts":
                return (searchResults.podcasts || []).length;
            case "audiobooks":
                return (searchResults.audiobooks || []).length;
            default:
                return 0;
        }
    };
    const sortedResults = useMemo(() => {
        if (!searchResults)
            return { tracks: [], albums: [], artists: [], playlists: [], podcasts: [], audiobooks: [] };
        const filterStr = resultFilter.toLowerCase();
        let tracks = [...searchResults.tracks];
        if (filterStr) {
            tracks = tracks.filter(t => (t.name || '').toLowerCase().includes(filterStr) || (t.artists || '').toLowerCase().includes(filterStr));
        }
        if (hideClean) {
            tracks = excludeCleanVariants(tracks);
        }
        const tSort = sortOrders.tracks;
        if (tSort !== 'default') {
            tracks.sort((a, b) => {
                if (tSort === 'title-asc')
                    return (a.name || '').localeCompare(b.name || '');
                if (tSort === 'title-desc')
                    return (b.name || '').localeCompare(a.name || '');
                if (tSort === 'artist-asc')
                    return (a.artists || '').localeCompare(b.artists || '');
                if (tSort === 'artist-desc')
                    return (b.artists || '').localeCompare(a.artists || '');
                if (tSort === 'duration-desc')
                    return (b.duration_ms || 0) - (a.duration_ms || 0);
                if (tSort === 'duration-asc')
                    return (a.duration_ms || 0) - (b.duration_ms || 0);
                return 0;
            });
        }
        let albums = [...searchResults.albums];
        if (filterStr) {
            albums = albums.filter(a => (a.name || '').toLowerCase().includes(filterStr) || (a.artists || '').toLowerCase().includes(filterStr));
        }
        if (hideClean) {
            albums = excludeCleanVariants(albums);
        }
        const alSort = sortOrders.albums;
        if (alSort !== 'default') {
            albums.sort((a, b) => {
                if (alSort === 'title-asc')
                    return (a.name || '').localeCompare(b.name || '');
                if (alSort === 'title-desc')
                    return (b.name || '').localeCompare(a.name || '');
                if (alSort === 'artist-asc')
                    return (a.artists || '').localeCompare(b.artists || '');
                if (alSort === 'artist-desc')
                    return (b.artists || '').localeCompare(a.artists || '');
                if (alSort === 'year-desc')
                    return (b.release_date || '').localeCompare(a.release_date || '');
                if (alSort === 'year-asc')
                    return (a.release_date || '').localeCompare(b.release_date || '');
                return 0;
            });
        }
        let artists = [...searchResults.artists];
        if (filterStr) {
            artists = artists.filter(a => (a.name || '').toLowerCase().includes(filterStr));
        }
        const arSort = sortOrders.artists;
        if (arSort !== 'default') {
            artists.sort((a, b) => {
                if (arSort === 'name-asc')
                    return (a.name || '').localeCompare(b.name || '');
                if (arSort === 'name-desc')
                    return (b.name || '').localeCompare(a.name || '');
                return 0;
            });
        }
        let playlists = [...searchResults.playlists];
        if (filterStr) {
            playlists = playlists.filter(p => (p.name || '').toLowerCase().includes(filterStr) || (p.owner || '').toLowerCase().includes(filterStr));
        }
        const pSort = sortOrders.playlists;
        if (pSort !== 'default') {
            playlists.sort((a, b) => {
                if (pSort === 'title-asc')
                    return (a.name || '').localeCompare(b.name || '');
                if (pSort === 'title-desc')
                    return (b.name || '').localeCompare(a.name || '');
                if (pSort === 'owner-asc')
                    return (a.owner || '').localeCompare(b.owner || '');
                if (pSort === 'owner-desc')
                    return (b.owner || '').localeCompare(a.owner || '');
                return 0;
            });
        }
        // Podcasts and audiobooks: filter by name/byline, sort by title only.
        const showLikeSort = (list: backend.SearchResult[], order: string) => {
            let out = [...list];
            if (filterStr) {
                out = out.filter(p => (p.name || '').toLowerCase().includes(filterStr) || (p.owner || '').toLowerCase().includes(filterStr));
            }
            if (order === 'title-asc')
                out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            if (order === 'title-desc')
                out.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
            return out;
        };
        const podcasts = showLikeSort(searchResults.podcasts || [], sortOrders.podcasts);
        const audiobooks = showLikeSort(searchResults.audiobooks || [], sortOrders.audiobooks);
        return { tracks, albums, artists, playlists, podcasts, audiobooks };
    }, [searchResults, sortOrders, resultFilter, hideClean]);
    const tabs: {
        key: ResultTab;
        label: string;
    }[] = [
        { key: "artists", label: "Artists" },
        { key: "albums", label: "Albums" },
        { key: "tracks", label: "Tracks" },
        { key: "playlists", label: "Playlists" },
        { key: "profiles", label: "Profiles" },
        // Podcasts/audiobooks are wired up end-to-end but hidden for now —
        // re-enable by adding the tabs back.
        // { key: "podcasts", label: "Podcasts" },
        // { key: "audiobooks", label: "Audiobooks" },
    ];
    return (<div className="space-y-4">
      <div className="flex gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" className="shrink-0" onClick={() => onSearchModeChange(!searchMode)}>
              {searchMode ? (<Link className="h-4 w-4"/>) : (<Search className="h-4 w-4"/>)}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{searchMode ? "Fetch Mode" : "Search Mode"}</p>
          </TooltipContent>
        </Tooltip>

        <div className="relative flex-1">
          {!searchMode ? (<>
              <InputWithContext id="spotify-url" placeholder={placeholderText} value={url} onChange={(e) => onUrlChange(e.target.value)} onPaste={handlePaste} onKeyDown={(e) => e.key === "Enter" && handleFetchWithValidation()} className="pr-8"/>
              {url && (<button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" onClick={() => onUrlChange("")}>
                  <XCircle className="h-4 w-4"/>
                </button>)}
            </>) : (<>
              <InputWithContext id="spotify-search" placeholder={placeholderText} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pr-8"/>
              {searchQuery && (<button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" onClick={() => {
                    setSearchQuery("");
                    setSearchResults(null);
                    setLastSearchedQuery("");
                    setResultFilter("");
                    setProfiles([]);
                    setProfileView(null);
                    profileQueryRef.current = "";
                }}>
                  <XCircle className="h-4 w-4"/>
                </button>)}
            </>)}
        </div>

        {!searchMode && (<>
            <Button onClick={handleFetchWithValidation} disabled={loading}>
              {loading ? (<>
                  <Spinner />
                  Fetching...
                </>) : (<>
                  <CloudDownload className="h-4 w-4"/>
                  Fetch
                </>)}
            </Button>
          </>)}
        {searchMode && (
          <Select value={searchSource} onValueChange={(v) => { setSearchSource(v as SearchSource); setLastSearchedQuery(""); }}>
            <SelectTrigger className="w-[120px] bg-background shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="spotify">Spotify</SelectItem>
              <SelectItem value="qobuz">Qobuz</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {searchMode && (<div className="space-y-4">
          {isSearching && (<div className="flex items-center justify-center py-8">
              <Spinner />
              <span className="ml-2 text-muted-foreground">Searching...</span>
            </div>)}

          {!isSearching && searchSource === "qobuz" && searchQuery && lastSearchedQuery && qobuzTracks.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No results found for "{searchQuery}"
            </div>
          )}

          {!isSearching && searchSource === "qobuz" && qobuzTracks.length > 0 && (<>
              <div className="flex gap-1 border-b mb-4">
                <button type="button" className="px-4 py-2 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px border-primary text-foreground">
                  Tracks ({qobuzTracks.length})
                </button>
              </div>

              <div className="flex gap-2 mb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
                  <Input placeholder="Search tracks..." value={resultFilter} onChange={(e) => setResultFilter(e.target.value)} className="pl-10 pr-8"/>
                  {resultFilter && (<button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" onClick={() => setResultFilter("")}>
                      <XCircle className="h-4 w-4"/>
                    </button>)}
                </div>
                <Select value={qobuzSort} onValueChange={setQobuzSort}>
                  <SelectTrigger className="w-[170px] bg-background gap-1.5">
                    <ArrowUpDown className="h-4 w-4 text-muted-foreground"/>
                    <SelectValue placeholder="Sort by"/>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="title-asc">Title (A-Z)</SelectItem>
                    <SelectItem value="title-desc">Title (Z-A)</SelectItem>
                    <SelectItem value="artist-asc">Artist (A-Z)</SelectItem>
                    <SelectItem value="artist-desc">Artist (Z-A)</SelectItem>
                    <SelectItem value="duration-desc">Duration (Longest)</SelectItem>
                    <SelectItem value="duration-asc">Duration (Shortest)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                {qobuzDisplayed.map((t) => {
                  const qid = `qobuz_${t.id}`;
                  const qualityText = `Qobuz · ${t.hires && t.bitDepth > 16 ? `${t.bitDepth}-bit/${t.sampleRate} kHz` : "16-bit/44.1 kHz"}`;
                  return (
                    <button key={t.id} type="button"
                      className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors"
                      title="Download from Qobuz"
                      onClick={() => {
                        if (downloadingTrack === qid || downloadedTracks.has(qid)) return;
                        handleDownloadTrack(qid, t.title, t.artist, t.album, undefined, undefined, t.durationMs, undefined, undefined, t.releaseDate);
                      }}>
                      {t.cover ? (<img src={t.cover} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="font-medium truncate">{t.title}</p>
                          <span title={`Best available: ${qualityText}`}
                            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap ${t.hires && t.bitDepth > 16 ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground"}`}>
                            {qualityText}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {t.artist}
                        </p>
                      </div>
                      {downloadingTrack === qid
                        ? <Spinner className="h-4 w-4 shrink-0"/>
                        : downloadedTracks.has(qid)
                          ? <Check className="h-4 w-4 text-green-500 shrink-0"/>
                          : (<span className="text-sm text-muted-foreground shrink-0">
                              {formatDuration(t.durationMs || 0)}
                            </span>)}
                    </button>
                  );
                })}
              </div>
            </>)}

          {!isSearching && searchSource === "spotify" && searchQuery && !hasAnyResults && (<div className="text-center py-8 text-muted-foreground">
              No results found for "{searchQuery}"
            </div>)}

          {!isSearching && searchSource === "spotify" && hasAnyResults && (<>
              <div className="flex gap-1 border-b mb-4">
                {tabs.map((tab) => {
                    const count = getTabCount(tab.key);
                    if (count === 0)
                        return null;
                    return (<button key={tab.key} type="button" onClick={() => setActiveTab(tab.key)} className={cn("px-4 py-2 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px", activeTab === tab.key
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground")}>
                      {tab.label} ({count})
                    </button>);
                })}
              </div>

              <div className="flex gap-2 mb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
                  <Input placeholder={`Search ${activeTab}...`} value={resultFilter} onChange={(e) => setResultFilter(e.target.value)} className="pl-10 pr-8"/>
                  {resultFilter && (<button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" onClick={() => setResultFilter("")}>
                      <XCircle className="h-4 w-4"/>
                    </button>)}
                </div>
                <Select value={sortOrders[activeTab]} onValueChange={(val) => setSortOrders(prev => ({ ...prev, [activeTab]: val }))}>
                  <SelectTrigger className="w-[170px] bg-background gap-1.5">
                    <ArrowUpDown className="h-4 w-4 text-muted-foreground"/>
                    <SelectValue placeholder="Sort by"/>
                  </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {activeTab === 'tracks' && (<>
                          <SelectItem value="title-asc">Title (A-Z)</SelectItem>
                          <SelectItem value="title-desc">Title (Z-A)</SelectItem>
                          <SelectItem value="artist-asc">Artist (A-Z)</SelectItem>
                          <SelectItem value="artist-desc">Artist (Z-A)</SelectItem>
                          <SelectItem value="duration-desc">Duration (Longest)</SelectItem>
                          <SelectItem value="duration-asc">Duration (Shortest)</SelectItem>
                        </>)}
                      {activeTab === 'albums' && (<>
                          <SelectItem value="title-asc">Title (A-Z)</SelectItem>
                          <SelectItem value="title-desc">Title (Z-A)</SelectItem>
                          <SelectItem value="artist-asc">Artist (A-Z)</SelectItem>
                          <SelectItem value="artist-desc">Artist (Z-A)</SelectItem>
                          <SelectItem value="year-desc">Year (Newest)</SelectItem>
                          <SelectItem value="year-asc">Year (Oldest)</SelectItem>
                        </>)}
                      {activeTab === 'artists' && (<>
                          <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                          <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                        </>)}
                      {activeTab === 'playlists' && (<>
                          <SelectItem value="title-asc">Title (A-Z)</SelectItem>
                          <SelectItem value="title-desc">Title (Z-A)</SelectItem>
                          <SelectItem value="owner-asc">Owner (A-Z)</SelectItem>
                          <SelectItem value="owner-desc">Owner (Z-A)</SelectItem>
                        </>)}
                      {(activeTab === 'podcasts' || activeTab === 'audiobooks') && (<>
                          <SelectItem value="title-asc">Title (A-Z)</SelectItem>
                          <SelectItem value="title-desc">Title (Z-A)</SelectItem>
                        </>)}
                    </SelectContent>
                  </Select>
              </div>

              <div className="grid gap-2">
                {activeTab === "tracks" &&
                    sortedResults.tracks.map((track) => (<button key={track.id} type="button" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => handleResultClick(track.external_urls)}>
                      {track.images ? (<img src={track.images} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="font-medium truncate">{track.name}</p>
                          {track.is_explicit && (<span className="flex items-center justify-center min-w-[16px] h-[16px] rounded bg-red-600 text-[10px] font-bold text-white leading-none shrink-0" title="Explicit">
                              E
                            </span>)}
                          <QualityBadge spotifyId={track.id} />
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {track.artists}
                        </p>
                      </div>
                      <span className="text-sm text-muted-foreground shrink-0">
                        {formatDuration(track.duration_ms || 0)}
                      </span>
                    </button>))}

                {activeTab === "albums" &&
                    sortedResults.albums.map((album) => (<button key={album.id} type="button" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => handleResultClick(album.external_urls)}>
                      {album.images ? (<img src={album.images} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{album.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {album.artists}
                        </p>
                      </div>
                      <span className="text-sm text-muted-foreground shrink-0">
                        {album.release_date || ""}
                      </span>
                    </button>))}

                {activeTab === "artists" &&
                    sortedResults.artists.map((artist) => (<button key={artist.id} type="button" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => handleResultClick(artist.external_urls)}>
                      {artist.images ? (<img src={artist.images} alt="" className="w-12 h-12 rounded-full object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded-full bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{artist.name}</p>
                        <p className="text-sm text-muted-foreground">Artist</p>
                      </div>
                    </button>))}

                {activeTab === "playlists" &&
                    sortedResults.playlists.map((playlist) => (<button key={playlist.id} type="button" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => syncAndOpen(playlist.external_urls, playlist.name)}>
                      {playlist.images ? (<img src={playlist.images} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{playlist.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {playlist.owner || ""}
                        </p>
                      </div>
                    </button>))}

                {activeTab === "podcasts" &&
                    sortedResults.podcasts.map((show) => (<button key={show.id} type="button" title="Open on Spotify" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => show.external_urls && BrowserOpenURL(show.external_urls)}>
                      {show.images ? (<img src={show.images} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{show.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {show.owner || "Podcast"}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">Opens on Spotify</span>
                    </button>))}

                {activeTab === "audiobooks" &&
                    sortedResults.audiobooks.map((book) => (<button key={book.id} type="button" title="Open on Spotify" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => book.external_urls && BrowserOpenURL(book.external_urls)}>
                      {book.images ? (<img src={book.images} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{book.name}</p>
                        <p className="text-sm text-muted-foreground truncate">
                          {book.owner || "Audiobook"}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">Opens on Spotify</span>
                    </button>))}

                {activeTab === "profiles" && !profileView &&
                    profiles
                        .filter((p) => !resultFilter || p.name.toLowerCase().includes(resultFilter.toLowerCase()))
                        .map((prof) => (<button key={prof.id} type="button" className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => {
                            setProfileView({ profile: prof, items: null });
                            GetUserPlaylists(prof.id)
                                .then((items) => setProfileView((v) => v && v.profile.id === prof.id ? { ...v, items: items || [] } : v))
                                .catch(() => setProfileView((v) => v && v.profile.id === prof.id ? { ...v, items: [] } : v));
                        }}>
                      {prof.image ? (<img src={prof.image} alt="" className="w-12 h-12 rounded-full object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded-full bg-muted shrink-0"/>)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{prof.name}</p>
                        <p className="text-sm text-muted-foreground">Profile</p>
                      </div>
                    </button>))}

                {activeTab === "profiles" && profileView && (<div className="space-y-2">
                    <button type="button" className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer" onClick={() => setProfileView(null)}>
                      ← Profiles
                    </button>
                    <div className="flex items-center gap-3 p-3">
                      {profileView.profile.image ? (<img src={profileView.profile.image} alt="" className="w-14 h-14 rounded-full object-cover shrink-0"/>) : (<div className="w-14 h-14 rounded-full bg-muted shrink-0"/>)}
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{profileView.profile.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {profileView.items === null
                            ? "Loading playlists…"
                            : `${profileView.items.length} public playlist${profileView.items.length === 1 ? "" : "s"}`}
                        </p>
                      </div>
                    </div>
                    {profileView.items === null && (<div className="flex items-center justify-center py-6">
                        <Spinner />
                      </div>)}
                    {profileView.items !== null && profileView.items.length === 0 && (<div className="text-center py-6 text-muted-foreground">
                        No public playlists
                      </div>)}
                    {(profileView.items || [])
                        .filter((pl) => !resultFilter || pl.name.toLowerCase().includes(resultFilter.toLowerCase()))
                        .map((pl) => (<button key={pl.id} type="button" className="flex items-center gap-3 p-3 w-full rounded-lg bg-card hover:bg-accent border cursor-pointer text-left transition-colors" onClick={() => syncAndOpen(pl.url, pl.name)}>
                          {pl.image ? (<img src={pl.image} alt="" className="w-12 h-12 rounded object-cover shrink-0"/>) : (<div className="w-12 h-12 rounded bg-muted shrink-0"/>)}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{pl.name}</p>
                            <p className="text-sm text-muted-foreground truncate">
                              {pl.followers > 0
                                ? `${pl.followers.toLocaleString()} follower${pl.followers === 1 ? "" : "s"}`
                                : "Playlist"}
                            </p>
                          </div>
                        </button>))}
                  </div>)}
              </div>

              {hasMore[activeTab] && (<div className="flex justify-center pt-2">
                  <Button variant="outline" onClick={handleLoadMore} disabled={isLoadingMore}>
                    {isLoadingMore ? (<>
                        <Spinner />
                        Loading...
                      </>) : (<>
                        <ChevronDown className="h-4 w-4"/>
                        Load More
                      </>)}
                  </Button>
                </div>)}
            </>)}
        </div>)}

      <Dialog open={showInvalidUrlDialog} onOpenChange={setShowInvalidUrlDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Invalid URL</DialogTitle>
            <DialogDescription>
              Only Spotify links are allowed in Fetch mode.
            </DialogDescription>
          </DialogHeader>

          {invalidUrl && (<div className="p-3 bg-muted rounded-md border text-xs font-mono break-all opacity-70">
              {invalidUrl}
            </div>)}

          <DialogFooter>
            <Button variant="outline" onClick={() => {
            setShowInvalidUrlDialog(false);
            setInvalidUrl("");
        }}>
              Cancel
            </Button>
            <Button onClick={() => {
            onSearchModeChange(true);
            setShowInvalidUrlDialog(false);
            setInvalidUrl("");
        }}>
              Switch to Search
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>);
}
