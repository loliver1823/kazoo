package backend

// Direct Qobuz catalog search — finds music that isn't on Spotify (artists
// who pulled their catalog but remain on other platforms). Results carry the
// exact Qobuz track ID so downloads pin the right pressing via the existing
// "qobuz_<id>" convention in searchByISRC.

import (
	"fmt"
	"net/url"
	"strings"
)

type QobuzSearchTrack struct {
	ID          int64   `json:"id"`
	Title       string  `json:"title"`
	Artist      string  `json:"artist"`
	Album       string  `json:"album"`
	Cover       string  `json:"cover"`
	DurationMs  int64   `json:"durationMs"`
	ISRC        string  `json:"isrc"`
	Hires       bool    `json:"hires"`
	BitDepth    int     `json:"bitDepth"`
	SampleRate  float64 `json:"sampleRate"`
	ReleaseDate string  `json:"releaseDate"`
}

// SearchQobuzTracks searches Qobuz's public catalog by free-text query.
func SearchQobuzTracks(query string) ([]QobuzSearchTrack, error) {
	out := []QobuzSearchTrack{}
	q := strings.TrimSpace(query)
	if q == "" {
		return out, nil
	}
	var resp qobuzPublicSearchResponse
	if err := doQobuzSignedJSONRequest("track/search", url.Values{
		"query": {q},
		"limit": {"50"},
	}, &resp); err != nil {
		return out, fmt.Errorf("Qobuz search failed: %w", err)
	}
	for _, t := range resp.Tracks.Items {
		if t.ID == 0 {
			continue
		}
		title := strings.TrimSpace(t.Title)
		if v := strings.TrimSpace(t.Version); v != "" {
			title = title + " (" + v + ")"
		}
		artist := strings.TrimSpace(t.Performer.Name)
		if artist == "" {
			artist = strings.TrimSpace(t.Album.Artist.Name)
		}
		cover := t.Album.Image.Small
		if cover == "" {
			cover = t.Album.Image.Thumbnail
		}
		out = append(out, QobuzSearchTrack{
			ID: t.ID, Title: title, Artist: artist, Album: strings.TrimSpace(t.Album.Title),
			Cover: cover, DurationMs: int64(t.Duration) * 1000, ISRC: t.ISRC,
			Hires: t.HiresStreamable || t.Hires, BitDepth: t.MaximumBitDepth,
			SampleRate: t.MaximumSamplingRate, ReleaseDate: t.ReleaseDateOriginal,
		})
	}
	return out, nil
}
