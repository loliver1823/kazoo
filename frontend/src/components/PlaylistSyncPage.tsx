import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ArrowLeft, Check, Disc3, Download, Link2, ListMusic, Play, Plus, RefreshCw, Trash2, User } from "lucide-react";
import {
    SyncSpotifyPlaylist, ListSyncedPlaylists, GetSyncedPlaylistDetail,
    ResyncSyncedPlaylist, RemoveSyncedPlaylist, OpenSpotifyPlaylist, SetPlaylistSynced,
} from "../../wailsjs/go/main/App";
import { backend } from "../../wailsjs/go/models";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { playQueue, toPlayerTrack } from "@/lib/player";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { plural } from "@/lib/utils";
import { useDownload } from "@/hooks/useDownload";
import type { TrackMetadata } from "@/types/api";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { FindLibraryArtistName, FindLibraryAlbum } from "../../wailsjs/go/main/App";
import { openLibraryArtist, openLibraryAlbum } from "@/components/LibraryPage";
import { FixTrackMatchDialog } from "@/components/FixTrackMatchDialog";

type Synced = backend.SyncedPlaylist;
type Detail = backend.SyncedPlaylistDetail;
type Match = backend.MatchedTrack;

// Other views (search results, profile playlists, On Spotify cards) land here:
// stash the playlist URL, then tell App to switch to the Playlist Sync page.
// Opening is metadata-style — retrieved and cached, NOT added to the sync list.
let pendingOpenUrl: string | null = null;
export function openSpotifyPlaylistView(url: string) {
    pendingOpenUrl = url;
    window.dispatchEvent(new CustomEvent("kazoo:open-playlist-sync"));
}

function fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function PlaylistSyncPage() {
    const [playlists, setPlaylists] = useState<Synced[]>([]);
    const [url, setUrl] = useState("");
    const [adding, setAdding] = useState(false);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [fixMatch, setFixMatch] = useState<Match | null>(null);
    // True when the open playlist was pushed from another page (search,
    // profile, artist page) — back then returns there, not to the sync list.
    const [fromExternal, setFromExternal] = useState(false);
    const [loadingDetail, setLoadingDetail] = useState(false);
    const [resyncing, setResyncing] = useState(false);
    const { handleDownloadTrack, handleDownloadSelected, isDownloading, downloadingTrack } = useDownload();

    const loadList = async () => {
        try { setPlaylists(await ListSyncedPlaylists() || []); }
        catch { /* library not ready yet */ }
    };
    useEffect(() => { loadList(); }, []);

    const openDetail = async (id: number) => {
        setLoadingDetail(true);
        try { setDetail(await GetSyncedPlaylistDetail(id)); }
        catch (e) { toast.error(`${e}`); }
        finally { setLoadingDetail(false); }
    };

    // Open a playlist pushed from another view (and handle the case where we
    // were already mounted when it was pushed).
    useEffect(() => {
        const consume = () => {
            if (pendingOpenUrl != null) {
                const u = pendingOpenUrl;
                pendingOpenUrl = null;
                setFromExternal(true);
                setDetail(null);
                setLoadingDetail(true);
                OpenSpotifyPlaylist(u)
                    .then((p) => openDetail(p.id))
                    .catch((e) => { setLoadingDetail(false); toast.error(`${e}`); });
            }
        };
        consume();
        window.addEventListener("kazoo:open-playlist-sync", consume);
        return () => window.removeEventListener("kazoo:open-playlist-sync", consume);
    }, []);

    // Downloads auto-import into the library; rematch the open playlist so
    // dulled rows light up as tracks land.
    useEffect(() => {
        // Rematching the playlist against the whole library is heavy — during
        // batch downloads events arrive per file, so coalesce them.
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = EventsOn("library:changed", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                loadList();
                setDetail((d) => {
                    if (d) GetSyncedPlaylistDetail(d.playlist.id).then(setDetail).catch(() => { });
                    return d;
                });
            }, 2500);
        });
        return () => { off(); if (timer) clearTimeout(timer); };
    }, []);

    const onAdd = async () => {
        const u = url.trim();
        if (!u) return;
        setAdding(true);
        try {
            const p = await SyncSpotifyPlaylist(u);
            setUrl("");
            setFromExternal(false);
            await loadList();
            await openDetail(p.id);
        } catch (e) { toast.error(`${e}`); }
        finally { setAdding(false); }
    };

    const onResync = async () => {
        if (!detail) return;
        setResyncing(true);
        try {
            const p = await ResyncSyncedPlaylist(detail.playlist.id);
            await loadList();
            await openDetail(p.id);
            toast.success("Playlist refreshed");
        } catch (e) { toast.error(`${e}`); }
        finally { setResyncing(false); }
    };

    const onPinToSync = async () => {
        if (!detail) return;
        try {
            await SetPlaylistSynced(detail.playlist.id, true);
            setDetail((d) => d ? new backend.SyncedPlaylistDetail({ ...d, playlist: { ...d.playlist, synced: true } }) : d);
            await loadList();
            toast.success(`"${detail.playlist.name}" added to Playlist Sync`);
        } catch (e) { toast.error(`${e}`); }
    };

    const onRemove = async (id: number, name: string) => {
        try {
            await RemoveSyncedPlaylist(id);
            setDetail((d) => (d && d.playlist.id === id ? null : d));
            await loadList();
            toast.success(`Removed "${name}"`);
        } catch (e) { toast.error(`${e}`); }
    };

    const refToTrackMeta = (m: Match): TrackMetadata => ({
        spotify_id: m.ref.spotifyId,
        name: m.ref.name,
        artists: (m.ref.artistNames || []).join(", "),
        album_name: m.ref.album,
        duration_ms: m.ref.durationMs,
    } as unknown as TrackMetadata);

    const downloadOne = (m: Match) => {
        // Clicking while something downloads enqueues it (shared chain).
        handleDownloadTrack(
            m.ref.spotifyId, m.ref.name, (m.ref.artistNames || []).join(", "), m.ref.album,
            m.ref.spotifyId, detail?.playlist.name, m.ref.durationMs,
        );
    };

    // Context-menu nav: prefer the library page; if we don't have the artist
    // or album locally, land on the Download page with it fetched instead.
    const goToArtist = async (m: Match) => {
        const artist = (m.ref.artistNames || [])[0] || m.local?.artist || "";
        if (!artist) { toast.error("No artist on this track"); return; }
        const libName = await FindLibraryArtistName(artist).catch(() => "");
        if (libName) { openLibraryArtist(libName); return; }
        if (m.ref.artistId) {
            window.dispatchEvent(new CustomEvent("kazoo:fetch-url", { detail: `https://open.spotify.com/artist/${m.ref.artistId}/discography/all` }));
            return;
        }
        toast.info(`"${artist}" isn't in your library`);
    };
    const goToAlbum = async (m: Match) => {
        const artist = (m.ref.artistNames || [])[0] || "";
        if (m.ref.album) {
            const alb = await FindLibraryAlbum(m.ref.album, artist).catch(() => null);
            if (alb) { openLibraryAlbum(alb); return; }
        }
        if (m.ref.albumId) {
            window.dispatchEvent(new CustomEvent("kazoo:fetch-url", { detail: `https://open.spotify.com/album/${m.ref.albumId}` }));
            return;
        }
        toast.info("No album details for this track — try Resync");
    };

    const onDownloadMissing = async () => {
        if (!detail) return;
        const missing = detail.matches.filter((m) => !m.local);
        if (!missing.length) { toast.success("Nothing missing — you have it all!"); return; }
        // Downloading a playlist means you care about it — keep it synced.
        if (!detail.playlist.synced) {
            try {
                await SetPlaylistSynced(detail.playlist.id, true);
                setDetail((d) => d ? new backend.SyncedPlaylistDetail({ ...d, playlist: { ...d.playlist, synced: true } }) : d);
                await loadList();
            } catch { /* non-fatal */ }
        }
        await handleDownloadSelected(
            missing.map((m) => m.ref.spotifyId),
            missing.map(refToTrackMeta),
            detail.playlist.name,
            false,
        );
    };

    // ---- Detail: a normal playlist page; missing tracks are dulled out ----
    if (detail) {
        const p = detail.playlist;
        const missing = p.total - p.haveCount;
        // The playable queue is the playlist's in-library tracks, in playlist order.
        const libTracks = detail.matches.filter((m) => m.local).map((m) => toPlayerTrack(m.local!));
        let libIdx = -1;
        return (
            <div className="h-full overflow-y-auto">
                <div className="p-6 pb-24">
                    <button
                        type="button"
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex items-center gap-1 mb-5"
                        onClick={() => {
                            setDetail(null);
                            if (fromExternal) {
                                setFromExternal(false);
                                window.dispatchEvent(new CustomEvent("kazoo:playlist-sync-back"));
                            }
                        }}
                    >
                        <ArrowLeft className="h-4 w-4" /> {fromExternal ? "Back" : "Synced playlists"}
                    </button>

                    <div className="flex items-end gap-6 mb-7">
                        {p.cover
                            ? <img src={p.cover} alt="" className="h-48 w-48 rounded-lg object-cover shadow-xl shrink-0" />
                            : <div className="h-48 w-48 rounded-lg bg-muted shrink-0 flex items-center justify-center shadow-xl"><ListMusic className="h-14 w-14 text-muted-foreground" /></div>}
                        <div className="min-w-0 pb-1">
                            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{p.synced ? "Synced playlist" : "Spotify playlist"}</div>
                            <h1 className="text-3xl font-bold truncate mb-2">{p.name || "Playlist"}</h1>
                            <div className="text-sm text-muted-foreground mb-4">
                                {p.owner && <>{p.owner} · </>}
                                {plural(p.total, "track")} · <span className="text-green-500">{p.haveCount} in library</span>
                                {missing > 0 && <> · <span className="text-amber-500">{missing} missing</span></>}
                            </div>
                            <div className="flex items-center gap-2">
                                {libTracks.length > 0 && (
                                    <Button onClick={() => playQueue(libTracks, 0)}>
                                        <Play className="h-4 w-4 mr-1" /> Play
                                    </Button>
                                )}
                                {missing > 0 && (
                                    <Button variant="outline" onClick={onDownloadMissing}>
                                        {isDownloading ? <Spinner className="h-4 w-4 mr-1" /> : <Download className="h-4 w-4 mr-1" />}
                                        Download missing ({missing})
                                    </Button>
                                )}
                                {!p.synced && (
                                    <Button variant="outline" onClick={onPinToSync} title="Keep this playlist in Playlist Sync">
                                        <Plus className="h-4 w-4 mr-1" /> Sync
                                    </Button>
                                )}
                                <Button variant="outline" onClick={onResync} disabled={resyncing} title="Re-fetch from Spotify">
                                    {resyncing ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                                </Button>
                                {p.synced && (
                                    <Button variant="ghost" size="icon" onClick={() => onRemove(p.id, p.name)} title="Remove from Playlist Sync">
                                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 px-3 pb-2 text-xs uppercase tracking-wider text-muted-foreground border-b border-border/60">
                        <span className="w-7 text-right shrink-0">#</span>
                        <span className="flex-1">Title</span>
                        <span className="flex-1 hidden md:block">Album</span>
                        <span className="w-12 text-right shrink-0">Time</span>
                        <span className="w-8 shrink-0"></span>
                    </div>
                    <div>
                        {detail.matches.map((m, i) => {
                            const inLib = !!m.local;
                            const myLibIdx = inLib ? ++libIdx : -1;
                            return (
                                <ContextMenu key={`${m.ref.spotifyId || i}`}>
                                  <ContextMenuTrigger asChild>
                                <div
                                    className={`group flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${inLib
                                        ? "hover:bg-accent cursor-pointer"
                                        : "opacity-40 hover:opacity-70"}`}
                                    onDoubleClick={() => { if (inLib) playQueue(libTracks, myLibIdx); }}
                                >
                                    <span className="w-7 text-right shrink-0 text-sm text-muted-foreground tabular-nums relative">
                                        {inLib ? (
                                            <>
                                                <span className="group-hover:opacity-0">{i + 1}</span>
                                                <button
                                                    type="button"
                                                    className="absolute inset-0 items-center justify-end hidden group-hover:flex cursor-pointer text-foreground"
                                                    title="Play"
                                                    onClick={(e) => { e.stopPropagation(); playQueue(libTracks, myLibIdx); }}
                                                >
                                                    <Play className="h-3.5 w-3.5 fill-current" />
                                                </button>
                                            </>
                                        ) : (
                                            <span>{i + 1}</span>
                                        )}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm truncate">{m.ref.name}</div>
                                        <div className="text-xs text-muted-foreground truncate">{(m.ref.artistNames || []).join(", ")}</div>
                                    </div>
                                    <div className="flex-1 min-w-0 hidden md:block text-sm text-muted-foreground truncate">{m.ref.album}</div>
                                    <span className="w-12 text-right shrink-0 text-sm text-muted-foreground tabular-nums">{fmtDuration(m.ref.durationMs)}</span>
                                    <span className="w-8 shrink-0 text-center">
                                        {inLib
                                            ? <Check className="h-4 w-4 text-green-500 inline-block opacity-0 group-hover:opacity-100 transition-opacity" />
                                            : downloadingTrack === m.ref.spotifyId
                                                ? <Spinner className="h-4 w-4 inline-block" />
                                                : (
                                                    <button
                                                        type="button"
                                                        className="text-amber-500 hover:text-amber-400 transition-colors cursor-pointer align-middle disabled:opacity-50"
                                                        title="Download this track"
                                                        onClick={(e) => { e.stopPropagation(); downloadOne(m); }}
                                                    >
                                                        <Download className="h-4 w-4 inline-block" />
                                                    </button>
                                                )}
                                    </span>
                                </div>
                                  </ContextMenuTrigger>
                                  <ContextMenuContent>
                                    {inLib && (
                                        <ContextMenuItem onClick={() => playQueue(libTracks, myLibIdx)}>
                                            <Play className="h-4 w-4 mr-2" /> Play
                                        </ContextMenuItem>
                                    )}
                                    {!inLib && (
                                        <ContextMenuItem onClick={() => downloadOne(m)}>
                                            <Download className="h-4 w-4 mr-2" /> Download
                                        </ContextMenuItem>
                                    )}
                                    {m.ref.spotifyId && (
                                        <ContextMenuItem onClick={() => setFixMatch(m)}>
                                            <Link2 className="h-4 w-4 mr-2" /> Fix match…
                                        </ContextMenuItem>
                                    )}
                                    <ContextMenuItem onClick={() => goToArtist(m)}>
                                        <User className="h-4 w-4 mr-2" /> Go to artist
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => goToAlbum(m)}>
                                        <Disc3 className="h-4 w-4 mr-2" /> Go to album
                                    </ContextMenuItem>
                                  </ContextMenuContent>
                                </ContextMenu>
                            );
                        })}
                    </div>
                </div>
                {fixMatch && (
                    <FixTrackMatchDialog
                        open
                        spotifyId={fixMatch.ref.spotifyId}
                        initialQuery={fixMatch.ref.name}
                        currentTrackId={fixMatch.local ? Number(fixMatch.local.id) : undefined}
                        onClose={() => setFixMatch(null)}
                        onApplied={() => { GetSyncedPlaylistDetail(p.id).then(setDetail).catch(() => { }); loadList(); }}
                    />
                )}
            </div>
        );
    }

    // ---- List of synced playlists -----------------------------------------
    return (
        <div className="flex flex-col h-full p-4 gap-3">
            <div className="flex items-center gap-3">
                <ListMusic className="h-5 w-5 text-primary" />
                <h1 className="text-lg font-semibold">Playlist Sync</h1>
                <span className="text-xs text-muted-foreground">Keep Spotify playlists mirrored against your library</span>
            </div>

            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && onAdd()}
                        placeholder="https://open.spotify.com/playlist/…"
                        className="h-9 w-full rounded-md bg-card border border-border pl-8 pr-3 text-sm outline-none focus:border-primary"
                    />
                </div>
                <Button onClick={onAdd} disabled={adding}>
                    {adding ? <Spinner className="h-4 w-4 mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                    Sync
                </Button>
            </div>

            {(loadingDetail || adding) && (
                <div className="flex items-center justify-center py-8">
                    <Spinner /><span className="ml-2 text-muted-foreground">Loading playlist…</span>
                </div>
            )}

            {!loadingDetail && !adding && playlists.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2">
                    <ListMusic className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No synced playlists yet — paste a Spotify playlist link above.</p>
                </div>
            )}

            {!loadingDetail && !adding && playlists.length > 0 && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                    <div className="grid gap-2">
                        {playlists.map((p) => {
                            const missing = p.total - p.haveCount;
                            return (
                                <div
                                    key={p.id}
                                    className="flex items-center gap-3 p-3 rounded-lg bg-card hover:bg-accent border cursor-pointer transition-colors group"
                                    onClick={() => { setFromExternal(false); openDetail(p.id); }}
                                >
                                    {p.cover
                                        ? <img src={p.cover} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
                                        : <div className="w-12 h-12 rounded bg-muted shrink-0 flex items-center justify-center"><ListMusic className="h-5 w-5 text-muted-foreground" /></div>}
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium truncate">{p.name || "Playlist"}</p>
                                        <p className="text-xs text-muted-foreground truncate">
                                            {p.owner ? `by ${p.owner} · ` : ""}
                                            <span className="text-green-500">{p.haveCount}</span> of {p.total} in library
                                            {missing > 0 && <> · <span className="text-amber-500">{missing} missing</span></>}
                                        </p>
                                    </div>
                                    {missing === 0 && <Check className="h-4 w-4 text-green-500 shrink-0" />}
                                    <button
                                        type="button"
                                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-all cursor-pointer shrink-0"
                                        title="Remove synced playlist"
                                        onClick={(e) => { e.stopPropagation(); onRemove(p.id, p.name); }}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
