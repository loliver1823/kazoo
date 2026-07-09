import { useSyncExternalStore } from "react";

// Clean variants are permanently excluded from fetch/search results (NOT the
// library) — there is no user toggle for this anymore.

const hideCleanState = true;

export function setHideClean(_v: boolean): void { /* always on */ }

export function toggleHideClean(): void { /* always on */ }

export function useHideClean(): boolean {
    return useSyncExternalStore(
        () => () => { },
        () => hideCleanState,
        () => hideCleanState,
    );
}

// A "clean" label: a (Clean)/[Clean] tag, or a "Clean Version/Edit" / "- Clean" suffix.
const CLEAN_LABEL_RE = /\(clean\b[^)]*\)|\[clean\b[^\]]*\]|\bclean version\b|\bclean edit\b|[-–]\s*clean\s*$/i;

function normForCleanMatch(s?: string): string {
    return (s || "")
        .toLowerCase()
        .replace(/\((clean|explicit)[^)]*\)/g, "")
        .replace(/\[(clean|explicit)[^\]]*\]/g, "")
        .replace(/[-–]\s*(clean|explicit)\s*$/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Drops items labelled "Clean", plus non-explicit items that have an explicit
// twin of the same title + artist within the same list.
export function excludeCleanVariants<T extends { name?: string; artists?: string; album_name?: string; is_explicit?: boolean }>(items: T[]): T[] {
    const explicitKeys = new Set<string>();
    for (const it of items) {
        if (it.is_explicit) {
            explicitKeys.add(normForCleanMatch(it.name) + "" + (it.artists || "").toLowerCase());
        }
    }
    return items.filter((it) => {
        if (CLEAN_LABEL_RE.test(it.name || "") || CLEAN_LABEL_RE.test(it.album_name || "")) return false;
        if (it.is_explicit === false) {
            const key = normForCleanMatch(it.name) + "" + (it.artists || "").toLowerCase();
            if (explicitKeys.has(key)) return false;
        }
        return true;
    });
}
