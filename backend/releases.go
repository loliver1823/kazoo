package backend

// "New releases" for a library artist: the full Spotify discography compared
// against the local library, so the artist page can show what's missing.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

type ArtistReleaseCheck struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Type        string `json:"type"`
	ReleaseDate string `json:"releaseDate"`
	Cover       string `json:"cover"`
	URL         string `json:"url"`
	TotalTracks int    `json:"totalTracks"`
	// HaveTracks: how many of this release's tracks the library already has
	// (by album-title match). InLibrary means complete; 0 < HaveTracks <
	// TotalTracks marks the release incomplete.
	HaveTracks int  `json:"haveTracks"`
	InLibrary  bool `json:"inLibrary"`
}

// GetArtistNewReleases fetches the artist's Spotify discography and marks
// which releases the library already has (title-base match, so a Deluxe
// pressing still counts as having the album).
func GetArtistNewReleases(name string) ([]ArtistReleaseCheck, error) {
	out := []ArtistReleaseCheck{}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return out, nil
	}
	spid := artistSpotifyMatch(trimmed)
	if spid == "" {
		if spid = autoMatchSpotifyArtist(trimmed); spid != "" {
			saveArtistSpotifyMatch(trimmed, spid)
		}
	}
	if spid == "" {
		return out, fmt.Errorf("artist not matched on Spotify — use Fix Match on this artist first")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	data, err := GetFilteredSpotifyData(ctx, "https://open.spotify.com/artist/"+spid+"/discography/all", false, time.Second, ", ", nil)
	if err != nil {
		return out, err
	}
	var payload ArtistDiscographyPayload
	switch p := data.(type) {
	case ArtistDiscographyPayload:
		payload = p
	case *ArtistDiscographyPayload:
		payload = *p
	default:
		return out, fmt.Errorf("unexpected discography response")
	}

	// Owned-track counts per album title key. A release counts as complete
	// only when the library has at least its full track count — a single
	// downloaded song no longer hides the whole album from "missing".
	have := map[string]int{}
	if libDB != nil {
		rows, qerr := libDB.Query(
			"SELECT t.album, COUNT(DISTINCT t.id) FROM tracks t LEFT JOIN track_artists ta ON ta.track_id = t.id WHERE ta.name = ? OR t.album_artist = ? GROUP BY t.album",
			trimmed, trimmed)
		if qerr == nil {
			for rows.Next() {
				var a string
				var n int
				if rows.Scan(&a, &n) == nil {
					if k := titleBaseKey(a); k != "" {
						have[k] += n
					}
				}
			}
			rows.Close()
		}
	}

	seen := map[string]bool{}
	for _, a := range payload.AlbumList {
		if a.ID == "" || seen[a.ID] {
			continue
		}
		seen[a.ID] = true
		url := a.ExternalURL
		if url == "" {
			url = "https://open.spotify.com/album/" + a.ID
		}
		haveN := have[titleBaseKey(a.Name)]
		complete := haveN > 0 && (a.TotalTracks == 0 || haveN >= a.TotalTracks)
		out = append(out, ArtistReleaseCheck{
			ID: a.ID, Name: a.Name, Type: a.AlbumType, ReleaseDate: a.ReleaseDate,
			Cover: a.Images, URL: url, TotalTracks: a.TotalTracks,
			HaveTracks: haveN, InLibrary: complete,
		})
	}
	// Releases the artist only appears on (soundtracks, compilations, other
	// artists' albums) — the Spotify artist page's "Appears On" shelf.
	for _, a := range fetchArtistAppearsOn(spid) {
		if seen[a.ID] {
			continue
		}
		seen[a.ID] = true
		haveN := have[titleBaseKey(a.Name)]
		a.HaveTracks = haveN
		a.InLibrary = haveN > 0
		out = append(out, a)
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].ReleaseDate > out[j].ReleaseDate })
	return out, nil
}

// fetchArtistAppearsOn parses the "Appears On" shelf out of the artist
// overview call. Best-effort: an empty result just hides the section.
func fetchArtistAppearsOn(artistID string) []ArtistReleaseCheck {
	out := []ArtistReleaseCheck{}
	client := NewSpotifyClient()
	if err := client.Initialize(); err != nil {
		return out
	}
	payload := map[string]interface{}{
		"variables":     map[string]interface{}{"uri": "spotify:artist:" + artistID, "locale": ""},
		"operationName": "queryArtistOverview",
		"extensions": map[string]interface{}{
			"persistedQuery": map[string]interface{}{"version": 1, "sha256Hash": artistOverviewQueryHash},
		},
	}
	data, err := client.Query(payload)
	if err != nil {
		return out
	}
	items := getSlice(getMap(getMap(getMap(getMap(data, "data"), "artistUnion"), "relatedContent"), "appearsOn"), "items")
	for _, it := range items {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		rels := getSlice(getMap(m, "releases"), "items")
		if len(rels) == 0 {
			continue
		}
		r, ok := rels[0].(map[string]interface{})
		if !ok {
			continue
		}
		id, name := getString(r, "id"), getString(r, "name")
		if id == "" || name == "" {
			continue
		}
		year := 0
		if d := getMap(r, "date"); d != nil {
			if y, ok := d["year"].(float64); ok {
				year = int(y)
			}
		}
		cover := ""
		if ca := getMap(r, "coverArt"); ca != nil {
			for _, src := range getSlice(ca, "sources") {
				if sm, ok := src.(map[string]interface{}); ok {
					if h, ok := sm["height"].(float64); ok && int(h) == 300 {
						cover = getString(sm, "url")
					}
					if cover == "" {
						cover = getString(sm, "url")
					}
				}
			}
		}
		date := ""
		if year > 0 {
			date = fmt.Sprintf("%d", year)
		}
		out = append(out, ArtistReleaseCheck{
			ID: id, Name: name, Type: "appears_on", ReleaseDate: date,
			Cover: cover, URL: "https://open.spotify.com/album/" + id,
		})
	}
	return out
}
