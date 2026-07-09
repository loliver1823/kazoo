import { useEffect } from "react";
import { ensureQualities, useTrackQuality, ensureAlbumQualities, useAlbumQuality } from "@/lib/quality";
import { useSource, sourceHasExactQuality, sourceLabel } from "@/lib/source";
import { backend } from "../../wailsjs/go/models";
import { cn } from "@/lib/utils";

function Pill({ text, hiRes, title, className }: { text: string; hiRes?: boolean; title?: string; className?: string }) {
    return (
        <span
            title={title ?? text}
            className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap",
                hiRes ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground",
                className,
            )}
        >
            {text}
        </span>
    );
}

function QualityPill({ q, className }: { q: backend.TrackQuality; className?: string }) {
    const text = `${q.source}${q.label ? ` · ${q.label}` : ""}`;
    return <Pill text={text} hiRes={q.hiRes} title={`Best available: ${text}`} className={className} />;
}

// Static label for sources whose exact spec isn't free to fetch (Tidal/Amazon).
function SourceTierPill({ source, className }: { source: string; className?: string }) {
    const label = sourceLabel(source);
    if (!label) return null;
    return <Pill text={`${label} · Lossless`} title={`${label} — lossless (exact spec not fetched to avoid rate limits)`} className={className} />;
}

// Best available source + quality for a single track (auto-probes on mount).
export function QualityBadge({ spotifyId, isrc, className }: { spotifyId?: string; isrc?: string; className?: string }) {
    const source = useSource();
    const exact = sourceHasExactQuality(source);
    useEffect(() => {
        if (exact && spotifyId) ensureQualities([{ spotifyId, isrc }]);
    }, [exact, spotifyId, isrc]);
    const q = useTrackQuality(spotifyId);
    if (!exact) return <SourceTierPill source={source} className={className} />;
    if (!q || !q.found) return null;
    return <QualityPill q={q} className={className} />;
}

// Album-level quality (ISRC-exact per edition for Qobuz/Auto; tier for others).
export function AlbumQualityBadge({ albumId, className }: { albumId?: string; className?: string }) {
    const source = useSource();
    const exact = sourceHasExactQuality(source);
    useEffect(() => {
        if (exact && albumId) ensureAlbumQualities([albumId]);
    }, [exact, albumId]);
    const q = useAlbumQuality(albumId);
    if (!exact) return <SourceTierPill source={source} className={className} />;
    if (!q || !q.found) return null;
    return <QualityPill q={q} className={className} />;
}
