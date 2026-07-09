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
	InLibrary   bool   `json:"inLibrary"`
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

	// Album title keys the library already has for this artist.
	have := map[string]bool{}
	if libDB != nil {
		rows, qerr := libDB.Query(
			"SELECT DISTINCT t.album FROM tracks t LEFT JOIN track_artists ta ON ta.track_id = t.id WHERE ta.name = ? OR t.album_artist = ?",
			trimmed, trimmed)
		if qerr == nil {
			for rows.Next() {
				var a string
				if rows.Scan(&a) == nil {
					if k := titleBaseKey(a); k != "" {
						have[k] = true
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
		out = append(out, ArtistReleaseCheck{
			ID: a.ID, Name: a.Name, Type: a.AlbumType, ReleaseDate: a.ReleaseDate,
			Cover: a.Images, URL: url, TotalTracks: a.TotalTracks,
			InLibrary: have[titleBaseKey(a.Name)],
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ReleaseDate > out[j].ReleaseDate })
	return out, nil
}
