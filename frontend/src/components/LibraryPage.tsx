import { useState, useEffect, useLayoutEffect, useCallback, useRef, Fragment, type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { FolderPlus, Search, Play, Music, ArrowLeft, Clock, ChevronRight, FolderCog, Trash2, Folder, RefreshCw, Pencil, ListPlus, ListEnd, User, Disc3, Info, Plus, ListMusic, X, Check, Link2, Sparkles, Download } from "lucide-react";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent } from "@/components/ui/context-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
    ScanLibraryFolder, RescanLibrary, GetLibraryAlbums, GetAlbumTracks, GetArtistReleases, GetLibraryArtistsList,
    GetLibraryAlbumArtists, GetEmbeddedCover, GetLibraryTracks, GetLibraryStats, GetLibraryFolders, RemoveLibraryFolder,
    GetLibraryFacets, GetTrackCredits, GetCommonMetadata, GetArtistMeta, WriteArtistMetadata, GetArtistImage, SetArtistImage,
    GetArtistBanner, SetArtistBanner, SetArtistBio,
    EnrichLibraryArtist, GetArtistTopTracks, ListArtistsNeedingEnrichment,
    LockArtistFields, UnlockArtistFields, GetArtistLocks, RescanLibraryQuiet,
    SetArtistMatch, SearchArtistMatchCandidates, RefreshArtistMetadata, GetLibraryTracksByIDs,
    GetArtistArtCandidates, GetAlbumArtCandidates, GetArtistSpotifyPlaylists,
    WriteBulkTrackMetadata, TrackIDsForAlbums, TrackIDsForArtists, GetImageInfo, EmbedCoverFromSource, SelectFile, GetPlaylists,
    GetPlaylistTracks, CreatePlaylist, RenamePlaylist, DeletePlaylist, AddTracksToPlaylist, RemoveTrackFromPlaylist, SelectFolder,
    FindLibraryAlbum, GetArtistNewReleases, DeleteLibraryTracks, GetTrackDetails, RefreshTrackMetadata, OpenFolder, DeleteAlbumRefs,
    ListSyncedPlaylists, RemoveSyncedPlaylist, SyncSpotifyPlaylist,
} from "../../wailsjs/go/main/App";
import { openSpotifyPlaylistView } from "@/components/PlaylistSyncPage";
import { FixTrackMatchDialog } from "@/components/FixTrackMatchDialog";
import { fetchSpotifyMetadata } from "@/lib/api";
import { backend } from "../../wailsjs/go/models";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { playQueue, addToQueue, toPlayerTrack } from "@/lib/player";
import { useDownload } from "@/hooks/useDownload";
import { getSettings, saveSettings } from "@/lib/settings";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { plural } from "@/lib/utils";

type Album = backend.LibraryAlbum;
type Artist = backend.LibraryArtist;
type Track = backend.LibraryTrack;
type LibFolder = backend.LibraryFolder;
type Playlist = backend.Playlist;

type Route =
    | { kind: "albums" }
    | { kind: "artists" }
    | { kind: "albumartists" }
    | { kind: "genres" }
    | { kind: "years" }
    | { kind: "playlists" }
    | { kind: "playlist"; playlist: Playlist }
    | { kind: "songs"; filters?: Record<string, string>; label?: string; sort?: string; desc?: boolean }
    | { kind: "artist"; name: string }
    | { kind: "album"; album: Album };

type Pill = { id: string; label: string; root: Route };
const PILLS: Pill[] = [
    { id: "artists", label: "Artists", root: { kind: "artists" } },
    { id: "albumartists", label: "Album Artists", root: { kind: "albumartists" } },
    { id: "albums", label: "Albums", root: { kind: "albums" } },
    { id: "songs", label: "Songs", root: { kind: "songs" } },
    { id: "playlists", label: "Playlists", root: { kind: "playlists" } },
    { id: "genres", label: "Genres", root: { kind: "genres" } },
    { id: "years", label: "Years", root: { kind: "years" } },
    { id: "recent", label: "Recently Added", root: { kind: "songs", label: "Recently Added", sort: "date_added", desc: true } },
];

// The pills are drag-reorderable; the saved order persists and the first pill
// is the default view when the library opens.
const PILL_ORDER_KEY = "kazoo_pill_order";
function orderedPillList(): Pill[] {
    try {
        const saved: string[] = JSON.parse(localStorage.getItem(PILL_ORDER_KEY) || "[]");
        const byId = new Map(PILLS.map((p) => [p.id, p]));
        const out: Pill[] = [];
        for (const id of saved) {
            const p = byId.get(id);
            if (p) { out.push(p); byId.delete(id); }
        }
        for (const p of PILLS) if (byId.has(p.id)) out.push(p);
        return out;
    } catch { return [...PILLS]; }
}



function fmtDur(sec: number): string {
    if (!sec) return "";
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}
function featuring(t: Track): string {
    const feat = (t.artists || []).filter((a) => a.role === "featuring").map((a) => a.name);
    if (!feat.length || /feat\.?|ft\.?|featuring/i.test(t.title)) return "";
    return ` (feat. ${feat.join(", ")})`;
}
function fmtQuality(t: Track): string {
    const p: string[] = [];
    if (t.codec) p.push(t.codec.toUpperCase());
    if (t.sampleRate) p.push(`${(t.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`);
    if (t.bitrate) p.push(`${t.bitrate} kbps`);
    return p.join(" · ") || "—";
}
function labelFor(r: Route): string {
    switch (r.kind) {
        case "albums": return "Albums";
        case "artists": return "Artists";
        case "albumartists": return "Album Artists";
        case "genres": return "Genres";
        case "years": return "Years";
        case "playlists": return "Playlists";
        case "playlist": return r.playlist.name;
        case "songs": return r.label || "Songs";
        case "artist": return r.name;
        case "album": return r.album.title;
    }
}

// Art is served over HTTP (/cover, /artistart) instead of base64 across the
// JS bridge: the browser lazy-loads offscreen images, decodes off the main
// thread, and caches thumbnails — this is what keeps big grids snappy.
// Bump artVersion (via bustArt) after cover/photo edits to refresh URLs.
let artVersion = 1;
function bustArt() { artVersion++; }
export function coverURL(path: string, size = 320): string {
    return `/cover?path=${encodeURIComponent(path)}&s=${size}&v=${artVersion}`;
}

function Cover({ path, circle, size = 320 }: { path: string; circle?: boolean; size?: number }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => { setFailed(false); }, [path]);
    const r = circle ? "rounded-full" : "rounded-md";
    if (!path || failed) {
        return (
            <div className={`${r} w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card`}>
                <Music className="h-1/3 w-1/3 text-muted-foreground/40" />
            </div>
        );
    }
    return <img src={coverURL(path, size)} alt="" loading="lazy" decoding="async"
        className={`${r} object-cover w-full h-full bg-gradient-to-br from-muted to-card`}
        draggable={false} onError={() => setFailed(true)} />;
}

// --- playback helpers (module-level so grids/menus can use them anywhere) ----
async function playAlbumNow(a: Album) {
    try {
        const ts = await GetAlbumTracks(a.id);
        if (ts.length) playQueue(ts.map(toPlayerTrack));
    } catch (e) { toast.error(`${e}`); }
}
async function queueAlbumTracks(a: Album) {
    try {
        const ts = await GetAlbumTracks(a.id);
        if (ts.length) { addToQueue(ts.map(toPlayerTrack)); toast.success(`Added ${ts.length} track${ts.length === 1 ? "" : "s"} to queue`); }
    } catch (e) { toast.error(`${e}`); }
}
async function queueArtistTracks(name: string) {
    try {
        const q = { search: "", filters: { artist: name }, sort: "title", desc: false, limit: 2000, offset: 0 } as unknown as backend.LibraryQuery;
        const ts = await GetLibraryTracks(q);
        if (ts.length) { addToQueue(ts.map(toPlayerTrack)); toast.success(`Added ${ts.length} track${ts.length === 1 ? "" : "s"} to queue`); }
    } catch (e) { toast.error(`${e}`); }
}

function ArtistCover({ name, fallback, circle }: { name: string; fallback: string; circle?: boolean }) {
    const [failed, setFailed] = useState(false);
    useEffect(() => { setFailed(false); }, [name]);
    if (failed) return <Cover path={fallback} circle={circle} />;
    const r = circle ? "rounded-full" : "rounded-md";
    return <img src={`/artistart?name=${encodeURIComponent(name)}&v=${artVersion}`} alt="" loading="lazy" decoding="async"
        className={`${r} object-cover w-full h-full bg-gradient-to-br from-muted to-card`}
        draggable={false} onError={() => setFailed(true)} />;
}

function SelectBox({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
    const stop = (e: { stopPropagation: () => void; preventDefault: () => void }) => { e.stopPropagation(); e.preventDefault(); };
    return (
        <div
            onPointerDown={stop}
            onMouseDown={stop}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggle(); }}
            className={`absolute top-2 left-2 h-6 w-6 rounded-md border-2 flex items-center justify-center cursor-pointer transition z-20 ${checked ? "bg-primary border-primary text-primary-foreground opacity-100" : "bg-background/70 border-foreground/60 opacity-0 group-hover:opacity-100 hover:border-primary"}`}>
            {checked && <Check className="h-4 w-4" />}
        </div>
    );
}

const GRID = "repeat(auto-fill,minmax(160px,1fr))";

// Sorting is fixed per view (no global sort dropdown): names A–Z everywhere,
// years and artist releases newest→oldest, and "songs" routes may carry their
// own sort (e.g. Recently Added = date added, newest first).
// order release-type sections on an artist page (unknown types appended, then Appears On)
const SECTION_ORDER = ["Albums", "EPs", "Singles", "Compilations", "Live", "Soundtracks", "Demos", "Remixes", "Mixtapes", "DJ-Mixes", "Broadcasts", "Spoken Word", "Field Recordings", "Other"];

// Navigation survives page switches (opening a playlist, visiting Settings…)
// — the component unmounts, so the current view is cached at module level.
let savedNav: { stack: Route[]; activeRootId: string; search: string } | null = null;

// Other pages (e.g. the synced-playlist context menu) land on a library view:
// stash the route, then tell App to switch to the Library page.
let pendingLibraryRoute: Route | null = null;
export function openLibraryArtist(name: string) {
    pendingLibraryRoute = { kind: "artist", name };
    window.dispatchEvent(new CustomEvent("kazoo:open-library"));
}
export function openLibraryAlbum(album: backend.LibraryAlbum) {
    pendingLibraryRoute = { kind: "album", album };
    window.dispatchEvent(new CustomEvent("kazoo:open-library"));
}

export function LibraryPage() {
    const [stack, setStack] = useState<Route[]>(() => savedNav?.stack ?? [orderedPillList()[0].root]);
    const [pills, setPills] = useState<Pill[]>(() => orderedPillList());
    const dragPill = useRef<string | null>(null);
    const [draggingPill, setDraggingPill] = useState<string | null>(null);
    // Live reorder with FLIP animation: capture every pill's position before
    // the order changes, then (below) animate each one from its old spot to
    // its new one so they glide aside instead of snapping.
    const pillRefs = useRef(new Map<string, HTMLButtonElement>());
    const pillRectsBefore = useRef<Map<string, DOMRect> | null>(null);
    const lastPillMove = useRef(0);
    // Stable reorder: only move once the cursor crosses the target's midpoint
    // (idempotent — hovering the same spot always yields the same order), and
    // hold off while the previous slide animation is still playing. Both stop
    // the rapid flip-flopping a naive swap-on-dragover causes.
    const reorderPills = (targetId: string, clientX: number) => {
        const from = dragPill.current;
        if (!from || from === targetId) return;
        if (performance.now() - lastPillMove.current < 200) return;
        const targetEl = pillRefs.current.get(targetId);
        if (!targetEl) return;
        const r = targetEl.getBoundingClientRect();
        const insertBefore = clientX < r.left + r.width / 2;
        const fi = pills.findIndex((p) => p.id === from);
        const ti = pills.findIndex((p) => p.id === targetId);
        if (fi < 0 || ti < 0) return;
        let insert = insertBefore ? ti : ti + 1;
        if (fi < insert) insert--;
        if (insert === fi) return;
        lastPillMove.current = performance.now();
        const rects = new Map<string, DOMRect>();
        pillRefs.current.forEach((el, id) => rects.set(id, el.getBoundingClientRect()));
        pillRectsBefore.current = rects;
        setPills((prev) => {
            const pfi = prev.findIndex((p) => p.id === from);
            if (pfi < 0) return prev;
            const next = [...prev];
            const [moved] = next.splice(pfi, 1);
            next.splice(Math.min(insert, next.length), 0, moved);
            return next;
        });
    };
    useLayoutEffect(() => {
        const before = pillRectsBefore.current;
        if (!before) return;
        pillRectsBefore.current = null;
        pillRefs.current.forEach((el, id) => {
            const old = before.get(id);
            if (!old) return;
            const now = el.getBoundingClientRect();
            const dx = old.left - now.left;
            const dy = old.top - now.top;
            if (dx === 0 && dy === 0) return;
            el.style.transition = "none";
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            requestAnimationFrame(() => {
                el.style.transition = "transform 180ms ease";
                el.style.transform = "";
            });
        });
    }, [pills]);
    const finishPillDrag = () => {
        dragPill.current = null;
        setDraggingPill(null);
        setPills((prev) => {
            localStorage.setItem(PILL_ORDER_KEY, JSON.stringify(prev.map((p) => p.id)));
            return prev;
        });
    };
    // Sidebar "Library" clicked while already here → back to the root view,
    // with the first pill selected to match.
    useEffect(() => {
        const onHome = () => {
            const first = orderedPillList()[0];
            setSearch("");
            setActiveRootId(first.id);
            setStack([first.root]);
        };
        window.addEventListener("kazoo:library-home", onHome);
        return () => window.removeEventListener("kazoo:library-home", onHome);
    }, []);
    const route = stack[stack.length - 1];
    const [activeRootId, setActiveRootId] = useState(() => savedNav?.activeRootId ?? orderedPillList()[0].id);

    const [albums, setAlbums] = useState<Album[]>([]);
    const [artists, setArtists] = useState<Artist[]>([]);
    const [songs, setSongs] = useState<Track[]>([]);
    const [facets, setFacets] = useState<backend.Facet[]>([]);
    const [artistReleases, setArtistReleases] = useState<backend.ArtistReleases | null>(null);
    const [albumTracks, setAlbumTracks] = useState<Track[]>([]);
    const [playlists, setPlaylists] = useState<Playlist[]>([]);
    const [syncedPls, setSyncedPls] = useState<backend.SyncedPlaylist[]>([]);
    const [playlistTracks, setPlaylistTracks] = useState<Track[]>([]);
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [selKind, setSelKind] = useState<"songs" | "albums" | "artists" | "">("");
    const [editorIds, setEditorIds] = useState<number[] | null>(null);
    const lastIdx = useRef(-1);
    const [creditsTrack, setCreditsTrack] = useState<Track | null>(null);
    const [editArtist, setEditArtist] = useState<string | null>(null);
    const [matchArtist, setMatchArtist] = useState<string | null>(null);
    const [artBust, setArtBust] = useState(0);
    const [nameDialog, setNameDialog] = useState<{ title: string; value: string; submit: (v: string) => void } | null>(null);

    const [search, setSearch] = useState(savedNav?.search ?? "");
    useEffect(() => {
        savedNav = { stack, activeRootId, search };
    }, [stack, activeRootId, search]);
    const [stats, setStats] = useState<backend.LibStats | null>(null);
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [foldersOpen, setFoldersOpen] = useState(false);
    const [folders, setFolders] = useState<LibFolder[]>([]);
    const searchTimer = useRef<number | null>(null);

    const push = (r: Route) => {
        setStack((s) => [...s, r]);
    };
    const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    const setRoot = (p: Pill) => { setSearch(""); setActiveRootId(p.id); setStack([p.root]); };
    const gotoCrumb = (i: number) => setStack((s) => s.slice(0, i + 1));

    // Open a route pushed from another page (also handles the case where the
    // library was already mounted when it was pushed).
    useEffect(() => {
        const consume = () => {
            if (pendingLibraryRoute) {
                const r = pendingLibraryRoute;
                pendingLibraryRoute = null;
                setStack((s) => [...s, r]);
            }
        };
        consume();
        window.addEventListener("kazoo:open-library", consume);
        return () => window.removeEventListener("kazoo:open-library", consume);
    }, []);

    const selectAt = (kind: "songs" | "albums" | "artists", keys: string[], index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
        const key = keys[index];
        setSelKind(kind);
        setSel((prev) => {
            if (e.shiftKey && lastIdx.current >= 0) {
                const next = new Set(prev);
                const [a, b] = lastIdx.current < index ? [lastIdx.current, index] : [index, lastIdx.current];
                for (let i = a; i <= b; i++) next.add(keys[i]);
                return next;
            }
            if (e.ctrlKey || e.metaKey) {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
            }
            return new Set([key]); // plain click → single
        });
        lastIdx.current = index;
    };
    const toggleOne = (kind: "songs" | "albums" | "artists", key: string) => {
        setSelKind(kind);
        setSel((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
    };
    const clearSel = () => { setSel(new Set()); setSelKind(""); lastIdx.current = -1; };
    const openBulkEdit = async () => {
        const keys = [...sel];
        let ids: number[] = [];
        try {
            if (selKind === "songs") ids = keys.map(Number);
            else if (selKind === "albums") ids = await TrackIDsForAlbums(keys);
            else if (selKind === "artists") ids = await TrackIDsForArtists(keys);
        } catch (e) { toast.error(`${e}`); return; }
        if (!ids.length) { toast.error("No tracks to edit"); return; }
        setEditorIds(ids);
    };
    const editAlbumMeta = async (a: Album) => {
        try { const ids = await TrackIDsForAlbums([a.id]); if (ids.length) setEditorIds(ids); else toast.error("No tracks in album"); }
        catch (e) { toast.error(`${e}`); }
    };

    // Delete = remove from library AND delete files from disk (with the
    // watcher auto-scanning, "remove from library only" would just re-add).
    const [confirmDelete, setConfirmDelete] = useState<{ ids: number[]; label: string; albumId?: string } | null>(null);
    const [infoTrackId, setInfoTrackId] = useState<number | null>(null);
    const [deleting, setDeleting] = useState(false);
    const openDeleteSelection = async () => {
        const keys = [...sel];
        let ids: number[] = [];
        try {
            if (selKind === "songs") ids = keys.map(Number);
            else if (selKind === "albums") ids = await TrackIDsForAlbums(keys);
            else if (selKind === "artists") ids = await TrackIDsForArtists(keys);
        } catch (e) { toast.error(`${e}`); return; }
        if (!ids.length) { toast.error("Nothing to delete"); return; }
        const noun = selKind === "albums" ? "album" : selKind === "artists" ? "artist" : "song";
        setConfirmDelete({ ids, label: `${sel.size} ${noun}${sel.size === 1 ? "" : "s"} (${ids.length} track${ids.length === 1 ? "" : "s"})` });
    };
    const queuePlaylist = async (p: Playlist) => {
        try {
            const ts = await GetPlaylistTracks(p.id);
            if (!ts.length) { toast.info("Playlist is empty"); return; }
            addToQueue(ts.map(toPlayerTrack));
            toast.success(`Added ${plural(ts.length, "track")} to queue`);
        } catch (e) { toast.error(`${e}`); }
    };
    const deleteArtist = async (name: string) => {
        try {
            const ids = await TrackIDsForArtists([name]);
            if (!ids.length) { toast.error("No tracks for this artist"); return; }
            setConfirmDelete({ ids, label: `"${name}" (${plural(ids.length, "track")})` });
        } catch (e) { toast.error(`${e}`); }
    };
    const refreshTrackIds = async (ids: number[]) => {
        if (!ids.length) { toast.info("No tracks to refresh"); return; }
        try {
            const n = await RefreshTrackMetadata(ids);
            toast.success(`Refreshed metadata for ${plural(n, "track")}`);
            load(); loadStats();
        } catch (e) { toast.error(`${e}`); }
    };
    const refreshArtistTracks = async (name: string) => {
        try { await refreshTrackIds(await TrackIDsForArtists([name])); } catch (e) { toast.error(`${e}`); }
    };
    const refreshAlbum = async (a: Album) => {
        try { await refreshTrackIds(await TrackIDsForAlbums([a.id])); } catch (e) { toast.error(`${e}`); }
    };
    const deleteAlbum = async (a: Album) => {
        try {
            const ids = await TrackIDsForAlbums([a.id]);
            if (!ids.length) {
                // Album made entirely of borrowed (linked) tracks — removing it
                // only drops the links; the files belong to other albums.
                await DeleteAlbumRefs(a.id);
                toast.success("Removed album (linked tracks stay in their own albums)");
                load(); loadStats();
                return;
            }
            setConfirmDelete({ ids, label: `"${a.title}" (${ids.length} track${ids.length === 1 ? "" : "s"})`, albumId: a.id });
        } catch (e) { toast.error(`${e}`); }
    };
    const doDelete = async () => {
        if (!confirmDelete || deleting) return;
        setDeleting(true);
        try {
            const n = await DeleteLibraryTracks(confirmDelete.ids);
            if (confirmDelete.albumId) await DeleteAlbumRefs(confirmDelete.albumId).catch(() => { });
            toast.success(`Deleted ${n} track${n === 1 ? "" : "s"} from library and disk`);
            setConfirmDelete(null);
            clearSel();
            load(); loadStats(); loadPlaylists();
        } catch (e) { toast.error(`${e}`); }
        finally { setDeleting(false); }
    };

    const primaryArtist = (t: Track) =>
        (t.artists || []).find((a) => a.role === "primary")?.name
        || (t.artists || [])[0]?.name
        || (t.artist || "").split(",")[0].trim();

    const handleTrackAction = (action: string, t: Track, arg?: number) => {
        switch (action) {
            case "artist": {
                const n = primaryArtist(t);
                if (n) push({ kind: "artist", name: n }); else toast.error("No artist for this track.");
                break;
            }
            case "album":
                if (!t.albumId) { toast.error("This track has no album."); break; }
                push({
                    kind: "album", album: backend.LibraryAlbum.createFrom({
                        id: t.albumId, title: t.album, albumArtist: t.albumArtist,
                        year: t.year, trackCount: 0, coverPath: t.path, releaseType: "",
                    }),
                });
                break;
            case "credits": setCreditsTrack(t); break;
            case "addtoplaylist": if (arg) addToPlaylist(arg, [t.id]); break;
            case "newplaylist": newPlaylist([t.id]); break;
            case "removefromplaylist":
                if (arg) RemoveTrackFromPlaylist(arg, t.id).then(() => { toast.success("Removed from playlist"); load(); loadPlaylists(); }).catch((e) => toast.error(`${e}`));
                break;
            case "metadata": setEditorIds([t.id]); break;
            case "queue": addToQueue([toPlayerTrack(t)]); toast.success("Added to queue"); break;
            case "delete": setConfirmDelete({ ids: [Number(t.id)], label: `"${t.title}"` }); break;
            case "info": setInfoTrackId(Number(t.id)); break;
            case "refresh":
                RefreshTrackMetadata([Number(t.id)])
                    .then(() => { toast.success("Metadata refreshed"); load(); loadStats(); })
                    .catch((e) => toast.error(`${e}`));
                break;
        }
    };
    const goArtist = (name: string) => { if (name) push({ kind: "artist", name }); };

    const loadStats = useCallback(async () => { try { setStats(await GetLibraryStats()); } catch { /* */ } }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            if (route.kind === "albums") setAlbums(await GetLibraryAlbums(search, "name", false));
            else if (route.kind === "artists") setArtists(await GetLibraryArtistsList(search, "name", false));
            else if (route.kind === "albumartists") setArtists(await GetLibraryAlbumArtists(search, "name", false));
            else if (route.kind === "genres" || route.kind === "years") {
                const f = await GetLibraryFacets(route.kind === "genres" ? "genre" : "year");
                // Genres A–Z; years newest first.
                f.sort((a, b) => route.kind === "years"
                    ? b.value.localeCompare(a.value)
                    : a.value.localeCompare(b.value));
                setFacets([...f]);
            } else if (route.kind === "songs") {
                const q = {
                    search, filters: route.filters || {},
                    sort: route.sort || "title",
                    desc: route.desc || false,
                    limit: 2000, offset: 0,
                } as unknown as backend.LibraryQuery;
                setSongs(await GetLibraryTracks(q));
            } else if (route.kind === "artist") setArtistReleases(await GetArtistReleases(route.name, "year", true));
            else if (route.kind === "album") setAlbumTracks(await GetAlbumTracks(route.album.id));
            else if (route.kind === "playlists") {
                setPlaylists(await GetPlaylists());
                try { setSyncedPls(await ListSyncedPlaylists() || []); } catch { setSyncedPls([]); }
            }
            else if (route.kind === "playlist") setPlaylistTracks(await GetPlaylistTracks(route.playlist.id));
        } catch (e) { toast.error(`${e}`); }
        finally { setLoading(false); }
    }, [stack, search]); // eslint-disable-line react-hooks/exhaustive-deps

    const loadPlaylists = useCallback(async () => { try { setPlaylists(await GetPlaylists()); } catch { /* */ } }, []);
    useEffect(() => { loadPlaylists(); }, [loadPlaylists]);

    const addToPlaylist = async (playlistID: number, trackIDs: number[]) => {
        try {
            const n = await AddTracksToPlaylist(playlistID, trackIDs);
            toast.success(n > 0 ? `Added ${n} to playlist` : "Already in playlist");
            loadPlaylists();
        } catch (e) { toast.error(`${e}`); }
    };
    const newPlaylist = (trackIDs?: number[]) => setNameDialog({
        title: "New playlist", value: "",
        submit: async (name) => {
            try {
                const id = await CreatePlaylist(name);
                if (trackIDs && trackIDs.length) await AddTracksToPlaylist(id, trackIDs);
                toast.success(`Created "${name}"`);
                loadPlaylists();
            } catch (e) { toast.error(`${e}`); }
        },
    });
    const syncPlaylistPrompt = () => setNameDialog({
        title: "Sync Spotify playlist", value: "",
        submit: async (url) => {
            try {
                const p = await SyncSpotifyPlaylist(url);
                toast.success(`"${p.name}" synced`);
                try { setSyncedPls(await ListSyncedPlaylists() || []); } catch { /* */ }
            } catch (e) { toast.error(`${e}`); }
        },
    });
    const renamePlaylist = (p: Playlist) => setNameDialog({
        title: "Rename playlist", value: p.name,
        submit: async (name) => { try { await RenamePlaylist(p.id, name); loadPlaylists(); load(); } catch (e) { toast.error(`${e}`); } },
    });
    const removePlaylist = async (p: Playlist) => {
        try { await DeletePlaylist(p.id); toast.success(`Deleted "${p.name}"`); if (route.kind === "playlist") back(); loadPlaylists(); }
        catch (e) { toast.error(`${e}`); }
    };

    useEffect(() => { load(); }, [load]);
    useEffect(() => { loadStats(); }, [loadStats]);
    useEffect(() => { setSel(new Set()); setSelKind(""); lastIdx.current = -1; }, [stack]);
    useEffect(() => {
        const off = EventsOn("library:scan-progress", (p: { done: number; total: number }) => setProgress(p));
        return () => { off(); };
    }, []);

    const loadFolders = useCallback(async () => { try { setFolders(await GetLibraryFolders()); } catch { /* */ } }, []);
    useEffect(() => { if (foldersOpen) loadFolders(); }, [foldersOpen, loadFolders]);

    // Post-scan Spotify enrichment (Plex-style agent pass): fill missing artist
    // photos/banners/bios in the background, throttled backend-side.
    const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null);
    const enrichRunning = useRef(false);
    const enrichLibrary = useCallback(async () => {
        if (enrichRunning.current) return;
        enrichRunning.current = true;
        try {
            const names = await ListArtistsNeedingEnrichment();
            if (!names || names.length === 0) return;
            setEnrichProgress({ done: 0, total: names.length });
            let changed = false;
            for (let i = 0; i < names.length; i++) {
                try {
                    const r = await EnrichLibraryArtist(names[i]);
                    if (r.photo || r.banner || r.bio) changed = true;
                } catch { /* keep going — offline or no match */ }
                setEnrichProgress({ done: i + 1, total: names.length });
            }
            if (changed) { bustArt(); setArtBust((b) => b + 1); }
        } catch { /* enrichment is best-effort */ }
        finally { enrichRunning.current = false; setEnrichProgress(null); }
    }, []);

    // Realtime watcher: the backend scans changed folders the moment files
    // land on disk and tells us what happened — just refresh and notify.
    useEffect(() => {
        // Batch downloads fire one event per imported file; coalesce bursts
        // into a single refresh + toast so the UI stays smooth mid-download.
        let timer: ReturnType<typeof setTimeout> | null = null;
        let pendingAdded = 0;
        let pendingRemoved = 0;
        const off = EventsOn("library:changed", (ch: { added: number; updated: number; removed: number }) => {
            pendingAdded += ch?.added || 0;
            pendingRemoved += ch?.removed || 0;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                bustArt();
                void load(); void loadStats();
                if (pendingAdded > 0) {
                    toast.info(`Library updated — ${pendingAdded.toLocaleString()} new track${pendingAdded === 1 ? "" : "s"}`);
                    void enrichLibrary();
                } else if (pendingRemoved > 0) {
                    toast.info(`Library updated — ${pendingRemoved.toLocaleString()} track${pendingRemoved === 1 ? "" : "s"} removed`);
                }
                pendingAdded = 0;
                pendingRemoved = 0;
            }, 2500);
        });
        return () => { off(); if (timer) clearTimeout(timer); };
    }, [load, loadStats, enrichLibrary]);

    // Safety-net scanning: a quiet incremental pass on startup and every 15
    // minutes catches anything the realtime watcher missed (e.g. changes made
    // while the app was closed). Unchanged files are skipped by mtime.
    const autoScanRunning = useRef(false);
    useEffect(() => {
        const autoScan = async (retryEnrich: boolean) => {
            if (autoScanRunning.current || enrichRunning.current) return;
            autoScanRunning.current = true;
            try {
                const res = await RescanLibraryQuiet();
                if (res.added > 0 || res.updated > 0 || (res.removed || 0) > 0) {
                    bustArt();
                    await Promise.all([load(), loadStats()]);
                    if (res.added > 0) toast.info(`Library updated — ${res.added.toLocaleString()} new track${res.added === 1 ? "" : "s"}`);
                    else if ((res.removed || 0) > 0) toast.info(`Library cleaned up — ${res.removed.toLocaleString()} stale entr${res.removed === 1 ? "y" : "ies"} removed`);
                    retryEnrich = true;
                }
            } catch { /* library may be empty or not initialized yet */ }
            finally { autoScanRunning.current = false; }
            // On startup, retry artists that previously failed to match even
            // when nothing on disk changed — the matcher may do better now.
            if (retryEnrich) void enrichLibrary();
        };
        const startup = window.setTimeout(() => {
            const retry = !enrichRetryRan;
            enrichRetryRan = true;
            void autoScan(retry);
        }, 4000);
        const interval = window.setInterval(() => autoScan(false), 15 * 60 * 1000);
        return () => { window.clearTimeout(startup); window.clearInterval(interval); };
    }, [load, loadStats, enrichLibrary]);

    // Plex's "Refresh All Metadata": re-pull every artist's Spotify data,
    // replacing stale auto-fetched fields. Locked (hand-edited) fields survive.
    const refreshAllMetadata = useCallback(async () => {
        if (enrichRunning.current) return;
        enrichRunning.current = true;
        try {
            const artists = await GetLibraryArtistsList("", "name", false);
            const names = (artists || []).map((a) => a.name).filter(Boolean);
            if (names.length === 0) { toast.info("No artists in the library yet"); return; }
            setEnrichProgress({ done: 0, total: names.length });
            let matched = 0;
            for (let i = 0; i < names.length; i++) {
                try {
                    const r = await RefreshArtistMetadata(names[i]);
                    if (r.matched) matched++;
                } catch { /* keep going */ }
                setEnrichProgress({ done: i + 1, total: names.length });
            }
            bustArt(); setArtBust((b) => b + 1);
            toast.success(`Refreshed metadata for ${matched.toLocaleString()} of ${names.length.toLocaleString()} artists`);
        } finally { enrichRunning.current = false; setEnrichProgress(null); }
    }, []);

    const addFolder = async () => {
        const folder = await SelectFolder("");
        if (!folder) return;
        const wasFirst = folders.length === 0;
        setScanning(true); setProgress({ done: 0, total: 0 });
        try {
            const res = await ScanLibraryFolder(folder);
            toast.success(`Scanned: ${res.added} added, ${res.updated} updated, ${res.skipped} unchanged`);
            // Downloads always live in the library: the first folder is the destination.
            if (wasFirst) {
                await saveSettings({ ...getSettings(), downloadPath: folder });
            }
            await Promise.all([loadFolders(), load(), loadStats()]);
            void enrichLibrary();
        } catch (e) { toast.error(`Scan failed: ${e}`); }
        finally { setScanning(false); setProgress(null); }
    };
    const removeFolder = async (p: string) => {
        try {
            const n = await RemoveLibraryFolder(p);
            toast.success(`Removed ${plural(n, "track")} from library`);
            // Keep downloads pointed at a folder that is still in the library.
            const remaining = await GetLibraryFolders();
            setFolders(remaining);
            const s = getSettings();
            if (normFolderPath(s.downloadPath || "") === normFolderPath(p)) {
                await saveSettings({ ...s, downloadPath: remaining[0]?.path || "" });
            }
            await Promise.all([load(), loadStats()]);
        } catch (e) { toast.error(`${e}`); }
    };
    const rescanAll = async () => {
        setScanning(true); setProgress({ done: 0, total: 0 });
        try {
            const res = await RescanLibrary();
            bustArt();
            toast.success(`Rescanned: ${res.updated} updated, ${res.added} added`);
            await Promise.all([loadFolders(), load(), loadStats()]);
            void enrichLibrary();
        } catch (e) { toast.error(`Rescan failed: ${e}`); }
        finally { setScanning(false); setProgress(null); }
    };

    const onSearch = (v: string) => {
        if (searchTimer.current) window.clearTimeout(searchTimer.current);
        searchTimer.current = window.setTimeout(() => setSearch(v), 250);
    };

    return (
        <div className="flex flex-col h-full bg-background text-foreground relative">
            <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                <h1 className="text-2xl font-bold tracking-tight">Your Library</h1>
                {stats && (
                    <span className="text-xs text-muted-foreground mt-1">
                        {plural(stats.tracks, "song")} · {plural(stats.albums, "album")} · {plural(stats.artists, "artist")}
                    </span>
                )}
                {enrichProgress && (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                        <Spinner className="h-3 w-3" /> artist info {enrichProgress.done}/{enrichProgress.total}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <input
                            placeholder="Search"
                            className="h-9 w-52 rounded-full bg-muted focus:bg-accent pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground"
                            onChange={(e) => onSearch(e.target.value)}
                        />
                    </div>
                    <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setFoldersOpen(true)}>
                        <FolderCog className="h-4 w-4 mr-1.5" /> Folders
                    </Button>
                </div>
            </div>

            {/* view pills — drag to reorder; the first one is the default view.
                Only shown at the library root, not inside drill-in views. */}
            {stack.length === 1 && (
            <div className="px-6 pb-2 flex items-center gap-2 flex-wrap">
                {pills.map((p) => (
                    <button key={p.id} onClick={() => setRoot(p)}
                        ref={(el) => { if (el) pillRefs.current.set(p.id, el); else pillRefs.current.delete(p.id); }}
                        draggable
                        onDragStart={(e) => { dragPill.current = p.id; setDraggingPill(p.id); e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={(e) => { e.preventDefault(); reorderPills(p.id, e.clientX); }}
                        onDrop={(e) => { e.preventDefault(); finishPillDrag(); }}
                        onDragEnd={finishPillDrag}
                        title="Drag to reorder — the first pill is the library's default view"
                        className={`px-3 py-1 rounded-full text-sm font-medium transition cursor-pointer ${draggingPill === p.id ? "opacity-40 scale-95" : ""} ${activeRootId === p.id ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-accent"}`}>
                        {p.label}
                    </button>
                ))}
            </div>
            )}

            {scanning && progress && (
                <div className="px-6 pb-1 text-xs text-muted-foreground">Scanning… {progress.done}{progress.total ? ` / ${progress.total}` : ""}</div>
            )}

            {stack.length > 1 && (
                <div className="px-6 pb-2 flex items-center gap-1 text-sm">
                    <button onClick={back} className="mr-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
                    {stack.map((r, i) => (
                        <Fragment key={i}>
                            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                            <button onClick={() => gotoCrumb(i)}
                                className={`truncate max-w-[200px] ${i === stack.length - 1 ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}>
                                {labelFor(r)}
                            </button>
                        </Fragment>
                    ))}
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-6 py-3">
                {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Spinner className="h-4 w-4" /> Loading…</div>}

                {!loading && route.kind === "albums" && (
                    albums.length === 0 ? <Empty onOpen={() => setFoldersOpen(true)} /> :
                        <AlbumGrid albums={albums} onOpen={(a) => push({ kind: "album", album: a })} onArtist={goArtist} onEdit={editAlbumMeta} onDelete={deleteAlbum} onRefresh={refreshAlbum}
                            selectedKeys={sel} onSelect={(i, e) => selectAt("albums", albums.map((a) => a.id), i, e)} onToggle={(key) => toggleOne("albums", key)} />
                )}

                {!loading && (route.kind === "artists" || route.kind === "albumartists") && (
                    artists.length === 0 ? <Empty onOpen={() => setFoldersOpen(true)} /> :
                        <div className="grid gap-4" style={{ gridTemplateColumns: GRID }}>
                            {artists.map((a, i) => (
                                <ContextMenu key={a.name}>
                                    <ContextMenuTrigger asChild>
                                        <button onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) selectAt("artists", artists.map((x) => x.name), i, e); else push({ kind: "artist", name: a.name }); }}
                                            className={`group text-center rounded-lg p-3 transition ${sel.has(a.name) ? "bg-accent ring-2 ring-primary" : "bg-card hover:bg-accent"}`}>
                                            <div className="relative aspect-square mb-3"><ArtistCover name={a.name} fallback={a.coverPath} circle /><SelectBox checked={sel.has(a.name)} onToggle={() => toggleOne("artists", a.name)} /></div>
                                            <div className="font-semibold truncate text-sm">{a.name}</div>
                                            <div className="text-xs text-muted-foreground mt-0.5">{plural(a.trackCount, "song")}</div>
                                        </button>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent className="w-44">
                                        <ContextMenuItem onSelect={() => push({ kind: "artist", name: a.name })}><User className="h-4 w-4 mr-2" /> Go to artist</ContextMenuItem>
                                        <ContextMenuItem onSelect={() => push({ kind: "songs", filters: { artist: a.name }, label: a.name })}><ListMusic className="h-4 w-4 mr-2" /> View all songs</ContextMenuItem>
                                        <ContextMenuItem onSelect={() => void queueArtistTracks(a.name)}><ListEnd className="h-4 w-4 mr-2" /> Add to queue</ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem onSelect={() => setEditArtist(a.name)}><Pencil className="h-4 w-4 mr-2" /> Edit artist metadata</ContextMenuItem>
                                        <ContextMenuItem onSelect={() => setMatchArtist(a.name)}><Link2 className="h-4 w-4 mr-2" /> Fix match…</ContextMenuItem>
                                        <ContextMenuItem onSelect={() => void refreshArtistTracks(a.name)}><RefreshCw className="h-4 w-4 mr-2" /> Refresh metadata</ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => void deleteArtist(a.name)}><Trash2 className="h-4 w-4 mr-2" /> Delete from library</ContextMenuItem>
                                    </ContextMenuContent>
                                </ContextMenu>
                            ))}
                        </div>
                )}

                {!loading && route.kind === "songs" && (
                    songs.length === 0 ? <Empty onOpen={() => setFoldersOpen(true)} /> :
                        <SongList tracks={songs} onAction={handleTrackAction} playlists={playlists}
                            selectedKeys={sel} onRowClick={(i, e) => selectAt("songs", songs.map((t) => String(t.id)), i, e)}
                            onPlay={(i) => playQueue(songs.map(toPlayerTrack), i)} />
                )}

                {!loading && route.kind === "playlists" && (
                    <div className="grid gap-4" style={{ gridTemplateColumns: GRID }}>
                        <button onClick={() => newPlaylist()}
                            className="bg-card hover:bg-accent transition rounded-lg p-3 flex flex-col items-center justify-center aspect-[3/4] text-muted-foreground gap-2">
                            <Plus className="h-8 w-8" /><span className="text-sm font-medium">New Playlist</span>
                        </button>
                        <button onClick={syncPlaylistPrompt}
                            className="bg-card hover:bg-accent transition rounded-lg p-3 flex flex-col items-center justify-center aspect-[3/4] text-muted-foreground gap-2">
                            <Link2 className="h-8 w-8" /><span className="text-sm font-medium">Sync Spotify Playlist</span>
                        </button>
                        {playlists.map((p) => (
                            <ContextMenu key={p.id}>
                                <ContextMenuTrigger asChild>
                                    <button onClick={() => push({ kind: "playlist", playlist: p })}
                                        className="group text-left bg-card hover:bg-accent transition rounded-lg p-3">
                                        <div className="relative aspect-square mb-3">
                                            {p.coverPath ? <Cover path={p.coverPath} /> :
                                                <div className="w-full h-full rounded-md flex items-center justify-center bg-gradient-to-br from-muted to-card"><ListMusic className="h-1/3 w-1/3 text-muted-foreground/40" /></div>}
                                        </div>
                                        <div className="font-semibold truncate text-sm">{p.name}</div>
                                        <div className="text-xs text-muted-foreground mt-0.5">{plural(p.trackCount, "song")}</div>
                                    </button>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-44">
                                    <ContextMenuItem onSelect={() => push({ kind: "playlist", playlist: p })}><ListMusic className="h-4 w-4 mr-2" /> Open</ContextMenuItem>
                                    <ContextMenuItem onSelect={() => void queuePlaylist(p)}><ListEnd className="h-4 w-4 mr-2" /> Add to queue</ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem onSelect={() => renamePlaylist(p)}><Pencil className="h-4 w-4 mr-2" /> Rename</ContextMenuItem>
                                    <ContextMenuItem onSelect={() => removePlaylist(p)}><Trash2 className="h-4 w-4 mr-2" /> Delete</ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        ))}
                        {syncedPls.map((p) => (
                            <ContextMenu key={`sync-${p.id}`}>
                                <ContextMenuTrigger asChild>
                                    <button onClick={() => openSpotifyPlaylistView(p.url)}
                                        className="group text-left bg-card hover:bg-accent transition rounded-lg p-3">
                                        <div className="relative aspect-square mb-3">
                                            {p.cover ? <img src={p.cover} alt="" className="w-full h-full rounded-md object-cover" /> :
                                                <div className="w-full h-full rounded-md flex items-center justify-center bg-gradient-to-br from-muted to-card"><ListMusic className="h-1/3 w-1/3 text-muted-foreground/40" /></div>}
                                            <span className="absolute top-1.5 left-1.5 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-primary/80 text-primary-foreground">
                                                Synced
                                            </span>
                                        </div>
                                        <div className="font-semibold truncate text-sm">{p.name || "Playlist"}</div>
                                        <div className="text-xs text-muted-foreground mt-0.5">
                                            {p.haveCount} of {plural(p.total, "song")} in library
                                        </div>
                                    </button>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-44">
                                    <ContextMenuItem onSelect={() => openSpotifyPlaylistView(p.url)}><ListMusic className="h-4 w-4 mr-2" /> Open</ContextMenuItem>
                                    <ContextMenuItem onSelect={async () => {
                                        try { await RemoveSyncedPlaylist(p.id); setSyncedPls((s) => s.filter((x) => x.id !== p.id)); }
                                        catch (e) { toast.error(`${e}`); }
                                    }}><Trash2 className="h-4 w-4 mr-2" /> Remove sync</ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        ))}
                    </div>
                )}

                {!loading && route.kind === "playlist" && (
                    <div>
                        <div className="flex gap-6 items-end mb-6">
                            <div className="h-48 w-48 shrink-0 shadow-2xl rounded-md overflow-hidden">
                                {route.playlist.coverPath ? <Cover path={route.playlist.coverPath} /> :
                                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-card"><ListMusic className="h-1/3 w-1/3 text-muted-foreground/40" /></div>}
                            </div>
                            <div className="min-w-0">
                                <div className="text-xs uppercase tracking-wide text-muted-foreground">Playlist</div>
                                <div className="text-4xl font-bold truncate leading-tight mt-1">{route.playlist.name}</div>
                                <div className="text-sm text-muted-foreground mt-2">{plural(playlistTracks.length, "song")}</div>
                            </div>
                        </div>
                        {playlistTracks.length === 0
                            ? <div className="text-sm text-muted-foreground">Empty playlist — right-click any song and use <b>Add to playlist</b>.</div>
                            : <SongList tracks={playlistTracks} onAction={handleTrackAction} playlists={playlists} playlistId={route.playlist.id}
                                selectedKeys={sel} onRowClick={(i, e) => selectAt("songs", playlistTracks.map((t) => String(t.id)), i, e)}
                                onPlay={(i) => playQueue(playlistTracks.map(toPlayerTrack), i)} />}
                    </div>
                )}

                {!loading && (route.kind === "genres" || route.kind === "years") && (
                    facets.length === 0 ? <Empty onOpen={() => setFoldersOpen(true)} /> :
                        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))" }}>
                            {facets.map((f) => {
                                const field = route.kind === "genres" ? "genre" : "year";
                                return (
                                    <button key={f.value} onClick={() => push({ kind: "songs", filters: { [field]: f.value }, label: f.value })}
                                        className="text-left bg-card hover:bg-accent transition rounded-lg p-4 h-24 flex flex-col justify-between">
                                        <div className="font-semibold truncate">{f.value}</div>
                                        <div className="text-xs text-muted-foreground">{plural(f.count, "song")}</div>
                                    </button>
                                );
                            })}
                        </div>
                )}

                {!loading && route.kind === "artist" && artistReleases && (
                    <ArtistView releases={artistReleases} name={route.name} bust={artBust}
                        onOpenAlbum={(a) => push({ kind: "album", album: a })}
                        onAllSongs={() => push({ kind: "songs", filters: { artist: route.name }, label: route.name })}
                        onArtist={goArtist} onEdit={editAlbumMeta} onEditArtist={() => setEditArtist(route.name)}
                        onFixMatch={() => setMatchArtist(route.name)}
                        onArtChanged={() => { bustArt(); setArtBust((b) => b + 1); }}
                        selectedKeys={sel} onToggle={(key) => toggleOne("albums", key)} />
                )}

                {!loading && route.kind === "album" && (
                    <div>
                        <div className="flex gap-6 items-end mb-6">
                            <div className="h-48 w-48 shrink-0 shadow-2xl rounded-md overflow-hidden"><Cover path={route.album.coverPath} size={640} /></div>
                            <div className="min-w-0">
                                <div className="text-xs uppercase tracking-wide text-muted-foreground">Album</div>
                                <div className="text-4xl font-bold truncate leading-tight mt-1">{route.album.title}</div>
                                <div className="text-sm text-muted-foreground mt-2">
                                    <button className="text-foreground font-medium hover:underline"
                                        onClick={() => push({ kind: "artist", name: route.album.albumArtist })}>
                                        {route.album.albumArtist}
                                    </button>
                                    {route.album.year ? ` · ${route.album.year}` : ""} · {plural(albumTracks.length, "song")}
                                    {(route.album as any).totalTracks > albumTracks.length && (
                                        <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-amber-500/15 text-amber-500" title={`This release has ${(route.album as any).totalTracks} tracks; you have ${albumTracks.length}.`}>
                                            Incomplete · {albumTracks.length}/{(route.album as any).totalTracks}
                                        </span>
                                    )}
                                </div>
                                <Button variant="secondary" size="sm" className="mt-3" onClick={() => editAlbumMeta(route.album)}>
                                    <Pencil className="h-4 w-4 mr-1.5" /> Edit album
                                </Button>
                            </div>
                        </div>
                        <SongList tracks={albumTracks} numbered onAction={handleTrackAction} playlists={playlists}
                            selectedKeys={sel} onRowClick={(i, e) => selectAt("songs", albumTracks.map((t) => String(t.id)), i, e)}
                            onPlay={(i) => playQueue(albumTracks.map(toPlayerTrack), i)} />
                    </div>
                )}
            </div>

            <FolderManager
                open={foldersOpen} onOpenChange={setFoldersOpen}
                folders={folders} onAdd={addFolder} onRemove={removeFolder} onRescan={rescanAll} scanning={scanning}
                onRefreshMetadata={() => void refreshAllMetadata()} refreshing={enrichProgress !== null}
            />
            {sel.size > 0 && (
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-card border border-border rounded-full shadow-2xl px-3 py-2 flex items-center gap-2 z-20">
                    <span className="text-sm font-medium px-2">{sel.size} {selKind === "albums" ? "album" : selKind === "artists" ? "artist" : "song"}{sel.size === 1 ? "" : "s"} selected</span>
                    <Button size="sm" onClick={openBulkEdit}><Pencil className="h-4 w-4 mr-1.5" /> Edit metadata</Button>
                    {selKind === "songs" && <Button size="sm" variant="secondary" onClick={() => newPlaylist([...sel].map(Number))}>Add to playlist</Button>}
                    <Button size="sm" variant="destructive" onClick={openDeleteSelection}><Trash2 className="h-4 w-4 mr-1.5" /> Delete</Button>
                    <button onClick={clearSel} className="h-7 w-7 rounded-full hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
                </div>
            )}
            <Dialog open={!!confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete from library?</DialogTitle>
                        <DialogDescription>
                            {confirmDelete?.label} will be removed from the library and the files
                            will be permanently deleted from disk. This can't be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={deleting}>Cancel</Button>
                        <Button variant="destructive" onClick={doDelete} disabled={deleting}>
                            {deleting && <Spinner className="h-4 w-4 mr-1.5" />} Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <TrackInfoDialog trackId={infoTrackId} onClose={() => setInfoTrackId(null)} />
            <TrackEditor ids={editorIds} onClose={() => setEditorIds(null)} onSaved={() => { bustArt(); clearSel(); load(); loadStats(); loadPlaylists(); }} />
            <MatchDialog name={matchArtist} onClose={() => setMatchArtist(null)} onMatched={() => {
                bustArt(); setArtBust((b) => b + 1);
            }} />
            <ArtistEditor name={editArtist} onClose={() => setEditArtist(null)} onSaved={(newName) => {
                bustArt(); loadStats(); setArtBust((b) => b + 1);
                if (route.kind === "artist" && route.name === editArtist && newName !== editArtist) push({ kind: "artist", name: newName });
                else load();
            }} />
            <CreditsDialog track={creditsTrack} onClose={() => setCreditsTrack(null)} />
            <NameDialog data={nameDialog} onClose={() => setNameDialog(null)} />
        </div>
    );
}

// Quality stamp from scan-time DB fields: "FLAC · 44.1 kHz" for lossless,
// "MP3 · 320 kbps" for lossy. No bit depth by design.
function fmtQualityStamp(codec?: string, sampleRate?: number, bitrate?: number): string {
    const c = (codec || "").toUpperCase();
    if (!c) return "";
    if (c === "MIXED") return "Mixed";
    const lossy = ["MP3", "AAC", "M4A", "OGG", "OPUS", "VORBIS", "WMA"].includes(c);
    if (lossy) return bitrate && bitrate > 0 ? `${c} · ${bitrate} kbps` : c;
    if (sampleRate && sampleRate > 0) {
        const khz = sampleRate / 1000;
        return `${c} · ${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
    }
    return c;
}

function QualityStamp({ codec, sampleRate, bitrate, className }: { codec?: string; sampleRate?: number; bitrate?: number; className?: string }) {
    const text = fmtQualityStamp(codec, sampleRate, bitrate);
    if (!text) return null;
    return (
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap bg-muted text-muted-foreground ${className || ""}`}>
            {text}
        </span>
    );
}

function fmtBytes(n: number): string {
    if (!n) return "\u2014";
    const units = ["B", "KB", "MB", "GB"];
    let v = n, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}

// Plex-style "Get Info": the library row, file stats and the raw tag dump.
function TrackInfoDialog({ trackId, onClose }: { trackId: number | null; onClose: () => void }) {
    const [details, setDetails] = useState<backend.TrackDetails | null>(null);
    useEffect(() => {
        if (trackId == null) { setDetails(null); return; }
        let alive = true;
        GetTrackDetails(trackId).then((d) => { if (alive) setDetails(d); }).catch((e) => { toast.error(`${e}`); onClose(); });
        return () => { alive = false; };
    }, [trackId]); // eslint-disable-line react-hooks/exhaustive-deps
    const t = details?.track;
    const folder = t?.path ? t.path.replace(/[\\/][^\\/]*$/, "") : "";
    const row = (label: string, value: ReactNode) => (
        <div key={label} className="grid grid-cols-[130px_1fr] gap-2 py-1 text-sm border-b border-border/50 last:border-0">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 break-all">{value}</span>
        </div>
    );
    return (
        <Dialog open={trackId != null} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="truncate">{t ? t.title : "Track info"}</DialogTitle>
                    <DialogDescription className="truncate">{t ? `${t.artist} \u2014 ${t.album}` : ""}</DialogDescription>
                </DialogHeader>
                {!details || !t ? <div className="py-8 flex justify-center"><Spinner /></div> : (
                    <div className="space-y-4">
                        <div>
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">File</div>
                            {row("Location", <button type="button" className="text-left underline-offset-2 hover:underline cursor-pointer" title="Open folder" onClick={() => { if (folder) void OpenFolder(folder); }}>{t.path}</button>)}
                            {row("Size", fmtBytes(details.fileSize))}
                            {row("Codec", `${(t.codec || "?").toUpperCase()}${t.sampleRate ? ` \u00b7 ${(t.sampleRate / 1000).toFixed(1)} kHz` : ""}${t.bitrate ? ` \u00b7 ${t.bitrate} kbps` : ""}`)}
                            {row("Duration", fmtDur(t.duration))}
                            {row("Modified", details.modified ? new Date(details.modified * 1000).toLocaleString() : "\u2014")}
                            {row("Added", t.dateAdded ? new Date(t.dateAdded * 1000).toLocaleString() : "\u2014")}
                            {row("Plays", `${t.playCount || 0}`)}
                        </div>
                        <div>
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Tags</div>
                            {Object.keys(details.tags || {}).sort().map((k) => row(k, (details.tags[k] || []).join("; ")))}
                            {Object.keys(details.tags || {}).length === 0 && <div className="text-sm text-muted-foreground">No tags read</div>}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function AlbumGrid({ albums, onOpen, onArtist, onEdit, onDelete, onRefresh, selectedKeys, onSelect, onToggle }: {
    albums: Album[]; onOpen: (a: Album) => void; onArtist?: (name: string) => void; onEdit?: (a: Album) => void;
    onDelete?: (a: Album) => void; onRefresh?: (a: Album) => void;
    selectedKeys?: Set<string>; onSelect?: (index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
    onToggle?: (key: string) => void;
}) {
    return (
        <div className="grid gap-4" style={{ gridTemplateColumns: GRID }}>
            {albums.map((a, i) => (
                <ContextMenu key={a.id}>
                    <ContextMenuTrigger asChild>
                        <button onClick={(e) => { if (onSelect && (e.ctrlKey || e.metaKey || e.shiftKey)) onSelect(i, e); else onOpen(a); }}
                            className={`group text-left rounded-lg p-3 transition ${selectedKeys?.has(a.id) ? "bg-accent ring-2 ring-primary" : "bg-card hover:bg-accent"}`}>
                            <div className="relative aspect-square mb-3">
                                <Cover path={a.coverPath} />
                                {onToggle && <SelectBox checked={!!selectedKeys?.has(a.id)} onToggle={() => onToggle(a.id)} />}
                                <div role="button" tabIndex={-1}
                                    onClick={(e) => { e.stopPropagation(); void playAlbumNow(a); }}
                                    className="absolute bottom-2 right-2 h-12 w-12 rounded-full bg-primary text-primary-foreground shadow-xl flex items-center justify-center opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition cursor-pointer hover:scale-105">
                                    <Play className="h-5 w-5 fill-current ml-0.5" />
                                </div>
                            </div>
                            <div className="font-semibold truncate text-sm">{a.title}</div>
                            <div className="text-xs text-muted-foreground truncate mt-0.5">{a.year ? `${a.year} · ` : ""}{a.albumArtist}</div>
                            <div className="mt-1"><QualityStamp codec={a.codec} sampleRate={a.sampleRate} bitrate={a.bitrate} /></div>
                        </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                        <ContextMenuItem onSelect={() => void playAlbumNow(a)}><Play className="h-4 w-4 mr-2" /> Play</ContextMenuItem>
                        <ContextMenuItem onSelect={() => void queueAlbumTracks(a)}><ListEnd className="h-4 w-4 mr-2" /> Add to queue</ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => onOpen(a)}><Disc3 className="h-4 w-4 mr-2" /> Go to album</ContextMenuItem>
                        {onArtist && a.albumArtist && <ContextMenuItem onSelect={() => onArtist(a.albumArtist)}><User className="h-4 w-4 mr-2" /> Go to artist</ContextMenuItem>}
                        {onEdit && <><ContextMenuSeparator /><ContextMenuItem onSelect={() => onEdit(a)}><Pencil className="h-4 w-4 mr-2" /> Edit album metadata</ContextMenuItem></>}
                        {onRefresh && <ContextMenuItem onSelect={() => onRefresh(a)}><RefreshCw className="h-4 w-4 mr-2" /> Refresh metadata</ContextMenuItem>}
                        {onDelete && <><ContextMenuSeparator /><ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(a)}><Trash2 className="h-4 w-4 mr-2" /> Delete from library</ContextMenuItem></>}
                    </ContextMenuContent>
                </ContextMenu>
            ))}
        </div>
    );
}

// Artists we already tried to enrich this session — avoids re-hitting Spotify
// on every page open for artists that simply aren't on it.
const enrichAttempted = new Set<string>();

// The startup "retry missed artists" pass runs once per app session, not on
// every Library mount.
let enrichRetryRan = false;

// Bio with a character cap and Show more/Show less. When expanded inside the
// fixed-height banner it scrolls instead of overflowing.
function BioText({ text, limit, className, buttonClass, scrollWhenExpanded }: {
    text: string; limit: number; className: string; buttonClass: string; scrollWhenExpanded?: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    useEffect(() => { setExpanded(false); }, [text]);
    if (!text) return null;
    const needsClamp = text.length > limit;
    const shown = !needsClamp || expanded ? text : text.slice(0, limit).trimEnd() + "…";
    return (
        <p className={`${className} ${expanded && scrollWhenExpanded ? "max-h-24 overflow-y-auto pr-2" : ""}`}>
            {shown}
            {needsClamp && (
                <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                    className={`ml-1.5 font-semibold hover:underline cursor-pointer ${buttonClass}`}>
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </p>
    );
}

function ArtistView({ releases, name, bust, onOpenAlbum, onAllSongs, onArtist, onEdit, onEditArtist, onFixMatch, onArtChanged, selectedKeys, onToggle }: {
    releases: backend.ArtistReleases; name: string; bust: number;
    onOpenAlbum: (a: Album) => void; onAllSongs: () => void; onArtist: (name: string) => void; onEdit: (a: Album) => void; onEditArtist: () => void;
    onFixMatch: () => void;
    onArtChanged: () => void;
    selectedKeys: Set<string>; onToggle: (key: string) => void;
}) {
    const [banner, setBanner] = useState("");
    const [bannerRatio, setBannerRatio] = useState<number | null>(null);
    const [bio, setBio] = useState("");
    const [topTracks, setTopTracks] = useState<backend.ArtistTopTrack[]>([]);
    const [spotifyPlaylists, setSpotifyPlaylists] = useState<backend.ProfilePlaylist[]>([]);
    const [enriching, setEnriching] = useState(false);
    const { handleDownloadTrack, handleDownloadAll, downloadingTrack } = useDownload();
    const downloadPopular = (t: backend.ArtistTopTrack) => {
        // Clicking while something downloads enqueues it (shared chain).
        // t.artist carries the FULL credited artists ("Lana Del Rey, Bleachers")
        // — the page artist may only be featured on the track.
        handleDownloadTrack(t.spotifyId, t.title, t.artist || name, t.album, t.spotifyId);
    };
    const [fixTrack, setFixTrack] = useState<backend.ArtistTopTrack | null>(null);
    const reloadTopTracks = () => GetArtistTopTracks(name).then((t) => setTopTracks(t || [])).catch(() => { });
    // "New releases": full Spotify discography vs the library, missing first.
    const [newRelOpen, setNewRelOpen] = useState(false);
    const [newRel, setNewRel] = useState<backend.ArtistReleaseCheck[] | null>(null);
    const [newRelLoading, setNewRelLoading] = useState(false);
    const [newRelFilter, setNewRelFilter] = useState("all");
    const [selRel, setSelRel] = useState<Set<string>>(new Set());
    const [dlRel, setDlRel] = useState<Set<string>>(new Set());
    // Fetches a release's tracks in the background and enqueues them all —
    // no page switch. Already-owned recordings skip via ISRC dedup.
    const downloadRelease = async (r: backend.ArtistReleaseCheck) => {
        if (dlRel.has(r.id)) return;
        setDlRel((prev) => new Set(prev).add(r.id));
        try {
            const meta = await fetchSpotifyMetadata(r.url, false, 0, 300);
            const list = ("track_list" in meta ? (meta as any).track_list : []) as any[];
            if (!list.length) { toast.error(`No tracks found for ${r.name}`); return; }
            await handleDownloadAll(list, r.name);
        } catch (e) { toast.error(`${e}`); }
        finally {
            setDlRel((prev) => { const n = new Set(prev); n.delete(r.id); return n; });
        }
    };
    const downloadReleaseList = async (rels: backend.ArtistReleaseCheck[]) => {
        for (const r of rels) await downloadRelease(r);
    };
    const openNewReleases = async () => {
        setNewRelOpen(true);
        setNewRelLoading(true);
        setNewRelFilter("all");
        setSelRel(new Set());
        setNewRel(null);
        try { setNewRel(await GetArtistNewReleases(name) || []); }
        catch (e) { toast.error(`${e}`); setNewRelOpen(false); }
        finally { setNewRelLoading(false); }
    };
    // Prefer the library album; fall back to fetching it on the Download page.
    const goToPopularAlbum = async (t: backend.ArtistTopTrack) => {
        if (t.album) {
            const alb = await FindLibraryAlbum(t.album, name).catch(() => null);
            if (alb) { onOpenAlbum(alb); return; }
        }
        if (t.spotifyId) {
            try {
                const meta = await fetchSpotifyMetadata(`https://open.spotify.com/track/${t.spotifyId}`, false, 0, 10);
                const albumId = ("track" in meta && meta.track) ? (meta.track as any).album_id : "";
                if (albumId) {
                    window.dispatchEvent(new CustomEvent("kazoo:fetch-url", { detail: `https://open.spotify.com/album/${albumId}` }));
                    return;
                }
            }
            catch { /* fall through */ }
        }
        toast.info("Couldn't find this track's album");
    };
    // Downloads auto-import — refresh the Popular badges as tracks land
    // (debounced: one refresh per burst, not one per file).
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = EventsOn("library:changed", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                GetArtistTopTracks(name).then((t) => setTopTracks(t || [])).catch(() => { });
            }, 2500);
        });
        return () => { off(); if (timer) clearTimeout(timer); };
    }, [name]);
    useEffect(() => {
        let alive = true;
        setSpotifyPlaylists([]);
        GetArtistSpotifyPlaylists(name).then((p) => { if (alive) setSpotifyPlaylists(p || []); }).catch(() => { });
        return () => { alive = false; };
    }, [name]);
    useEffect(() => {
        let alive = true;
        GetArtistBanner(name).then((u) => { if (alive) setBanner(u || ""); }).catch(() => { });
        GetArtistMeta(name).then((m) => { if (alive) setBio(m.bio || ""); }).catch(() => { });
        GetArtistTopTracks(name).then((t) => { if (alive) setTopTracks(t || []); }).catch(() => { });
        return () => { alive = false; };
    }, [name, bust]);
    // Play the artist's in-library popular tracks, in displayed rank order,
    // starting from the clicked one — the queue mirrors the Popular list.
    const playPopular = async (rank: number) => {
        const inLib = topTracks.filter((t) => t.inLibrary && t.libraryTrackId);
        if (inLib.length === 0) return;
        try {
            const tracks = await GetLibraryTracksByIDs(inLib.map((t) => t.libraryTrackId!));
            if (tracks.length === 0) return;
            const idx = inLib.findIndex((t) => t.rank === rank);
            playQueue(tracks.map(toPlayerTrack), Math.max(0, idx));
        } catch (e) { toast.error(`${e}`); }
    };
    const queuePopular = async (t: backend.ArtistTopTrack) => {
        if (!t.libraryTrackId) return;
        try {
            const tracks = await GetLibraryTracksByIDs([t.libraryTrackId]);
            if (tracks.length) { addToQueue(tracks.map(toPlayerTrack)); toast.success("Added to queue"); }
        } catch (e) { toast.error(`${e}`); }
    };
    // Plex-style on-demand enrichment: first time an artist page opens with no
    // Spotify data yet, pull photo/banner/bio/top-tracks in the background.
    useEffect(() => {
        let alive = true;
        (async () => {
            if (enrichAttempted.has(name)) return;
            enrichAttempted.add(name);
            try {
                const existing = await GetArtistTopTracks(name);
                if (!alive || (existing || []).length > 0) return;
                setEnriching(true);
                const r = await EnrichLibraryArtist(name);
                if (!alive) return;
                if (r.photo || r.banner || r.bio || r.topTracks > 0) {
                    onArtChanged();
                    const t = await GetArtistTopTracks(name);
                    if (alive) setTopTracks(t || []);
                }
            } catch { /* offline or not on Spotify — fine */ }
            finally { if (alive) setEnriching(false); }
        })();
        return () => { alive = false; };
    }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
    const groups = new Map<string, Album[]>();
    for (const a of releases.own || []) {
        const k = a.releaseType || "Albums";
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(a);
    }
    const ordered = [
        ...SECTION_ORDER.filter((s) => groups.has(s)),
        ...[...groups.keys()].filter((k) => !SECTION_ORDER.includes(k)).sort(),
    ];
    const cover = releases.own?.[0]?.coverPath || releases.appearsOn?.[0]?.coverPath || "";
    const appearsOn = releases.appearsOn || [];
    return (
        <div>
            {/* Wide windows: hero on the left, Popular fills the empty right
                side; below 1600px everything stacks back vertically. */}
            <div className="flex flex-col min-[1600px]:flex-row min-[1600px]:items-start min-[1600px]:gap-10">
            <div className="min-w-0 min-[1600px]:w-full min-[1600px]:max-w-[1080px] min-[1600px]:shrink-0">
            {banner ? (
                // Sized to the image's own aspect ratio (capped) so the full
                // banner picture is visible instead of a fixed-height crop.
                <div className="relative mb-6 rounded-xl overflow-hidden max-h-[420px]"
                    style={{ aspectRatio: bannerRatio ? String(bannerRatio) : "7 / 3" }}>
                    <img src={banner} alt="" className="absolute inset-0 w-full h-full object-cover"
                        onLoad={(e) => {
                            const im = e.currentTarget;
                            if (im.naturalWidth > 0 && im.naturalHeight > 0) setBannerRatio(im.naturalWidth / im.naturalHeight);
                        }} />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-black/10" />
                    <div className="absolute bottom-0 left-0 right-0 p-5 flex items-end gap-4">
                        <div className="h-24 w-24 shrink-0 rounded-full overflow-hidden ring-2 ring-white/20"><ArtistCover name={name} fallback={cover} circle /></div>
                        <div className="min-w-0 flex-1">
                            <div className="text-xs uppercase tracking-wide text-white/70">Artist</div>
                            <div className="text-4xl font-bold text-white drop-shadow-lg">{name}</div>
                            {bio && <BioText text={bio} limit={220} scrollWhenExpanded
                                className="text-sm text-white/85 mt-1.5 max-w-2xl drop-shadow"
                                buttonClass="text-white" />}
                            <div className="mt-2 flex items-center gap-3">
                                <button onClick={onAllSongs} className="text-sm text-white hover:underline">View all songs →</button>
                                <button onClick={openNewReleases} className="text-sm text-white/75 hover:text-white inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /> New releases</button>
                                <button onClick={onEditArtist} className="text-sm text-white/75 hover:text-white inline-flex items-center gap-1"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                                <button onClick={onFixMatch} className="text-sm text-white/75 hover:text-white inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" /> Fix match</button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="mb-6">
                    <div className="flex items-center gap-4">
                        <div className="h-28 w-28 shrink-0"><ArtistCover name={name} fallback={cover} circle /></div>
                        <div>
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">Artist</div>
                            <div className="text-4xl font-bold">{name}</div>
                            <div className="mt-2 flex items-center gap-3">
                                <button onClick={onAllSongs} className="text-sm text-primary hover:underline">View all songs →</button>
                                <button onClick={openNewReleases} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /> New releases</button>
                                <button onClick={onEditArtist} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                                <button onClick={onFixMatch} className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" /> Fix match</button>
                            </div>
                        </div>
                    </div>
                    {bio && <BioText text={bio} limit={400}
                        className="text-sm text-muted-foreground mt-4 max-w-3xl leading-relaxed whitespace-pre-line"
                        buttonClass="text-primary" />}
                </div>
            )}
            {enriching && (
                <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner className="h-3.5 w-3.5" /> Fetching artist info from Spotify…
                </div>
            )}
            <Dialog open={newRelOpen} onOpenChange={(o) => { if (!o) setNewRelOpen(false); }}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>New releases</DialogTitle>
                        <DialogDescription>
                            {newRel === null
                                ? "Checking Spotify's discography against your library…"
                                : (() => {
                                    const missing = newRel.filter((r) => !r.inLibrary).length;
                                    return missing > 0
                                        ? `${missing} of ${newRel.length} releases missing from your library.`
                                        : `Your library has all ${newRel.length} releases Spotify lists.`;
                                })()}
                        </DialogDescription>
                    </DialogHeader>
                    {newRelLoading && (
                        <div className="flex items-center justify-center py-10 text-muted-foreground">
                            <Spinner className="h-5 w-5 mr-2" /> Fetching discography…
                        </div>
                    )}
                    {!newRelLoading && newRel && (() => {
                        const missingRel = newRel.filter((r) => !r.inLibrary);
                        const types = [...new Set(missingRel.map((r) => (r.type || "other").toLowerCase()))];
                        const shown = newRelFilter === "all" ? missingRel : missingRel.filter((r) => (r.type || "other").toLowerCase() === newRelFilter);
                        const chipLabel = (t: string) => t === "ep" ? "EPs" : t === "appears_on" ? "Appears on" : `${t.charAt(0).toUpperCase()}${t.slice(1)}s`;
                        const openRelease = (r: backend.ArtistReleaseCheck) => {
                            setNewRelOpen(false);
                            window.dispatchEvent(new CustomEvent("kazoo:fetch-url", { detail: r.url }));
                        };
                        return (<>
                            {types.length > 1 && (
                                <div className="flex gap-1.5 flex-wrap">
                                    <button type="button" onClick={() => setNewRelFilter("all")}
                                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${newRelFilter === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
                                        All ({missingRel.length})
                                    </button>
                                    {types.map((t) => (
                                        <button key={t} type="button" onClick={() => setNewRelFilter(t)}
                                            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${newRelFilter === t ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
                                            {chipLabel(t)} ({missingRel.filter((r) => (r.type || "other").toLowerCase() === t).length})
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div className="max-h-96 overflow-y-auto -mx-1">
                                {missingRel.length === 0 && (
                                    <div className="py-8 text-center text-sm text-muted-foreground">
                                        Nothing missing — you have it all 🎉
                                    </div>
                                )}
                                {shown.map((r) => (
                                    <div key={r.id} onClick={() => openRelease(r)}
                                        className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent group cursor-pointer"
                                        title="Open this release on the Download page">
                                        <span onClick={(e) => e.stopPropagation()} className="shrink-0 flex items-center">
                                            <Checkbox checked={selRel.has(r.id)} onCheckedChange={(c) => setSelRel((prev) => {
                                                const n = new Set(prev);
                                                if (c === true) n.add(r.id); else n.delete(r.id);
                                                return n;
                                            })} />
                                        </span>
                                        {r.cover
                                            ? <img src={r.cover} alt="" loading="lazy" className="h-11 w-11 rounded object-cover shrink-0" />
                                            : <div className="h-11 w-11 rounded bg-muted shrink-0" />}
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm truncate">{r.name}
                                                {(r as any).haveTracks > 0 && (
                                                    <span className="ml-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-amber-500/15 text-amber-500">
                                                        Incomplete · {(r as any).haveTracks}/{r.totalTracks}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {(r.releaseDate || "").slice(0, 4)}
                                                {r.type ? ` · ${r.type.charAt(0).toUpperCase()}${r.type.slice(1)}` : ""}
                                                {r.totalTracks > 0 ? ` · ${plural(r.totalTracks, "track")}` : ""}
                                            </div>
                                        </div>
                                        {dlRel.has(r.id)
                                            ? <Spinner className="h-4 w-4 shrink-0" />
                                            : (<button type="button" title="Download this release"
                                                className="shrink-0 text-primary opacity-0 group-hover:opacity-100 transition cursor-pointer hover:scale-110"
                                                onClick={(e) => { e.stopPropagation(); void downloadRelease(r); }}>
                                                <Download className="h-4 w-4" />
                                            </button>)}
                                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
                                    </div>
                                ))}
                            </div>
                            {missingRel.length > 0 && (
                                <div className="flex items-center gap-2 pt-1">
                                    <Button size="sm" onClick={() => void downloadReleaseList(shown)} disabled={dlRel.size > 0}>
                                        <Download className="h-4 w-4 mr-1.5" /> Download all ({shown.length.toLocaleString()})
                                    </Button>
                                    {selRel.size > 0 && (
                                        <Button size="sm" variant="secondary" disabled={dlRel.size > 0}
                                            onClick={() => void downloadReleaseList(shown.filter((r) => selRel.has(r.id)))}>
                                            Download selected ({selRel.size.toLocaleString()})
                                        </Button>
                                    )}
                                </div>
                            )}
                        </>);
                    })()}
                </DialogContent>
            </Dialog>
            </div>
            {topTracks.length > 0 && (
                <div className="mb-7 min-w-0 min-[1600px]:flex-1">
                    <div className="text-xl font-bold mb-3">Popular</div>
                    <div className="max-w-2xl min-[1600px]:max-w-none">
                        {topTracks.map((t) => (
                            <ContextMenu key={t.rank}>
                              <ContextMenuTrigger asChild>
                                <div
                                    className={`group flex items-center gap-3 px-3 py-1.5 rounded-md hover:bg-accent/50 ${t.inLibrary ? "cursor-pointer" : ""}`}
                                    onDoubleClick={() => t.inLibrary && playPopular(t.rank)}
                                    onClick={(e) => { if (e.detail === 1 && t.inLibrary && (e.target as Element).closest("[data-pop-play]")) playPopular(t.rank); }}>
                                    <span className={`w-5 text-right text-sm text-muted-foreground tabular-nums ${t.inLibrary ? "group-hover:hidden" : ""}`}>{t.rank}</span>
                                    {t.inLibrary && <span data-pop-play className="w-5 hidden group-hover:flex justify-end cursor-pointer"><Play className="h-3.5 w-3.5 fill-current hover:text-primary" /></span>}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            <span className="truncate text-sm">{t.title}</span>
                                            {t.inLibrary && <QualityStamp codec={t.codec} sampleRate={t.sampleRate} bitrate={t.bitrate} className="shrink-0" />}
                                        </div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {t.artist}{t.album ? ` · ${t.album}` : ""}
                                        </div>
                                    </div>
                                    {t.inLibrary
                                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary whitespace-nowrap">In library</span>
                                        : (<>
                                            {downloadingTrack === t.spotifyId
                                                ? <Spinner className="h-4 w-4 shrink-0" />
                                                : t.spotifyId && (
                                                    <button type="button"
                                                        className="shrink-0 text-amber-500 hover:text-amber-400 transition-colors cursor-pointer disabled:opacity-50"
                                                        title="Download this track"
                                                        onClick={(e) => { e.stopPropagation(); downloadPopular(t); }}>
                                                        <Download className="h-4 w-4" />
                                                    </button>
                                                )}
                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground whitespace-nowrap">Not in library</span>
                                        </>)}
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                {t.inLibrary && (
                                    <ContextMenuItem onClick={() => playPopular(t.rank)}>
                                        <Play className="h-4 w-4 mr-2" /> Play
                                    </ContextMenuItem>
                                )}
                                {t.inLibrary && t.libraryTrackId && (
                                    <ContextMenuItem onClick={() => void queuePopular(t)}>
                                        <ListEnd className="h-4 w-4 mr-2" /> Add to queue
                                    </ContextMenuItem>
                                )}
                                {!t.inLibrary && t.spotifyId && (
                                    <ContextMenuItem onClick={() => downloadPopular(t)}>
                                        <Download className="h-4 w-4 mr-2" /> Download
                                    </ContextMenuItem>
                                )}
                                {t.spotifyId && (
                                    <ContextMenuItem onClick={() => setFixTrack(t)}>
                                        <Link2 className="h-4 w-4 mr-2" /> Fix match…
                                    </ContextMenuItem>
                                )}
                                <ContextMenuItem onClick={() => goToPopularAlbum(t)}>
                                    <Disc3 className="h-4 w-4 mr-2" /> Go to album
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                        ))}
                        {fixTrack && (
                            <FixTrackMatchDialog
                                open
                                spotifyId={fixTrack.spotifyId}
                                initialQuery={fixTrack.title}
                                currentTrackId={fixTrack.libraryTrackId ? Number(fixTrack.libraryTrackId) : undefined}
                                onClose={() => setFixTrack(null)}
                                onApplied={reloadTopTracks}
                            />
                        )}
                    </div>
                </div>
            )}
            </div>
            {spotifyPlaylists.length > 0 && (
                <div className="mb-7">
                    <div className="text-xl font-bold mb-3">On Spotify</div>
                    <div className="flex gap-4 flex-wrap">
                        {spotifyPlaylists.map((p) => (
                            <button key={p.id} type="button" title={`Open ${p.name}`}
                                onClick={() => openSpotifyPlaylistView(p.url)}
                                className="group w-36 text-left rounded-lg p-2.5 bg-card hover:bg-accent transition cursor-pointer">
                                <div className="relative aspect-square mb-2 rounded-md overflow-hidden bg-muted">
                                    {p.image && <img src={p.image} alt="" loading="lazy" className="w-full h-full object-cover" />}
                                    <div className="absolute bottom-1.5 right-1.5 h-9 w-9 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                                        <ListMusic className="h-4 w-4" />
                                    </div>
                                </div>
                                <div className="text-sm font-medium truncate">{p.name}</div>
                                <div className="text-[11px] text-muted-foreground truncate">by {p.owner}</div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {ordered.length === 0 && appearsOn.length === 0 && <div className="text-sm text-muted-foreground">No releases.</div>}
            {ordered.map((section) => (
                <div key={section} className="mb-7">
                    <div className="text-xl font-bold mb-3">{section}</div>
                    <AlbumGrid albums={groups.get(section)!} onOpen={onOpenAlbum} onArtist={onArtist} onEdit={onEdit} selectedKeys={selectedKeys} onToggle={onToggle} />
                </div>
            ))}
            {appearsOn.length > 0 && (
                <div className="mb-7">
                    <div className="text-xl font-bold mb-3">Appears On</div>
                    <AlbumGrid albums={appearsOn} onOpen={onOpenAlbum} onArtist={onArtist} onEdit={onEdit} selectedKeys={selectedKeys} onToggle={onToggle} />
                </div>
            )}
        </div>
    );
}

function Empty({ onOpen }: { onOpen: () => void }) {
    return (
        <div className="py-16 text-center text-sm text-muted-foreground">
            Nothing here yet. <button onClick={onOpen} className="text-primary hover:underline font-medium">Add a folder</button> to build your library.
        </div>
    );
}

function SongList({ tracks, numbered, onAction, onPlay, playlists, playlistId, selectedKeys, onRowClick }: {
    tracks: Track[]; numbered?: boolean;
    onAction: (action: string, t: Track, arg?: number) => void;
    // Play context: the parent passes the exact list it renders, so pressing
    // play queues precisely what's on screen (same order/filter), from row i.
    onPlay: (index: number) => void;
    playlists: Playlist[]; playlistId?: number;
    selectedKeys: Set<string>; onRowClick: (index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
}) {
    const discs = numbered ? [...new Set(tracks.map((t) => t.discNo || 1))].sort((a, b) => a - b) : [];
    const multiDisc = discs.length > 1;
    // Incremental rendering for long flat lists (Songs / playlists can hit
    // thousands of rows): render in chunks and grow as the user scrolls, so
    // opening the view doesn't stall on a giant initial render.
    const CHUNK = 250;
    const [visibleCount, setVisibleCount] = useState(CHUNK);
    useEffect(() => { setVisibleCount(CHUNK); }, [tracks]);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const obs = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting) setVisibleCount((v) => v + CHUNK);
        }, { rootMargin: "1000px" });
        obs.observe(el);
        return () => obs.disconnect();
    }, [tracks, visibleCount]);

    const row = (t: Track, i: number) => (
        <ContextMenu key={t.id}>
            <ContextMenuTrigger asChild>
                <div onClick={(e) => onRowClick(i, e)} onDoubleClick={() => onPlay(i)}
                    className={`grid items-center gap-3 px-3 py-2 rounded-md cursor-default group text-sm ${selectedKeys.has(String(t.id)) ? "bg-accent" : "hover:bg-accent/60"}`}
                    style={{ gridTemplateColumns: "24px 1fr 1fr 60px" }}>
                    <span className="text-right text-muted-foreground group-hover:hidden">{numbered ? t.trackNo || i + 1 : i + 1}</span>
                    <Play className="h-3.5 w-3.5 fill-current justify-self-end hidden group-hover:block cursor-pointer hover:text-primary"
                        onClick={(e) => { e.stopPropagation(); onPlay(i); }} />
                    <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate font-medium">{t.title}<span className="text-muted-foreground">{featuring(t)}</span></span>
                            <QualityStamp codec={t.codec} sampleRate={t.sampleRate} bitrate={t.bitrate} className="shrink-0" />
                            {(t as any).borrowed && <span className="shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none bg-primary/10 text-primary" title={`File lives on "${t.album}"`}>Linked</span>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{t.artist}</div>
                    </div>
                    <span className="truncate text-muted-foreground">{numbered ? "" : t.album}</span>
                    <span className="text-right text-muted-foreground">{fmtDur(t.duration)}</span>
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
                <ContextMenuItem onSelect={() => onPlay(i)}><Play className="h-4 w-4 mr-2" /> Play</ContextMenuItem>
                <ContextMenuItem onSelect={() => onAction("queue", t)}><ListEnd className="h-4 w-4 mr-2" /> Add to queue</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onAction("metadata", t)}><Pencil className="h-4 w-4 mr-2" /> Metadata</ContextMenuItem>
                <ContextMenuSub>
                    <ContextMenuSubTrigger><ListPlus className="h-4 w-4 mr-2" /> Add to playlist</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-48 max-h-72 overflow-y-auto">
                        <ContextMenuItem onSelect={() => onAction("newplaylist", t)}><Plus className="h-4 w-4 mr-2" /> New playlist…</ContextMenuItem>
                        {playlists.length > 0 && <ContextMenuSeparator />}
                        {playlists.map((p) => (
                            <ContextMenuItem key={p.id} onSelect={() => onAction("addtoplaylist", t, p.id)}>{p.name}</ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                </ContextMenuSub>
                {playlistId != null && <ContextMenuItem onSelect={() => onAction("removefromplaylist", t, playlistId)}><Trash2 className="h-4 w-4 mr-2" /> Remove from playlist</ContextMenuItem>}
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onAction("artist", t)}><User className="h-4 w-4 mr-2" /> Go to artist</ContextMenuItem>
                <ContextMenuItem onSelect={() => onAction("album", t)}><Disc3 className="h-4 w-4 mr-2" /> Go to album</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onAction("info", t)}><Info className="h-4 w-4 mr-2" /> Get info</ContextMenuItem>
                <ContextMenuItem onSelect={() => onAction("credits", t)}><User className="h-4 w-4 mr-2" /> View credits</ContextMenuItem>
                <ContextMenuItem onSelect={() => onAction("refresh", t)}><RefreshCw className="h-4 w-4 mr-2" /> Refresh metadata</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => onAction("delete", t)}><Trash2 className="h-4 w-4 mr-2" /> Delete from library</ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );

    return (
        <div>
            <div className="grid items-center gap-3 px-3 pb-2 mb-1 border-b border-border text-xs text-muted-foreground uppercase tracking-wide"
                style={{ gridTemplateColumns: "24px 1fr 1fr 60px" }}>
                <span className="text-right">#</span><span>Title</span><span>{numbered ? "" : "Album"}</span>
                <span className="flex justify-end"><Clock className="h-4 w-4" /></span>
            </div>
            {multiDisc
                ? discs.map((d) => (
                    <div key={d}>
                        <div className="flex items-center gap-2 px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground"><Disc3 className="h-3.5 w-3.5" /> Disc {d}</div>
                        {tracks.map((t, i) => ((t.discNo || 1) === d ? row(t, i) : null))}
                    </div>
                ))
                : tracks.slice(0, visibleCount).map((t, i) => row(t, i))}
            {!multiDisc && visibleCount < tracks.length && (
                <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
                    {(tracks.length - visibleCount).toLocaleString()} more…
                </div>
            )}
        </div>
    );
}

const CREDIT_ROLES: { role: string; label: string }[] = [
    { role: "primary", label: "Artist" },
    { role: "featuring", label: "Featuring" },
    { role: "album_artist", label: "Album Artist" },
    { role: "collaboration", label: "Collaboration" },
];

const RELEASE_TYPES: { v: string; label: string }[] = [
    { v: "", label: "— (none → Album)" },
    { v: "album", label: "Album" },
    { v: "single", label: "Single" },
    { v: "ep", label: "EP" },
    { v: "compilation", label: "Compilation" },
    { v: "live", label: "Live" },
    { v: "demo", label: "Demo" },
    { v: "soundtrack", label: "Soundtrack" },
    { v: "remix", label: "Remix" },
    { v: "mixtape", label: "Mixtape" },
    { v: "broadcast", label: "Broadcast" },
    { v: "dj-mix", label: "DJ-Mix" },
    { v: "other", label: "Other" },
];

const editInput = "h-9 w-full rounded-md bg-muted border border-border px-3 text-sm outline-none focus:border-primary";

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
    return (
        <label className={`flex flex-col gap-1 ${wide ? "col-span-2" : ""}`}>
            <span className="text-xs text-muted-foreground">{label}{hint && <span className="ml-1 opacity-70">({hint})</span>}</span>
            {children}
        </label>
    );
}

type ArtChoice = { src: string; info: backend.ImageInfo } | null;

// Plex-style artwork rail: big preview, local path/URL entry, and a "Find
// online" picker showing candidates from every source (Spotify, Deezer).
function ArtSection({ currentPath, currentArtist, bannerArtist, art, setArt, label = "Album art", circle, wide, candidates }: {
    currentPath?: string; currentArtist?: string; bannerArtist?: string;
    art: ArtChoice; setArt: (a: ArtChoice) => void; label?: string; circle?: boolean; wide?: boolean;
    candidates?: () => Promise<backend.ArtCandidate[]>;
}) {
    const [input, setInput] = useState("");
    const [current, setCurrent] = useState("");
    const [loading, setLoading] = useState(false);
    const [cands, setCands] = useState<backend.ArtCandidate[] | null>(null);
    const [candsOpen, setCandsOpen] = useState(false);
    const [candsLoading, setCandsLoading] = useState(false);
    useEffect(() => {
        if (bannerArtist) GetArtistBanner(bannerArtist).then(setCurrent).catch(() => { });
        else if (currentArtist) GetArtistImage(currentArtist).then(setCurrent).catch(() => { });
        else if (currentPath) GetEmbeddedCover(currentPath).then(setCurrent).catch(() => { });
    }, [currentPath, currentArtist, bannerArtist]);
    const load = async (s: string) => {
        if (!s.trim()) return;
        setLoading(true);
        try { const info = await GetImageInfo(s.trim()); setArt({ src: s.trim(), info }); }
        catch (e) { toast.error(`${e}`); setArt(null); }
        finally { setLoading(false); }
    };
    const browse = async () => { const f = await SelectFile(); if (f) { setInput(f); load(f); } };
    const findOnline = async () => {
        if (candsOpen) { setCandsOpen(false); return; }
        setCandsOpen(true);
        if (cands === null && candidates) {
            setCandsLoading(true);
            try { setCands(await candidates()); } catch { setCands([]); }
            finally { setCandsLoading(false); }
        }
    };
    const preview = art?.info.dataUrl || current;
    const shape = circle ? "rounded-full aspect-square w-28 mx-auto" : wide ? "rounded-md aspect-[21/9] w-full" : "rounded-md aspect-square w-full";
    return (
        <div className="space-y-2">
            <div className={`overflow-hidden bg-muted flex items-center justify-center ${shape}`}>
                {preview ? <img src={preview} alt="" className="w-full h-full object-cover" /> : <Music className="h-8 w-8 text-muted-foreground/40" />}
            </div>
            <div className="text-xs text-muted-foreground">{label}{art && <span className="text-primary"> · new {art.info.width}×{art.info.height} {art.info.format}</span>}</div>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(input)} placeholder="Local path or image URL…" className={`${editInput} w-full`} />
            <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" className="flex-1" onClick={browse}>Browse</Button>
                <Button size="sm" variant="secondary" className="flex-1" onClick={() => load(input)} disabled={loading}>{loading ? <Spinner className="h-4 w-4" /> : "Load"}</Button>
            </div>
            {candidates && (
                <Button size="sm" variant="outline" className="w-full" onClick={findOnline}>
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" /> {candsOpen ? "Hide online options" : "Find online"}
                </Button>
            )}
            {candsOpen && (
                <div className="max-h-64 overflow-y-auto grid grid-cols-2 gap-2 pr-1">
                    {candsLoading && <div className="col-span-2 py-4 flex justify-center"><Spinner className="h-4 w-4" /></div>}
                    {!candsLoading && (cands || []).map((c, i) => (
                        <button key={i} type="button" title={c.source}
                            onClick={() => { setInput(c.url); void load(c.url); setCandsOpen(false); }}
                            className="group text-left cursor-pointer">
                            <img src={c.url} alt="" loading="lazy"
                                className={`w-full object-cover rounded-md group-hover:ring-2 ring-primary ${wide ? "aspect-[21/9]" : "aspect-square"}`} />
                            <div className="text-[10px] text-muted-foreground truncate mt-0.5">{c.source}</div>
                        </button>
                    ))}
                    {!candsLoading && (cands || []).length === 0 && (
                        <div className="col-span-2 text-center text-xs text-muted-foreground py-3">No online art found</div>
                    )}
                </div>
            )}
            {art && <div className="text-[11px] text-muted-foreground">{(currentArtist || bannerArtist) ? "Applied on Save." : "Embedded into the file(s) on Save."}</div>}
        </div>
    );
}

// One shared fetch per artist per dialog-open — photos and banners come from
// the same backend call.
const artCandCache = new Map<string, Promise<backend.ArtistArtCandidates>>();
function fetchArtistCands(name: string): Promise<backend.ArtistArtCandidates> {
    let p = artCandCache.get(name);
    if (!p) {
        p = GetArtistArtCandidates(name);
        artCandCache.set(name, p);
        // refresh next time the dialog opens
        setTimeout(() => artCandCache.delete(name), 60_000);
    }
    return p;
}

function TrackEditor({ ids, onClose, onSaved }: { ids: number[] | null; onClose: () => void; onSaved: () => void }) {
    const [m, setM] = useState<backend.TrackMeta | null>(null);
    const [mixed, setMixed] = useState<Set<string>>(new Set());
    const [changed, setChanged] = useState<Set<string>>(new Set());
    const [art, setArt] = useState<ArtChoice>(null);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        if (!ids) { setM(null); return; }
        setM(null); setArt(null); setChanged(new Set());
        GetCommonMetadata(ids).then((cm) => { setM(cm.meta); setMixed(new Set(cm.mixed)); })
            .catch((e) => { toast.error(`${e}`); onClose(); });
    }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!ids) return null;
    const multi = ids.length > 1;
    const set = (k: keyof backend.TrackMeta, v: string | number) => {
        setM((prev) => (prev ? ({ ...prev, [k]: v } as backend.TrackMeta) : prev));
        setChanged((prev) => new Set(prev).add(k as string));
    };
    const ph = (f: string) => (mixed.has(f) && !changed.has(f) ? "⟨multiple values⟩" : undefined);
    const save = async () => {
        if (!m) return;
        const fields = [...changed];
        if (!fields.length && !art) { toast.warning("No changes to apply"); onClose(); return; }
        setSaving(true);
        try {
            if (fields.length) {
                const payload: Record<string, unknown> = { fields };
                for (const f of fields) payload[f] = (m as unknown as Record<string, unknown>)[f];
                await WriteBulkTrackMetadata(ids, backend.BulkMeta.createFrom(payload));
            }
            if (art) await EmbedCoverFromSource(ids, art.src);
            toast.success(multi ? `Updated ${plural(ids.length, "track")}` : "Metadata saved");
            onSaved(); onClose();
        } catch (e) { toast.error(`Save failed: ${e}`); }
        finally { setSaving(false); }
    };
    const rtMixed = mixed.has("releaseType") && !changed.has("releaseType");
    return (
        <Dialog open={!!ids} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{multi ? `Edit ${ids.length.toLocaleString()} tracks` : "Edit metadata"}</DialogTitle>
                    <DialogDescription>{multi
                        ? "Shared fields only — per-track fields (title, track/disc #) are hidden so they can't be overwritten in bulk. Only fields you change are written."
                        : "Writes to the file (other tags preserved). Release type is saved to all compatible tags for cross-player support."}</DialogDescription>
                </DialogHeader>
                {!m ? <div className="py-10 flex justify-center"><Spinner className="h-5 w-5" /></div> : (
                    <div className="grid gap-6 max-h-[65vh] overflow-y-auto pr-1" style={{ gridTemplateColumns: "220px 1fr" }}>
                        <ArtSection currentPath={m.path} art={art} setArt={setArt}
                            candidates={() => GetAlbumArtCandidates(m.album, m.albumArtist || m.artist)} />
                        <div className="grid grid-cols-2 gap-3 content-start">
                            {!multi && <Field label="Title" wide><input className={editInput} value={m.title} placeholder={ph("title")} onChange={(e) => set("title", e.target.value)} /></Field>}
                            <Field label="Artist" hint="; for multiple" wide><input className={editInput} value={m.artist} placeholder={ph("artist")} onChange={(e) => set("artist", e.target.value)} /></Field>
                            <Field label="Album Artist" wide><input className={editInput} value={m.albumArtist} placeholder={ph("albumArtist")} onChange={(e) => set("albumArtist", e.target.value)} /></Field>
                            <Field label="Album" wide><input className={editInput} value={m.album} placeholder={ph("album")} onChange={(e) => set("album", e.target.value)} /></Field>
                            <Field label="Year"><input className={editInput} type="number" value={m.year || ""} placeholder={ph("year")} onChange={(e) => set("year", parseInt(e.target.value) || 0)} /></Field>
                            <Field label="Genre"><input className={editInput} value={m.genre} placeholder={ph("genre")} onChange={(e) => set("genre", e.target.value)} /></Field>
                            {!multi && <Field label="Track #"><input className={editInput} type="number" value={m.trackNo || ""} placeholder={ph("trackNo")} onChange={(e) => set("trackNo", parseInt(e.target.value) || 0)} /></Field>}
                            {!multi && <Field label="Disc #"><input className={editInput} type="number" value={m.discNo || ""} placeholder={ph("discNo")} onChange={(e) => set("discNo", parseInt(e.target.value) || 0)} /></Field>}
                            <Field label="Composer" wide><input className={editInput} value={m.composer} placeholder={ph("composer")} onChange={(e) => set("composer", e.target.value)} /></Field>
                            <Field label="Release Type" wide>
                                <select className={editInput + " cursor-pointer"} value={rtMixed ? "__mixed__" : m.releaseType} onChange={(e) => set("releaseType", e.target.value)}>
                                    {rtMixed && <option value="__mixed__">⟨multiple values⟩</option>}
                                    {RELEASE_TYPES.map((rt) => <option key={rt.v} value={rt.v}>{rt.label}</option>)}
                                </select>
                            </Field>
                        </div>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
                    <Button size="sm" onClick={save} disabled={saving || !m}>{saving && <Spinner className="h-4 w-4 mr-1.5" />} {multi ? `Save to ${ids.length.toLocaleString()}` : "Save"}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ArtistEditor({ name, onClose, onSaved }: { name: string | null; onClose: () => void; onSaved: (newName: string) => void }) {
    const [meta, setMeta] = useState<backend.ArtistMeta | null>(null);
    const [newName, setNewName] = useState("");
    const [genre, setGenre] = useState("");
    const [bio, setBio] = useState("");
    const [art, setArt] = useState<ArtChoice>(null);
    const [banner, setBanner] = useState<ArtChoice>(null);
    const [changed, setChanged] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [locks, setLocks] = useState<string[]>([]);
    useEffect(() => {
        if (!name) { setMeta(null); return; }
        setMeta(null); setChanged(new Set()); setArt(null); setBanner(null); setLocks([]);
        GetArtistMeta(name).then((m) => { setMeta(m); setNewName(m.name); setGenre(m.genre); setBio(m.bio); })
            .catch((e) => { toast.error(`${e}`); onClose(); });
        GetArtistLocks(name).then((l) => setLocks(l || [])).catch(() => { });
    }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!name) return null;
    const save = async () => {
        if (!meta) return;
        const metaFields = [...changed].filter((f) => f === "name" || f === "genre");
        if (!metaFields.length && !changed.has("bio") && !art && !banner) { toast.warning("No changes to apply"); onClose(); return; }
        setSaving(true);
        try {
            const finalName = changed.has("name") && newName.trim() ? newName.trim() : name;
            let n = 0;
            if (metaFields.length) n = await WriteArtistMetadata(name, newName.trim(), genre, metaFields);
            if (changed.has("bio")) await SetArtistBio(finalName, bio);
            if (art) await SetArtistImage(finalName, art.src);
            if (banner) await SetArtistBanner(finalName, banner.src);
            // Plex-style: manually edited fields get locked so Spotify
            // enrichment never overwrites them.
            const lockFields = [
                ...(changed.has("bio") ? ["bio"] : []),
                ...(art ? ["photo"] : []),
                ...(banner ? ["banner"] : []),
            ];
            if (lockFields.length) await LockArtistFields(finalName, lockFields);
            toast.success(metaFields.length ? `Updated ${n} track${n === 1 ? "" : "s"}` : "Artist updated");
            onSaved(finalName); onClose();
        } catch (e) { toast.error(`Save failed: ${e}`); }
        finally { setSaving(false); }
    };
    const unlock = async () => {
        try {
            await UnlockArtistFields(name);
            setLocks([]);
            toast.success("Unlocked — Spotify can fill these fields again");
        } catch (e) { toast.error(`${e}`); }
    };
    return (
        <Dialog open={!!name} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Edit artist — {name}</DialogTitle>
                    <DialogDescription>{meta
                        ? `Applies to ${meta.trackCount} track${meta.trackCount === 1 ? "" : "s"} crediting this artist. Renaming replaces this name in the artist & album-artist tags — other co-artists on a track are kept.`
                        : "Loading…"}</DialogDescription>
                </DialogHeader>
                {!meta ? <div className="py-10 flex justify-center"><Spinner className="h-5 w-5" /></div> : (
                    <div className="grid gap-6 max-h-[65vh] overflow-y-auto pr-1" style={{ gridTemplateColumns: "240px 1fr" }}>
                        <div className="space-y-5">
                            <ArtSection currentArtist={name} art={art} setArt={setArt} label="Artist photo" circle
                                candidates={async () => (await fetchArtistCands(name)).photos} />
                            <ArtSection bannerArtist={name} art={banner} setArt={setBanner} label="Background banner (landscape)" wide
                                candidates={async () => (await fetchArtistCands(name)).banners} />
                        </div>
                        <div className="space-y-3 content-start">
                            <Field label="Artist name" wide><input className={editInput} value={newName} onChange={(e) => { setNewName(e.target.value); setChanged((p) => new Set(p).add("name")); }} /></Field>
                            <Field label="Genre" hint="applies to all their tracks" wide><input className={editInput} value={genre} placeholder={meta.genreMixed && !changed.has("genre") ? "⟨multiple values⟩" : undefined} onChange={(e) => { setGenre(e.target.value); setChanged((p) => new Set(p).add("genre")); }} /></Field>
                            <Field label="Bio" hint="shown on the artist page" wide><textarea className={editInput + " min-h-[160px] resize-y leading-relaxed"} value={bio} placeholder="A short biography…" onChange={(e) => { setBio(e.target.value); setChanged((p) => new Set(p).add("bio")); }} /></Field>
                            {locks.length > 0 && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <span>🔒 Locked from online updates: {locks.join(", ")}</span>
                                    <button type="button" onClick={unlock} className="text-primary hover:underline cursor-pointer">Unlock</button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
                    <Button size="sm" onClick={save} disabled={saving || !meta}>{saving && <Spinner className="h-4 w-4 mr-1.5" />} Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// Plex-style "Fix match": search Spotify artists, pick the right one, and
// re-pull photo/banner/bio/top-tracks from that match.
function MatchDialog({ name, onClose, onMatched }: { name: string | null; onClose: () => void; onMatched: () => void }) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<backend.MatchCandidate[]>([]);
    const [searching, setSearching] = useState(false);
    const [applying, setApplying] = useState<string | null>(null);
    const timer = useRef<number | null>(null);
    useEffect(() => {
        if (!name) return;
        setQuery(name); setResults([]); setApplying(null);
    }, [name]);
    useEffect(() => {
        if (!name || !query.trim()) { setResults([]); return; }
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(async () => {
            setSearching(true);
            try {
                const r = await SearchArtistMatchCandidates(query.trim());
                setResults(r || []);
            } catch { setResults([]); }
            finally { setSearching(false); }
        }, 350);
        return () => { if (timer.current) window.clearTimeout(timer.current); };
    }, [query, name]);
    if (!name) return null;
    const pick = async (r: backend.MatchCandidate) => {
        setApplying(r.source + r.id);
        try {
            enrichAttempted.add(name);
            await SetArtistMatch(name, r.source, r.id);
            toast.success(`Matched “${name}” to ${r.name} (${r.source === "deezer" ? "Deezer" : "Spotify"})`);
            onMatched(); onClose();
        } catch (e) { toast.error(`Match failed: ${e}`); }
        finally { setApplying(null); }
    };
    const row = (r: backend.MatchCandidate) => (
        <button key={r.source + r.id} type="button" onClick={() => pick(r)} disabled={!!applying}
            className="w-full flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-accent text-left cursor-pointer disabled:opacity-50">
            {r.image ? <img src={r.image} alt="" loading="lazy" className="h-9 w-9 rounded-full object-cover" /> : <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center"><User className="h-4 w-4 text-muted-foreground" /></div>}
            <span className="flex-1 truncate text-sm">{r.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${r.source === "deezer" ? "bg-fuchsia-500/15 text-fuchsia-500" : "bg-emerald-500/15 text-emerald-500"}`}>
                {r.source === "deezer" ? "Deezer" : "Spotify"}
            </span>
            {applying === r.source + r.id && <Spinner className="h-4 w-4" />}
        </button>
    );
    const spotify = results.filter((r) => r.source === "spotify");
    const deezer = results.filter((r) => r.source === "deezer");
    return (
        <Dialog open={!!name} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Fix match — {name}</DialogTitle>
                    <DialogDescription>
                        Pick the correct artist from any source. Photo, bio and top tracks are refreshed from the match; fields you edited yourself stay locked.
                    </DialogDescription>
                </DialogHeader>
                <input className={editInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search artists…" autoFocus />
                <div className="max-h-80 overflow-y-auto space-y-1 pr-1">
                    {searching && <div className="py-6 flex justify-center"><Spinner className="h-4 w-4" /></div>}
                    {!searching && spotify.map(row)}
                    {!searching && deezer.length > 0 && spotify.length > 0 && <div className="border-t my-1" />}
                    {!searching && deezer.map(row)}
                    {!searching && results.length === 0 && query.trim() && (
                        <div className="py-6 text-center text-sm text-muted-foreground">No results</div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function NameDialog({ data, onClose }: { data: { title: string; value: string; submit: (v: string) => void } | null; onClose: () => void }) {
    const [value, setValue] = useState("");
    useEffect(() => { setValue(data?.value || ""); }, [data]);
    if (!data) return null;
    const submit = () => { const v = value.trim(); if (v) data.submit(v); onClose(); };
    return (
        <Dialog open={!!data} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader><DialogTitle>{data.title}</DialogTitle></DialogHeader>
                <input autoFocus value={value} onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                    placeholder="Playlist name"
                    className="h-9 w-full rounded-md bg-muted border border-border px-3 text-sm outline-none focus:border-primary" />
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
                    <Button size="sm" onClick={submit}>Save</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function CreditRow({ label, value }: { label: string; value: string }) {
    return <div className="flex gap-3"><div className="w-28 shrink-0 text-muted-foreground">{label}</div><div className="flex-1">{value}</div></div>;
}

function CreditsDialog({ track, onClose }: { track: Track | null; onClose: () => void }) {
    const [credits, setCredits] = useState<backend.Credit[]>([]);
    const [loading, setLoading] = useState(false);
    useEffect(() => {
        if (!track) return;
        setCredits([]); setLoading(true);
        GetTrackCredits(track.path).then(setCredits).catch(() => setCredits([])).finally(() => setLoading(false));
    }, [track]);

    const performing = CREDIT_ROLES.map((r) => ({
        label: r.label, names: (track?.artists || []).filter((a) => a.role === r.role).map((a) => a.name),
    })).filter((g) => g.names.length);

    const credGroups: { label: string; names: string[] }[] = [];
    for (const c of credits) {
        let g = credGroups.find((x) => x.label === c.role);
        if (!g) { g = { label: c.role, names: [] }; credGroups.push(g); }
        g.names.push(c.name);
    }

    return (
        <Dialog open={!!track} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-md">
                {track && (
                    <>
                        <DialogHeader>
                            <DialogTitle className="truncate">{track.title}</DialogTitle>
                            <DialogDescription>{track.album || "—"}{track.year ? ` · ${track.year}` : ""}</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-2.5 text-sm max-h-[60vh] overflow-y-auto pr-1">
                            {performing.map((g) => <CreditRow key={g.label} label={g.label} value={g.names.join(", ")} />)}
                            {performing.length > 0 && credGroups.length > 0 && <div className="border-t border-border !my-2.5" />}
                            {loading && <div className="text-muted-foreground text-xs">Reading credits…</div>}
                            {!loading && credGroups.length === 0 && <div className="text-muted-foreground text-xs">No songwriting / production credits saved in this file.</div>}
                            {credGroups.map((g) => <CreditRow key={g.label} label={g.label} value={g.names.join(", ")} />)}
                            <div className="border-t border-border !my-2.5" />
                            <CreditRow label="Genre" value={track.genre || "—"} />
                            <CreditRow label="Quality" value={fmtQuality(track)} />
                        </div>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

function normFolderPath(p: string): string {
    return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function FolderManager({ open, onOpenChange, folders, onAdd, onRemove, onRescan, onRefreshMetadata, scanning, refreshing }: {
    open: boolean; onOpenChange: (o: boolean) => void; folders: LibFolder[];
    onAdd: () => void; onRemove: (p: string) => void; onRescan: () => void; onRefreshMetadata: () => void;
    scanning: boolean; refreshing: boolean;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Library folders</DialogTitle>
                    <DialogDescription>Folders scanned into your library — downloads save here too. Removing one deletes its tracks from the library (files on disk are untouched).</DialogDescription>
                </DialogHeader>
                <div className="max-h-72 overflow-y-auto -mx-1">
                    {folders.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">No folders yet.</div>}
                    {folders.map((f) => (
                        <div key={f.path} className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent group">
                            <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{f.path}</div>
                                <div className="text-xs text-muted-foreground">{plural(f.trackCount, "track")}</div>
                            </div>
                            <button onClick={() => onRemove(f.path)} title="Remove from library"
                                className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition">
                                <Trash2 className="h-4 w-4" />
                            </button>
                        </div>
                    ))}
                </div>
                <div className="flex gap-2">
                    <Button onClick={onAdd} disabled={scanning} className="flex-1">
                        {scanning ? <Spinner className="h-4 w-4 mr-1.5" /> : <FolderPlus className="h-4 w-4 mr-1.5" />}
                        Add folder
                    </Button>
                    <Button variant="secondary" onClick={onRescan} disabled={scanning || folders.length === 0}
                        title="Scan all folders for new or changed files">
                        <RefreshCw className="h-4 w-4 mr-1.5" /> Rescan all
                    </Button>
                    <Button variant="secondary" onClick={onRefreshMetadata} disabled={scanning || refreshing || folders.length === 0}
                        title="Re-pull every artist's photo, banner, bio and top tracks from Spotify (your locked edits are kept)">
                        {refreshing ? <Spinner className="h-4 w-4 mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
                        Refresh metadata
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
