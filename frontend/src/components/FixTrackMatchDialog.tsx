import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Check, Search } from "lucide-react";
import { GetLibraryTracks, SetTrackMatch } from "../../wailsjs/go/main/App";
import { backend } from "../../wailsjs/go/models";
import { toastWithSound as toast } from "@/lib/toast-with-sound";

// Fix Match for a Spotify track (popular list or synced playlist row): pick
// the library track it should map to. The override is keyed by Spotify ID so
// it applies everywhere the song shows up.
export function FixTrackMatchDialog({ open, spotifyId, initialQuery, currentTrackId, onClose, onApplied }: {
    open: boolean;
    spotifyId: string;
    initialQuery: string;
    currentTrackId?: number;
    onClose: () => void;
    onApplied: () => void;
}) {
    const [q, setQ] = useState(initialQuery);
    const [results, setResults] = useState<backend.LibraryTrack[]>([]);
    const [loading, setLoading] = useState(false);
    useEffect(() => { if (open) setQ(initialQuery); }, [open, initialQuery]);
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setLoading(true);
        const t = setTimeout(async () => {
            try {
                const res = await GetLibraryTracks({
                    search: q, filters: {}, sort: "title", desc: false, limit: 50, offset: 0,
                } as unknown as backend.LibraryQuery);
                if (alive) setResults(res || []);
            }
            catch { if (alive) setResults([]); }
            finally { if (alive) setLoading(false); }
        }, 250);
        return () => { alive = false; clearTimeout(t); };
    }, [q, open]);

    const apply = async (trackId: number) => {
        try {
            await SetTrackMatch(spotifyId, trackId);
            toast.success(trackId > 0 ? "Match updated" : "Reverted to automatic matching");
            onApplied();
            onClose();
        }
        catch (e) { toast.error(`${e}`); }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Fix match</DialogTitle>
                    <DialogDescription>Pick the library track this song should match. The fix applies everywhere it appears — Popular lists and synced playlists.</DialogDescription>
                </DialogHeader>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search your library…"
                        className="h-9 w-full rounded-md bg-muted focus:bg-accent pl-9 pr-3 text-sm outline-none"
                    />
                </div>
                <div className="max-h-72 overflow-y-auto -mx-1">
                    {loading && <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground"><Spinner className="h-4 w-4" /> Searching…</div>}
                    {!loading && results.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">No library tracks match.</div>}
                    {!loading && results.map((t) => (
                        <button key={t.id} type="button" onClick={() => apply(Number(t.id))}
                            className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-left cursor-pointer">
                            <div className="min-w-0 flex-1">
                                <div className="text-sm truncate">{t.title}</div>
                                <div className="text-xs text-muted-foreground truncate">{t.artist}{t.album ? ` — ${t.album}` : ""}</div>
                            </div>
                            {currentTrackId != null && Number(t.id) === currentTrackId && <Check className="h-4 w-4 text-green-500 shrink-0" />}
                        </button>
                    ))}
                </div>
                <div className="flex justify-between">
                    <Button variant="ghost" size="sm" onClick={() => apply(0)}>Use automatic match</Button>
                    <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
