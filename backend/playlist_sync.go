package backend

// Synced Spotify playlists: persisted snapshots of playlists the user wants to
// mirror locally. Track refs are stored in the library DB; matching against
// the library is recomputed on every read so "missing" always reflects the
// current library (rows light up as downloads land).

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

type SyncedPlaylist struct {
	ID         int64  `json:"id"`
	SpotifyID  string `json:"spotifyId"`
	URL        string `json:"url"`
	Name       string `json:"name"`
	Owner      string `json:"owner"`
	Cover      string `json:"cover"`
	Total      int    `json:"total"`
	HaveCount  int    `json:"haveCount"`
	LastSynced int64  `json:"lastSynced"`
	// Synced marks playlists the user explicitly added to Playlist Sync.
	// Unsynced rows are browse-cache only and never show in the sync list.
	Synced bool `json:"synced"`
}

// playlistCacheTTL is how long a cached snapshot is served without
// re-fetching from Spotify (opening a playlist twice in a day is instant).
const playlistCacheTTL = 24 * 3600

type SyncedPlaylistDetail struct {
	Playlist SyncedPlaylist `json:"playlist"`
	Matches  []MatchedTrack `json:"matches"`
}

var rePlaylistID = regexp.MustCompile(`(?:playlist[/:])([A-Za-z0-9]+)`)

func extractPlaylistID(url string) string {
	if m := rePlaylistID.FindStringSubmatch(url); len(m) == 2 {
		return m[1]
	}
	return ""
}

// fetchPlaylistRefs pulls a playlist's metadata and track refs from Spotify.
func fetchPlaylistRefs(url string) (name, owner, cover string, refs []SpotifyTrackRef, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
	defer cancel()
	data, err := GetFilteredSpotifyData(ctx, url, false, time.Second, ", ", nil)
	if err != nil {
		return "", "", "", nil, err
	}
	var payload PlaylistResponsePayload
	switch p := data.(type) {
	case PlaylistResponsePayload:
		payload = p
	case *PlaylistResponsePayload:
		payload = *p
	default:
		return "", "", "", nil, fmt.Errorf("URL is not a playlist")
	}
	refs = make([]SpotifyTrackRef, 0, len(payload.TrackList))
	for _, t := range payload.TrackList {
		var artists []string
		for _, a := range strings.Split(t.Artists, ",") {
			if a = strings.TrimSpace(a); a != "" {
				artists = append(artists, a)
			}
		}
		refs = append(refs, SpotifyTrackRef{
			SpotifyID:   t.SpotifyID,
			Name:        t.Name,
			ArtistNames: artists,
			Album:       t.AlbumName,
			DurationMs:  int64(t.DurationMS),
			AlbumID:     t.AlbumID,
			ArtistID:    t.ArtistID,
		})
	}
	// formatPlaylistData maps the playlist title into Owner.Name and the owner
	// into Owner.DisplayName.
	return payload.PlaylistInfo.Owner.Name, payload.PlaylistInfo.Owner.DisplayName, payload.PlaylistInfo.Cover, refs, nil
}

// SyncSpotifyPlaylist fetches a playlist and adds it to Playlist Sync.
func SyncSpotifyPlaylist(url string) (SyncedPlaylist, error) {
	return syncPlaylistSnapshot(url, true)
}

// OpenSpotifyPlaylist retrieves a playlist for viewing, metadata-style:
// served from cache when fresh, fetched and cached otherwise. Does NOT add
// it to the Playlist Sync list.
func OpenSpotifyPlaylist(url string) (SyncedPlaylist, error) {
	var out SyncedPlaylist
	if libDB == nil {
		return out, fmt.Errorf("library not initialised")
	}
	spotifyID := extractPlaylistID(strings.TrimSpace(url))
	if spotifyID == "" {
		return out, fmt.Errorf("not a Spotify playlist URL")
	}
	if cached, err := loadSyncedPlaylistBySpotifyID(spotifyID); err == nil {
		if time.Now().Unix()-cached.LastSynced < playlistCacheTTL {
			return cached, nil
		}
		if fresh, ferr := syncPlaylistSnapshot(url, false); ferr == nil {
			return fresh, nil
		}
		return cached, nil // a stale snapshot beats a fetch error
	}
	return syncPlaylistSnapshot(url, false)
}

// SetPlaylistSynced adds a cached playlist to (or removes it from) the
// Playlist Sync list without touching the snapshot.
func SetPlaylistSynced(id int64, synced bool) error {
	if libDB == nil {
		return fmt.Errorf("library not initialised")
	}
	v := 0
	if synced {
		v = 1
	}
	_, err := libDB.Exec("UPDATE synced_playlists SET synced = ? WHERE id = ?", v, id)
	return err
}

// syncPlaylistSnapshot fetches a playlist and persists (or refreshes) its
// snapshot. markSynced=true pins it into the Playlist Sync list; false keeps
// an existing row's synced flag untouched.
func syncPlaylistSnapshot(url string, markSynced bool) (SyncedPlaylist, error) {
	var out SyncedPlaylist
	if libDB == nil {
		return out, fmt.Errorf("library not initialised")
	}
	url = strings.TrimSpace(url)
	spotifyID := extractPlaylistID(url)
	if spotifyID == "" {
		return out, fmt.Errorf("not a Spotify playlist URL")
	}
	name, owner, cover, refs, err := fetchPlaylistRefs(url)
	if err != nil {
		return out, err
	}
	if len(refs) == 0 {
		return out, fmt.Errorf("no tracks found — is that a public playlist?")
	}

	matches, err := MatchPlaylistTracks(refs)
	if err != nil {
		return out, err
	}
	have := 0
	for _, m := range matches {
		if m.Local != nil {
			have++
		}
	}

	now := time.Now().Unix()
	syncedVal := 0
	if markSynced {
		syncedVal = 1
	}
	// A browse-cache refresh (synced=0) must never unpin an explicitly
	// synced playlist — keep the higher of the two flags.
	if _, err := libDB.Exec(`INSERT INTO synced_playlists(spotify_id, url, name, owner, cover, total, have_count, last_synced, synced)
		VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(spotify_id) DO UPDATE SET url=excluded.url, name=excluded.name, owner=excluded.owner,
			cover=excluded.cover, total=excluded.total, have_count=excluded.have_count, last_synced=excluded.last_synced,
			synced=MAX(synced_playlists.synced, excluded.synced)`,
		spotifyID, url, name, owner, cover, len(refs), have, now, syncedVal); err != nil {
		return out, err
	}
	var id int64
	var syncedOut int
	if err := libDB.QueryRow("SELECT id, synced FROM synced_playlists WHERE spotify_id = ?", spotifyID).Scan(&id, &syncedOut); err != nil {
		return out, err
	}

	tx, err := libDB.Begin()
	if err != nil {
		return out, err
	}
	tx.Exec("DELETE FROM synced_playlist_tracks WHERE playlist_id = ?", id)
	for i, r := range refs {
		artistsJSON, _ := json.Marshal(r.ArtistNames)
		tx.Exec(`INSERT INTO synced_playlist_tracks(playlist_id, pos, spotify_id, name, artists, album, duration_ms, album_id, artist_id)
			VALUES(?,?,?,?,?,?,?,?,?)`, id, i, r.SpotifyID, r.Name, string(artistsJSON), r.Album, r.DurationMs, r.AlbumID, r.ArtistID)
	}
	if err := tx.Commit(); err != nil {
		return out, err
	}

	return SyncedPlaylist{ID: id, SpotifyID: spotifyID, URL: url, Name: name, Owner: owner,
		Cover: cover, Total: len(refs), HaveCount: have, LastSynced: now, Synced: syncedOut == 1}, nil
}

// ListSyncedPlaylists returns explicitly synced playlists (browse-cache rows
// are excluded), most recently synced first.
func ListSyncedPlaylists() ([]SyncedPlaylist, error) {
	out := []SyncedPlaylist{}
	if libDB == nil {
		return out, nil
	}
	rows, err := libDB.Query(`SELECT id, spotify_id, url, name, owner, cover, total, have_count, last_synced, synced
		FROM synced_playlists WHERE synced = 1 ORDER BY last_synced DESC`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var p SyncedPlaylist
		var s int
		if rows.Scan(&p.ID, &p.SpotifyID, &p.URL, &p.Name, &p.Owner, &p.Cover, &p.Total, &p.HaveCount, &p.LastSynced, &s) == nil {
			p.Synced = s == 1
			out = append(out, p)
		}
	}
	return out, nil
}

func loadSyncedPlaylist(id int64) (SyncedPlaylist, error) {
	var p SyncedPlaylist
	var s int
	err := libDB.QueryRow(`SELECT id, spotify_id, url, name, owner, cover, total, have_count, last_synced, synced
		FROM synced_playlists WHERE id = ?`, id).
		Scan(&p.ID, &p.SpotifyID, &p.URL, &p.Name, &p.Owner, &p.Cover, &p.Total, &p.HaveCount, &p.LastSynced, &s)
	p.Synced = s == 1
	return p, err
}

func loadSyncedPlaylistBySpotifyID(spotifyID string) (SyncedPlaylist, error) {
	var p SyncedPlaylist
	var s int
	err := libDB.QueryRow(`SELECT id, spotify_id, url, name, owner, cover, total, have_count, last_synced, synced
		FROM synced_playlists WHERE spotify_id = ?`, spotifyID).
		Scan(&p.ID, &p.SpotifyID, &p.URL, &p.Name, &p.Owner, &p.Cover, &p.Total, &p.HaveCount, &p.LastSynced, &s)
	p.Synced = s == 1
	return p, err
}

// GetSyncedPlaylistDetail returns a playlist with its tracks re-matched
// against the current library (and refreshes the stored have count).
func GetSyncedPlaylistDetail(id int64) (SyncedPlaylistDetail, error) {
	var out SyncedPlaylistDetail
	if libDB == nil {
		return out, fmt.Errorf("library not initialised")
	}
	p, err := loadSyncedPlaylist(id)
	if err != nil {
		return out, fmt.Errorf("playlist not found")
	}

	rows, err := libDB.Query(`SELECT spotify_id, name, artists, album, duration_ms, album_id, artist_id
		FROM synced_playlist_tracks WHERE playlist_id = ? ORDER BY pos`, id)
	if err != nil {
		return out, err
	}
	refs := []SpotifyTrackRef{}
	for rows.Next() {
		var r SpotifyTrackRef
		var artistsJSON string
		if rows.Scan(&r.SpotifyID, &r.Name, &artistsJSON, &r.Album, &r.DurationMs, &r.AlbumID, &r.ArtistID) != nil {
			continue
		}
		json.Unmarshal([]byte(artistsJSON), &r.ArtistNames)
		refs = append(refs, r)
	}
	rows.Close()

	matches, err := MatchPlaylistTracks(refs)
	if err != nil {
		return out, err
	}
	have := 0
	for _, m := range matches {
		if m.Local != nil {
			have++
		}
	}
	if have != p.HaveCount || len(matches) != p.Total {
		libDB.Exec("UPDATE synced_playlists SET have_count = ?, total = ? WHERE id = ?", have, len(matches), id)
	}
	p.HaveCount = have
	p.Total = len(matches)

	out.Playlist = p
	out.Matches = matches
	return out, nil
}

// ResyncSyncedPlaylist re-fetches a playlist from Spotify (new/removed tracks)
// and rematches it.
func ResyncSyncedPlaylist(id int64) (SyncedPlaylist, error) {
	var out SyncedPlaylist
	if libDB == nil {
		return out, fmt.Errorf("library not initialised")
	}
	p, err := loadSyncedPlaylist(id)
	if err != nil {
		return out, fmt.Errorf("playlist not found")
	}
	// Refresh keeps the existing synced/cached status (MAX() in the upsert
	// preserves an explicit pin).
	return syncPlaylistSnapshot(p.URL, false)
}

// RemoveSyncedPlaylist deletes a synced playlist and its stored tracks.
func RemoveSyncedPlaylist(id int64) error {
	if libDB == nil {
		return fmt.Errorf("library not initialised")
	}
	if _, err := libDB.Exec("DELETE FROM synced_playlist_tracks WHERE playlist_id = ?", id); err != nil {
		return err
	}
	_, err := libDB.Exec("DELETE FROM synced_playlists WHERE id = ?", id)
	return err
}
