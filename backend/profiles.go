package backend

// Spotify profile discovery: search user profiles, browse their public
// playlists, and surface editorial "This Is <artist>" playlists on library
// artist pages. All via the anonymous web token — no login.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	neturl "net/url"
	"strings"
	"time"
)

type SpotifyProfile struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Image string `json:"image"`
}

type ProfilePlaylist struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	Name      string `json:"name"`
	Image     string `json:"image"`
	Owner     string `json:"owner"`
	Followers int64  `json:"followers"`
}

// SearchSpotifyProfiles searches user profiles (the "Profiles" vertical of
// Spotify search).
func SearchSpotifyProfiles(query string) ([]SpotifyProfile, error) {
	out := []SpotifyProfile{}
	q := strings.TrimSpace(query)
	if q == "" {
		return out, nil
	}
	client := NewSpotifyClient()
	if err := client.Initialize(); err != nil {
		return out, err
	}
	payload := map[string]interface{}{
		"variables": map[string]interface{}{
			"searchTerm": q, "offset": 0, "limit": 12, "numberOfTopResults": 5,
			"includeAudiobooks": false, "includeArtistHasConcertsField": false,
			"includePreReleases": false, "includeAuthors": false,
		},
		"operationName": "searchDesktop",
		"extensions": map[string]interface{}{
			"persistedQuery": map[string]interface{}{
				"version": 1, "sha256Hash": "fcad5a3e0d5af727fb76966f06971c19cfa2275e6ff7671196753e008611873c",
			},
		},
	}
	data, err := client.Query(payload)
	if err != nil {
		return out, err
	}
	items := getSlice(getMap(getMap(getMap(data, "data"), "searchV2"), "users"), "items")
	for _, item := range items {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		d := getMap(m, "data")
		id := getString(d, "id")
		if id == "" {
			id = getString(d, "username")
		}
		if id == "" {
			continue
		}
		name := getString(d, "displayName")
		if name == "" {
			name = id
		}
		image := ""
		if sources := getSlice(getMap(d, "avatar"), "sources"); len(sources) > 0 {
			// last source is the largest
			if s, ok := sources[len(sources)-1].(map[string]interface{}); ok {
				image = getString(s, "url")
			}
		}
		out = append(out, SpotifyProfile{ID: id, Name: name, Image: image})
	}
	return out, nil
}

// GetUserPlaylists returns a profile's public playlists.
func GetUserPlaylists(userID string) ([]ProfilePlaylist, error) {
	out := []ProfilePlaylist{}
	id := strings.TrimSpace(userID)
	if id == "" {
		return out, nil
	}
	client := NewSpotifyClient()
	if err := client.Initialize(); err != nil {
		return out, err
	}
	req, err := http.NewRequest("GET",
		"https://spclient.wg.spotify.com/user-profile-view/v3/profile/"+neturl.PathEscape(id)+"?playlist_limit=200&market=from_token", nil)
	if err != nil {
		return out, err
	}
	req.Header.Set("Authorization", "Bearer "+client.accessToken)
	req.Header.Set("app-platform", "WebPlayer")
	resp, err := fallbackHTTP.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out, fmt.Errorf("profile request failed: %d", resp.StatusCode)
	}
	var parsed struct {
		PublicPlaylists []struct {
			URI       string `json:"uri"`
			Name      string `json:"name"`
			ImageURL  string `json:"image_url"`
			Followers int64  `json:"followers_count"`
			OwnerName string `json:"owner_name"`
		} `json:"public_playlists"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return out, err
	}
	for _, p := range parsed.PublicPlaylists {
		pid := p.URI
		if i := strings.LastIndex(pid, ":"); i >= 0 {
			pid = pid[i+1:]
		}
		if pid == "" {
			continue
		}
		out = append(out, ProfilePlaylist{
			ID: pid, URL: "https://open.spotify.com/playlist/" + pid,
			Name: p.Name, Image: p.ImageURL, Owner: p.OwnerName, Followers: p.Followers,
		})
	}
	return out, nil
}

const artistPlaylistsCacheTTL = 7 * 24 * 3600

// GetArtistSpotifyPlaylists finds Spotify-editorial playlists for a library
// artist — most notably "This Is <artist>". Cached in the library DB like
// other metadata, so artist pages render instantly; refreshed weekly.
func GetArtistSpotifyPlaylists(name string) ([]ProfilePlaylist, error) {
	out := []ProfilePlaylist{}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return out, nil
	}

	if libDB != nil {
		var checked int64
		libDB.QueryRow("SELECT checked_at FROM artist_sp_playlists_meta WHERE artist = ?", trimmed).Scan(&checked)
		if checked > 0 && time.Now().Unix()-checked < artistPlaylistsCacheTTL {
			return loadCachedArtistPlaylists(trimmed), nil
		}
	}

	fetched, err := fetchArtistSpotifyPlaylists(trimmed)
	if err != nil {
		// Network hiccup — serve whatever we had rather than nothing.
		return loadCachedArtistPlaylists(trimmed), nil
	}
	if libDB != nil {
		libDB.Exec("DELETE FROM artist_sp_playlists WHERE artist = ?", trimmed)
		for i, p := range fetched {
			libDB.Exec("INSERT INTO artist_sp_playlists(artist, pos, spid, url, name, image) VALUES(?,?,?,?,?,?)",
				trimmed, i, p.ID, p.URL, p.Name, p.Image)
		}
		libDB.Exec("INSERT OR REPLACE INTO artist_sp_playlists_meta(artist, checked_at) VALUES(?, ?)", trimmed, time.Now().Unix())
	}
	return fetched, nil
}

func loadCachedArtistPlaylists(artist string) []ProfilePlaylist {
	out := []ProfilePlaylist{}
	if libDB == nil {
		return out
	}
	rows, err := libDB.Query("SELECT spid, url, name, image FROM artist_sp_playlists WHERE artist = ? ORDER BY pos", artist)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var p ProfilePlaylist
		if rows.Scan(&p.ID, &p.URL, &p.Name, &p.Image) == nil {
			p.Owner = "Spotify"
			out = append(out, p)
		}
	}
	return out
}

func fetchArtistSpotifyPlaylists(trimmed string) ([]ProfilePlaylist, error) {
	out := []ProfilePlaylist{}
	seen := map[string]bool{}
	var lastErr error
	for _, q := range []string{"This Is " + trimmed, trimmed + " Radio"} {
		results, err := SearchSpotifyByType(context.Background(), q, "playlist", 10, 0)
		if err != nil {
			lastErr = err
			continue
		}
		for _, r := range results {
			// Editorial playlists only, exactly matching the expected title —
			// anything else is fan-made noise.
			if !strings.EqualFold(strings.TrimSpace(r.Owner), "spotify") {
				continue
			}
			if normArtistName(r.Name) != normArtistName(q) {
				continue
			}
			if seen[r.ID] {
				continue
			}
			seen[r.ID] = true
			out = append(out, ProfilePlaylist{
				ID: r.ID, URL: r.ExternalURL, Name: r.Name, Image: r.Images, Owner: "Spotify",
			})
		}
	}
	if len(out) == 0 && lastErr != nil {
		return out, lastErr
	}
	return out, nil
}
