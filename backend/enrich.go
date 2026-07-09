package backend

// Plex-style library enrichment: pull artist photo, banner, bio and top
// tracks from Spotify for artists in the local library. User-set data is
// never overwritten — enrichment only fills gaps (top tracks refresh).

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	neturl "net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type EnrichResult struct {
	Artist    string `json:"artist"`
	Matched   bool   `json:"matched"`
	Photo     bool   `json:"photo"`
	Banner    bool   `json:"banner"`
	Bio       bool   `json:"bio"`
	TopTracks int    `json:"topTracks"`
}

type ArtistTopTrack struct {
	Rank           int    `json:"rank"`
	Title          string `json:"title"`
	Album          string `json:"album"`
	Artist         string `json:"artist"`
	SpotifyID      string `json:"spotifyId"`
	InLibrary      bool   `json:"inLibrary"`
	LibraryTrackID int64  `json:"libraryTrackId,omitempty"`
	// Quality stamp of the matched library file (empty when not in library).
	Codec      string `json:"codec,omitempty"`
	SampleRate int    `json:"sampleRate,omitempty"`
	Bitrate    int    `json:"bitrate,omitempty"`
}

func ensureTopTracksTable() {
	if libDB == nil {
		return
	}
	libDB.Exec(`CREATE TABLE IF NOT EXISTS artist_top_tracks (
		artist TEXT NOT NULL,
		rank INTEGER NOT NULL,
		title TEXT NOT NULL,
		album TEXT NOT NULL DEFAULT '',
		spotify_id TEXT NOT NULL DEFAULT '',
		artists TEXT NOT NULL DEFAULT '',
		PRIMARY KEY(artist, rank)
	)`)
	// Older sessions created the table without these columns.
	libDB.Exec("ALTER TABLE artist_top_tracks ADD COLUMN album TEXT NOT NULL DEFAULT ''")
	libDB.Exec("ALTER TABLE artist_top_tracks ADD COLUMN artists TEXT NOT NULL DEFAULT ''")
}

// normArtistName reduces a name to a comparison key: casefolded, diacritics
// stripped, punctuation variants unified, then everything but letters/digits
// dropped. "Beyoncé" == "beyonce", "blink‐182" == "blink-182", "P!nk" == "pnk".
func normArtistName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer("’", "'", "‐", "-", "–", "-", "—", "-", "&", " and ").Replace(s)
	d := norm.NFD.String(s)
	out := make([]rune, 0, len(d))
	for _, r := range d {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out = append(out, r)
		}
	}
	return string(out)
}

// levenshtein for short strings — used to accept near-misses like a stray
// apostrophe or single-letter typo, never wholesale different names.
func levenshtein(a, b string) int {
	ar, br := []rune(a), []rune(b)
	prev := make([]int, len(br)+1)
	cur := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		cur[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(br)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

var titleDecorRe = regexp.MustCompile(`\([^)]*\)|\[[^\]]*\]`)

// titleBaseKey reduces a track title to its undecorated core for matching:
// parentheticals/brackets, "feat." credits and dash-suffixes ("- Remastered
// 2011", "- Live") are stripped, then the same canonicalization as artist
// names is applied (casefold, diacritics, punctuation).
func titleBaseKey(s string) string {
	s = strings.ToLower(s)
	if i := strings.Index(s, " - "); i > 0 {
		s = s[:i]
	}
	s = titleDecorRe.ReplaceAllString(s, " ")
	for _, m := range []string{" feat.", " feat ", " ft.", " ft ", " featuring "} {
		if i := strings.Index(s, m); i > 0 {
			s = s[:i]
		}
	}
	return normArtistName(s)
}

// artistSpotifyMatch returns the stored Spotify artist ID for this name
// (set by a prior auto-match or a manual "Fix match").
func artistSpotifyMatch(name string) string {
	if libDB == nil {
		return ""
	}
	var id string
	libDB.QueryRow("SELECT COALESCE(spotify_id,'') FROM artist_art WHERE name=?", name).Scan(&id)
	return strings.TrimSpace(id)
}

func saveArtistSpotifyMatch(name, id string) {
	if libDB == nil {
		return
	}
	libDB.Exec("INSERT INTO artist_art(name, path, spotify_id, updated_at) VALUES(?,'',?,?) ON CONFLICT(name) DO UPDATE SET spotify_id=excluded.spotify_id, updated_at=excluded.updated_at",
		name, id, time.Now().Unix())
}

// markArtistChecked records that an enrichment attempt ran (matched or not),
// so background passes don't re-check the same artist every launch — artists
// Spotify has no bio/photo for would otherwise "need enrichment" forever.
func markArtistChecked(name string) {
	if libDB == nil {
		return
	}
	libDB.Exec("INSERT INTO artist_art(name, path, checked_at) VALUES(?,'',?) ON CONFLICT(name) DO UPDATE SET checked_at=excluded.checked_at",
		name, time.Now().Unix())
}

// autoMatchSpotifyArtist searches Spotify and returns a confidently-matched
// artist ID, or "" when unsure (manual Fix Match covers the rest).
func autoMatchSpotifyArtist(name string) string {
	results, err := SearchSpotifyByType(context.Background(), name, "artist", 10, 0)
	if err != nil {
		return ""
	}
	target := normArtistName(name)
	if target == "" {
		return ""
	}
	for _, r := range results {
		if normArtistName(r.Name) == target {
			return r.ID
		}
	}
	// Near-miss fallback: accept the top result only when it's one edit away
	// on a reasonably long name (catches stray punctuation, not wrong artists).
	if len(results) > 0 && len([]rune(target)) >= 5 {
		if levenshtein(normArtistName(results[0].Name), target) <= 1 {
			return results[0].ID
		}
	}
	return ""
}

// fetchArtistOverview does the single queryArtistOverview GraphQL call and
// returns the filtered artist payload plus its top tracks (which FilterArtist
// doesn't carry).
func fetchArtistOverview(artistID string) (*apiArtistResponse, []ArtistTopTrack, error) {
	client := NewSpotifyClient()
	if err := client.Initialize(); err != nil {
		return nil, nil, fmt.Errorf("failed to initialize spotify client: %w", err)
	}
	payload := map[string]interface{}{
		"variables": map[string]interface{}{
			"uri":    fmt.Sprintf("spotify:artist:%s", artistID),
			"locale": "",
		},
		"operationName": "queryArtistOverview",
		"extensions": map[string]interface{}{
			"persistedQuery": map[string]interface{}{
				"version":    1,
				"sha256Hash": "446130b4a0aa6522a686aafccddb0ae849165b5e0436fd802f96e0243617b5d8",
			},
		},
	}
	data, err := client.Query(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query artist overview: %w", err)
	}

	filtered := FilterArtist(data, "; ")
	jsonData, _ := json.Marshal(filtered)
	var overview apiArtistResponse
	if err := json.Unmarshal(jsonData, &overview); err != nil {
		return nil, nil, err
	}

	// The topTracks payload only carries an album URI — resolve names from the
	// release lists that ship in the same overview response.
	albumNames := map[string]string{}
	disc := getMap(getMap(getMap(data, "data"), "artistUnion"), "discography")
	harvest := func(m map[string]interface{}) {
		id, name := getString(m, "id"), getString(m, "name")
		if id != "" && name != "" {
			albumNames[id] = name
		}
	}
	for _, item := range getSlice(getMap(disc, "popularReleasesAlbums"), "items") {
		if m, ok := item.(map[string]interface{}); ok {
			harvest(m)
		}
	}
	for _, section := range []string{"albums", "singles", "compilations"} {
		for _, item := range getSlice(getMap(disc, section), "items") {
			itemMap, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			for _, rel := range getSlice(getMap(itemMap, "releases"), "items") {
				if m, ok := rel.(map[string]interface{}); ok {
					harvest(m)
				}
			}
		}
	}
	lastURIPart := func(uri string) string {
		if i := strings.LastIndex(uri, ":"); i >= 0 {
			return uri[i+1:]
		}
		return ""
	}

	// Top tracks live under artistUnion.discography.topTracks in the raw payload.
	var top []ArtistTopTrack
	ttItems := getSlice(getMap(getMap(getMap(getMap(data, "data"), "artistUnion"), "discography"), "topTracks"), "items")
	for i, item := range ttItems {
		itemMap, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		trackMap := getMap(itemMap, "track")
		if len(trackMap) == 0 {
			continue
		}
		name := getString(trackMap, "name")
		if name == "" {
			continue
		}
		album := albumNames[lastURIPart(getString(getMap(trackMap, "albumOfTrack"), "uri"))]
		id := getString(trackMap, "id")
		if id == "" {
			id = lastURIPart(getString(trackMap, "uri"))
		}
		// The payload carries every credited artist — capture them so tracks
		// not in the library still show who's on them.
		var artistNames []string
		for _, ai := range getSlice(getMap(trackMap, "artists"), "items") {
			if am, ok := ai.(map[string]interface{}); ok {
				if n := getString(getMap(am, "profile"), "name"); n != "" {
					artistNames = append(artistNames, n)
				}
			}
		}
		top = append(top, ArtistTopTrack{Rank: i + 1, Title: name, Album: album, Artist: strings.Join(artistNames, ", "), SpotifyID: id})
		if len(top) >= 10 {
			break
		}
	}

	// The overview's release lists don't cover every album a top track can
	// come from (compilations, soundtracks) — resolve leftovers with a direct
	// track fetch so the album is stored, not blank.
	for i := range top {
		if top[i].Album != "" || top[i].SpotifyID == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		td, terr := GetFilteredSpotifyData(ctx, "https://open.spotify.com/track/"+top[i].SpotifyID, false, time.Second, ", ", nil)
		cancel()
		if terr != nil {
			continue
		}
		var tm TrackMetadata
		switch p := td.(type) {
		case TrackResponse:
			tm = p.Track
		case *TrackResponse:
			tm = p.Track
		default:
			continue
		}
		top[i].Album = tm.AlbumName
		if top[i].Artist == "" && tm.Artists != "" {
			top[i].Artist = tm.Artists
		}
	}
	return &overview, top, nil
}

// EnrichLibraryArtist fills this artist's missing photo/banner/bio from
// Spotify and refreshes their stored top tracks. Uses the stored match if
// one exists; otherwise auto-matches conservatively (manual Fix Match covers
// anything ambiguous).
func EnrichLibraryArtist(name string) (EnrichResult, error) {
	res := EnrichResult{Artist: name}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || libDB == nil {
		return res, nil
	}
	artistID := artistSpotifyMatch(trimmed)
	if artistID == "" {
		artistID = autoMatchSpotifyArtist(trimmed)
		if artistID != "" {
			saveArtistSpotifyMatch(trimmed, artistID)
		}
	}
	markArtistChecked(trimmed)
	if artistID == "" {
		applyEnrichmentFallbacks(trimmed, &res)
		return res, nil
	}
	if strings.HasPrefix(artistID, "deezer:") {
		return enrichFromDeezer(trimmed, strings.TrimPrefix(artistID, "deezer:"), false)
	}
	out, err := enrichFromID(trimmed, artistID, false)
	applyEnrichmentFallbacks(trimmed, &out)
	return out, err
}

// SetArtistSpotifyMatch is the Plex-style "Fix match": stores the chosen
// Spotify artist and re-pulls photo/banner/bio/top-tracks from it, replacing
// previous auto-fetched data. Locked (manually edited) fields are preserved.
func SetArtistSpotifyMatch(name, artistID string) (EnrichResult, error) {
	res := EnrichResult{Artist: name}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.TrimSpace(artistID) == "" || libDB == nil {
		return res, nil
	}
	saveArtistSpotifyMatch(trimmed, strings.TrimSpace(artistID))
	out, err := enrichFromID(trimmed, strings.TrimSpace(artistID), true)
	applyEnrichmentFallbacks(trimmed, &out)
	return out, err
}

// enrichFromID pulls the artist overview and applies it. force=false fills
// gaps only (background enrichment); force=true replaces unlocked fields
// (manual Fix Match). Locked fields are never touched either way.
func enrichFromID(name, artistID string, force bool) (EnrichResult, error) {
	res := EnrichResult{Artist: name, Matched: true}
	overview, top, err := fetchArtistOverview(artistID)
	if err != nil {
		return res, err
	}

	locked := artistLockedFields(name)
	if !locked["photo"] && overview.Avatar != "" {
		cur, _ := GetArtistImage(name)
		if force || cur == "" {
			if SetArtistImage(name, overview.Avatar) == nil {
				res.Photo = true
			}
		}
	}
	if !locked["banner"] && overview.Header != "" {
		cur, _ := GetArtistBanner(name)
		if force || cur == "" {
			if SetArtistBanner(name, overview.Header) == nil {
				res.Banner = true
			}
		}
	}
	if !locked["bio"] && strings.TrimSpace(overview.Profile.Biography) != "" {
		var curBio string
		libDB.QueryRow("SELECT COALESCE(bio,'') FROM artist_art WHERE name=?", name).Scan(&curBio)
		if force || strings.TrimSpace(curBio) == "" {
			if SetArtistBio(name, overview.Profile.Biography) == nil {
				res.Bio = true
			}
		}
	}

	if len(top) > 0 {
		ensureTopTracksTable()
		libDB.Exec("DELETE FROM artist_top_tracks WHERE artist=?", name)
		for _, t := range top {
			libDB.Exec("INSERT OR REPLACE INTO artist_top_tracks(artist, rank, title, album, spotify_id, artists) VALUES(?,?,?,?,?,?)",
				name, t.Rank, t.Title, t.Album, t.SpotifyID, t.Artist)
		}
		res.TopTracks = len(top)
	}
	return res, nil
}

// GetArtistTopTracks returns the stored Spotify top tracks for an artist,
// flagging the ones that exist in the local library (matched by title).
func GetArtistTopTracks(name string) ([]ArtistTopTrack, error) {
	out := []ArtistTopTrack{}
	if libDB == nil {
		return out, nil
	}
	ensureTopTracksTable()
	rows, err := libDB.Query("SELECT rank, title, album, spotify_id, artists FROM artist_top_tracks WHERE artist=? ORDER BY rank ASC", strings.TrimSpace(name))
	if err != nil {
		return out, nil
	}
	for rows.Next() {
		var t ArtistTopTrack
		if rows.Scan(&t.Rank, &t.Title, &t.Album, &t.SpotifyID, &t.Artist) == nil {
			out = append(out, t)
		}
	}
	rows.Close()
	if len(out) == 0 {
		return out, nil
	}

	// Two-tier matching against the local library:
	//   1. exact canonical title (apostrophes/diacritics/punctuation unified);
	//   2. base title + base album — decorations stripped from both, so a
	//      "(Deluxe Edition)" pressing of the same album matches, but a live
	//      or remaster cut from a *different* album never false-positives.
	exact := map[string]int64{}
	baseWithAlbum := map[string]int64{}
	trows, err := libDB.Query(
		"SELECT t.id, t.title, t.album FROM tracks t JOIN track_artists ta ON ta.track_id=t.id WHERE ta.name=? OR t.album_artist=?",
		strings.TrimSpace(name), strings.TrimSpace(name))
	if err == nil {
		for trows.Next() {
			var id int64
			var title, album string
			if trows.Scan(&id, &title, &album) == nil {
				if k := normArtistName(title); k != "" {
					if _, ok := exact[k]; !ok {
						exact[k] = id
					}
				}
				if tk, ak := titleBaseKey(title), titleBaseKey(album); tk != "" && ak != "" {
					if _, ok := baseWithAlbum[tk+"|"+ak]; !ok {
						baseWithAlbum[tk+"|"+ak] = id
					}
				}
			}
		}
		trows.Close()
	}
	for i := range out {
		if id, ok := exact[normArtistName(out[i].Title)]; ok {
			out[i].InLibrary = true
			out[i].LibraryTrackID = id
			continue
		}
		if out[i].Album != "" {
			if id, ok := baseWithAlbum[titleBaseKey(out[i].Title)+"|"+titleBaseKey(out[i].Album)]; ok {
				out[i].InLibrary = true
				out[i].LibraryTrackID = id
			}
		}
	}

	// Manual Fix Match overrides beat automatic matching, and the entry takes
	// on the local track's metadata. Keyed by Spotify ID, so the same fix
	// applies anywhere the song appears (playlists included).
	for i := range out {
		if out[i].SpotifyID == "" {
			continue
		}
		trackID, ok := lookupTrackMatchOverride(out[i].SpotifyID)
		if !ok {
			continue
		}
		var title, album string
		if libDB.QueryRow("SELECT title, album FROM tracks WHERE id = ?", trackID).Scan(&title, &album) != nil {
			// Overridden track no longer exists — drop the stale override.
			libDB.Exec("DELETE FROM track_match_overrides WHERE spotify_id = ?", out[i].SpotifyID)
			continue
		}
		out[i].InLibrary = true
		out[i].LibraryTrackID = trackID
		out[i].Title = title
		out[i].Album = album
	}

	// Display fields: matched rows adopt the local file's metadata (artist,
	// album, quality stamp) — Spotify's top-tracks payload often can't resolve
	// album names, so the local tags are both more reliable and consistent
	// with what Fix Match shows.
	for i := range out {
		if strings.TrimSpace(out[i].Artist) == "" {
			out[i].Artist = strings.TrimSpace(name)
		}
		if !out[i].InLibrary || out[i].LibraryTrackID <= 0 {
			continue
		}
		var artist, album, codec string
		var sr, br int
		if libDB.QueryRow("SELECT artist, album, codec, sample_rate, bitrate FROM tracks WHERE id = ?", out[i].LibraryTrackID).
			Scan(&artist, &album, &codec, &sr, &br) == nil {
			if strings.TrimSpace(artist) != "" {
				out[i].Artist = artist
			}
			if strings.TrimSpace(album) != "" {
				out[i].Album = album
			}
			out[i].Codec, out[i].SampleRate, out[i].Bitrate = codec, sr, br
		}
	}
	return out, nil
}

// lookupTrackMatchOverride returns a manual spotify-track → library-track
// mapping, if one exists.
func lookupTrackMatchOverride(spotifyID string) (int64, bool) {
	if libDB == nil || spotifyID == "" {
		return 0, false
	}
	var trackID int64
	if libDB.QueryRow("SELECT track_id FROM track_match_overrides WHERE spotify_id = ?", spotifyID).Scan(&trackID) != nil {
		return 0, false
	}
	return trackID, trackID > 0
}

// SetTrackMatch pins a Spotify track to a specific library track (Fix Match).
// The override applies everywhere the Spotify track appears — artist Popular
// lists and synced playlists alike. trackID <= 0 reverts to automatic matching.
func SetTrackMatch(spotifyID string, trackID int64) error {
	if libDB == nil {
		return fmt.Errorf("library not initialized")
	}
	spotifyID = strings.TrimSpace(spotifyID)
	if spotifyID == "" {
		return fmt.Errorf("track has no Spotify ID")
	}
	if trackID <= 0 {
		_, err := libDB.Exec("DELETE FROM track_match_overrides WHERE spotify_id = ?", spotifyID)
		return err
	}
	_, err := libDB.Exec("INSERT OR REPLACE INTO track_match_overrides(spotify_id, track_id) VALUES(?, ?)", spotifyID, trackID)
	return err
}

// ListArtistsNeedingEnrichment returns library artists that have no photo or
// no bio yet — the work list for a background enrichment pass. Artists checked
// recently are skipped: if Spotify had nothing for them last time, re-asking
// every launch just burns time (they get a weekly retry instead).
func ListArtistsNeedingEnrichment() ([]string, error) {
	out := []string{}
	if libDB == nil {
		return out, nil
	}
	artists, err := GetLibraryArtistsList("", "name", false)
	if err != nil {
		return out, err
	}
	recheckAfter := time.Now().Add(-7 * 24 * time.Hour).Unix()
	for _, a := range artists {
		var path, bio string
		var checkedAt int64
		libDB.QueryRow("SELECT COALESCE(path,''), COALESCE(bio,''), COALESCE(checked_at,0) FROM artist_art WHERE name=?", a.Name).Scan(&path, &bio, &checkedAt)
		if strings.TrimSpace(path) != "" && strings.TrimSpace(bio) != "" {
			continue
		}
		if checkedAt > recheckAfter {
			continue
		}
		out = append(out, a.Name)
	}
	return out, nil
}

// --- Fallback sources ---------------------------------------------------------
// When Spotify has no photo/bio for an artist (common for band members and
// soundtrack credits), fill the gap from Deezer (photos, keyless) and Last.fm
// (bios, user-supplied API key). Fallbacks only ever fill still-empty fields —
// Spotify data and locked fields always win.

var fallbackHTTP = &http.Client{Timeout: 8 * time.Second}

func deezerArtistPhoto(name string) string {
	resp, err := fallbackHTTP.Get("https://api.deezer.com/search/artist?limit=5&q=" + neturl.QueryEscape(name))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var parsed struct {
		Data []struct {
			Name       string `json:"name"`
			PictureXL  string `json:"picture_xl"`
			PictureBig string `json:"picture_big"`
		} `json:"data"`
	}
	if json.NewDecoder(resp.Body).Decode(&parsed) != nil {
		return ""
	}
	target := normArtistName(name)
	for _, d := range parsed.Data {
		if normArtistName(d.Name) != target {
			continue
		}
		pic := d.PictureXL
		if pic == "" {
			pic = d.PictureBig
		}
		// Deezer serves a generic placeholder for artists without photos —
		// its URL has an empty image hash ("/artist//").
		if pic == "" || strings.Contains(pic, "/artist//") {
			continue
		}
		return pic
	}
	return ""
}

var lastfmReadMoreRe = regexp.MustCompile(`<a href="[^"]*"[^>]*>Read more[^<]*</a>\.?`)

func lastfmArtistBio(name, key string) string {
	resp, err := fallbackHTTP.Get("https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&autocorrect=1&format=json&artist=" +
		neturl.QueryEscape(name) + "&api_key=" + neturl.QueryEscape(key))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var parsed struct {
		Artist struct {
			Name string `json:"name"`
			Bio  struct {
				Summary string `json:"summary"`
				Content string `json:"content"`
			} `json:"bio"`
		} `json:"artist"`
	}
	if json.NewDecoder(resp.Body).Decode(&parsed) != nil {
		return ""
	}
	// autocorrect can redirect to a different artist — only trust same-name.
	if normArtistName(parsed.Artist.Name) != normArtistName(name) {
		return ""
	}
	bio := parsed.Artist.Bio.Content
	if strings.TrimSpace(bio) == "" {
		bio = parsed.Artist.Bio.Summary
	}
	bio = lastfmReadMoreRe.ReplaceAllString(bio, "")
	bio = strings.TrimSpace(bio)
	if len(bio) < 40 { // placeholder/empty stubs
		return ""
	}
	return bio
}

// applyEnrichmentFallbacks fills any photo/bio still missing after the
// Spotify pass. Fill-only: never overwrites, always respects locks.
func applyEnrichmentFallbacks(name string, res *EnrichResult) {
	locked := artistLockedFields(name)
	if !locked["photo"] {
		if cur, _ := GetArtistImage(name); cur == "" {
			if pic := deezerArtistPhoto(name); pic != "" {
				if SetArtistImage(name, pic) == nil {
					res.Photo = true
				}
			}
		}
	}
	if !locked["bio"] {
		var curBio string
		libDB.QueryRow("SELECT COALESCE(bio,'') FROM artist_art WHERE name=?", name).Scan(&curBio)
		if strings.TrimSpace(curBio) == "" {
			if key := GetLastfmApiKeySetting(); key != "" {
				if bio := lastfmArtistBio(name, key); bio != "" {
					if SetArtistBio(name, bio) == nil {
						res.Bio = true
					}
				}
			}
		}
	}
}

// --- Multi-source candidates & matching ----------------------------------------

type ArtCandidate struct {
	Source string `json:"source"` // e.g. "Spotify", "Deezer — Exact Name"
	URL    string `json:"url"`
}

type ArtistArtCandidates struct {
	Photos  []ArtCandidate `json:"photos"`
	Banners []ArtCandidate `json:"banners"`
}

type deezerArtistHit struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	PictureXL  string `json:"picture_xl"`
	PictureBig string `json:"picture_big"`
}

func deezerSearchArtists(query string, limit int) []deezerArtistHit {
	resp, err := fallbackHTTP.Get(fmt.Sprintf("https://api.deezer.com/search/artist?limit=%d&q=%s", limit, neturl.QueryEscape(query)))
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var parsed struct {
		Data []deezerArtistHit `json:"data"`
	}
	if json.NewDecoder(resp.Body).Decode(&parsed) != nil {
		return nil
	}
	return parsed.Data
}

func deezerPicOf(d deezerArtistHit) string {
	pic := d.PictureXL
	if pic == "" {
		pic = d.PictureBig
	}
	if pic == "" || strings.Contains(pic, "/artist//") {
		return ""
	}
	return pic
}

// GetArtistArtCandidates gathers photo/banner options from every source we
// know (Spotify avatar/header/gallery via the pinned match, Deezer search),
// for the Plex-style "choose from candidates" picker.
func GetArtistArtCandidates(name string) (ArtistArtCandidates, error) {
	out := ArtistArtCandidates{Photos: []ArtCandidate{}, Banners: []ArtCandidate{}}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return out, nil
	}

	sid := artistSpotifyMatch(trimmed)
	if sid == "" {
		sid = autoMatchSpotifyArtist(trimmed)
	}
	if sid != "" && !strings.HasPrefix(sid, "deezer:") {
		if overview, _, err := fetchArtistOverview(sid); err == nil {
			if overview.Avatar != "" {
				out.Photos = append(out.Photos, ArtCandidate{Source: "Spotify", URL: overview.Avatar})
			}
			if overview.Header != "" {
				out.Banners = append(out.Banners, ArtCandidate{Source: "Spotify header", URL: overview.Header})
			}
			for _, g := range overview.Gallery {
				if g != "" {
					out.Photos = append(out.Photos, ArtCandidate{Source: "Spotify gallery", URL: g})
					out.Banners = append(out.Banners, ArtCandidate{Source: "Spotify gallery", URL: g})
				}
			}
		}
	}
	for _, d := range deezerSearchArtists(trimmed, 6) {
		if pic := deezerPicOf(d); pic != "" {
			out.Photos = append(out.Photos, ArtCandidate{Source: "Deezer — " + d.Name, URL: pic})
		}
	}
	return out, nil
}

// GetAlbumArtCandidates gathers cover options from Spotify and Deezer for the
// track/album editor's art picker.
func GetAlbumArtCandidates(album, artist string) ([]ArtCandidate, error) {
	out := []ArtCandidate{}
	q := strings.TrimSpace(artist + " " + album)
	if q == "" {
		return out, nil
	}
	if results, err := SearchSpotifyByType(context.Background(), q, "album", 6, 0); err == nil {
		for _, r := range results {
			if r.Images != "" {
				out = append(out, ArtCandidate{Source: "Spotify — " + r.Name + " (" + r.Artists + ")", URL: r.Images})
			}
		}
	}
	resp, err := fallbackHTTP.Get("https://api.deezer.com/search/album?limit=6&q=" + neturl.QueryEscape(q))
	if err == nil {
		defer resp.Body.Close()
		var parsed struct {
			Data []struct {
				Title   string `json:"title"`
				CoverXL string `json:"cover_xl"`
				Artist  struct {
					Name string `json:"name"`
				} `json:"artist"`
			} `json:"data"`
		}
		if json.NewDecoder(resp.Body).Decode(&parsed) == nil {
			for _, d := range parsed.Data {
				if d.CoverXL != "" && !strings.Contains(d.CoverXL, "/cover//") {
					out = append(out, ArtCandidate{Source: "Deezer — " + d.Title + " (" + d.Artist.Name + ")", URL: d.CoverXL})
				}
			}
		}
	}
	return out, nil
}

type MatchCandidate struct {
	Source string `json:"source"` // "spotify" | "deezer"
	ID     string `json:"id"`
	Name   string `json:"name"`
	Image  string `json:"image"`
}

// SearchArtistMatchCandidates searches every supported source for the Fix
// Match dialog.
func SearchArtistMatchCandidates(query string) ([]MatchCandidate, error) {
	out := []MatchCandidate{}
	q := strings.TrimSpace(query)
	if q == "" {
		return out, nil
	}
	if results, err := SearchSpotifyByType(context.Background(), q, "artist", 6, 0); err == nil {
		for _, r := range results {
			out = append(out, MatchCandidate{Source: "spotify", ID: r.ID, Name: r.Name, Image: r.Images})
		}
	}
	for _, d := range deezerSearchArtists(q, 6) {
		out = append(out, MatchCandidate{Source: "deezer", ID: fmt.Sprintf("%d", d.ID), Name: d.Name, Image: deezerPicOf(d)})
	}
	return out, nil
}

// enrichFromDeezer covers artists that aren't on Spotify: photo + top tracks
// from Deezer, bio via the Last.fm fallback.
func enrichFromDeezer(name, deezerID string, force bool) (EnrichResult, error) {
	res := EnrichResult{Artist: name, Matched: true}
	locked := artistLockedFields(name)

	if !locked["photo"] {
		cur, _ := GetArtistImage(name)
		if force || cur == "" {
			resp, err := fallbackHTTP.Get("https://api.deezer.com/artist/" + neturl.PathEscape(deezerID))
			if err == nil {
				var d deezerArtistHit
				if json.NewDecoder(resp.Body).Decode(&d) == nil {
					if pic := deezerPicOf(d); pic != "" {
						if SetArtistImage(name, pic) == nil {
							res.Photo = true
						}
					}
				}
				resp.Body.Close()
			}
		}
	}

	resp, err := fallbackHTTP.Get("https://api.deezer.com/artist/" + neturl.PathEscape(deezerID) + "/top?limit=10")
	if err == nil {
		var parsed struct {
			Data []struct {
				ID    int64  `json:"id"`
				Title string `json:"title"`
				Album struct {
					Title string `json:"title"`
				} `json:"album"`
			} `json:"data"`
		}
		if json.NewDecoder(resp.Body).Decode(&parsed) == nil && len(parsed.Data) > 0 {
			ensureTopTracksTable()
			libDB.Exec("DELETE FROM artist_top_tracks WHERE artist=?", name)
			for i, t := range parsed.Data {
				libDB.Exec("INSERT OR REPLACE INTO artist_top_tracks(artist, rank, title, album, spotify_id) VALUES(?,?,?,?,?)",
					name, i+1, t.Title, t.Album.Title, "")
			}
			res.TopTracks = len(parsed.Data)
		}
		resp.Body.Close()
	}

	applyEnrichmentFallbacks(name, &res)
	return res, nil
}

// SetArtistMatch pins an artist to a source-qualified match ("spotify" or
// "deezer") and re-pulls their metadata from it.
func SetArtistMatch(name, source, id string) (EnrichResult, error) {
	trimmed := strings.TrimSpace(name)
	id = strings.TrimSpace(id)
	if trimmed == "" || id == "" || libDB == nil {
		return EnrichResult{Artist: name}, nil
	}
	if source == "deezer" {
		saveArtistSpotifyMatch(trimmed, "deezer:"+id)
		markArtistChecked(trimmed)
		return enrichFromDeezer(trimmed, id, true)
	}
	return SetArtistSpotifyMatch(trimmed, id)
}

// RefreshArtistMetadata is Plex's "Refresh Metadata": re-pulls this artist's
// data from Spotify (stored match first, else auto-match), replacing unlocked
// fields even when already filled. Locked fields stay untouched.
func RefreshArtistMetadata(name string) (EnrichResult, error) {
	res := EnrichResult{Artist: name}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || libDB == nil {
		return res, nil
	}
	artistID := artistSpotifyMatch(trimmed)
	if artistID == "" {
		artistID = autoMatchSpotifyArtist(trimmed)
		if artistID != "" {
			saveArtistSpotifyMatch(trimmed, artistID)
		}
	}
	markArtistChecked(trimmed)
	if artistID == "" {
		applyEnrichmentFallbacks(trimmed, &res)
		return res, nil
	}
	if strings.HasPrefix(artistID, "deezer:") {
		return enrichFromDeezer(trimmed, strings.TrimPrefix(artistID, "deezer:"), true)
	}
	out, err := enrichFromID(trimmed, artistID, true)
	applyEnrichmentFallbacks(trimmed, &out)
	return out, err
}

// enrichThrottle keeps a bulk pass polite to the Spotify endpoints.
var enrichThrottle = time.Tick(1200 * time.Millisecond)

// EnrichLibraryArtistThrottled is EnrichLibraryArtist behind a shared rate
// limiter, for bulk passes driven from the frontend.
func EnrichLibraryArtistThrottled(name string) (EnrichResult, error) {
	<-enrichThrottle
	return EnrichLibraryArtist(name)
}

// RefreshArtistMetadataThrottled is RefreshArtistMetadata behind the same
// shared rate limiter.
func RefreshArtistMetadataThrottled(name string) (EnrichResult, error) {
	<-enrichThrottle
	return RefreshArtistMetadata(name)
}
