// Placeholder "kazoo" mark (a bobbin/spool) — swap for a real logo later.
function KazooMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className}>
            <line x1="12" y1="3.5" x2="12" y2="20.5" />
            <ellipse cx="12" cy="6" rx="6" ry="1.8" />
            <ellipse cx="12" cy="18" rx="6" ry="1.8" />
            <path d="M8 10h8M8 12.5h8M8 15h8" />
        </svg>
    );
}

export function Header() {
    const reload = () => window.location.reload();
    return (
        <div className="relative flex flex-col items-center text-center gap-4 pt-2">
            <div className="flex items-center gap-3.5">
                <button
                    type="button"
                    onClick={reload}
                    aria-label="Reload Kazoo"
                    className="group cursor-pointer rounded-2xl border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                    <span className="flex h-12 w-12 items-center justify-center rounded-[15px] bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-lg shadow-primary/25 transition-transform group-hover:scale-105">
                        <KazooMark className="h-7 w-7" />
                    </span>
                </button>
                <button type="button" onClick={reload} className="cursor-pointer rounded-sm border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                    <h1 className="text-4xl font-bold tracking-tight">
                        Kazoo<span className="text-muted-foreground/60 font-normal"> Music</span>
                    </h1>
                </button>
            </div>
            <p className="max-w-xl text-muted-foreground">
                Your lossless music manager — search, fetch and organise tracks from Tidal, Qobuz &amp; Amazon, all in one library.
            </p>
        </div>
    );
}
