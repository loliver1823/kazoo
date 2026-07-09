package backend

// Metadata editing. Reads the editable fields from a file, and writes changes
// back with taglib in MERGE mode (other tags — lyrics, replaygain, IDs — are
// preserved). Release type is written to EVERY known key so the file reads
// correctly across all players. After a write the single file is re-indexed.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go.senan.xyz/taglib"
	"golang.org/x/text/unicode/norm"
)

type TrackMeta struct {
	Path        string `json:"path"`
	Title       string `json:"title"`
	Artist      string `json:"artist"`      // "; " separated for multiple
	AlbumArtist string `json:"albumArtist"`
	Album       string `json:"album"`
	Genre       string `json:"genre"`
	Composer    string `json:"composer"`
	ReleaseType string `json:"releaseType"` // a canonical token: album/single/ep/…
	Year        int    `json:"year"`
	TrackNo     int    `json:"trackNo"`
	DiscNo      int    `json:"discNo"`
}

func GetEditableMetadata(path string) (TrackMeta, error) {
	m := TrackMeta{Path: path}
	tags, err := taglib.ReadTags(norm.NFC.String(path))
	if err != nil {
		return m, err
	}
	m.Title = tagFirst(tags, taglib.Title)
	m.Artist = strings.Join(tags[taglib.Artist], "; ")
	m.AlbumArtist = tagFirst(tags, taglib.AlbumArtist)
	m.Album = tagFirst(tags, taglib.Album)
	m.Genre = tagFirst(tags, taglib.Genre)
	m.Composer = tagFirst(tags, taglib.Composer)
	m.Year = parseYear(tagFirst(tags, taglib.Date))
	m.TrackNo = parseIntPrefix(tagFirst(tags, taglib.TrackNumber))
	m.DiscNo = parseIntPrefix(tagFirst(tags, taglib.DiscNumber))
	for _, t := range releaseTokens(tags) {
		if knownReleaseTypes[t] {
			m.ReleaseType = t
			break
		}
	}
	return m, nil
}

func setMapStr(m map[string][]string, key, val string) {
	if strings.TrimSpace(val) == "" {
		m[key] = []string{}
	} else {
		m[key] = []string{val}
	}
}

func setReleaseType(changes map[string][]string, rt string) {
	rt = strings.ToLower(strings.TrimSpace(rt))
	keys := []string{"RELEASETYPE", "MUSICBRAINZ_ALBUMTYPE", "CONTENTGROUP", "GROUPING"}
	if rt == "" {
		for _, k := range keys {
			changes[k] = []string{}
		}
		return
	}
	pretty := titleCaseWords(rt)
	changes["RELEASETYPE"] = []string{rt}
	changes["MUSICBRAINZ_ALBUMTYPE"] = []string{rt}
	changes["CONTENTGROUP"] = []string{pretty}
	changes["GROUPING"] = []string{pretty}
}

// BulkMeta carries fields to apply across many tracks. Only fields named in
// Fields are written (enable-per-field, like a tag editor's checkboxes).
type BulkMeta struct {
	Title       string   `json:"title"`
	Artist      string   `json:"artist"`
	AlbumArtist string   `json:"albumArtist"`
	Album       string   `json:"album"`
	Genre       string   `json:"genre"`
	Composer    string   `json:"composer"`
	ReleaseType string   `json:"releaseType"`
	Year        int      `json:"year"`
	TrackNo     int      `json:"trackNo"`
	DiscNo      int      `json:"discNo"`
	Fields      []string `json:"fields"`
}

func inPlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

// WriteBulkTrackMetadata writes the enabled fields to every given track.
func WriteBulkTrackMetadata(trackIDs []int64, m BulkMeta) (int, error) {
	if libDB == nil || len(trackIDs) == 0 {
		return 0, nil
	}
	want := map[string]bool{}
	for _, f := range m.Fields {
		want[f] = true
	}
	if len(want) == 0 {
		return 0, nil
	}
	args := make([]any, len(trackIDs))
	for i, id := range trackIDs {
		args[i] = id
	}
	rows, err := libDB.Query("SELECT path FROM tracks WHERE id IN ("+inPlaceholders(len(trackIDs))+")", args...)
	if err != nil {
		return 0, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			paths = append(paths, p)
		}
	}
	rows.Close()

	count := 0
	for _, p := range paths {
		np := norm.NFC.String(p)
		changes := map[string][]string{}
		if want["title"] {
			setMapStr(changes, taglib.Title, m.Title)
		}
		if want["artist"] {
			var arts []string
			for _, a := range strings.Split(m.Artist, ";") {
				if a = strings.TrimSpace(a); a != "" {
					arts = append(arts, a)
				}
			}
			changes[taglib.Artist] = arts
		}
		if want["albumArtist"] {
			setMapStr(changes, taglib.AlbumArtist, m.AlbumArtist)
		}
		if want["album"] {
			setMapStr(changes, taglib.Album, m.Album)
		}
		if want["genre"] {
			setMapStr(changes, taglib.Genre, m.Genre)
		}
		if want["composer"] {
			setMapStr(changes, taglib.Composer, m.Composer)
		}
		if want["year"] {
			if m.Year > 0 {
				cur, _ := taglib.ReadTags(np)
				curDate := ""
				if v := cur[taglib.Date]; len(v) > 0 {
					curDate = v[0]
				}
				if parseYear(curDate) != m.Year {
					changes[taglib.Date] = []string{strconv.Itoa(m.Year)}
				}
			} else {
				changes[taglib.Date] = []string{}
			}
		}
		if want["releaseType"] {
			setReleaseType(changes, m.ReleaseType)
		}
		if want["trackNo"] {
			if m.TrackNo > 0 {
				changes[taglib.TrackNumber] = []string{strconv.Itoa(m.TrackNo)}
			} else {
				changes[taglib.TrackNumber] = []string{}
			}
		}
		if want["discNo"] {
			if m.DiscNo > 0 {
				changes[taglib.DiscNumber] = []string{strconv.Itoa(m.DiscNo)}
			} else {
				changes[taglib.DiscNumber] = []string{}
			}
		}
		if len(changes) == 0 {
			continue
		}
		if err := taglib.WriteTags(np, changes, 0); err == nil {
			ReindexFile(p)
			count++
		}
	}
	return count, nil
}

func TrackIDsForAlbums(albumIDs []string) ([]int64, error) {
	if libDB == nil || len(albumIDs) == 0 {
		return nil, nil
	}
	args := make([]any, len(albumIDs))
	for i, a := range albumIDs {
		args[i] = a
	}
	return scanIDs("SELECT id FROM tracks WHERE album_id IN ("+inPlaceholders(len(albumIDs))+")", args)
}

func TrackIDsForArtists(names []string) ([]int64, error) {
	if libDB == nil || len(names) == 0 {
		return nil, nil
	}
	args := make([]any, len(names))
	for i, n := range names {
		args[i] = n
	}
	return scanIDs("SELECT DISTINCT track_id FROM track_artists WHERE name IN ("+inPlaceholders(len(names))+")", args)
}

func scanIDs(query string, args []any) ([]int64, error) {
	rows, err := libDB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out, nil
}

// CommonMeta is the shared metadata across a set of tracks: fields that differ
// are blanked and listed in Mixed (so the editor can show "multiple values").
type CommonMeta struct {
	Meta  TrackMeta `json:"meta"`
	Mixed []string  `json:"mixed"`
}

func GetCommonMetadata(trackIDs []int64) (CommonMeta, error) {
	var out CommonMeta
	if libDB == nil || len(trackIDs) == 0 {
		return out, nil
	}
	args := make([]any, len(trackIDs))
	for i, id := range trackIDs {
		args[i] = id
	}
	rows, err := libDB.Query("SELECT path FROM tracks WHERE id IN ("+inPlaceholders(len(trackIDs))+")", args...)
	if err != nil {
		return out, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			paths = append(paths, p)
		}
	}
	rows.Close()

	mixed := map[string]bool{}
	var base TrackMeta
	for i, p := range paths {
		m, err := GetEditableMetadata(p)
		if err != nil {
			continue
		}
		if i == 0 {
			base = m // keep first track's path for the art preview
			continue
		}
		if m.Title != base.Title {
			mixed["title"] = true
		}
		if m.Artist != base.Artist {
			mixed["artist"] = true
		}
		if m.AlbumArtist != base.AlbumArtist {
			mixed["albumArtist"] = true
		}
		if m.Album != base.Album {
			mixed["album"] = true
		}
		if m.Genre != base.Genre {
			mixed["genre"] = true
		}
		if m.Composer != base.Composer {
			mixed["composer"] = true
		}
		if m.ReleaseType != base.ReleaseType {
			mixed["releaseType"] = true
		}
		if m.Year != base.Year {
			mixed["year"] = true
		}
		if m.TrackNo != base.TrackNo {
			mixed["trackNo"] = true
		}
		if m.DiscNo != base.DiscNo {
			mixed["discNo"] = true
		}
	}
	blank := func(field string, clear func()) {
		if mixed[field] {
			clear()
		}
	}
	blank("title", func() { base.Title = "" })
	blank("artist", func() { base.Artist = "" })
	blank("albumArtist", func() { base.AlbumArtist = "" })
	blank("album", func() { base.Album = "" })
	blank("genre", func() { base.Genre = "" })
	blank("composer", func() { base.Composer = "" })
	blank("releaseType", func() { base.ReleaseType = "" })
	blank("year", func() { base.Year = 0 })
	blank("trackNo", func() { base.TrackNo = 0 })
	blank("discNo", func() { base.DiscNo = 0 })

	keys := make([]string, 0, len(mixed))
	for k := range mixed {
		keys = append(keys, k)
	}
	out.Meta = base
	out.Mixed = keys
	return out, nil
}

func WriteTrackMetadata(m TrackMeta) error {
	np := norm.NFC.String(m.Path)
	cur, _ := taglib.ReadTags(np)
	changes := map[string][]string{}

	setStr := func(key, val string) {
		if strings.TrimSpace(val) == "" {
			changes[key] = []string{}
		} else {
			changes[key] = []string{val}
		}
	}
	setStr(taglib.Title, m.Title)
	setStr(taglib.AlbumArtist, m.AlbumArtist)
	setStr(taglib.Album, m.Album)
	setStr(taglib.Genre, m.Genre)
	setStr(taglib.Composer, m.Composer)

	// Artist supports "; "-separated multiple values.
	var arts []string
	for _, a := range strings.Split(m.Artist, ";") {
		if a = strings.TrimSpace(a); a != "" {
			arts = append(arts, a)
		}
	}
	changes[taglib.Artist] = arts

	if m.TrackNo > 0 {
		changes[taglib.TrackNumber] = []string{strconv.Itoa(m.TrackNo)}
	} else {
		changes[taglib.TrackNumber] = []string{}
	}
	if m.DiscNo > 0 {
		changes[taglib.DiscNumber] = []string{strconv.Itoa(m.DiscNo)}
	} else {
		changes[taglib.DiscNumber] = []string{}
	}

	// Year: keep an existing full date if its year is unchanged (don't truncate).
	if m.Year > 0 {
		curDate := ""
		if v := cur[taglib.Date]; len(v) > 0 {
			curDate = v[0]
		}
		if parseYear(curDate) != m.Year {
			changes[taglib.Date] = []string{strconv.Itoa(m.Year)}
		}
	} else {
		changes[taglib.Date] = []string{}
	}

	// Release type → write to every compatible key (one field, all players).
	if rt := strings.ToLower(strings.TrimSpace(m.ReleaseType)); rt != "" {
		pretty := titleCaseWords(rt)
		changes["RELEASETYPE"] = []string{rt}
		changes["MUSICBRAINZ_ALBUMTYPE"] = []string{rt}
		changes["CONTENTGROUP"] = []string{pretty}
		changes["GROUPING"] = []string{pretty}
	}

	if err := taglib.WriteTags(np, changes, 0); err != nil { // 0 = merge, keep other tags
		return err
	}
	return ReindexFile(m.Path)
}

// ReindexFile re-reads one file's tags and updates its library row + artists.
func ReindexFile(path string) error {
	if libDB == nil {
		return nil
	}
	vals, artists, ok := readTrackRow(path)
	if !ok {
		return nil
	}
	if _, err := libDB.Exec(trackUpsertSQL, vals...); err != nil {
		return err
	}
	np := norm.NFC.String(path)
	var tid int64
	if libDB.QueryRow("SELECT id FROM tracks WHERE path=?", np).Scan(&tid) == nil {
		libDB.Exec("DELETE FROM track_artists WHERE track_id=?", tid)
		for _, a := range artists {
			libDB.Exec("INSERT INTO track_artists(track_id,name,role) VALUES(?,?,?)", tid, a.Name, a.Role)
		}
	}
	return nil
}

// readTrackRow builds the tracks-table values (matching trackUpsertSQL) + roled
// artists for one file.
func readTrackRow(path string) ([]any, []TrackArtist, bool) {
	np := norm.NFC.String(path)
	st, err := os.Stat(path)
	if err != nil {
		return nil, nil, false
	}
	tags, _ := taglib.ReadTags(np)
	props, _ := taglib.ReadProperties(np)
	title := tagFirst(tags, taglib.Title)
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	albumArtist := stripFeatured(tagFirst(tags, taglib.AlbumArtist))
	display, arts := parseArtists(tags, title, albumArtist)
	if albumArtist == "" && len(arts) > 0 {
		albumArtist = arts[0].Name
	}
	album := tagFirst(tags, taglib.Album)
	codec := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	vals := []any{
		np, title, display, albumArtist, album, albumKey(albumArtist, album),
		tagFirst(tags, taglib.Genre), parseYear(tagFirst(tags, taglib.Date)),
		parseIntPrefix(tagFirst(tags, taglib.TrackNumber)), parseIntPrefix(tagFirst(tags, taglib.DiscNumber)),
		int(props.Length.Seconds()), int(props.Bitrate), int(props.SampleRate),
		codec, st.Size(), releaseBucket(tags), time.Now().Unix(), st.ModTime().Unix(),
	}
	return vals, arts, true
}
