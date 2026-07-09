import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TidalIcon, QobuzIcon, AmazonIcon } from "./PlatformIcons";
import { useSource, setSource } from "@/lib/source";

// Inline download-source picker; persists to settings so downloads use it.
export function SourceSelect({ className }: { className?: string }) {
    const value = useSource();
    return (
        <Select value={value} onValueChange={setSource}>
            <SelectTrigger className={`h-8 w-fit gap-1.5 ${className ?? ""}`} aria-label="Download source">
                <span className="text-xs text-muted-foreground">Source</span>
                <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="tidal"><span className="flex items-center gap-2"><TidalIcon />Tidal</span></SelectItem>
                <SelectItem value="qobuz"><span className="flex items-center gap-2"><QobuzIcon />Qobuz</span></SelectItem>
                <SelectItem value="amazon"><span className="flex items-center gap-2"><AmazonIcon />Amazon Music</span></SelectItem>
            </SelectContent>
        </Select>
    );
}
