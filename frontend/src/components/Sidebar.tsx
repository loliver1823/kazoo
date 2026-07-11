import { useEffect, useRef, useState, type RefObject } from "react";
import { SettingsIcon } from "@/components/ui/settings";
import { ActivityIcon, type ActivityIconHandle } from "@/components/ui/activity";
import { TerminalIcon } from "@/components/ui/terminal";
import { FileMusicIcon, type FileMusicIconHandle } from "@/components/ui/file-music";
import { FilePenIcon, type FilePenIconHandle } from "@/components/ui/file-pen";
import { FileTextIcon, type FileTextIconHandle } from "@/components/ui/file-text";
import { AudioLinesIcon, type AudioLinesIconHandle } from "@/components/ui/audio-lines";
import { ToolCaseIcon } from "@/components/ui/tool-case";
import { Library, Download, ListOrdered } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger, } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
export type PageType = "main" | "library" | "playlist-sync" | "queue" | "settings" | "debug" | "audio-analysis" | "audio-converter" | "audio-resampler" | "file-manager" | "lyrics-manager" | "projects" | "support";
interface SidebarProps {
    currentPage: PageType;
    onPageChange: (page: PageType) => void;
}
interface AnimatedIconHandle {
    startAnimation: () => void;
    stopAnimation: () => void;
}
export function Sidebar({ currentPage, onPageChange }: SidebarProps) {
    // Live count of active work (queued + downloading) for the Queue badge.
    const [activeQueueCount, setActiveQueueCount] = useState(0);
    useEffect(() => {
        const poll = async () => {
            try {
                // Counts-only endpoint — polling the full queue marshalled
                // hundreds of rows every 2s and slowed the UI mid-download.
                const c = await (window as any)["go"]["main"]["App"]["GetDownloadQueueCounts"]();
                setActiveQueueCount((c?.queued || 0) + (c?.downloading || 0));
            }
            catch { /* backend not ready */ }
        };
        poll();
        const t = setInterval(poll, 2000);
        return () => clearInterval(t);
    }, []);
    const analyzerIconRef = useRef<ActivityIconHandle>(null);
    const resamplerIconRef = useRef<AudioLinesIconHandle>(null);
    const converterIconRef = useRef<FileMusicIconHandle>(null);
    const fileManagerIconRef = useRef<FilePenIconHandle>(null);
    const lyricsManagerIconRef = useRef<FileTextIconHandle>(null);
    const getAnimatedItemHandlers = <T extends AnimatedIconHandle>(iconRef: RefObject<T | null>) => ({
        onMouseEnter: () => iconRef.current?.startAnimation(),
        onMouseLeave: () => iconRef.current?.stopAnimation(),
        onFocus: () => iconRef.current?.startAnimation(),
        onBlur: () => iconRef.current?.stopAnimation(),
    });
    return (<div className="fixed left-0 top-0 h-full w-14 bg-card border-r border-border flex flex-col items-center py-14 z-30">
            <div className="flex flex-col gap-2 flex-1">
                <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                        <Button variant={currentPage === "library" ? "secondary" : "ghost"} size="icon" className={`h-10 w-10 ${currentPage === "library" ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-primary/10 hover:text-primary"}`} onClick={() => onPageChange("library")}>
                            <Library size={20}/>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                        <p>Library</p>
                    </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                        <Button variant={currentPage === "main" ? "secondary" : "ghost"} size="icon" className={`h-10 w-10 ${currentPage === "main" ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-primary/10 hover:text-primary"}`} onClick={() => onPageChange("main")}>
                            <Download size={20}/>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                        <p>Download</p>
                    </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                        <Button variant={currentPage === "queue" ? "secondary" : "ghost"} size="icon" className={`relative h-10 w-10 ${currentPage === "queue" ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-primary/10 hover:text-primary"}`} onClick={() => onPageChange("queue")}>
                            <ListOrdered size={20}/>
                            {activeQueueCount > 0 && (<span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-4 text-center">
                                {activeQueueCount > 99 ? "99+" : activeQueueCount}
                            </span>)}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                        <p>Queue</p>
                    </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={0}>
                    <TooltipTrigger asChild>
                        <Button variant={currentPage === "settings" ? "secondary" : "ghost"} size="icon" className={`h-10 w-10 ${currentPage === "settings" ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-primary/10 hover:text-primary"}`} onClick={() => onPageChange("settings")}>
                            <SettingsIcon size={20}/>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                        <p>Settings</p>
                    </TooltipContent>
                </Tooltip>

                <DropdownMenu>
                    <Tooltip delayDuration={0}>
                        <DropdownMenuTrigger asChild>
                            <TooltipTrigger asChild>
                                <Button variant={["audio-analysis", "audio-converter", "audio-resampler", "file-manager", "lyrics-manager", "debug"].includes(currentPage) ? "secondary" : "ghost"} size="icon" className={`h-10 w-10 ${["audio-analysis", "audio-converter", "audio-resampler", "file-manager", "lyrics-manager", "debug"].includes(currentPage) ? "bg-primary/10 text-primary hover:bg-primary/20" : "hover:bg-primary/10 hover:text-primary"}`}>
                                    <ToolCaseIcon size={20}/>
                                </Button>
                            </TooltipTrigger>
                        </DropdownMenuTrigger>
                        <TooltipContent side="right">
                            <p>Tools</p>
                        </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent side="right" sideOffset={14} className="min-w-50 ml-2">
                        <DropdownMenuItem onClick={() => onPageChange("audio-analysis")} className="gap-3 cursor-pointer py-2 px-3" {...getAnimatedItemHandlers(analyzerIconRef)}>
                            <ActivityIcon ref={analyzerIconRef} size={16}/>
                            <span>Audio Quality Analyzer</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPageChange("audio-resampler")} className="gap-3 cursor-pointer py-2 px-3" {...getAnimatedItemHandlers(resamplerIconRef)}>
                            <AudioLinesIcon ref={resamplerIconRef} size={16}/>
                            <span>Audio Resampler</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPageChange("audio-converter")} className="gap-3 cursor-pointer py-2 px-3" {...getAnimatedItemHandlers(converterIconRef)}>
                            <FileMusicIcon ref={converterIconRef} size={16}/>
                            <span>Audio Converter</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPageChange("file-manager")} className="gap-3 cursor-pointer py-2 px-3" {...getAnimatedItemHandlers(fileManagerIconRef)}>
                            <FilePenIcon ref={fileManagerIconRef} size={16}/>
                            <span>File Organizer</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPageChange("lyrics-manager")} className="gap-3 cursor-pointer py-2 px-3" {...getAnimatedItemHandlers(lyricsManagerIconRef)}>
                            <FileTextIcon ref={lyricsManagerIconRef} size={16}/>
                            <span>Lyrics Manager</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onPageChange("debug")} className="gap-3 cursor-pointer py-2 px-3">
                            <TerminalIcon size={16}/>
                            <span>Debug Logs</span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

        </div>);
}
