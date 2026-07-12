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
	sort.SliceStable(out, func(i, j int) bool { return out[i].ReleaseDate > out[j].ReleaseDate })
	return out, nil
}
