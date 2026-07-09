import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EyeOff } from "lucide-react";
import { useHideClean, toggleHideClean } from "@/lib/clean";

// Toggle to hide "clean" variants in fetch/search results. Shared, synced state.
export function CleanToggle({ labelled = false }: { labelled?: boolean }) {
    const hideClean = useHideClean();
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant={hideClean ? "default" : "outline"}
                    size={labelled ? "default" : "icon"}
                    className={labelled ? "shrink-0 gap-1.5" : "shrink-0"}
                    onClick={toggleHideClean}
                    aria-label="Hide clean versions"
                >
                    <EyeOff className="h-4 w-4" />
                    {labelled && (hideClean ? "Clean hidden" : "Hide clean")}
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                <p>{hideClean ? "Clean versions hidden — click to show" : "Hide clean versions"}</p>
            </TooltipContent>
        </Tooltip>
    );
}
