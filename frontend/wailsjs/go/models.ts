export namespace backend {
	
	export class AnalysisDecodeResponse {
	    pcm_base64: string;
	    sample_rate: number;
	    channels: number;
	    bits_per_sample: number;
	    duration: number;
	    bitrate_kbps?: number;
	    bit_depth?: string;
	
	    static createFrom(source: any = {}) {
	        return new AnalysisDecodeResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pcm_base64 = source["pcm_base64"];
	        this.sample_rate = source["sample_rate"];
	        this.channels = source["channels"];
	        this.bits_per_sample = source["bits_per_sample"];
	        this.duration = source["duration"];
	        this.bitrate_kbps = source["bitrate_kbps"];
	        this.bit_depth = source["bit_depth"];
	    }
	}
	export class ArtCandidate {
	    source: string;
	    url: string;
	
	    static createFrom(source: any = {}) {
	        return new ArtCandidate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.url = source["url"];
	    }
	}
	export class ArtistArtCandidates {
	    photos: ArtCandidate[];
	    banners: ArtCandidate[];
	
	    static createFrom(source: any = {}) {
	        return new ArtistArtCandidates(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.photos = this.convertValues(source["photos"], ArtCandidate);
	        this.banners = this.convertValues(source["banners"], ArtCandidate);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ArtistMeta {
	    name: string;
	    genre: string;
	    genreMixed: boolean;
	    trackCount: number;
	    bio: string;
	
	    static createFrom(source: any = {}) {
	        return new ArtistMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.genre = source["genre"];
	        this.genreMixed = source["genreMixed"];
	        this.trackCount = source["trackCount"];
	        this.bio = source["bio"];
	    }
	}
	export class ArtistReleaseCheck {
	    id: string;
	    name: string;
	    type: string;
	    releaseDate: string;
	    cover: string;
	    url: string;
	    totalTracks: number;
	    haveTracks: number;
	    inLibrary: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ArtistReleaseCheck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.releaseDate = source["releaseDate"];
	        this.cover = source["cover"];
	        this.url = source["url"];
	        this.totalTracks = source["totalTracks"];
	        this.haveTracks = source["haveTracks"];
	        this.inLibrary = source["inLibrary"];
	    }
	}
	export class LibraryAlbum {
	    id: string;
	    title: string;
	    albumArtist: string;
	    year: number;
	    trackCount: number;
	    coverPath: string;
	    releaseType: string;
	    codec: string;
	    sampleRate: number;
	    bitrate: number;
	    totalTracks: number;
	
	    static createFrom(source: any = {}) {
	        return new LibraryAlbum(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.albumArtist = source["albumArtist"];
	        this.year = source["year"];
	        this.trackCount = source["trackCount"];
	        this.coverPath = source["coverPath"];
	        this.releaseType = source["releaseType"];
	        this.codec = source["codec"];
	        this.sampleRate = source["sampleRate"];
	        this.bitrate = source["bitrate"];
	        this.totalTracks = source["totalTracks"];
	    }
	}
	export class ArtistReleases {
	    own: LibraryAlbum[];
	    appearsOn: LibraryAlbum[];
	
	    static createFrom(source: any = {}) {
	        return new ArtistReleases(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.own = this.convertValues(source["own"], LibraryAlbum);
	        this.appearsOn = this.convertValues(source["appearsOn"], LibraryAlbum);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ArtistTopTrack {
	    rank: number;
	    title: string;
	    album: string;
	    artist: string;
	    spotifyId: string;
	    inLibrary: boolean;
	    libraryTrackId?: number;
	    codec?: string;
	    sampleRate?: number;
	    bitrate?: number;
	
	    static createFrom(source: any = {}) {
	        return new ArtistTopTrack(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rank = source["rank"];
	        this.title = source["title"];
	        this.album = source["album"];
	        this.artist = source["artist"];
	        this.spotifyId = source["spotifyId"];
	        this.inLibrary = source["inLibrary"];
	        this.libraryTrackId = source["libraryTrackId"];
	        this.codec = source["codec"];
	        this.sampleRate = source["sampleRate"];
	        this.bitrate = source["bitrate"];
	    }
	}
	export class AudioMetadata {
	    title: string;
	    artist: string;
	    album: string;
	    album_artist: string;
	    track_number: number;
	    disc_number: number;
	    year: string;
	    isrc: string;
	    upc: string;
	
	    static createFrom(source: any = {}) {
	        return new AudioMetadata(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.artist = source["artist"];
	        this.album = source["album"];
	        this.album_artist = source["album_artist"];
	        this.track_number = source["track_number"];
	        this.disc_number = source["disc_number"];
	        this.year = source["year"];
	        this.isrc = source["isrc"];
	        this.upc = source["upc"];
	    }
	}
	export class AvatarDownloadResponse {
	    success: boolean;
	    message: string;
	    file?: string;
	    error?: string;
	    already_exists?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AvatarDownloadResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	    }
	}
	export class BulkMeta {
	    title: string;
	    artist: string;
	    albumArtist: string;
	    album: string;
	    genre: string;
	    composer: string;
	    releaseType: string;
	    year: number;
	    trackNo: number;
	    discNo: number;
	    fields: string[];
	
	    static createFrom(source: any = {}) {
	        return new BulkMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.artist = source["artist"];
	        this.albumArtist = source["albumArtist"];
	        this.album = source["album"];
	        this.genre = source["genre"];
	        this.composer = source["composer"];
	        this.releaseType = source["releaseType"];
	        this.year = source["year"];
	        this.trackNo = source["trackNo"];
	        this.discNo = source["discNo"];
	        this.fields = source["fields"];
	    }
	}
	export class TrackMeta {
	    path: string;
	    title: string;
	    artist: string;
	    albumArtist: string;
	    album: string;
	    genre: string;
	    composer: string;
	    releaseType: string;
	    year: number;
	    trackNo: number;
	    discNo: number;
	
	    static createFrom(source: any = {}) {
	        return new TrackMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.title = source["title"];
	        this.artist = source["artist"];
	        this.albumArtist = source["albumArtist"];
	        this.album = source["album"];
	        this.genre = source["genre"];
	        this.composer = source["composer"];
	        this.releaseType = source["releaseType"];
	        this.year = source["year"];
	        this.trackNo = source["trackNo"];
	        this.discNo = source["discNo"];
	    }
	}
	export class CommonMeta {
	    meta: TrackMeta;
	    mixed: string[];
	
	    static createFrom(source: any = {}) {
	        return new CommonMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.meta = this.convertValues(source["meta"], TrackMeta);
	        this.mixed = source["mixed"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ConvertAudioResult {
	    input_file: string;
	    output_file: string;
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConvertAudioResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.input_file = source["input_file"];
	        this.output_file = source["output_file"];
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class CoverDownloadResponse {
	    success: boolean;
	    message: string;
	    file?: string;
	    error?: string;
	    already_exists?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CoverDownloadResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	    }
	}
	export class Credit {
	    role: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new Credit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.name = source["name"];
	    }
	}
	export class DownloadItem {
	    id: string;
	    track_name: string;
	    artist_name: string;
	    album_name: string;
	    spotify_id: string;
	    status: string;
	    progress: number;
	    total_size: number;
	    speed: number;
	    start_time: number;
	    end_time: number;
	    error_message: string;
	    file_path: string;
	    artists?: string;
	    album_artist?: string;
	    release_date?: string;
	    cover_url?: string;
	    duration_ms?: number;
	    track_no?: number;
	    disc_no?: number;
	    total_tracks?: number;
	    total_discs?: number;
	    copyright?: string;
	    publisher?: string;
	    isrc?: string;
	    album_id?: string;
	    category?: string;
	    upc?: string;
	    position?: number;
	    service?: string;
	    apply_folder?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DownloadItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.track_name = source["track_name"];
	        this.artist_name = source["artist_name"];
	        this.album_name = source["album_name"];
	        this.spotify_id = source["spotify_id"];
	        this.status = source["status"];
	        this.progress = source["progress"];
	        this.total_size = source["total_size"];
	        this.speed = source["speed"];
	        this.start_time = source["start_time"];
	        this.end_time = source["end_time"];
	        this.error_message = source["error_message"];
	        this.file_path = source["file_path"];
	        this.artists = source["artists"];
	        this.album_artist = source["album_artist"];
	        this.release_date = source["release_date"];
	        this.cover_url = source["cover_url"];
	        this.duration_ms = source["duration_ms"];
	        this.track_no = source["track_no"];
	        this.disc_no = source["disc_no"];
	        this.total_tracks = source["total_tracks"];
	        this.total_discs = source["total_discs"];
	        this.copyright = source["copyright"];
	        this.publisher = source["publisher"];
	        this.isrc = source["isrc"];
	        this.album_id = source["album_id"];
	        this.category = source["category"];
	        this.upc = source["upc"];
	        this.position = source["position"];
	        this.service = source["service"];
	        this.apply_folder = source["apply_folder"];
	    }
	}
	export class DownloadQueueInfo {
	    is_downloading: boolean;
	    queue: DownloadItem[];
	    current_speed: number;
	    total_downloaded: number;
	    session_start_time: number;
	    queued_count: number;
	    completed_count: number;
	    failed_count: number;
	    skipped_count: number;
	    cooldown: boolean;
	    cooldown_secs: number;
	    cooldown_message: string;
	    paused: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DownloadQueueInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.is_downloading = source["is_downloading"];
	        this.queue = this.convertValues(source["queue"], DownloadItem);
	        this.current_speed = source["current_speed"];
	        this.total_downloaded = source["total_downloaded"];
	        this.session_start_time = source["session_start_time"];
	        this.queued_count = source["queued_count"];
	        this.completed_count = source["completed_count"];
	        this.failed_count = source["failed_count"];
	        this.skipped_count = source["skipped_count"];
	        this.cooldown = source["cooldown"];
	        this.cooldown_secs = source["cooldown_secs"];
	        this.cooldown_message = source["cooldown_message"];
	        this.paused = source["paused"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class EmbeddedLyrics {
	    path: string;
	    name: string;
	    lyrics: string;
	    source: string;
	    synced: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new EmbeddedLyrics(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.lyrics = source["lyrics"];
	        this.source = source["source"];
	        this.synced = source["synced"];
	        this.error = source["error"];
	    }
	}
	export class EnrichResult {
	    artist: string;
	    matched: boolean;
	    photo: boolean;
	    banner: boolean;
	    bio: boolean;
	    topTracks: number;
	
	    static createFrom(source: any = {}) {
	        return new EnrichResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.artist = source["artist"];
	        this.matched = source["matched"];
	        this.photo = source["photo"];
	        this.banner = source["banner"];
	        this.bio = source["bio"];
	        this.topTracks = source["topTracks"];
	    }
	}
	export class ExtractLyricsResult {
	    path: string;
	    output_path?: string;
	    success: boolean;
	    error?: string;
	    already_exists?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ExtractLyricsResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.output_path = source["output_path"];
	        this.success = source["success"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	    }
	}
	export class Facet {
	    value: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new Facet(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.value = source["value"];
	        this.count = source["count"];
	    }
	}
	export class FetchHistoryItem {
	    id: string;
	    url: string;
	    type: string;
	    name: string;
	    info: string;
	    image: string;
	    data: string;
	    is_explicit?: boolean;
	    timestamp: number;
	
	    static createFrom(source: any = {}) {
	        return new FetchHistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.url = source["url"];
	        this.type = source["type"];
	        this.name = source["name"];
	        this.info = source["info"];
	        this.image = source["image"];
	        this.data = source["data"];
	        this.is_explicit = source["is_explicit"];
	        this.timestamp = source["timestamp"];
	    }
	}
	export class FileInfo {
	    name: string;
	    path: string;
	    is_dir: boolean;
	    size: number;
	    children?: FileInfo[];
	
	    static createFrom(source: any = {}) {
	        return new FileInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.is_dir = source["is_dir"];
	        this.size = source["size"];
	        this.children = this.convertValues(source["children"], FileInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FlacInfo {
	    path: string;
	    sample_rate: number;
	    bits_per_sample: number;
	
	    static createFrom(source: any = {}) {
	        return new FlacInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.sample_rate = source["sample_rate"];
	        this.bits_per_sample = source["bits_per_sample"];
	    }
	}
	export class GalleryImageDownloadResponse {
	    success: boolean;
	    message: string;
	    file?: string;
	    error?: string;
	    already_exists?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GalleryImageDownloadResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	    }
	}
	export class HeaderDownloadResponse {
	    success: boolean;
	    message: string;
	    file?: string;
	    error?: string;
	    already_exists?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new HeaderDownloadResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	    }
	}
	export class HistoryItem {
	    id: string;
	    spotify_id: string;
	    title: string;
	    artists: string;
	    album: string;
	    duration_str: string;
	    cover_url: string;
	    quality: string;
	    format: string;
	    path: string;
	    source: string;
	    timestamp: number;
	
	    static createFrom(source: any = {}) {
	        return new HistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.spotify_id = source["spotify_id"];
	        this.title = source["title"];
	        this.artists = source["artists"];
	        this.album = source["album"];
	        this.duration_str = source["duration_str"];
	        this.cover_url = source["cover_url"];
	        this.quality = source["quality"];
	        this.format = source["format"];
	        this.path = source["path"];
	        this.source = source["source"];
	        this.timestamp = source["timestamp"];
	    }
	}
	export class ImageInfo {
	    width: number;
	    height: number;
	    format: string;
	    dataUrl: string;
	
	    static createFrom(source: any = {}) {
	        return new ImageInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.width = source["width"];
	        this.height = source["height"];
	        this.format = source["format"];
	        this.dataUrl = source["dataUrl"];
	    }
	}
	export class LibStats {
	    tracks: number;
	    albums: number;
	    artists: number;
	    totalSize: number;
	    totalDuration: number;
	
	    static createFrom(source: any = {}) {
	        return new LibStats(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tracks = source["tracks"];
	        this.albums = source["albums"];
	        this.artists = source["artists"];
	        this.totalSize = source["totalSize"];
	        this.totalDuration = source["totalDuration"];
	    }
	}
	
	export class LibraryArtist {
	    name: string;
	    trackCount: number;
	    coverPath: string;
	
	    static createFrom(source: any = {}) {
	        return new LibraryArtist(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.trackCount = source["trackCount"];
	        this.coverPath = source["coverPath"];
	    }
	}
	export class LibraryFolder {
	    path: string;
	    addedAt: number;
	    trackCount: number;
	
	    static createFrom(source: any = {}) {
	        return new LibraryFolder(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.addedAt = source["addedAt"];
	        this.trackCount = source["trackCount"];
	    }
	}
	export class LibraryQuery {
	    search: string;
	    filters: Record<string, string>;
	    sort: string;
	    desc: boolean;
	    limit: number;
	    offset: number;
	
	    static createFrom(source: any = {}) {
	        return new LibraryQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.search = source["search"];
	        this.filters = source["filters"];
	        this.sort = source["sort"];
	        this.desc = source["desc"];
	        this.limit = source["limit"];
	        this.offset = source["offset"];
	    }
	}
	export class TrackArtist {
	    name: string;
	    role: string;
	
	    static createFrom(source: any = {}) {
	        return new TrackArtist(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.role = source["role"];
	    }
	}
	export class LibraryTrack {
	    id: number;
	    path: string;
	    title: string;
	    artist: string;
	    artists: TrackArtist[];
	    albumArtist: string;
	    album: string;
	    albumId: string;
	    genre: string;
	    year: number;
	    trackNo: number;
	    discNo: number;
	    duration: number;
	    bitrate: number;
	    sampleRate: number;
	    codec: string;
	    size: number;
	    rating: number;
	    playCount: number;
	    dateAdded: number;
	    isrc: string;
	    borrowed?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LibraryTrack(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path = source["path"];
	        this.title = source["title"];
	        this.artist = source["artist"];
	        this.artists = this.convertValues(source["artists"], TrackArtist);
	        this.albumArtist = source["albumArtist"];
	        this.album = source["album"];
	        this.albumId = source["albumId"];
	        this.genre = source["genre"];
	        this.year = source["year"];
	        this.trackNo = source["trackNo"];
	        this.discNo = source["discNo"];
	        this.duration = source["duration"];
	        this.bitrate = source["bitrate"];
	        this.sampleRate = source["sampleRate"];
	        this.codec = source["codec"];
	        this.size = source["size"];
	        this.rating = source["rating"];
	        this.playCount = source["playCount"];
	        this.dateAdded = source["dateAdded"];
	        this.isrc = source["isrc"];
	        this.borrowed = source["borrowed"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LyricsDownloadResponse {
	    success: boolean;
	    message: string;
	    file?: string;
	    error?: string;
	    already_exists?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LyricsDownloadResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	    }
	}
	export class MatchCandidate {
	    source: string;
	    id: string;
	    name: string;
	    image: string;
	
	    static createFrom(source: any = {}) {
	        return new MatchCandidate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.id = source["id"];
	        this.name = source["name"];
	        this.image = source["image"];
	    }
	}
	export class SpotifyTrackRef {
	    spotifyId: string;
	    name: string;
	    artistNames: string[];
	    album: string;
	    durationMs: number;
	    albumId: string;
	    artistId: string;
	
	    static createFrom(source: any = {}) {
	        return new SpotifyTrackRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.spotifyId = source["spotifyId"];
	        this.name = source["name"];
	        this.artistNames = source["artistNames"];
	        this.album = source["album"];
	        this.durationMs = source["durationMs"];
	        this.albumId = source["albumId"];
	        this.artistId = source["artistId"];
	    }
	}
	export class MatchedTrack {
	    ref: SpotifyTrackRef;
	    local?: LibraryTrack;
	    confidence: number;
	
	    static createFrom(source: any = {}) {
	        return new MatchedTrack(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ref = this.convertValues(source["ref"], SpotifyTrackRef);
	        this.local = this.convertValues(source["local"], LibraryTrack);
	        this.confidence = source["confidence"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Playlist {
	    id: number;
	    name: string;
	    trackCount: number;
	    coverPath: string;
	
	    static createFrom(source: any = {}) {
	        return new Playlist(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.trackCount = source["trackCount"];
	        this.coverPath = source["coverPath"];
	    }
	}
	export class PlaylistMatchResult {
	    name: string;
	    cover: string;
	    total: number;
	    haveCount: number;
	    missingCount: number;
	    matches: MatchedTrack[];
	
	    static createFrom(source: any = {}) {
	        return new PlaylistMatchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.cover = source["cover"];
	        this.total = source["total"];
	        this.haveCount = source["haveCount"];
	        this.missingCount = source["missingCount"];
	        this.matches = this.convertValues(source["matches"], MatchedTrack);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProfilePlaylist {
	    id: string;
	    url: string;
	    name: string;
	    image: string;
	    owner: string;
	    followers: number;
	
	    static createFrom(source: any = {}) {
	        return new ProfilePlaylist(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.url = source["url"];
	        this.name = source["name"];
	        this.image = source["image"];
	        this.owner = source["owner"];
	        this.followers = source["followers"];
	    }
	}
	export class ProgressInfo {
	    is_downloading: boolean;
	    mb_downloaded: number;
	    speed_mbps: number;
	    rate_limited: boolean;
	    rate_limit_secs: number;
	    cooldown: boolean;
	    cooldown_secs: number;
	    cooldown_message: string;
	    cooldown_event_id: number;
	
	    static createFrom(source: any = {}) {
	        return new ProgressInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.is_downloading = source["is_downloading"];
	        this.mb_downloaded = source["mb_downloaded"];
	        this.speed_mbps = source["speed_mbps"];
	        this.rate_limited = source["rate_limited"];
	        this.rate_limit_secs = source["rate_limit_secs"];
	        this.cooldown = source["cooldown"];
	        this.cooldown_secs = source["cooldown_secs"];
	        this.cooldown_message = source["cooldown_message"];
	        this.cooldown_event_id = source["cooldown_event_id"];
	    }
	}
	export class QobuzArtistHit {
	    id: number;
	    name: string;
	    albumsCount: number;
	    image: string;
	
	    static createFrom(source: any = {}) {
	        return new QobuzArtistHit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.albumsCount = source["albumsCount"];
	        this.image = source["image"];
	    }
	}
	export class QobuzSearchTrack {
	    id: number;
	    title: string;
	    artist: string;
	    album: string;
	    cover: string;
	    durationMs: number;
	    isrc: string;
	    hires: boolean;
	    bitDepth: number;
	    sampleRate: number;
	    releaseDate: string;
	
	    static createFrom(source: any = {}) {
	        return new QobuzSearchTrack(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.artist = source["artist"];
	        this.album = source["album"];
	        this.cover = source["cover"];
	        this.durationMs = source["durationMs"];
	        this.isrc = source["isrc"];
	        this.hires = source["hires"];
	        this.bitDepth = source["bitDepth"];
	        this.sampleRate = source["sampleRate"];
	        this.releaseDate = source["releaseDate"];
	    }
	}
	export class QualityRequest {
	    spotifyId: string;
	    isrc: string;
	
	    static createFrom(source: any = {}) {
	        return new QualityRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.spotifyId = source["spotifyId"];
	        this.isrc = source["isrc"];
	    }
	}
	export class RenamePreview {
	    old_path: string;
	    old_name: string;
	    new_name: string;
	    new_path: string;
	    error?: string;
	    metadata: AudioMetadata;
	
	    static createFrom(source: any = {}) {
	        return new RenamePreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.old_path = source["old_path"];
	        this.old_name = source["old_name"];
	        this.new_name = source["new_name"];
	        this.new_path = source["new_path"];
	        this.error = source["error"];
	        this.metadata = this.convertValues(source["metadata"], AudioMetadata);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RenameResult {
	    old_path: string;
	    new_path: string;
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new RenameResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.old_path = source["old_path"];
	        this.new_path = source["new_path"];
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class ResampleResult {
	    input_file: string;
	    output_file: string;
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ResampleResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.input_file = source["input_file"];
	        this.output_file = source["output_file"];
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class SaveLyricsResult {
	    path: string;
	    success: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new SaveLyricsResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.success = source["success"];
	        this.error = source["error"];
	    }
	}
	export class ScanResult {
	    added: number;
	    updated: number;
	    skipped: number;
	    removed: number;
	    total: number;
	
	    static createFrom(source: any = {}) {
	        return new ScanResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.added = source["added"];
	        this.updated = source["updated"];
	        this.skipped = source["skipped"];
	        this.removed = source["removed"];
	        this.total = source["total"];
	    }
	}
	export class SearchResult {
	    id: string;
	    name: string;
	    type: string;
	    artists?: string;
	    album_name?: string;
	    images: string;
	    release_date?: string;
	    external_urls: string;
	    duration_ms?: number;
	    total_tracks?: number;
	    owner?: string;
	    is_explicit?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.artists = source["artists"];
	        this.album_name = source["album_name"];
	        this.images = source["images"];
	        this.release_date = source["release_date"];
	        this.external_urls = source["external_urls"];
	        this.duration_ms = source["duration_ms"];
	        this.total_tracks = source["total_tracks"];
	        this.owner = source["owner"];
	        this.is_explicit = source["is_explicit"];
	    }
	}
	export class SearchResponse {
	    tracks: SearchResult[];
	    albums: SearchResult[];
	    artists: SearchResult[];
	    playlists: SearchResult[];
	    podcasts: SearchResult[];
	    audiobooks: SearchResult[];
	
	    static createFrom(source: any = {}) {
	        return new SearchResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tracks = this.convertValues(source["tracks"], SearchResult);
	        this.albums = this.convertValues(source["albums"], SearchResult);
	        this.artists = this.convertValues(source["artists"], SearchResult);
	        this.playlists = this.convertValues(source["playlists"], SearchResult);
	        this.podcasts = this.convertValues(source["podcasts"], SearchResult);
	        this.audiobooks = this.convertValues(source["audiobooks"], SearchResult);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class SpotifyProfile {
	    id: string;
	    name: string;
	    image: string;
	
	    static createFrom(source: any = {}) {
	        return new SpotifyProfile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.image = source["image"];
	    }
	}
	
	export class SyncedPlaylist {
	    id: number;
	    spotifyId: string;
	    url: string;
	    name: string;
	    owner: string;
	    cover: string;
	    total: number;
	    haveCount: number;
	    lastSynced: number;
	    synced: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SyncedPlaylist(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.spotifyId = source["spotifyId"];
	        this.url = source["url"];
	        this.name = source["name"];
	        this.owner = source["owner"];
	        this.cover = source["cover"];
	        this.total = source["total"];
	        this.haveCount = source["haveCount"];
	        this.lastSynced = source["lastSynced"];
	        this.synced = source["synced"];
	    }
	}
	export class SyncedPlaylistDetail {
	    playlist: SyncedPlaylist;
	    matches: MatchedTrack[];
	
	    static createFrom(source: any = {}) {
	        return new SyncedPlaylistDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.playlist = this.convertValues(source["playlist"], SyncedPlaylist);
	        this.matches = this.convertValues(source["matches"], MatchedTrack);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TrackAudioInfo {
	    codec: string;
	    sampleRate: number;
	    bitrate: number;
	    bitDepth: number;
	
	    static createFrom(source: any = {}) {
	        return new TrackAudioInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.codec = source["codec"];
	        this.sampleRate = source["sampleRate"];
	        this.bitrate = source["bitrate"];
	        this.bitDepth = source["bitDepth"];
	    }
	}
	export class TrackDetails {
	    track: LibraryTrack;
	    fileSize: number;
	    modified: number;
	    tags: Record<string, Array<string>>;
	
	    static createFrom(source: any = {}) {
	        return new TrackDetails(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.track = this.convertValues(source["track"], LibraryTrack);
	        this.fileSize = source["fileSize"];
	        this.modified = source["modified"];
	        this.tags = source["tags"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TrackQuality {
	    source: string;
	    bitDepth: number;
	    sampleRate: number;
	    label: string;
	    hiRes: boolean;
	    found: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TrackQuality(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.source = source["source"];
	        this.bitDepth = source["bitDepth"];
	        this.sampleRate = source["sampleRate"];
	        this.label = source["label"];
	        this.hiRes = source["hiRes"];
	        this.found = source["found"];
	    }
	}
	export class UpdateInfo {
	    available: boolean;
	    current_version: string;
	    latest_version: string;
	    release_notes: string;
	    release_url: string;
	    asset_url: string;
	    asset_name: string;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.current_version = source["current_version"];
	        this.latest_version = source["latest_version"];
	        this.release_notes = source["release_notes"];
	        this.release_url = source["release_url"];
	        this.asset_url = source["asset_url"];
	        this.asset_name = source["asset_name"];
	    }
	}

}

export namespace main {
	
	export class APIStatusTargetResult {
	    target: string;
	    label: string;
	    online: boolean;
	    message?: string;
	
	    static createFrom(source: any = {}) {
	        return new APIStatusTargetResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.target = source["target"];
	        this.label = source["label"];
	        this.online = source["online"];
	        this.message = source["message"];
	    }
	}
	export class APIStatusReport {
	    type: string;
	    online: boolean;
	    require_all: boolean;
	    details: APIStatusTargetResult[];
	
	    static createFrom(source: any = {}) {
	        return new APIStatusReport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.online = source["online"];
	        this.require_all = source["require_all"];
	        this.details = this.convertValues(source["details"], APIStatusTargetResult);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class AvatarDownloadRequest {
	    avatar_url: string;
	    artist_name: string;
	    output_dir: string;
	
	    static createFrom(source: any = {}) {
	        return new AvatarDownloadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.avatar_url = source["avatar_url"];
	        this.artist_name = source["artist_name"];
	        this.output_dir = source["output_dir"];
	    }
	}
	export class CheckFileExistenceRequest {
	    spotify_id: string;
	    track_name: string;
	    artist_name: string;
	    artists?: string;
	    album_name?: string;
	    album_artist?: string;
	    category?: string;
	    upc?: string;
	    release_date?: string;
	    isrc?: string;
	    track_number?: number;
	    disc_number?: number;
	    total_tracks?: number;
	    total_discs?: number;
	    position?: number;
	    use_album_track_number?: boolean;
	    filename_format?: string;
	    include_track_number?: boolean;
	    audio_format?: string;
	    relative_path?: string;
	
	    static createFrom(source: any = {}) {
	        return new CheckFileExistenceRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.spotify_id = source["spotify_id"];
	        this.track_name = source["track_name"];
	        this.artist_name = source["artist_name"];
	        this.artists = source["artists"];
	        this.album_name = source["album_name"];
	        this.album_artist = source["album_artist"];
	        this.category = source["category"];
	        this.upc = source["upc"];
	        this.release_date = source["release_date"];
	        this.isrc = source["isrc"];
	        this.track_number = source["track_number"];
	        this.disc_number = source["disc_number"];
	        this.total_tracks = source["total_tracks"];
	        this.total_discs = source["total_discs"];
	        this.position = source["position"];
	        this.use_album_track_number = source["use_album_track_number"];
	        this.filename_format = source["filename_format"];
	        this.include_track_number = source["include_track_number"];
	        this.audio_format = source["audio_format"];
	        this.relative_path = source["relative_path"];
	    }
	}
	export class CheckFileExistenceResult {
	    spotify_id: string;
	    exists: boolean;
	    file_path?: string;
	    track_name?: string;
	    artist_name?: string;
	
	    static createFrom(source: any = {}) {
	        return new CheckFileExistenceResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.spotify_id = source["spotify_id"];
	        this.exists = source["exists"];
	        this.file_path = source["file_path"];
	        this.track_name = source["track_name"];
	        this.artist_name = source["artist_name"];
	    }
	}
	export class ConvertAudioRequest {
	    input_files: string[];
	    output_format: string;
	    bitrate: string;
	    codec: string;
	
	    static createFrom(source: any = {}) {
	        return new ConvertAudioRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.input_files = source["input_files"];
	        this.output_format = source["output_format"];
	        this.bitrate = source["bitrate"];
	        this.codec = source["codec"];
	    }
	}
	export class CoverDownloadRequest {
	    cover_url: string;
	    track_name: string;
	    artist_name: string;
	    album_name: string;
	    album_artist: string;
	    release_date: string;
	    output_dir: string;
	    filename_format: string;
	    track_number: boolean;
	    position: number;
	    disc_number: number;
	
	    static createFrom(source: any = {}) {
	        return new CoverDownloadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.cover_url = source["cover_url"];
	        this.track_name = source["track_name"];
	        this.artist_name = source["artist_name"];
	        this.album_name = source["album_name"];
	        this.album_artist = source["album_artist"];
	        this.release_date = source["release_date"];
	        this.output_dir = source["output_dir"];
	        this.filename_format = source["filename_format"];
	        this.track_number = source["track_number"];
	        this.position = source["position"];
	        this.disc_number = source["disc_number"];
	    }
	}
	export class DownloadFFmpegResponse {
	    success: boolean;
	    message: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new DownloadFFmpegResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.error = source["error"];
	    }
	}
	export class DownloadRequest {
	    service: string;
	    query?: string;
	    track_name?: string;
	    artist_name?: string;
	    album_name?: string;
	    album_artist?: string;
	    release_date?: string;
	    cover_url?: string;
	    tidal_api_url?: string;
	    qobuz_api_url?: string;
	    output_dir?: string;
	    audio_format?: string;
	    filename_format?: string;
	    track_number?: boolean;
	    position?: number;
	    use_album_track_number?: boolean;
	    spotify_id?: string;
	    embed_lyrics?: boolean;
	    embed_max_quality_cover?: boolean;
	    service_url?: string;
	    duration?: number;
	    item_id?: string;
	    spotify_track_number?: number;
	    spotify_disc_number?: number;
	    spotify_total_tracks?: number;
	    spotify_total_discs?: number;
	    isrc?: string;
	    copyright?: string;
	    publisher?: string;
	    composer?: string;
	    playlist_name?: string;
	    playlist_owner?: string;
	    allow_fallback: boolean;
	    use_first_artist_only?: boolean;
	    use_single_genre?: boolean;
	    embed_genre?: boolean;
	    separator?: string;
	    save_cover?: boolean;
	    artists?: string;
	    category?: string;
	    upc?: string;
	
	    static createFrom(source: any = {}) {
	        return new DownloadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.service = source["service"];
	        this.query = source["query"];
	        this.track_name = source["track_name"];
	        this.artist_name = source["artist_name"];
	        this.album_name = source["album_name"];
	        this.album_artist = source["album_artist"];
	        this.release_date = source["release_date"];
	        this.cover_url = source["cover_url"];
	        this.tidal_api_url = source["tidal_api_url"];
	        this.qobuz_api_url = source["qobuz_api_url"];
	        this.output_dir = source["output_dir"];
	        this.audio_format = source["audio_format"];
	        this.filename_format = source["filename_format"];
	        this.track_number = source["track_number"];
	        this.position = source["position"];
	        this.use_album_track_number = source["use_album_track_number"];
	        this.spotify_id = source["spotify_id"];
	        this.embed_lyrics = source["embed_lyrics"];
	        this.embed_max_quality_cover = source["embed_max_quality_cover"];
	        this.service_url = source["service_url"];
	        this.duration = source["duration"];
	        this.item_id = source["item_id"];
	        this.spotify_track_number = source["spotify_track_number"];
	        this.spotify_disc_number = source["spotify_disc_number"];
	        this.spotify_total_tracks = source["spotify_total_tracks"];
	        this.spotify_total_discs = source["spotify_total_discs"];
	        this.isrc = source["isrc"];
	        this.copyright = source["copyright"];
	        this.publisher = source["publisher"];
	        this.composer = source["composer"];
	        this.playlist_name = source["playlist_name"];
	        this.playlist_owner = source["playlist_owner"];
	        this.allow_fallback = source["allow_fallback"];
	        this.use_first_artist_only = source["use_first_artist_only"];
	        this.use_single_genre = source["use_single_genre"];
	        this.embed_genre = source["embed_genre"];
	        this.separator = source["separator"];
	        this.save_cover = source["save_cover"];
	        this.artists = source["artists"];
	        this.category = source["category"];
	        this.upc = source["upc"];
	    }
	}
	export class DownloadResponse {
	    success: boolean;
	    message: string;
	    file?: string;
	    error?: string;
	    already_exists?: boolean;
	    cancelled?: boolean;
	    item_id?: string;
	    source_url?: string;
	    source_label?: string;
	
	    static createFrom(source: any = {}) {
	        return new DownloadResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.file = source["file"];
	        this.error = source["error"];
	        this.already_exists = source["already_exists"];
	        this.cancelled = source["cancelled"];
	        this.item_id = source["item_id"];
	        this.source_url = source["source_url"];
	        this.source_label = source["source_label"];
	    }
	}
	export class GalleryImageDownloadRequest {
	    image_url: string;
	    artist_name: string;
	    image_index: number;
	    output_dir: string;
	
	    static createFrom(source: any = {}) {
	        return new GalleryImageDownloadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.image_url = source["image_url"];
	        this.artist_name = source["artist_name"];
	        this.image_index = source["image_index"];
	        this.output_dir = source["output_dir"];
	    }
	}
	export class HeaderDownloadRequest {
	    header_url: string;
	    artist_name: string;
	    output_dir: string;
	
	    static createFrom(source: any = {}) {
	        return new HeaderDownloadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.header_url = source["header_url"];
	        this.artist_name = source["artist_name"];
	        this.output_dir = source["output_dir"];
	    }
	}
	export class InstallFFmpegWithBrewResponse {
	    success: boolean;
	    message: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new InstallFFmpegWithBrewResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.success = source["success"];
	        this.message = source["message"];
	        this.error = source["error"];
	    }
	}
	export class LyricsDownloadRequest {
	    spotify_id: string;
	    track_name: string;
	    artist_name: string;
	    album_name: string;
	    album_artist: string;
	    release_date: string;
	    isrc?: string;
	    output_dir: string;
	    filename_format: string;
	    track_number: boolean;
	    position: number;
	    use_album_track_number: boolean;
	    disc_number: number;
	
	    static createFrom(source: any = {}) {
	        return new LyricsDownloadRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.spotify_id = source["spotify_id"];
	        this.track_name = source["track_name"];
	        this.artist_name = source["artist_name"];
	        this.album_name = source["album_name"];
	        this.album_artist = source["album_artist"];
	        this.release_date = source["release_date"];
	        this.isrc = source["isrc"];
	        this.output_dir = source["output_dir"];
	        this.filename_format = source["filename_format"];
	        this.track_number = source["track_number"];
	        this.position = source["position"];
	        this.use_album_track_number = source["use_album_track_number"];
	        this.disc_number = source["disc_number"];
	    }
	}
	export class ResampleAudioRequest {
	    input_files: string[];
	    sample_rate: string;
	    bit_depth: string;
	
	    static createFrom(source: any = {}) {
	        return new ResampleAudioRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.input_files = source["input_files"];
	        this.sample_rate = source["sample_rate"];
	        this.bit_depth = source["bit_depth"];
	    }
	}
	export class SpotifyMetadataRequest {
	    url: string;
	    batch: boolean;
	    delay: number;
	    timeout: number;
	    separator?: string;
	
	    static createFrom(source: any = {}) {
	        return new SpotifyMetadataRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.url = source["url"];
	        this.batch = source["batch"];
	        this.delay = source["delay"];
	        this.timeout = source["timeout"];
	        this.separator = source["separator"];
	    }
	}
	export class SpotifySearchByTypeRequest {
	    query: string;
	    search_type: string;
	    limit: number;
	    offset: number;
	
	    static createFrom(source: any = {}) {
	        return new SpotifySearchByTypeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.search_type = source["search_type"];
	        this.limit = source["limit"];
	        this.offset = source["offset"];
	    }
	}
	export class SpotifySearchRequest {
	    query: string;
	    limit: number;
	
	    static createFrom(source: any = {}) {
	        return new SpotifySearchRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.query = source["query"];
	        this.limit = source["limit"];
	    }
	}

}

