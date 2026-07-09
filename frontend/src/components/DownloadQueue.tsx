import { useEffect, useRef, useState } from "react";
import { X, Download, CheckCircle2, XCircle, Clock, FileCheck, Trash2, HardDrive, Zap, Timer, FileDown, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { GetDownloadQueue, ClearCompletedDownloads, ClearAllDownloads, ExportFailedDownloads, SetQueuePaused, RemoveDownloadItems, RequeueDownloadItems, ForceStopDownloads } from "../../wailsjs/go/main/App";
import { toastWithSound as toast } from "@/lib/toast-with-sound";
import { backend } from "../../wailsjs/go/models";

// Show paths library-relative — the full path is noise (and shows up in
// screenshots); it stays available as a hover tooltip.
function compactPath(p: string): string {
    if (!p) return "";
    const parts = p.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 3) return p;
    return parts.slice(-3).join("\\");
}

// Shared queue view — rendered both as the Queue page (sidebar) and inside
// the legacy dialog. Polls while mounted.
export function DownloadQueueView({ onClose }: { onClose?: () => void }) {
    const [queueInfo, setQueueInfo] = useState<backend.DownloadQueueInfo>(new backend.DownloadQueueInfo({
        is_downloading: false,
        queue: [],
        current_speed: 0,
        total_downloaded: 0,
        session_start_time: 0,
        queued_count: 0,
        completed_count: 0,
        failed_count: 0,
        skipped_count: 0,
    }));
    useEffect(() => {
        const fetchQueue = async () => {
            try {
                const info = await GetDownloadQueue();
                setQueueInfo(info);
            }
            catch (error) {
                console.error("Failed to get download queue:", error);
            }
        };
        fetchQueue();
        const interval = setInterval(fetchQueue, 400);
        return () => clearInterval(interval);
    }, []);
    const handleClearHistory = async () => {
        try {
            await ClearCompletedDownloads();
            const info = await GetDownloadQueue();
            setQueueInfo(info);
        }
        catch (error) {
            console.error("Failed to clear history:", error);
        }
    };
    const handleReset = async () => {
        try {
            await ClearAllDownloads();
            const info = await GetDownloadQueue();
            setQueueInfo(info);
            toast.success("Download queue reset");
        }
        catch (error) {
            console.error("Failed to reset queue:", error);
        }
    };
    const handleExportFailed = async () => {
        try {
            const message = await ExportFailedDownloads();
            if (message.startsWith("Successfully")) {
                toast.success(message);
            }
            else if (message !== "Export cancelled") {
                toast.info(message);
            }
        }
        catch (error) {
            console.error("Failed to export:", error);
            toast.error(`Failed to export: ${error}`);
        }
    };
    const getStatusIcon = (status: string) => {
        switch (status) {
            case "downloading":
                return <Download className="h-4 w-4 text-blue-500 animate-bounce"/>;
            case "completed":
                return <CheckCircle2 className="h-4 w-4 text-green-500"/>;
            case "failed":
                return <XCircle className="h-4 w-4 text-red-500"/>;
            case "skipped":
                return <FileCheck className="h-4 w-4 text-yellow-500"/>;
            case "queued":
                return <Clock className="h-4 w-4 text-muted-foreground"/>;
            default:
                return null;
        }
    };
    const getStatusBadge = (status: string) => {
        const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
            downloading: "default",
            completed: "outline",
            failed: "destructive",
            skipped: "secondary",
            queued: "outline",
        };
        return (<Badge variant={variants[status] || "outline"} className="text-xs">
      {status}
    </Badge>);
    };
    const formatDuration = (startTimestamp: number) => {
        if (startTimestamp === 0)
            return "—";
        const now = Math.floor(Date.now() / 1000);
        const durationSeconds = now - startTimestamp;
        const hours = Math.floor(durationSeconds / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = durationSeconds % 60;
        if (hours > 0) {
            return `${hours}h ${minutes}m ${seconds}s`;
        }
        else if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        }
        else {
            return `${seconds}s`;
        }
    };
    const [filterStatus, setFilterStatus] = useState<string>("all");
    const [showAllDone, setShowAllDone] = useState(false);
    const toggleFilter = (status: string) => {
        setFilterStatus(prev => prev === status ? "all" : status);
    };
    // Active work first; in the unfiltered view, collapse the wall of
    // completed/skipped rows so queued and downloading items stay visible.
    const DONE_PREVIEW = 6;
    const baseQueue = queueInfo.queue.filter((item: any) => {
        if (filterStatus === "all")
            return true;
        return item.status === filterStatus;
    });
    const isTerminalOk = (s: string) => s === "completed" || s === "skipped";
    let hiddenDone = 0;
    let filteredQueue = baseQueue;
    if (filterStatus === "all" && !showAllDone) {
        const active = baseQueue.filter((i: any) => !isTerminalOk(i.status));
        const done = baseQueue.filter((i: any) => isTerminalOk(i.status));
        hiddenDone = Math.max(0, done.length - DONE_PREVIEW);
        filteredQueue = [...active, ...done.slice(0, DONE_PREVIEW)];
    } else if (filterStatus === "all") {
        filteredQueue = [
            ...baseQueue.filter((i: any) => !isTerminalOk(i.status)),
            ...baseQueue.filter((i: any) => isTerminalOk(i.status)),
        ];
    }

    // Multi-select (ctrl toggles, shift ranges over the visible list).
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const lastClickIdx = useRef(-1);
    const rowClick = (index: number, e: React.MouseEvent) => {
        const ids = filteredQueue.map((i: any) => i.id);
        const id = ids[index];
        setSelected((prev) => {
            if (e.shiftKey && lastClickIdx.current >= 0) {
                const next = new Set(prev);
                const [a, b] = lastClickIdx.current < index ? [lastClickIdx.current, index] : [index, lastClickIdx.current];
                for (let i = a; i <= b; i++) next.add(ids[i]);
                return next;
            }
            if (e.ctrlKey || e.metaKey) {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id); else next.add(id);
                return next;
            }
            return prev.has(id) && prev.size === 1 ? new Set<string>() : new Set([id]);
        });
        if (!e.shiftKey) lastClickIdx.current = index;
    };

    const [retrying, setRetrying] = useState(false);
    const selectedItems = queueInfo.queue.filter((i: any) => selected.has(i.id));
    const retryable = selectedItems.filter((i: any) => i.status === "failed" || i.status === "skipped");

    // Failed/skipped items keep their metadata, so retry is just a requeue —
    // the backend runner picks them up again.
    const retrySelected = async () => {
        if (!retryable.length || retrying) return;
        setRetrying(true);
        try {
            await RequeueDownloadItems(retryable.map((i: any) => i.id));
            setSelected(new Set());
            const info = await GetDownloadQueue();
            setQueueInfo(info);
        } finally { setRetrying(false); }
    };

    const removeSelected = async () => {
        if (!selectedItems.length) return;
        await RemoveDownloadItems(selectedItems.map((i: any) => i.id));
        setSelected(new Set());
        const info = await GetDownloadQueue();
        setQueueInfo(info);
    };

    const togglePause = async () => {
        await SetQueuePaused(!(queueInfo as any).paused);
        const info = await GetDownloadQueue();
        setQueueInfo(info);
    };
    return (<div className="flex flex-col h-full min-h-0">
      <div className="px-6 pt-6 pb-4 border-b">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold hover:text-primary transition-colors cursor-pointer" title="Click to reset the queue" onClick={handleReset}>Download Queue</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={togglePause}
              title={(queueInfo as any).paused ? "Resume downloads" : "Pause all downloads (current file finishes first)"}>
              {(queueInfo as any).paused ? <Play className="h-3 w-3"/> : <Pause className="h-3 w-3"/>}
              {(queueInfo as any).paused ? "Resume" : "Pause all"}
            </Button>
            {(queueInfo.completed_count > 0 || queueInfo.failed_count > 0 || queueInfo.skipped_count > 0) && (<Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={handleClearHistory}>
              <Trash2 className="h-3 w-3"/>
              Clear History
            </Button>)}
            {queueInfo.failed_count > 0 && (<Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={handleExportFailed}>
              <FileDown className="h-3 w-3"/>
              Export Failures
            </Button>)}
            {onClose && (<Button variant="ghost" size="icon" className="h-7 w-7 rounded-full hover:bg-muted" onClick={onClose}>
              <X className="h-4 w-4"/>
            </Button>)}
          </div>
        </div>


        <div className="flex items-center gap-4 text-sm">
          <div className={`flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all select-none ${filterStatus === 'queued' ? 'bg-secondary px-2 py-0.5 rounded-md ring-1 ring-border' : ''}`} onClick={() => toggleFilter('queued')}>
            <Clock className="h-3.5 w-3.5 text-muted-foreground"/>
            <span className="text-muted-foreground">Queued:</span>
            <span className="font-semibold">{queueInfo.queued_count}</span>
          </div>
          <div className={`flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all select-none ${filterStatus === 'completed' ? 'bg-green-500/10 px-2 py-0.5 rounded-md ring-1 ring-green-500/20' : ''}`} onClick={() => toggleFilter('completed')}>
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500"/>
            <span className="text-muted-foreground">Completed:</span>
            <span className="font-semibold">{queueInfo.completed_count}</span>
          </div>
          <div className={`flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all select-none ${filterStatus === 'skipped' ? 'bg-yellow-500/10 px-2 py-0.5 rounded-md ring-1 ring-yellow-500/20' : ''}`} onClick={() => toggleFilter('skipped')}>
            <FileCheck className="h-3.5 w-3.5 text-yellow-500"/>
            <span className="text-muted-foreground">Skipped:</span>
            <span className="font-semibold">{queueInfo.skipped_count}</span>
          </div>
          <div className={`flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all select-none ${filterStatus === 'failed' ? 'bg-red-500/10 px-2 py-0.5 rounded-md ring-1 ring-red-500/20' : ''}`} onClick={() => toggleFilter('failed')}>
            <XCircle className="h-3.5 w-3.5 text-red-500"/>
            <span className="text-muted-foreground">Failed:</span>
            <span className="font-semibold">{queueInfo.failed_count}</span>
          </div>
        </div>


        {(queueInfo as any).paused && (
          <div className="flex items-center gap-2 mt-3 rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-600 dark:text-blue-300">
            <Pause className="h-4 w-4 shrink-0"/>
            <span>Queue paused — downloads hold until you resume.</span>
          </div>
        )}

        {selected.size > 0 && (
          <div className="flex items-center gap-2 mt-3 rounded-lg bg-accent/60 border px-3 py-2 text-sm">
            <span className="text-muted-foreground">{selected.size} selected</span>
            <Button size="sm" variant="secondary" className="h-7 text-xs gap-1.5" disabled={!retryable.length || retrying} onClick={retrySelected}>
              <RotateCcw className="h-3 w-3"/> Retry ({retryable.length})
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1.5" onClick={removeSelected}>
              <Trash2 className="h-3 w-3"/> Remove
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {(queueInfo as any).cooldown && (
          <div className="flex items-center gap-2 mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
            <Timer className="h-4 w-4 shrink-0"/>
            <span>
              Servers are on a scheduled break — downloads will resume automatically in
              {" "}~{Math.max(1, Math.ceil(((queueInfo as any).cooldown_secs || 0) / 60))} minute{Math.ceil(((queueInfo as any).cooldown_secs || 0) / 60) === 1 ? "" : "s"}.
            </span>
          </div>
        )}

        <div className="flex items-center gap-4 text-sm pt-3 mt-3 border-t">
          <div className="flex items-center gap-1.5">
            <HardDrive className="h-3.5 w-3.5 text-muted-foreground"/>
            <span className="text-muted-foreground">Downloaded:</span>
            <span className="font-semibold font-mono">
              {queueInfo.total_downloaded > 0 ? `${queueInfo.total_downloaded.toFixed(2)} MB` : "0.00 MB"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground"/>
            <span className="text-muted-foreground">Speed:</span>
            <span className="font-semibold font-mono">
              {queueInfo.current_speed > 0 && queueInfo.is_downloading
            ? `${queueInfo.current_speed.toFixed(2)} MB/s`
            : "—"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5 text-muted-foreground"/>
            <span className="text-muted-foreground">Duration:</span>
            <span className="font-semibold font-mono">
              {queueInfo.session_start_time > 0 ? formatDuration(queueInfo.session_start_time) : "—"}
            </span>
          </div>
        </div>

      </div>


      <div className="flex-1 overflow-y-auto px-6 custom-scrollbar">
        <div className="space-y-2 py-4">
          {queueInfo.queue.length === 0 ? (<div className="text-center py-12 text-muted-foreground">
            <Download className="h-12 w-12 mx-auto mb-3 opacity-20"/>
            <p>No downloads in queue</p>
          </div>) : filteredQueue.length === 0 ? (<div className="text-center py-12 text-muted-foreground">
             <p>No downloads with status "{filterStatus}"</p>
             <Button variant="link" onClick={() => setFilterStatus("all")}>Clear filter</Button>
            </div>) : (filteredQueue.map((item: any, idx: number) => (<div key={item.id}
            onClick={(e) => rowClick(idx, e)}
            className={`border rounded-lg p-3 transition-colors cursor-pointer select-none ${selected.has(item.id) ? "bg-accent ring-1 ring-primary" : "hover:bg-muted/30"}`}>
            <div className="flex items-start gap-3">
              <div className="mt-1">{getStatusIcon(item.status)}</div>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{item.track_name}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {item.artist_name}
                      {item.album_name && ` • ${item.album_name}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {item.status === "downloading" && (
                      <button type="button" title="Cancel this download (no partial file is left behind)"
                        className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                        onClick={(e) => { e.stopPropagation(); ForceStopDownloads(); toast.info("Cancelling download…"); }}>
                        <XCircle className="h-4 w-4"/>
                      </button>
                    )}
                    {getStatusBadge(item.status)}
                  </div>
                </div>


                {item.status === "downloading" && (() => {
                    const pct = item.total_size > 0 ? Math.min(100, (item.progress / item.total_size) * 100) : null;
                    const speed = item.speed > 0 ? item.speed : queueInfo.current_speed;
                    return (<div className="mt-2">
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        {pct !== null ? (
                          <div className="queue-bar-fill h-full rounded-full bg-primary relative overflow-hidden" style={{ width: `${pct}%` }}>
                            <div className="queue-bar-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent"/>
                          </div>
                        ) : (
                          <div className="queue-bar-indeterminate h-full w-1/3 rounded-full bg-primary/70"/>
                        )}
                      </div>
                      <div className="flex items-center justify-between mt-1.5 text-xs text-muted-foreground font-mono">
                        <span>
                          {item.progress > 0
                            ? (pct !== null && pct >= 99.5
                                ? "Finishing (tagging)…"
                                : `${item.progress.toFixed(2)}${item.total_size > 0 ? ` / ${item.total_size.toFixed(2)}` : ""} MB`)
                            : "Preparing (resolving source)…"}
                        </span>
                        <span>
                          {pct !== null ? `${pct.toFixed(0)}% · ` : ""}
                          {speed > 0 ? `${speed.toFixed(2)} MB/s` : "—"}
                        </span>
                      </div>
                    </div>);
                })()}


                {item.status === "completed" && (<div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                  <span className="font-mono">{item.progress.toFixed(2)} MB</span>
                </div>)}


                {item.status === "skipped" && (<div className="mt-1.5 text-xs text-muted-foreground">
                  File already exists
                </div>)}


                {item.status === "failed" && item.error_message && (<div className="mt-1.5 text-xs text-red-500 bg-red-50 dark:bg-red-950/20 rounded px-2 py-1">
                  {item.error_message}
                </div>)}


                {(item.status === "completed" || item.status === "skipped") && item.file_path && (<div className="mt-1.5 text-xs text-muted-foreground truncate font-mono" title={item.file_path}>
                  {compactPath(item.file_path)}
                </div>)}
              </div>
            </div>
          </div>)))}
          {hiddenDone > 0 && (
            <button type="button" onClick={() => setShowAllDone(true)}
              className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2 rounded-lg border border-dashed cursor-pointer transition-colors">
              Show {hiddenDone.toLocaleString()} more finished download{hiddenDone === 1 ? "" : "s"}
            </button>
          )}
          {showAllDone && filterStatus === "all" && queueInfo.queue.length > DONE_PREVIEW && (
            <button type="button" onClick={() => setShowAllDone(false)}
              className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2 rounded-lg border border-dashed cursor-pointer transition-colors">
              Collapse finished downloads
            </button>
          )}
        </div>
      </div>
    </div>);
}

// The full-page Queue view for the sidebar.
export function QueuePage() {
    return (<div className="h-full min-h-0">
      <DownloadQueueView />
    </div>);
}

interface DownloadQueueProps {
    isOpen: boolean;
    onClose: () => void;
}
export function DownloadQueue({ isOpen, onClose }: DownloadQueueProps) {
    return (<Dialog open={isOpen} onOpenChange={onClose}>
    <DialogContent className="max-w-[1200px] w-[95vw] max-h-[80vh] h-[80vh] flex flex-col p-0 gap-0 [&>button]:hidden">
      <DialogHeader className="sr-only">
        <DialogTitle>Download Queue</DialogTitle>
      </DialogHeader>
      <DownloadQueueView onClose={onClose}/>
    </DialogContent>
  </Dialog>);
}
