import { useDownloadQueueData } from "@/hooks/useDownloadQueueData";
import { Loader2, Pause, Timer } from "lucide-react";

// Compact download indicator living in the title bar next to the window
// controls: "3/12 Downloading… 2.4 MB/s" while working, a break countdown
// during server cooldowns. Clicking opens the queue.
export function TitleBarDownloadStatus() {
    const info = useDownloadQueueData() as any;
    const items = info.queue || [];
    const active = items.find((i: any) => i.status === "downloading");
    const queued = items.filter((i: any) => i.status === "queued").length;
    if (!active && queued === 0) return null;

    // Finished items persist across sessions — only count this session's.
    const sessionStart = info.session_start_time || 0;
    const sessionDone = sessionStart > 0
        ? items.filter((i: any) =>
            (i.status === "completed" || i.status === "failed" || i.status === "skipped") &&
            (i.end_time || 0) >= sessionStart).length
        : 0;
    const total = sessionDone + queued + (active ? 1 : 0);
    const pos = Math.min(sessionDone + 1, total);

    const paused = !!info.paused;
    const cooling = !!info.cooldown;
    const secs = info.cooldown_secs || 0;
    const breakClock = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, "0")}`;
    const speed = info.current_speed || 0;

    const status = paused
        ? "Paused"
        : cooling
            ? `Server break ${breakClock}`
            : active
                ? `Downloading…${speed > 0.05 ? ` ${speed.toFixed(1)} MB/s` : ""}`
                : "Starting…";

    return (
        <button type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("kazoo:open-queue"))}
            title="Open download queue"
            className="flex h-7 items-center gap-1.5 rounded px-2 mr-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors animate-in fade-in duration-300"
            style={{ "--wails-draggable": "no-drag" } as React.CSSProperties}>
            {paused
                ? <Pause className="h-3.5 w-3.5 text-blue-500" />
                : cooling
                    ? <Timer className="h-3.5 w-3.5 text-amber-500" />
                    : <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
            <span className="tabular-nums font-medium">{pos}/{total}</span>
            <span className="whitespace-nowrap">{status}</span>
        </button>
    );
}
