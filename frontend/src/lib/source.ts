import { useSyncExternalStore } from "react";
import { getSettings, saveSettings } from "./settings";

// Synced wrapper around the download-source setting so the inline picker and the
// quality badges stay in lock-step without prop drilling.

let current: string = (() => {
    try { return getSettings().downloader || "auto"; } catch { return "auto"; }
})();
const listeners = new Set<() => void>();

export function setSource(v: string): void {
    if (v === current) return;
    current = v;
    const s = getSettings();
    void saveSettings({ ...s, downloader: v as typeof s.downloader });
    listeners.forEach((l) => l());
}

export function useSource(): string {
    return useSyncExternalStore(
        (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        () => current,
        () => current,
    );
}

// Whether a source has free, exact quality metadata (Qobuz / Auto use Qobuz).
export function sourceHasExactQuality(source: string): boolean {
    return source === "qobuz" || source === "auto" || source === "";
}

export function sourceLabel(source: string): string {
    switch (source) {
        case "tidal": return "Tidal";
        case "amazon": return "Amazon";
        case "qobuz": return "Qobuz";
        default: return "";
    }
}
