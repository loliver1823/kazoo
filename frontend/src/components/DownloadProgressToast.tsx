import { useDownloadQueueData } from "@/hooks/useDownloadQueueData";
import { Download, Pause, Timer } from "lucide-react";

interface DownloadProgressToastProps {
    onClick: () => void;
}

// Floating download activity notice: slides in below the title bar while the
// queue is working, shows the active track with a live progress bar, and
// clicks through to the queue.
export function DownloadProgressToast({ onClick }: DownloadProgressToastProps) {
    const queueInfo = useDownloadQueueData();
    const info = queueInfo as any;
    const active = queueInfo.queue.find((i) => i.status === "downloading");
    const queuedCount = queueInfo.queue.filter((i) => i.status === "queued").length;
    if (!active && queuedCount === 0) {
        return null;
    }
    const pct = active && active.total_size > 0
        ? Math.min(100, (active.progress / active.total_size) * 100)
        : null;
    const paused = !!info.paused;
    const cooling = !!info.cooldown;
    const label = active
        ? `${active.track_name} — ${active.artist_name}`
        : paused
            ? "Downloads paused"
            : cooling
                ? "Waiting out a server break…"
                : "Starting next download…";
    return (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-4 duration-300">
            <button type="button" onClick={onClick}
                className="w-[420px] max-w-[90vw] cursor-pointer rounded-xl border bg-background/95 backdrop-blur shadow-lg px-4 py-2.5 text-left transition-colors hover:bg-muted/60">
                <div className="flex items-center gap-3">
                    {paused
                        ? <Pause className="h-4 w-4 shrink-0 text-blue-500"/>
                        : cooling && !active
                            ? <Timer className="h-4 w-4 shrink-0 text-amber-500"/>
                            : <Download className="h-4 w-4 shrink-0 text-primary animate-bounce"/>}
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{label}</p>
                        <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                            {pct !== null ? (
                                <div className="queue-bar-fill h-full rounded-full bg-primary relative overflow-hidden" style={{ width: `${pct}%` }}>
                                    <div className="queue-bar-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent"/>
                                </div>
                            ) : (
                                <div className="queue-bar-indeterminate h-full w-1/3 rounded-full bg-primary/70"/>
                            )}
                        </div>
                    </div>
                    <div className="shrink-0 text-right">
                        <p className="text-xs font-mono tabular-nums text-muted-foreground">
                            {pct !== null ? `${pct.toFixed(0)}%` : active && active.progress > 0 ? `${active.progress.toFixed(1)} MB` : "…"}
                        </p>
                        {queuedCount > 0 && (
                            <p className="text-[10px] text-muted-foreground whitespace-nowrap">+{queuedCount.toLocaleString()} queued</p>
                        )}
                    </div>
                </div>
            </button>
        </div>
    );
}
