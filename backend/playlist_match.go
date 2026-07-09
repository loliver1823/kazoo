package backend

// Spotify-playlist → local-library matching for the PC-companion flow.
// Ports com.musicplayer.shared.spotify.SpotifyMatcher (weighted fuzzy match:
// title 0.4, artist-overlap 0.4, album 0.1, duration±3s 0.1; threshold 0.5)
// so we can show "have vs missing" for any Spotify playlist and fill the gaps.

import (
	"regexp"
	"strings"
)

// SpotifyTrackRef mirrors shared/Models.SpotifyTrackRef.
type SpotifyTrackRef struct {
	SpotifyID   string   `json:"spotifyId"`
	Name        string   `json:"name"`
	ArtistNames []string `json:"artistNames"`
	Album       string   `json:"album"`
	DurationMs  int64    `json:"durationMs"`
	AlbumID     string   `json:"albumId"`
	ArtistID    string   `json:"artistId"`
}

// MatchedTrack mirrors shared/Models.MatchResult (local may be nil = missing).
type MatchedTrack struct {
	Ref        SpotifyTrackRef `json:"ref"`
	Local      *LibraryTrack   `json:"local"`
	Confidence float64         `json:"confidence"`
}

type PlaylistMatchResult struct {
	Name         string         `json:"name"`
	Cover        string         `json:"cover"`
	Total        int            `json:"total"`
	HaveCount    int            `json:"haveCount"`
	MissingCount int            `json:"missingCount"`
	Matches      []MatchedTrack `json:"matches"`
}

var reNormMatch = regexp.MustCompile(`[\s\-_]+`)

// Tags and Spotify disagree on punctuation: libraries often carry Unicode
// hyphens (blink‐182, U+2010) and curly apostrophes (M+M’s) where Spotify
// sends ASCII. Fold them before comparing or artist overlap scores zero.
var matchCharFolder = strings.NewReplacer(
	"‐", "-", "‑", "-", "‒", "-", "–", "-", "—", "-", "―", "-",
	"‘", "'", "’", "'", "‛", "'",
	"“", "\"", "”", "\"",
	" ", " ",
)

func normalizeMatch(s string) string {
	s = matchCharFolder.Replace(strings.ToLower(s))
	return strings.TrimSpace(reNormMatch.ReplaceAllString(s, " "))
}

// Greedy from the first opening bracket to a closing bracket at the end, so
// nested qualifiers ("[International Version (Explicit)]") strip whole.
var reTrailBracket = regexp.MustCompile(`\s*[(\[].*[)\]]\s*$`)

// stripVersionTail drops trailing "(...)"/"[...]" qualifiers and a final
// " - Xxx" segment ("Down - Single Version" → "Down") for tolerant title
// comparison. Works on the raw name, before normalizeMatch collapses dashes.
func stripVersionTail(s string) string {
	for {
		t := strings.TrimSpace(reTrailBracket.ReplaceAllString(s, ""))
		if t == s || t == "" {
			break
		}
		s = t
	}
	if i := strings.LastIndex(s, " - "); i > 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

type localMatchTrack struct {
	track         LibraryTrack
	normTitle     string
	normTitleCore string
	normArtists   map[string]bool
	normAlbum     string
	durationMs    int64
}

func loadLocalForMatch() ([]localMatchTrack, error) {
	if libDB == nil {
		return nil, nil
	}
	rows, err := libDB.Query(`SELECT t.id, t.path, t.title, t.artist, t.album_artist, t.album, t.album_id,
		t.genre, t.year, t.track_no, t.disc_no, t.duration, t.bitrate, t.sample_rate, t.codec,
		t.size, t.rating, t.play_count, t.date_added, ta.name
		FROM tracks t LEFT JOIN track_artists ta ON ta.track_id = t.id ORDER BY t.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []localMatchTrack
	var cur *localMatchTrack
	var curID int64 = -1
	for rows.Next() {
		var t LibraryTrack
		var artistName *string
		if err := rows.Scan(&t.ID, &t.Path, &t.Title, &t.Artist, &t.AlbumArtist, &t.Album, &t.AlbumID,
			&t.Genre, &t.Year, &t.TrackNo, &t.DiscNo, &t.Duration, &t.Bitrate, &t.SampleRate,
			&t.Codec, &t.Size, &t.Rating, &t.PlayCount, &t.DateAdded, &artistName); err != nil {
			continue
		}
		if t.ID != curID {
			out = append(out, localMatchTrack{
				track:         t,
				normTitle:     normalizeMatch(t.Title),
				normTitleCore: normalizeMatch(stripVersionTail(t.Title)),
				normArtists:   map[string]bool{},
				normAlbum:     normalizeMatch(t.Album),
				durationMs:    int64(t.Duration) * 1000,
			})
			cur = &out[len(out)-1]
			curID = t.ID
			cur.track.Artists = []TrackArtist{}
		}
		if artistName != nil && *artistName != "" {
			cur.normArtists[normalizeMatch(*artistName)] = true
			cur.track.Artists = append(cur.track.Artists, TrackArtist{Name: *artistName, Role: RolePrimary})
		}
	}
	return out, nil
}

func containsEither(a, b string) bool {
	return a == b || (a != "" && strings.Contains(b, a)) || (b != "" && strings.Contains(a, b))
}

func scoreMatch(refTitle, refTitleCore string, refArtists map[string]bool, refAlbum string, refDur int64, l *localMatchTrack) float64 {
	var score float64
	// Title (0.4)
	if refTitle == l.normTitle {
		score += 0.4
	} else if refTitleCore != "" && refTitleCore == l.normTitleCore {
		// Same song, different version qualifier ("Down - Single Version" vs
		// "Down") — near-exact so it survives even without album agreement.
		score += 0.35
	} else if l.normTitle != "" && (strings.Contains(l.normTitle, refTitle) || strings.Contains(refTitle, l.normTitle)) {
		score += 0.25
	} else if strings.ReplaceAll(refTitle, " ", "") == strings.ReplaceAll(l.normTitle, " ", "") {
		score += 0.2
	}
	// Artist overlap (0.4)
	if len(refArtists) == 0 {
		score += 0.4
	} else {
		overlap := 0
		for ra := range refArtists {
			for ta := range l.normArtists {
				if containsEither(ra, ta) {
					overlap++
					break
				}
			}
		}
		score += 0.4 * (float64(overlap) / float64(len(refArtists)))
	}
	// Album (0.1)
	if refAlbum != "" && l.normAlbum != "" {
		if refAlbum == l.normAlbum {
			score += 0.1
		} else if strings.Contains(l.normAlbum, refAlbum) || strings.Contains(refAlbum, l.normAlbum) {
			score += 0.05
		}
	} else {
		score += 0.05
	}
	// Duration ±3s (0.1)
	d := refDur - l.durationMs
	if d < 0 {
		d = -d
	}
	if d < 3000 {
		score += 0.1
	} else if d < 10000 {
		score += 0.05
	}
	if score > 1 {
		score = 1
	}
	return score
}

// MatchPlaylistTracks matches each Spotify ref against the local library.
func MatchPlaylistTracks(refs []SpotifyTrackRef) ([]MatchedTrack, error) {
	locals, err := loadLocalForMatch()
	if err != nil {
		return nil, err
	}
	out := make([]MatchedTrack, 0, len(refs))
	for _, ref := range refs {
		refTitle := normalizeMatch(ref.Name)
		refTitleCore := normalizeMatch(stripVersionTail(ref.Name))
		refArtists := map[string]bool{}
		for _, a := range ref.ArtistNames {
			if n := normalizeMatch(a); n != "" {
				refArtists[n] = true
			}
		}
		refAlbum := normalizeMatch(ref.Album)

		var best *LibraryTrack
		bestScore := 0.0
		for i := range locals {
			s := scoreMatch(refTitle, refTitleCore, refArtists, refAlbum, ref.DurationMs, &locals[i])
			if s > bestScore && s >= 0.5 {
				bestScore = s
				best = &locals[i].track
			}
		}
		out = append(out, MatchedTrack{Ref: ref, Local: best, Confidence: bestScore})
	}

	// Manual Fix Match overrides (keyed by Spotify ID) beat fuzzy matching,
	// and the entry takes on the local track's metadata.
	byID := map[int64]*LibraryTrack{}
	for i := range locals {
		byID[locals[i].track.ID] = &locals[i].track
	}
	for i := range out {
		trackID, ok := lookupTrackMatchOverride(out[i].Ref.SpotifyID)
		if !ok {
			continue
		}
		lt := byID[trackID]
		if lt == nil {
			continue // overridden track no longer in the library
		}
		out[i].Local = lt
		out[i].Confidence = 1
		out[i].Ref.Name = lt.Title
		out[i].Ref.Album = lt.Album
		if lt.Artist != "" {
			out[i].Ref.ArtistNames = []string{lt.Artist}
		}
	}
	return out, nil
}
