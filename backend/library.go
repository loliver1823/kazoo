package backend

// Local music library (MediaMonkey-style) + PC-companion model for the
// Music-Player Android app. Scans folders into a SQLite catalog, modelling
// multiple artists per track WITH ROLES (primary/featuring/album_artist/
// collaboration) to match the KMP shared/Models.Track contract — so songs can
// appear on multiple artist pages ("Appears on", feat/collab). Pure-Go SQLite.

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	gosort "sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.senan.xyz/taglib"
	"golang.org/x/text/unicode/norm"
	_ "modernc.org/sqlite"
)

var libDB *sql.DB

// Artist roles — mirror com.musicplayer.shared.model.ArtistRole.
const (
	RolePrimary     = "primary"
	RoleFeaturing   = "featuring"
	RoleAlbumArtist = "album_artist"
	RoleCollab      = "collaboration"
)

type TrackArtist struct {
	Name string `json:"name"`
	Role string `json:"role"`
}

type LibraryTrack struct {
	ID          int64         `json:"id"`
	Path        string        `json:"path"`
	Title       string        `json:"title"`
	Artist      string        `json:"artist"` // display: joined primaries
	Artists     []TrackArtist `json:"artists"`
	AlbumArtist string        `json:"albumArtist"`
	Album       string        `json:"album"`
	AlbumID     string        `json:"albumId"`
	Genre       string        `json:"genre"`
	Year        int           `json:"year"`
	TrackNo     int           `json:"trackNo"`
	DiscNo      int           `json:"discNo"`
	Duration    int           `json:"duration"`   // seconds
	Bitrate     int           `json:"bitrate"`    // kbit/s
	SampleRate  int           `json:"sampleRate"` // Hz
	Codec       string        `json:"codec"`
	Size        int64         `json:"size"`
	Rating      int           `json:"rating"`
	PlayCount   int           `json:"playCount"`
	DateAdded   int64         `json:"dateAdded"`
	ISRC        string        `json:"isrc"`
	// Borrowed: this row belongs to another album's folder and is shown here
	// via an album_refs link (cross-album recording dedup).
	Borrowed bool `json:"borrowed,omitempty"`
}

type ScanResult struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Skipped int `json:"skipped"`
	Removed int `json:"removed"`
	Total   int `json:"total"`
}

type Facet struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

type LibStats struct {
	Tracks        int   `json:"tracks"`
	Albums        int   `json:"albums"`
	Artists       int   `json:"artists"`
	TotalSize     int64 `json:"totalSize"`
	TotalDuration int64 `json:"totalDuration"`
}

type LibraryQuery struct {
	Search  string            `json:"search"`
	Filters map[string]string `json:"filters"`
	Sort    string            `json:"sort"`
	Desc    bool              `json:"desc"`
	Limit   int               `json:"limit"`
	Offset  int               `json:"offset"`
}

var audioExts = map[string]bool{
	".flac": true, ".mp3": true, ".m4a": true, ".opus": true, ".ogg": true, ".oga": true,
	".wav": true, ".aac": true, ".wma": true, ".aiff": true, ".aif": true, ".alac": true,
	".ape": true, ".dsf": true, ".wv": true, ".mpc": true,
}

var sortable = map[string]bool{
	"title": true, "artist": true, "album_artist": true, "album": true, "genre": true,
	"year": true, "duration": true, "bitrate": true, "sample_rate": true, "rating": true,
	"play_count": true, "date_added": true, "track_no": true,
}

// Filters applied directly on the tracks table.
var trackFilterable = map[string]bool{"album": true, "genre": true, "year": true, "album_artist": true}

func InitLibraryDB() error {
	dir, err := EnsureAppDir()
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "library.db"))
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1) // sqlite: serialize writes
	schema := `
	CREATE TABLE IF NOT EXISTS tracks (
		id INTEGER PRIMARY KEY,
		path TEXT UNIQUE NOT NULL,
		title TEXT, artist TEXT, album_artist TEXT, album TEXT, album_id TEXT, genre TEXT,
		year INTEGER DEFAULT 0, track_no INTEGER DEFAULT 0, disc_no INTEGER DEFAULT 0,
		duration INTEGER DEFAULT 0, bitrate INTEGER DEFAULT 0, sample_rate INTEGER DEFAULT 0,
		codec TEXT, size INTEGER DEFAULT 0,
		rating INTEGER DEFAULT 0, play_count INTEGER DEFAULT 0,
		date_added INTEGER DEFAULT 0, last_played INTEGER DEFAULT 0, mtime INTEGER DEFAULT 0,
		isrc TEXT DEFAULT '',
		total_tracks INTEGER DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS album_refs (
		album_id TEXT NOT NULL,
		album TEXT NOT NULL,
		album_artist TEXT DEFAULT '',
		year INTEGER DEFAULT 0,
		track_no INTEGER DEFAULT 0,
		disc_no INTEGER DEFAULT 0,
		track_id INTEGER NOT NULL,
		PRIMARY KEY(album_id, track_id)
	);
	CREATE TABLE IF NOT EXISTS track_artists (
		track_id INTEGER NOT NULL,
		name TEXT NOT NULL,
		role TEXT NOT NULL,
		FOREIGN KEY(track_id) REFERENCES tracks(id) ON DELETE CASCADE
	);
	CREATE TABLE IF NOT EXISTS library_folders (
		path TEXT PRIMARY KEY,
		added_at INTEGER DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS playlists (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		created_at INTEGER DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS playlist_tracks (
		playlist_id INTEGER NOT NULL,
		track_id INTEGER NOT NULL,
		position INTEGER DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS artist_art (
		name TEXT PRIMARY KEY,
		path TEXT NOT NULL,
		bio TEXT DEFAULT '',
		banner TEXT DEFAULT '',
		updated_at INTEGER DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS synced_playlists (
		id INTEGER PRIMARY KEY,
		spotify_id TEXT UNIQUE NOT NULL,
		url TEXT NOT NULL,
		name TEXT DEFAULT '',
		owner TEXT DEFAULT '',
		cover TEXT DEFAULT '',
		total INTEGER DEFAULT 0,
		have_count INTEGER DEFAULT 0,
		last_synced INTEGER DEFAULT 0,
		synced INTEGER DEFAULT 1
	);
	CREATE TABLE IF NOT EXISTS artist_sp_playlists (
		artist TEXT NOT NULL, pos INTEGER NOT NULL,
		spid TEXT, url TEXT, name TEXT, image TEXT,
		PRIMARY KEY(artist, pos)
	);
	CREATE TABLE IF NOT EXISTS artist_sp_playlists_meta (
		artist TEXT PRIMARY KEY,
		checked_at INTEGER DEFAULT 0
	);
	CREATE TABLE IF NOT EXISTS track_match_overrides (
		spotify_id TEXT PRIMARY KEY,
		track_id INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS synced_playlist_tracks (
		playlist_id INTEGER NOT NULL,
		pos INTEGER NOT NULL,
		spotify_id TEXT, name TEXT, artists TEXT, album TEXT,
		duration_ms INTEGER DEFAULT 0,
		album_id TEXT DEFAULT '', artist_id TEXT DEFAULT '',
		PRIMARY KEY(playlist_id, pos)
	);
	CREATE INDEX IF NOT EXISTS idx_pt_playlist ON playlist_tracks(playlist_id);
	CREATE INDEX IF NOT EXISTS idx_albumartist ON tracks(album_artist);
	CREATE INDEX IF NOT EXISTS idx_album ON tracks(album);
	CREATE INDEX IF NOT EXISTS idx_genre ON tracks(genre);
	CREATE INDEX IF NOT EXISTS idx_year ON tracks(year);
	CREATE INDEX IF NOT EXISTS idx_ta_name ON track_artists(name);
	CREATE INDEX IF NOT EXISTS idx_ta_track ON track_artists(track_id);
	CREATE INDEX IF NOT EXISTS idx_ar_track ON album_refs(track_id);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return err
	}
	// Migrations: CREATE TABLE IF NOT EXISTS won't add columns to a pre-existing
	// table, so ALTER in any newer columns (error ignored if already present).
	for _, m := range []string{
		"ALTER TABLE tracks ADD COLUMN album_id TEXT",
		"ALTER TABLE tracks ADD COLUMN release_type TEXT DEFAULT ''",
		"ALTER TABLE artist_art ADD COLUMN bio TEXT DEFAULT ''",
		"ALTER TABLE artist_art ADD COLUMN banner TEXT DEFAULT ''",
		"ALTER TABLE artist_art ADD COLUMN locked TEXT DEFAULT ''",
		"ALTER TABLE artist_art ADD COLUMN spotify_id TEXT DEFAULT ''",
		"ALTER TABLE artist_art ADD COLUMN checked_at INTEGER DEFAULT 0",
		"ALTER TABLE synced_playlist_tracks ADD COLUMN album_id TEXT DEFAULT ''",
		"ALTER TABLE synced_playlist_tracks ADD COLUMN artist_id TEXT DEFAULT ''",
		"ALTER TABLE tracks ADD COLUMN isrc TEXT DEFAULT ''",
		// Index depends on the migrated column, so it must come after.
		"CREATE INDEX IF NOT EXISTS idx_isrc ON tracks(isrc)",
		"ALTER TABLE tracks ADD COLUMN total_tracks INTEGER DEFAULT 0",
		"ALTER TABLE synced_playlists ADD COLUMN synced INTEGER DEFAULT 1",
	} {
		db.Exec(m)
	}
	backfillFolders(db)
	libDB = db
	return nil
}

// backfillFolders seeds library_folders for libraries scanned before folder
// tracking existed, by deriving the common root directory of all track paths.
func backfillFolders(db *sql.DB) {
	var fc int
	db.QueryRow("SELECT COUNT(*) FROM library_folders").Scan(&fc)
	if fc > 0 {
		return
	}
	rows, err := db.Query("SELECT path FROM tracks")
	if err != nil {
		return
	}
	root := ""
	first := true
	for rows.Next() {
		var p string
		if rows.Scan(&p) != nil {
			continue
		}
		dir := filepath.Dir(p)
		if first {
			root = dir
			first = false
		} else {
			root = commonDir(root, dir)
		}
	}
	rows.Close()
	if !first && root != "" {
		db.Exec("INSERT OR IGNORE INTO library_folders(path, added_at) VALUES(?, ?)", root, time.Now().Unix())
	}
}

func commonDir(a, b string) string {
	sep := string(os.PathSeparator)
	as, bs := strings.Split(a, sep), strings.Split(b, sep)
	n := len(as)
	if len(bs) < n {
		n = len(bs)
	}
	var out []string
	for i := 0; i < n; i++ {
		if as[i] == bs[i] {
			out = append(out, as[i])
		} else {
			break
		}
	}
	return strings.Join(out, sep)
}

func tagFirst(m map[string][]string, key string) string {
	if v, ok := m[key]; ok && len(v) > 0 {
		return strings.TrimSpace(v[0])
	}
	return ""
}

func parseIntPrefix(s string) int {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "/-"); i > 0 {
		s = s[:i]
	}
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

func parseYear(date string) int {
	date = strings.TrimSpace(date)
	if len(date) >= 4 {
		if y, err := strconv.Atoi(date[:4]); err == nil {
			return y
		}
	}
	return 0
}

func normKey(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// Featured-artist detection. We catch an explicit "feat."/"ft."/"featuring"
// credit either bracketed "(feat. X)" anywhere, or trailing "… feat. X". We do
// NOT match "with" — too many band/track names contain it ("Sleeping With Sirens").
var featBracketRe = regexp.MustCompile(`(?i)[\(\[]\s*(?:feat\.?|ft\.?|featuring)\s+([^\)\]]+?)\s*[\)\]]`)
var featTrailRe = regexp.MustCompile(`(?i)(?:^|\s)(?:feat\.?|ft\.?|featuring)\s+([^\(\)\[\]]+)`)

// multiArtistSep only splits the PRIMARY artist string on the standard multi-value
// separator ";" — never on &, /, +, x, vs or commas, which break real names like
// "AC/DC", "Earth, Wind & Fire", "Florence + The Machine".
var multiArtistSep = regexp.MustCompile(`\s*[;；]\s*`)

// featuredSep splits a FEATURED-artist list aggressively — inside a "feat. …"
// clause the separators unambiguously delimit guests: "feat. A, B & C".
var featuredSep = regexp.MustCompile(`(?i)\s*(?:,|;|/|&|\+|\sand\s|\sx\s)\s*`)

// extractFeatured pulls featured-artist names out of a title or artist string.
func extractFeatured(s string) []string {
	if m := featBracketRe.FindStringSubmatch(s); m != nil {
		return splitFeatured(m[1])
	}
	if m := featTrailRe.FindStringSubmatch(s); m != nil {
		return splitFeatured(m[1])
	}
	return nil
}

func splitFeatured(s string) []string {
	out := []string{}
	for _, p := range featuredSep.Split(strings.TrimSpace(s), -1) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// stripFeatured removes a "feat. …" clause from an artist string.
func stripFeatured(s string) string {
	s = featBracketRe.ReplaceAllString(s, "")
	s = featTrailRe.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// splitArtists splits a raw artist string into individual names, conservatively
// (avoids breaking names like "Tyler, The Creator" or "AC/DC").
func splitArtists(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := multiArtistSep.Split(raw, -1)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseArtists derives roled artists from tags + title (feat. extraction),
// mirroring TagData.toArtistsList() in the KMP shared module.
func parseArtists(tags map[string][]string, title, albumArtist string) (display string, artists []TrackArtist) {
	seen := map[string]bool{}
	add := func(name, role string) {
		name = strings.TrimSpace(name)
		if name == "" {
			return
		}
		key := normKey(name) + "|" + role
		if seen[key] {
			return
		}
		seen[key] = true
		artists = append(artists, TrackArtist{Name: name, Role: role})
	}

	// Featured artists come from the title ("Song (feat. X)") AND from any "feat."
	// embedded in the artist field — so guests are credited even when the artist
	// tag never lists them.
	feat := extractFeatured(title)

	var primaries []string
	rawArtists := tags[taglib.Artist]
	if len(rawArtists) == 0 {
		rawArtists = tags["ARTISTS"]
	}
	var all []string
	for _, raw := range rawArtists {
		if f := extractFeatured(raw); len(f) > 0 {
			feat = append(feat, f...)
			raw = stripFeatured(raw)
		}
		all = append(all, splitArtists(raw)...)
	}
	featSet := map[string]bool{}
	for _, f := range feat {
		featSet[normKey(f)] = true
	}

	// Only the FIRST artist in the tag is the primary credit. Later artists
	// named in the title's feat clause are guests; the rest are collaborators
	// — co-owners of the song, not features. "State Champs; Simple Plan" with
	// title "… (feat. We The Kings)" keeps Simple Plan a collaborator and
	// We The Kings a feature; both classify as Appears On for the album shelf.
	var collabs []string
	if len(all) > 0 {
		primaries = all[:1]
		for _, extra := range all[1:] {
			if !featSet[normKey(extra)] {
				collabs = append(collabs, extra)
			}
		}
	}

	// A "(feat. X)" credit in the title outranks the artist tag: X is a guest
	// even when listed first, else their page claims the album as own.
	kept := primaries[:0]
	for _, p := range primaries {
		if !featSet[normKey(p)] {
			kept = append(kept, p)
		}
	}
	primaries = kept

	primarySet := map[string]bool{}
	for _, p := range primaries {
		primarySet[normKey(p)] = true
		add(p, RolePrimary)
	}
	for _, c := range collabs {
		if !primarySet[normKey(c)] {
			add(c, RoleCollab)
		}
	}
	// Every artist named in the album-artist tag owns the release — a joint
	// single or split EP tagged "State Champs; Simple Plan" shows under BOTH
	// bands' own releases instead of Appears On.
	for _, aa := range splitArtists(albumArtist) {
		if !primarySet[normKey(aa)] {
			add(aa, RoleAlbumArtist)
		}
	}
	for _, f := range feat {
		// don't double-credit a guest who is already a primary artist
		if !primarySet[normKey(f)] {
			add(f, RoleFeaturing)
		}
	}

	display = strings.Join(append(append([]string{}, primaries...), collabs...), ", ")
	if display == "" {
		display = albumArtist
	}
	return display, artists
}

// Release type is stored in different tags by different apps, so we read them
// ALL. When metadata editing lands, the editor writes the chosen type back to
// every key in releaseTypeWriteKeys so the file is compatible across players.
//
//   - "open" keys are dedicated release-type fields → accept any value.
//   - "guarded" keys (CONTENTGROUP=TIT1, GROUPING=GRP1, scene "RELEASE TYPE")
//     are shared with work-grouping / playlist / scene text, so we only accept
//     recognized type words to avoid junk sections.
var releaseTypeKeysOpen = []string{"RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE", "MUSICBRAINZ_RELEASETYPE", "ALBUMTYPE"}
var releaseTypeKeysGuarded = []string{"CONTENTGROUP", "GROUPING", "RELEASE TYPE"}
var releaseTypeWriteKeys = []string{"RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE", "CONTENTGROUP", "GROUPING"} // for the future editor
var releaseTokenSep = regexp.MustCompile(`\s*[;,/]\s*`)

var knownReleaseTypes = map[string]bool{
	"album": true, "single": true, "ep": true, "demo": true, "live": true,
	"compilation": true, "soundtrack": true, "remix": true, "mixtape": true,
	"mixtape/street": true, "street": true, "dj-mix": true, "djmix": true,
	"broadcast": true, "spokenword": true, "interview": true, "audiobook": true,
	"audio drama": true, "audiodrama": true, "field recording": true, "other": true,
}

// fixExploded rejoins a value that taglib returned char-by-char (["a","l","b"]).
func fixExploded(vals []string) []string {
	if len(vals) > 1 {
		allSingle := true
		for _, v := range vals {
			if len([]rune(v)) != 1 {
				allSingle = false
				break
			}
		}
		if allSingle {
			return []string{strings.Join(vals, "")}
		}
	}
	return vals
}

// releaseTokens gathers the set of release-type tokens for a track (lowercased),
// reading every known tag field so the type is found wherever a tagger put it.
func releaseTokens(tags map[string][]string) []string {
	seen := map[string]bool{}
	var toks []string
	add := func(s string) {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" || s == "normal release" || seen[s] {
			return
		}
		seen[s] = true
		toks = append(toks, s)
	}
	addParts := func(vals []string, guarded bool) {
		for _, v := range fixExploded(vals) {
			for _, part := range releaseTokenSep.Split(v, -1) {
				if guarded && !knownReleaseTypes[strings.ToLower(strings.TrimSpace(part))] {
					continue
				}
				add(part)
			}
		}
	}
	for _, key := range releaseTypeKeysOpen {
		if vals, ok := tags[key]; ok {
			addParts(vals, false)
		}
	}
	for _, key := range releaseTypeKeysGuarded {
		if vals, ok := tags[key]; ok {
			addParts(vals, true)
		}
	}
	if v, ok := tags["COMPILATION"]; ok && len(v) > 0 {
		s := strings.TrimSpace(v[0])
		if s == "1" || strings.EqualFold(s, "true") || strings.EqualFold(s, "yes") {
			add("compilation")
		}
	}
	return toks
}

func titleCaseWords(s string) string {
	parts := strings.Fields(s)
	for i, p := range parts {
		r := []rune(p)
		if len(r) > 0 {
			parts[i] = strings.ToUpper(string(r[0])) + string(r[1:])
		}
	}
	return strings.Join(parts, " ")
}

// releaseBucket maps a track's release-type tags to a section label. Secondary
// types (live/compilation/demo/…) take priority over the primary, and an empty
// or missing type is assumed to be an Album.
func releaseBucket(tags map[string][]string) string {
	toks := releaseTokens(tags)
	has := func(opts ...string) bool {
		for _, t := range toks {
			for _, o := range opts {
				if t == o {
					return true
				}
			}
		}
		return false
	}
	switch {
	case has("demo"):
		return "Demos"
	case has("live"):
		return "Live"
	case has("soundtrack"):
		return "Soundtracks"
	case has("compilation"):
		return "Compilations"
	case has("remix"):
		return "Remixes"
	case has("dj-mix", "djmix"):
		return "DJ-Mixes"
	case has("mixtape", "mixtape/street", "street"):
		return "Mixtapes"
	case has("spokenword", "interview", "audiobook", "audio drama", "audiodrama"):
		return "Spoken Word"
	case has("broadcast"):
		return "Broadcasts"
	case has("field recording"):
		return "Field Recordings"
	case has("ep"):
		return "EPs"
	case has("single"):
		return "Singles"
	case has("other"):
		return "Other"
	case has("album"):
		return "Albums"
	case len(toks) > 0:
		return titleCaseWords(toks[0]) // unknown type → its own section
	default:
		return "Albums" // empty / missing → assume album
	}
}

func albumKey(albumArtist, album string) string {
	if album == "" {
		return ""
	}
	a := albumArtist
	if a == "" {
		a = "various"
	}
	return normKey(a) + "\x00" + normKey(album)
}

// ScanLibraryFolder walks root, reads tags+properties for each audio file, and
// upserts into the library. Unchanged files (same mtime) are skipped.
func ScanLibraryFolder(root string, force bool, onProgress func(done, total int, current string)) (ScanResult, error) {
	var res ScanResult
	if libDB == nil {
		return res, fmt.Errorf("library not initialized")
	}
	root = filepath.Clean(root)
	libDB.Exec("INSERT OR IGNORE INTO library_folders(path, added_at) VALUES(?, ?)", root, time.Now().Unix())
	var files []string
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if audioExts[strings.ToLower(filepath.Ext(p))] {
			files = append(files, p)
		}
		return nil
	})
	res.Total = len(files)

	stmt, err := libDB.Prepare(trackUpsertSQL)
	if err != nil {
		return res, err
	}
	defer stmt.Close()

	now := time.Now().Unix()
	for i, p := range files {
		switch upsertTrackFile(stmt, p, now, force) {
		case fileSkipped:
			res.Skipped++
			if onProgress != nil && i%50 == 0 {
				onProgress(i+1, res.Total, p)
			}
			continue
		case fileAdded:
			res.Added++
		case fileUpdated:
			res.Updated++
		}
		if onProgress != nil && i%25 == 0 {
			onProgress(i+1, res.Total, p)
		}
	}
	if onProgress != nil {
		onProgress(res.Total, res.Total, "")
	}

	// Prune rows whose files vanished from this root (moved or renamed
	// outside the app) — stale rows double up tracks and break album art,
	// which reads from the album's first path. Skipped entirely when the
	// root itself is gone (e.g. a disconnected drive) so a missing mount
	// never wipes its library entries.
	if st, err := os.Stat(root); err == nil && st.IsDir() {
		present := make(map[string]bool, len(files))
		for _, p := range files {
			present[norm.NFC.String(p)] = true
		}
		like := strings.TrimSuffix(root, string(os.PathSeparator)) + string(os.PathSeparator) + "%"
		if rows, err := libDB.Query("SELECT id, path FROM tracks WHERE path LIKE ?", like); err == nil {
			var gone []int64
			for rows.Next() {
				var id int64
				var p string
				if rows.Scan(&id, &p) == nil && !present[p] {
					// Double-check on disk — LIKE has wildcard semantics and
					// deleting a live row is far worse than keeping a stale one.
					if _, err := os.Stat(p); os.IsNotExist(err) {
						gone = append(gone, id)
					}
				}
			}
			rows.Close()
			for _, id := range gone {
				libDB.Exec("DELETE FROM tracks WHERE id=?", id)
				libDB.Exec("DELETE FROM track_artists WHERE track_id=?", id)
			}
			res.Removed = len(gone)
		}
	}
	return res, nil
}

const (
	fileError = iota
	fileSkipped
	fileAdded
	fileUpdated
)

// parseTrackTotal reads the release's official track count from tags:
// TRACKTOTAL (Vorbis/FLAC) or the "n/N" TRACKNUMBER form (ID3/MP4).
func parseTrackTotal(tags map[string][]string) int {
	if n := parseIntPrefix(tagFirst(tags, "TRACKTOTAL")); n > 0 {
		return n
	}
	if tn := tagFirst(tags, taglib.TrackNumber); strings.Contains(tn, "/") {
		return parseIntPrefix(strings.SplitN(tn, "/", 2)[1])
	}
	return 0
}

// upsertTrackFile scans one audio file into the tracks table.
func upsertTrackFile(stmt *sql.Stmt, p string, now int64, force bool) int {
	np := norm.NFC.String(p)
	st, err := os.Stat(p)
	if err != nil {
		return fileError
	}
	mtime := st.ModTime().Unix()
	var existing int64 = -1
	var artistCount int
	libDB.QueryRow(
		"SELECT mtime, (SELECT COUNT(*) FROM track_artists WHERE track_id=tracks.id) FROM tracks WHERE path=?",
		np).Scan(&existing, &artistCount)
	if !force && existing == mtime && artistCount > 0 {
		return fileSkipped
	}
	// If the track has no embedded art but a folder cover exists, embed it so
	// the art travels with the file. (Only writes when art is missing.)
	if embedded, _ := EmbedFolderCover(p); embedded {
		if st2, e2 := os.Stat(p); e2 == nil {
			mtime = st2.ModTime().Unix()
		}
	}
	tags, _ := taglib.ReadTags(np)
	props, _ := taglib.ReadProperties(np)
	title := tagFirst(tags, taglib.Title)
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
	}
	albumArtist := stripFeatured(tagFirst(tags, taglib.AlbumArtist))
	display, artists := parseArtists(tags, title, albumArtist)
	if albumArtist == "" && len(artists) > 0 {
		albumArtist = artists[0].Name
	}
	album := tagFirst(tags, taglib.Album)
	codec := strings.TrimPrefix(strings.ToLower(filepath.Ext(p)), ".")
	if _, err := stmt.Exec(np, title, display, albumArtist, album, albumKey(albumArtist, album),
		tagFirst(tags, taglib.Genre), parseYear(tagFirst(tags, taglib.Date)),
		parseIntPrefix(tagFirst(tags, taglib.TrackNumber)),
		parseIntPrefix(tagFirst(tags, taglib.DiscNumber)),
		int(props.Length.Seconds()), int(props.Bitrate), int(props.SampleRate),
		codec, st.Size(), releaseBucket(tags),
		strings.ToUpper(strings.TrimSpace(tagFirst(tags, taglib.ISRC))),
		parseTrackTotal(tags), now, mtime); err != nil {
		return fileError
	}
	var tid int64
	if libDB.QueryRow("SELECT id FROM tracks WHERE path=?", np).Scan(&tid) == nil {
		libDB.Exec("DELETE FROM track_artists WHERE track_id=?", tid)
		for _, a := range artists {
			libDB.Exec("INSERT INTO track_artists(track_id,name,role) VALUES(?,?,?)", tid, a.Name, a.Role)
		}
	}
	if existing == -1 {
		return fileAdded
	}
	return fileUpdated
}

// ImportDownloadedFile makes a fresh download appear in the library right away:
// it registers the download root as a library folder (so rescans cover it) and
// upserts just the one file — no full folder walk.
func ImportDownloadedFile(root, path string) {
	if libDB == nil || strings.TrimSpace(path) == "" {
		return
	}
	if !audioExts[strings.ToLower(filepath.Ext(path))] {
		return
	}
	if strings.TrimSpace(root) != "" && root != "." {
		// Nesting-aware: never registers a root already covered by a folder.
		if added, err := EnsureLibraryFolder(root); err == nil && added {
			// Brand-new download root — extend the realtime watcher to it.
			go RefreshLibraryWatcher()
		}
	}
	stmt, err := libDB.Prepare(trackUpsertSQL)
	if err != nil {
		return
	}
	defer stmt.Close()
	upsertTrackFile(stmt, path, time.Now().Unix(), true)
}

const trackUpsertSQL = `INSERT INTO tracks
	(path,title,artist,album_artist,album,album_id,genre,year,track_no,disc_no,duration,bitrate,sample_rate,codec,size,release_type,isrc,total_tracks,date_added,mtime)
	VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
	ON CONFLICT(path) DO UPDATE SET
	  title=excluded.title, artist=excluded.artist, album_artist=excluded.album_artist,
	  album=excluded.album, album_id=excluded.album_id, genre=excluded.genre, year=excluded.year,
	  track_no=excluded.track_no, disc_no=excluded.disc_no, duration=excluded.duration,
	  bitrate=excluded.bitrate, sample_rate=excluded.sample_rate, codec=excluded.codec,
	  size=excluded.size, release_type=excluded.release_type, isrc=excluded.isrc,
	  total_tracks=excluded.total_tracks, mtime=excluded.mtime`

const trackCols = `id,path,title,artist,album_artist,album,album_id,genre,year,track_no,disc_no,
	duration,bitrate,sample_rate,codec,size,rating,play_count,date_added,isrc`

func scanTrack(rows *sql.Rows) (LibraryTrack, error) {
	var t LibraryTrack
	err := rows.Scan(&t.ID, &t.Path, &t.Title, &t.Artist, &t.AlbumArtist, &t.Album, &t.AlbumID,
		&t.Genre, &t.Year, &t.TrackNo, &t.DiscNo, &t.Duration, &t.Bitrate, &t.SampleRate,
		&t.Codec, &t.Size, &t.Rating, &t.PlayCount, &t.DateAdded, &t.ISRC)
	t.Artists = []TrackArtist{}
	return t, err
}

func QueryLibrary(q LibraryQuery) ([]LibraryTrack, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	var where []string
	var args []any
	if s := strings.TrimSpace(q.Search); s != "" {
		where = append(where, "(title LIKE ? OR artist LIKE ? OR album LIKE ? OR album_artist LIKE ?)")
		like := "%" + s + "%"
		args = append(args, like, like, like, like)
	}
	for f, v := range q.Filters {
		if v == "" {
			continue
		}
		if f == "artist" {
			// "appears on": any role in track_artists; folded-duplicate
			// spellings (Unicode hyphens) all count.
			variants := artistNameVariants(v)
			where = append(where, "id IN (SELECT track_id FROM track_artists WHERE name IN ("+inPlaceholders(len(variants))+"))")
			args = append(args, artistArgs(variants)...)
		} else if trackFilterable[f] {
			where = append(where, f+"=?")
			args = append(args, v)
		}
	}
	sqlStr := "SELECT " + trackCols + " FROM tracks"
	if len(where) > 0 {
		sqlStr += " WHERE " + strings.Join(where, " AND ")
	}
	sortCol := "album_artist"
	if sortable[q.Sort] {
		sortCol = q.Sort
	}
	dir := "ASC"
	if q.Desc {
		dir = "DESC"
	}
	textSort := map[string]bool{"title": true, "artist": true, "album_artist": true, "album": true, "genre": true, "codec": true}
	orderCol := sortCol
	if textSort[sortCol] {
		orderCol = noArticle(sortCol)
	}
	sqlStr += fmt.Sprintf(" ORDER BY %s %s, %s ASC, disc_no ASC, track_no ASC", orderCol, dir, noArticle("album"))
	limit := q.Limit
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	sqlStr += " LIMIT ? OFFSET ?"
	args = append(args, limit, q.Offset)

	rows, err := libDB.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	out := []LibraryTrack{}
	byID := map[int64]int{}
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		byID[t.ID] = len(out)
		out = append(out, t)
	}
	rows.Close()
	if len(out) > 0 {
		loadArtistsInto(out, byID)
	}
	return out, nil
}

// loadArtistsInto fills each track's Artists via one query over track_artists.
func loadArtistsInto(tracks []LibraryTrack, byID map[int64]int) {
	ids := make([]string, 0, len(tracks))
	args := make([]any, 0, len(tracks))
	for _, t := range tracks {
		ids = append(ids, "?")
		args = append(args, t.ID)
	}
	rows, err := libDB.Query(
		"SELECT track_id,name,role FROM track_artists WHERE track_id IN ("+strings.Join(ids, ",")+")", args...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var tid int64
		var ta TrackArtist
		if rows.Scan(&tid, &ta.Name, &ta.Role) == nil {
			if idx, ok := byID[tid]; ok {
				tracks[idx].Artists = append(tracks[idx].Artists, ta)
			}
		}
	}
}

func LibraryFacets(field string) ([]Facet, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	var query string
	switch field {
	case "artist":
		query = "SELECT name, COUNT(DISTINCT track_id) FROM track_artists WHERE name != '' GROUP BY name ORDER BY 2 DESC, 1 ASC LIMIT 2000"
	case "album", "genre", "year", "album_artist":
		query = fmt.Sprintf("SELECT %s, COUNT(*) FROM tracks WHERE %s IS NOT NULL AND %s != '' GROUP BY %s ORDER BY 2 DESC, 1 ASC LIMIT 2000",
			field, field, field, field)
	default:
		return nil, fmt.Errorf("invalid facet field: %s", field)
	}
	rows, err := libDB.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Facet{}
	for rows.Next() {
		var f Facet
		if err := rows.Scan(&f.Value, &f.Count); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

func LibraryStatsInfo() (LibStats, error) {
	var s LibStats
	if libDB == nil {
		return s, fmt.Errorf("library not initialized")
	}
	libDB.QueryRow(`SELECT COUNT(*), COUNT(DISTINCT album_id), COALESCE(SUM(size),0), COALESCE(SUM(duration),0) FROM tracks`).
		Scan(&s.Tracks, &s.Albums, &s.TotalSize, &s.TotalDuration)
	libDB.QueryRow(`SELECT COUNT(DISTINCT name) FROM track_artists`).Scan(&s.Artists)
	return s, nil
}

func SetTrackRating(id int64, rating int) error {
	if libDB == nil {
		return fmt.Errorf("library not initialized")
	}
	if rating < 0 {
		rating = 0
	}
	if rating > 5 {
		rating = 5
	}
	_, err := libDB.Exec("UPDATE tracks SET rating=? WHERE id=?", rating, id)
	return err
}

// ---- Spotify-style browse: albums, artists, embedded cover art -------------

type LibraryAlbum struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	AlbumArtist string `json:"albumArtist"`
	Year        int    `json:"year"`
	TrackCount  int    `json:"trackCount"`
	CoverPath   string `json:"coverPath"`
	ReleaseType string `json:"releaseType"`
	// Quality stamp, aggregated from the album's tracks at scan time
	// ("Mixed" codec when tracks disagree).
	Codec      string `json:"codec"`
	SampleRate int    `json:"sampleRate"`
	Bitrate    int    `json:"bitrate"`
	// TotalTracks: the release's official track count (from TRACKTOTAL / the
	// "n/N" TRACKNUMBER form). TrackCount < TotalTracks = incomplete album.
	TotalTracks int `json:"totalTracks"`
}

type ArtistReleases struct {
	Own       []LibraryAlbum `json:"own"`
	AppearsOn []LibraryAlbum `json:"appearsOn"`
}

// albumSort maps a UI sort key to an ORDER BY clause over the grouped album
// query. Text columns use COLLATE NOCASE so "blink-182" sorts with the B's.
// noArticle wraps a text column so ORDER BY ignores a leading "The " —
// "The Car" files under C, matching the artist grids and every library
// manager users come from. LIKE is case-insensitive for ASCII in SQLite.
func noArticle(col string) string {
	return "(CASE WHEN " + col + " LIKE 'the %' THEN SUBSTR(" + col + ", 5) ELSE " + col + " END) COLLATE NOCASE"
}

func albumSort(sort string, desc bool) string {
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	switch sort {
	case "name":
		return noArticle("album") + " " + dir + ", " + noArticle("album_artist") + " ASC"
	case "year":
		return "MAX(year) " + dir + ", " + noArticle("album_artist") + " ASC, " + noArticle("album") + " ASC"
	case "added":
		return "MAX(date_added) " + dir + ", " + noArticle("album_artist") + " ASC, " + noArticle("album") + " ASC"
	default: // artist / album_artist
		return noArticle("album_artist") + " " + dir + ", year ASC, " + noArticle("album") + " ASC"
	}
}

type LibraryArtist struct {
	Name       string `json:"name"`
	TrackCount int    `json:"trackCount"`
	CoverPath  string `json:"coverPath"`
}

const albumCols = `album_id, album, album_artist, MAX(year), COUNT(*), MIN(path), MAX(release_type), MIN(codec), MAX(codec), MAX(sample_rate), MAX(bitrate), MAX(total_tracks)`

func scanAlbums(rows *sql.Rows) ([]LibraryAlbum, error) {
	out := []LibraryAlbum{}
	for rows.Next() {
		var a LibraryAlbum
		var rt, c1, c2 sql.NullString
		if err := rows.Scan(&a.ID, &a.Title, &a.AlbumArtist, &a.Year, &a.TrackCount, &a.CoverPath, &rt, &c1, &c2, &a.SampleRate, &a.Bitrate, &a.TotalTracks); err != nil {
			return nil, err
		}
		a.ReleaseType = rt.String
		if a.ReleaseType == "" {
			a.ReleaseType = "Albums"
		}
		if c1.String == c2.String {
			a.Codec = c1.String
		} else {
			a.Codec = "Mixed"
		}
		out = append(out, a)
	}
	return out, nil
}

func GetLibraryAlbums(search, sort string, desc bool) ([]LibraryAlbum, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	where := "album_id != ''"
	var args []any
	if s := strings.TrimSpace(search); s != "" {
		where += " AND (album LIKE ? OR album_artist LIKE ? OR artist LIKE ?)"
		like := "%" + s + "%"
		args = append(args, like, like, like)
	}
	rows, err := libDB.Query("SELECT "+albumCols+" FROM tracks WHERE "+where+
		" GROUP BY album_id ORDER BY "+albumSort(sort, desc)+" LIMIT 5000", args...)
	if err != nil {
		return nil, err
	}
	out, err := scanAlbums(rows)
	rows.Close()
	if err != nil {
		return nil, err
	}
	// Fold in virtual memberships: albums whose tracks (partly or wholly)
	// live in other albums' folders via album_refs.
	refRows, err := libDB.Query(`SELECT r.album_id, r.album, r.album_artist, MAX(r.year), COUNT(*), MIN(t.path)
		FROM album_refs r JOIN tracks t ON t.id = r.track_id GROUP BY r.album_id`)
	if err == nil {
		index := map[string]int{}
		for i := range out {
			index[out[i].ID] = i
		}
		needle := strings.ToLower(strings.TrimSpace(search))
		for refRows.Next() {
			var a LibraryAlbum
			if refRows.Scan(&a.ID, &a.Title, &a.AlbumArtist, &a.Year, &a.TrackCount, &a.CoverPath) != nil {
				continue
			}
			if i, ok := index[a.ID]; ok {
				out[i].TrackCount += a.TrackCount
				continue
			}
			if needle != "" && !strings.Contains(strings.ToLower(a.Title), needle) &&
				!strings.Contains(strings.ToLower(a.AlbumArtist), needle) {
				continue
			}
			a.ReleaseType = "Albums"
			out = append(out, a)
		}
		refRows.Close()
	}
	return out, nil
}

// GetArtistReleases splits an artist's releases into the ones they're the main
// artist on (Own — grouped client-side by ReleaseType) and the ones they only
// guest on (AppearsOn).
// artistFoldKey groups artist spellings that differ only in Unicode
// punctuation or case - "blink‐182" (U+2010 hyphen) and "blink-182" are the
// same artist to every human, but tags from different sources disagree.
func artistFoldKey(name string) string {
	return normalizeMatch(name)
}

// artistNameVariants returns every spelling in the library that folds to the
// same artist as name, so lookups from a merged grid card cover all of them.
func artistNameVariants(name string) []string {
	out := []string{name}
	if libDB == nil {
		return out
	}
	key := artistFoldKey(name)
	seen := map[string]bool{name: true}
	rows, err := libDB.Query("SELECT DISTINCT name FROM track_artists WHERE name != ''")
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil && !seen[n] && artistFoldKey(n) == key {
			seen[n] = true
			out = append(out, n)
		}
	}
	return out
}

func artistArgs(names []string) []any {
	args := make([]any, len(names))
	for i, n := range names {
		args[i] = n
	}
	return args
}

func GetArtistReleases(name, sort string, desc bool) (ArtistReleases, error) {
	var out ArtistReleases
	if libDB == nil {
		return out, fmt.Errorf("library not initialized")
	}
	// "Own" = albums where the artist is a primary/album-artist credit OR is the
	// album-artist field value — so editing the album-artist field actually drives
	// the grouping (matches by the corrected data, exact case).
	variants := artistNameVariants(name)
	ph := inPlaceholders(len(variants))
	ownSub := "(SELECT t.album_id FROM tracks t JOIN track_artists ta ON ta.track_id=t.id WHERE ta.name IN (" + ph + ") AND ta.role IN ('primary','album_artist') UNION SELECT album_id FROM tracks WHERE album_artist IN (" + ph + "))"
	featSub := "(SELECT t.album_id FROM tracks t JOIN track_artists ta ON ta.track_id=t.id WHERE ta.name IN (" + ph + ") AND ta.role IN ('featuring','collaboration'))"
	order := " GROUP BY album_id ORDER BY " + albumSort(sort, desc) + " LIMIT 5000"

	va := artistArgs(variants)
	rows, err := libDB.Query("SELECT "+albumCols+" FROM tracks WHERE album_id != '' AND album_id IN "+ownSub+order, append(append([]any{}, va...), va...)...)
	if err != nil {
		return out, err
	}
	own, err := scanAlbums(rows)
	rows.Close()
	if err != nil {
		return out, err
	}
	out.Own = own

	rows, err = libDB.Query("SELECT "+albumCols+" FROM tracks WHERE album_id != '' AND album_id IN "+featSub+" AND album_id NOT IN "+ownSub+order, append(append(append([]any{}, va...), va...), va...)...)
	if err != nil {
		return out, err
	}
	appears, err := scanAlbums(rows)
	rows.Close()
	if err != nil {
		return out, err
	}
	out.AppearsOn = appears
	return out, nil
}

// GetTracksByIDs returns tracks in the same order as the given ids
// (used by the artist page's Popular list to build a play queue).
func GetTracksByIDs(ids []int64) ([]LibraryTrack, error) {
	out := []LibraryTrack{}
	if libDB == nil || len(ids) == 0 {
		return out, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := libDB.Query("SELECT "+trackCols+" FROM tracks WHERE id IN ("+placeholders+")", args...)
	if err != nil {
		return out, err
	}
	byID := map[int64]LibraryTrack{}
	for rows.Next() {
		t, err := scanTrack(rows)
		if err == nil {
			byID[t.ID] = t
		}
	}
	rows.Close()
	idx := map[int64]int{}
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			idx[t.ID] = len(out)
			out = append(out, t)
		}
	}
	if len(out) > 0 {
		loadArtistsInto(out, idx)
	}
	return out, nil
}

// FindTrackByISRC returns the library track that carries this recording, or
// nil. The cross-album dedup key: the same ISRC on two albums is the same
// recording; remixes/live/re-records carry different ISRCs.
func FindTrackByISRC(isrc string) *LibraryTrack {
	isrc = strings.ToUpper(strings.TrimSpace(isrc))
	if libDB == nil || isrc == "" || strings.HasPrefix(strings.ToLower(isrc), "qobuz_") {
		return nil
	}
	rows, err := libDB.Query("SELECT "+trackCols+" FROM tracks WHERE isrc=? LIMIT 1", isrc)
	if err != nil {
		return nil
	}
	defer rows.Close()
	if rows.Next() {
		if t, err := scanTrack(rows); err == nil {
			return &t
		}
	}
	return nil
}

// AddAlbumRef links an existing library track into another album's view —
// the virtual membership behind cross-album dedup.
func AddAlbumRef(albumID, album, albumArtist, releaseDate string, trackNo, discNo int, trackID int64) {
	if libDB == nil || strings.TrimSpace(albumID) == "" || trackID <= 0 {
		return
	}
	libDB.Exec(`INSERT OR REPLACE INTO album_refs(album_id, album, album_artist, year, track_no, disc_no, track_id)
		VALUES(?,?,?,?,?,?,?)`, albumID, album, albumArtist, parseYear(releaseDate), trackNo, discNo, trackID)
}

// DeleteAlbumRefs removes an album's virtual memberships (used when the
// album itself is deleted; the referenced files belong to other albums and
// are never touched).
func DeleteAlbumRefs(albumID string) error {
	if libDB == nil {
		return fmt.Errorf("library not initialized")
	}
	_, err := libDB.Exec("DELETE FROM album_refs WHERE album_id=?", albumID)
	return err
}

func GetAlbumTracks(albumID string) ([]LibraryTrack, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	rows, err := libDB.Query("SELECT "+trackCols+" FROM tracks WHERE album_id=? ORDER BY disc_no ASC, track_no ASC", albumID)
	if err != nil {
		return nil, err
	}
	out := []LibraryTrack{}
	byID := map[int64]int{}
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		byID[t.ID] = len(out)
		out = append(out, t)
	}
	rows.Close()
	// Borrowed tracks: recordings that live in another album's folder but are
	// members of this album via album_refs.
	if refRows, err := libDB.Query("SELECT track_id, track_no, disc_no FROM album_refs WHERE album_id=?", albumID); err == nil {
		type refPos struct{ trackNo, discNo int }
		refs := map[int64]refPos{}
		ids := []int64{}
		for refRows.Next() {
			var id int64
			var tn, dn int
			if refRows.Scan(&id, &tn, &dn) == nil {
				refs[id] = refPos{tn, dn}
				ids = append(ids, id)
			}
		}
		refRows.Close()
		if len(ids) > 0 {
			if borrowed, err := GetTracksByIDs(ids); err == nil {
				for _, b := range borrowed {
					if p, ok := refs[b.ID]; ok {
						b.TrackNo, b.DiscNo = p.trackNo, p.discNo
					}
					b.Borrowed = true
					byID[b.ID] = len(out)
					out = append(out, b)
				}
				gosort.SliceStable(out, func(i, j int) bool {
					if out[i].DiscNo != out[j].DiscNo {
						return out[i].DiscNo < out[j].DiscNo
					}
					return out[i].TrackNo < out[j].TrackNo
				})
				byID = map[int64]int{}
				for i := range out {
					byID[out[i].ID] = i
				}
			}
		}
	}
	if len(out) > 0 {
		loadArtistsInto(out, byID)
	}
	return out, nil
}

func GetLibraryArtistsList(search, sort string, desc bool) ([]LibraryArtist, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	where := "name != ''"
	var args []any
	if s := strings.TrimSpace(search); s != "" {
		where += " AND name LIKE ?"
		args = append(args, "%"+s+"%")
	}
	order := "2 DESC, ta.name COLLATE NOCASE ASC"
	if sort == "name" {
		if desc {
			order = "ta.name COLLATE NOCASE DESC"
		} else {
			order = "ta.name COLLATE NOCASE ASC"
		}
	} else if (sort == "count" || sort == "added") && !desc {
		order = "2 ASC, ta.name COLLATE NOCASE ASC"
	}
	rows, err := libDB.Query(`SELECT ta.name, COUNT(DISTINCT ta.track_id),
		(SELECT t.path FROM track_artists t2 JOIN tracks t ON t.id=t2.track_id WHERE t2.name=ta.name LIMIT 1)
		FROM track_artists ta WHERE `+where+`
		GROUP BY ta.name ORDER BY `+order+` LIMIT 5000`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Fold spellings that differ only in Unicode punctuation into one card;
	// the most common spelling is the display name.
	out := []LibraryArtist{}
	index := map[string]int{}
	best := []int{}
	for rows.Next() {
		var a LibraryArtist
		if err := rows.Scan(&a.Name, &a.TrackCount, &a.CoverPath); err != nil {
			return nil, err
		}
		key := artistFoldKey(a.Name)
		if i, ok := index[key]; ok {
			out[i].TrackCount += a.TrackCount
			if a.TrackCount > best[i] {
				out[i].Name = a.Name
				out[i].CoverPath = a.CoverPath
				best[i] = a.TrackCount
			}
			continue
		}
		index[key] = len(out)
		best = append(best, a.TrackCount)
		out = append(out, a)
	}
	resortArtists(out, sort, desc)
	return out, nil
}

type LibraryFolder struct {
	Path       string `json:"path"`
	AddedAt    int64  `json:"addedAt"`
	TrackCount int    `json:"trackCount"`
}

// RescanAllFolders walks every library folder incrementally (Plex-style):
// unchanged files are skipped by modification time, so only new files and
// files whose tags were edited get re-read.
// roleSchemaVersion bumps whenever artist-role derivation changes (e.g. the
// first-artist-is-primary rule). A mismatch forces one full tag re-read so
// existing rows pick up the new rules; unchanged files are skipped otherwise.
const roleSchemaVersion = 6

func RescanAllFolders(onProgress func(done, total int, current string)) (ScanResult, error) {
	var agg ScanResult
	if libDB == nil {
		return agg, fmt.Errorf("library not initialized")
	}
	force := false
	var uv int
	if libDB.QueryRow("PRAGMA user_version").Scan(&uv) == nil && uv < roleSchemaVersion {
		force = true
		Dbgf("role schema %d -> %d: forcing full rescan\n", uv, roleSchemaVersion)
	}
	folders, err := GetLibraryFolders()
	if err != nil {
		return agg, err
	}
	for _, f := range folders {
		r, err := ScanLibraryFolder(f.Path, force, onProgress)
		if err != nil {
			return agg, err
		}
		agg.Added += r.Added
		agg.Updated += r.Updated
		agg.Skipped += r.Skipped
		agg.Removed += r.Removed
		agg.Total += r.Total
	}
	if force {
		libDB.Exec(fmt.Sprintf("PRAGMA user_version = %d", roleSchemaVersion))
	}
	return agg, nil
}

// GetArtistAlbums returns the albums an artist appears on (any role).
func GetArtistAlbums(name string) ([]LibraryAlbum, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	rows, err := libDB.Query(`SELECT album_id, album, album_artist, MAX(year), COUNT(*), MIN(path)
		FROM tracks WHERE album_id != '' AND id IN (SELECT track_id FROM track_artists WHERE name=?)
		GROUP BY album_id ORDER BY year DESC, album ASC LIMIT 2000`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LibraryAlbum{}
	for rows.Next() {
		var a LibraryAlbum
		if err := rows.Scan(&a.ID, &a.Title, &a.AlbumArtist, &a.Year, &a.TrackCount, &a.CoverPath); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

func GetLibraryFolders() ([]LibraryFolder, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	rows, err := libDB.Query("SELECT path, added_at FROM library_folders ORDER BY path ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LibraryFolder{}
	for rows.Next() {
		var f LibraryFolder
		if err := rows.Scan(&f.Path, &f.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	sep := string(os.PathSeparator)
	// A root nested inside another root is redundant (the parent already
	// covers its files) — drop such rows so stray registrations can't pile up.
	pruned := out[:0]
	for _, f := range out {
		nested := false
		lf := strings.ToLower(f.Path)
		for _, other := range out {
			if other.Path == f.Path {
				continue
			}
			if strings.HasPrefix(lf, strings.ToLower(other.Path)+sep) {
				nested = true
				break
			}
		}
		if nested {
			libDB.Exec("DELETE FROM library_folders WHERE path=?", f.Path)
			continue
		}
		pruned = append(pruned, f)
	}
	out = pruned
	for i := range out {
		libDB.QueryRow("SELECT COUNT(*) FROM tracks WHERE path=? OR path LIKE ?",
			out[i].Path, out[i].Path+sep+"%").Scan(&out[i].TrackCount)
	}
	return out, nil
}

// FindLibraryArtistName returns the library's spelling of an artist name
// (case- and punctuation-insensitive, so Spotify's "blink-182" matches a
// library tag of "blink‐182"), or "" if the artist isn't in the library.
func FindLibraryArtistName(name string) (string, error) {
	if libDB == nil || strings.TrimSpace(name) == "" {
		return "", nil
	}
	var exact string
	if err := libDB.QueryRow("SELECT name FROM track_artists WHERE name = ? COLLATE NOCASE LIMIT 1", name).Scan(&exact); err == nil && exact != "" {
		return exact, nil
	}
	want := normArtistName(name)
	if want == "" {
		return "", nil
	}
	rows, err := libDB.Query("SELECT DISTINCT name FROM track_artists")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil && normArtistName(n) == want {
			return n, nil
		}
	}
	return "", nil
}

// FindLibraryAlbum locates a library album by title, preferring one whose
// album artist matches the given artist. Returns nil if not found.
func FindLibraryAlbum(album, artist string) (*LibraryAlbum, error) {
	if libDB == nil || strings.TrimSpace(album) == "" {
		return nil, nil
	}
	rows, err := libDB.Query(`SELECT album_id, album, album_artist, MAX(year), COUNT(*), MIN(path)
		FROM tracks WHERE album = ? COLLATE NOCASE AND album_id != ''
		GROUP BY album_id`, album)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []LibraryAlbum
	for rows.Next() {
		var a LibraryAlbum
		if rows.Scan(&a.ID, &a.Title, &a.AlbumArtist, &a.Year, &a.TrackCount, &a.CoverPath) == nil {
			candidates = append(candidates, a)
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	if want := normArtistName(artist); want != "" {
		for i := range candidates {
			if normArtistName(candidates[i].AlbumArtist) == want {
				return &candidates[i], nil
			}
		}
	}
	return &candidates[0], nil
}

// RefreshTracks force re-reads tags and audio properties from disk for the
// given track ids — the targeted "Refresh metadata" action, vs a full rescan.
func RefreshTracks(ids []int64) (int, error) {
	if libDB == nil {
		return 0, fmt.Errorf("library not initialized")
	}
	stmt, err := libDB.Prepare(trackUpsertSQL)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	now := time.Now().Unix()
	refreshed := 0
	for _, id := range ids {
		var path string
		if err := libDB.QueryRow("SELECT path FROM tracks WHERE id = ?", id).Scan(&path); err != nil {
			continue
		}
		switch upsertTrackFile(stmt, path, now, true) {
		case fileAdded, fileUpdated:
			refreshed++
		}
	}
	return refreshed, nil
}

// TrackDetails is the Plex-style "Get Info" payload: the library row plus
// everything the file itself says.
type TrackDetails struct {
	Track    LibraryTrack        `json:"track"`
	FileSize int64               `json:"fileSize"`
	Modified int64               `json:"modified"` // unix seconds
	Tags     map[string][]string `json:"tags"`     // raw tag dump from the file
}

func GetTrackDetails(id int64) (TrackDetails, error) {
	var out TrackDetails
	tracks, err := GetTracksByIDs([]int64{id})
	if err != nil {
		return out, err
	}
	if len(tracks) == 0 {
		return out, fmt.Errorf("track not found")
	}
	out.Track = tracks[0]
	np := norm.NFC.String(out.Track.Path)
	if st, err := os.Stat(np); err == nil {
		out.FileSize = st.Size()
		out.Modified = st.ModTime().Unix()
	}
	if tags, err := taglib.ReadTags(np); err == nil {
		out.Tags = tags
	} else {
		out.Tags = map[string][]string{}
	}
	return out, nil
}

// DeleteLibraryTracks removes tracks from the library AND deletes their files
// from disk. Emptied album folders (and their emptied artist folders) are
// cleaned up. A file that can't be deleted keeps its DB row so the library
// never lies about what's on disk.
func DeleteLibraryTracks(ids []int64) (int, error) {
	if libDB == nil {
		return 0, fmt.Errorf("library not initialized")
	}
	deleted := 0
	dirs := map[string]bool{}
	for _, id := range ids {
		var path string
		if err := libDB.QueryRow("SELECT path FROM tracks WHERE id = ?", id).Scan(&path); err != nil {
			continue
		}
		if path != "" {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				continue
			}
			dirs[filepath.Dir(path)] = true
		}
		libDB.Exec("DELETE FROM track_artists WHERE track_id = ?", id)
		libDB.Exec("DELETE FROM playlist_tracks WHERE track_id = ?", id)
		libDB.Exec("DELETE FROM album_refs WHERE track_id = ?", id)
		libDB.Exec("DELETE FROM tracks WHERE id = ?", id)
		deleted++
	}
	for d := range dirs {
		// Remove the album folder if nothing but sidecar junk remains, then
		// try the artist folder above it.
		if removeDirIfDisposable(d) {
			removeDirIfDisposable(filepath.Dir(d))
		}
	}
	return deleted, nil
}

// removeDirIfDisposable deletes a directory when it's empty or contains only
// non-audio leftovers (covers, logs, lyrics), including in subfolders — an
// empty album folder from a failed download must not keep an artist folder
// alive. Registered library roots are never removed. Returns true if removed.
func removeDirIfDisposable(dir string) bool {
	if isLibraryRoot(dir) {
		return false
	}
	if !dirIsDisposable(dir) {
		return false
	}
	return os.RemoveAll(dir) == nil
}

func isLibraryRoot(dir string) bool {
	folders, err := GetLibraryFolders()
	if err != nil {
		return false
	}
	clean := filepath.Clean(dir)
	for _, f := range folders {
		if strings.EqualFold(filepath.Clean(f.Path), clean) {
			return true
		}
	}
	return false
}

func dirIsDisposable(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.IsDir() {
			if !dirIsDisposable(filepath.Join(dir, e.Name())) {
				return false
			}
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		switch ext {
		case ".jpg", ".jpeg", ".png", ".webp", ".txt", ".lrc", ".nfo", ".m3u8", ".m3u",
			".cue", ".log", ".accurip", ".sfv", ".md5", ".pdf":
			// disposable sidecars
		default:
			return false
		}
	}
	return true
}

// EnsureLibraryFolder registers a path as a library folder unless it's equal
// to or nested inside an existing one. Returns whether it was newly added.
// Used to keep the download folder part of the library automatically.
func EnsureLibraryFolder(path string) (bool, error) {
	if libDB == nil {
		return false, fmt.Errorf("library not initialized")
	}
	clean := filepath.Clean(strings.TrimSpace(path))
	if clean == "" || clean == "." {
		return false, fmt.Errorf("empty path")
	}
	folders, err := GetLibraryFolders()
	if err != nil {
		return false, err
	}
	sep := string(os.PathSeparator)
	for _, f := range folders {
		fp := filepath.Clean(f.Path)
		if strings.EqualFold(clean, fp) || strings.HasPrefix(strings.ToLower(clean)+sep, strings.ToLower(fp)+sep) {
			return false, nil // already covered by this folder
		}
	}
	_, err = libDB.Exec("INSERT OR IGNORE INTO library_folders(path, added_at) VALUES(?, ?)", clean, time.Now().Unix())
	return err == nil, err
}

// RemoveLibraryFolder forgets a scanned folder and deletes its tracks from the
// library (files on disk are untouched). Returns the number of tracks removed.
func RemoveLibraryFolder(path string) (int, error) {
	if libDB == nil {
		return 0, fmt.Errorf("library not initialized")
	}
	path = filepath.Clean(path)
	like := path + string(os.PathSeparator) + "%"
	libDB.Exec("DELETE FROM track_artists WHERE track_id IN (SELECT id FROM tracks WHERE path=? OR path LIKE ?)", path, like)
	r, err := libDB.Exec("DELETE FROM tracks WHERE path=? OR path LIKE ?", path, like)
	libDB.Exec("DELETE FROM library_folders WHERE path=?", path)
	if err != nil {
		return 0, err
	}
	n, _ := r.RowsAffected()
	return int(n), nil
}

// GetLibraryAlbumArtists lists the distinct album-artist field values (the main
// credited artist per release) — distinct from GetLibraryArtistsList, which
// includes every featuring/guest credit.
func GetLibraryAlbumArtists(search, sort string, desc bool) ([]LibraryArtist, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	where := "album_artist != ''"
	var args []any
	if s := strings.TrimSpace(search); s != "" {
		where += " AND album_artist LIKE ?"
		args = append(args, "%"+s+"%")
	}
	order := "2 DESC, album_artist COLLATE NOCASE ASC"
	if sort == "name" {
		if desc {
			order = "album_artist COLLATE NOCASE DESC"
		} else {
			order = "album_artist COLLATE NOCASE ASC"
		}
	} else if (sort == "count" || sort == "added") && !desc {
		order = "2 ASC, album_artist COLLATE NOCASE ASC"
	}
	rows, err := libDB.Query("SELECT album_artist, COUNT(*), MIN(path) FROM tracks WHERE "+where+
		" GROUP BY album_artist ORDER BY "+order+" LIMIT 5000", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Joint releases tag several owners ("Simple Plan; State Champs") — split
	// and attribute the tracks to EACH artist instead of showing a phantom
	// combined artist card. Merged counts keep the grid's requested order.
	out := []LibraryArtist{}
	index := map[string]int{}
	best := []int{}
	for rows.Next() {
		var a LibraryArtist
		if err := rows.Scan(&a.Name, &a.TrackCount, &a.CoverPath); err != nil {
			return nil, err
		}
		for _, name := range splitArtists(a.Name) {
			// Folded key also merges Unicode-punctuation spelling variants
			// ("blink‐182" vs "blink-182") into one card.
			key := artistFoldKey(name)
			if i, ok := index[key]; ok {
				out[i].TrackCount += a.TrackCount
				if a.TrackCount > best[i] {
					out[i].Name = name
					out[i].CoverPath = a.CoverPath
					best[i] = a.TrackCount
				}
				continue
			}
			index[key] = len(out)
			best = append(best, a.TrackCount)
			out = append(out, LibraryArtist{Name: name, TrackCount: a.TrackCount, CoverPath: a.CoverPath})
		}
	}
	// Merging can change counts/positions - re-apply the requested order.
	resortArtists(out, sort, desc)
	return out, nil
}

// resortArtists re-applies a grid's requested order after merge passes.
// A leading "The " is ignored when alphabetizing — The Blues Brothers files
// under B, like every library manager users come from.
func resortArtists(out []LibraryArtist, sort string, desc bool) {
	sortName := func(n string) string {
		l := strings.ToLower(n)
		if strings.HasPrefix(l, "the ") {
			return l[4:]
		}
		return l
	}
	nameLess := func(i, j int) bool {
		return sortName(out[i].Name) < sortName(out[j].Name)
	}
	if sort == "name" {
		gosort.SliceStable(out, func(i, j int) bool {
			if desc {
				return nameLess(j, i)
			}
			return nameLess(i, j)
		})
	} else {
		asc := (sort == "count" || sort == "added") && !desc
		gosort.SliceStable(out, func(i, j int) bool {
			if out[i].TrackCount != out[j].TrackCount {
				if asc {
					return out[i].TrackCount < out[j].TrackCount
				}
				return out[i].TrackCount > out[j].TrackCount
			}
			return nameLess(i, j)
		})
	}
}

var (
	coverCache = map[string]string{}
	coverMu    sync.Mutex
)

// GetEmbeddedCover returns a track's embedded cover art as a data URL ("" if
// none). Results are cached by path so grid scrolling stays cheap.
func GetEmbeddedCover(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	coverMu.Lock()
	if v, ok := coverCache[path]; ok {
		coverMu.Unlock()
		return v, nil
	}
	coverMu.Unlock()

	data, err := taglib.ReadImage(norm.NFC.String(path))
	url := ""
	if err == nil && len(data) > 0 {
		mime := "image/jpeg"
		if imageExtensionFromBytes(data) == ".png" {
			mime = "image/png"
		}
		url = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
	} else if cover := folderCoverPath(path); cover != "" {
		// no embedded art — fall back to a sidecar cover.jpg/folder.jpg
		if fdata, ferr := os.ReadFile(cover); ferr == nil && len(fdata) > 0 {
			mime := "image/jpeg"
			if imageExtensionFromBytes(fdata) == ".png" {
				mime = "image/png"
			}
			url = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(fdata)
		}
	}
	coverMu.Lock()
	coverCache[path] = url
	coverMu.Unlock()
	return url, nil
}

type Credit struct {
	Role string `json:"role"`
	Name string `json:"name"`
}

// creditSources maps a display role to the tag keys that may hold it. Order here
// is the display order in the credits dialog.
var creditSources = []struct {
	role string
	keys []string
}{
	{"Composer", []string{"COMPOSER"}},
	{"Lyricist", []string{"LYRICIST"}},
	{"Writer", []string{"WRITER", "SONGWRITER"}},
	{"Producer", []string{"PRODUCER"}},
	{"Co-Producer", []string{"COPRODUCER", "CO-PRODUCER"}},
	{"Mixer", []string{"MIXER", "MIXENGINEER", "MIX"}},
	{"Engineer", []string{"ENGINEER"}},
	{"Mastering", []string{"MASTERING", "MASTERINGENGINEER"}},
	{"Arranger", []string{"ARRANGER"}},
	{"Remixer", []string{"REMIXER", "MIXARTIST"}},
	{"Conductor", []string{"CONDUCTOR"}},
	{"Performer", []string{"PERFORMER"}},
}

// GetTrackCredits reads songwriting/production credits straight from the file's
// tags (composer, lyricist, writer, producer, mixer, engineer, …), so it's
// always current and needs no DB column.
func GetTrackCredits(path string) ([]Credit, error) {
	out := []Credit{}
	if path == "" {
		return out, nil
	}
	tags, err := taglib.ReadTags(norm.NFC.String(path))
	if err != nil {
		return out, err
	}
	seen := map[string]bool{}
	for _, src := range creditSources {
		for _, key := range src.keys {
			vals, ok := tags[key]
			if !ok {
				continue
			}
			for _, v := range fixExploded(vals) {
				for _, name := range splitFeatured(v) {
					name = strings.TrimSpace(name)
					k := src.role + "|" + strings.ToLower(name)
					if name == "" || seen[k] {
						continue
					}
					seen[k] = true
					out = append(out, Credit{Role: src.role, Name: name})
				}
			}
		}
	}
	return out, nil
}

func RemoveMissingTracks() (int, error) {
	if libDB == nil {
		return 0, fmt.Errorf("library not initialized")
	}
	rows, err := libDB.Query("SELECT id, path FROM tracks")
	if err != nil {
		return 0, err
	}
	var gone []int64
	for rows.Next() {
		var id int64
		var p string
		if rows.Scan(&id, &p) == nil {
			if _, err := os.Stat(p); os.IsNotExist(err) {
				gone = append(gone, id)
			}
		}
	}
	rows.Close()
	for _, id := range gone {
		libDB.Exec("DELETE FROM tracks WHERE id=?", id)
		libDB.Exec("DELETE FROM track_artists WHERE track_id=?", id)
	}
	return len(gone), nil
}
