package backend

// Local playlists (manual). Stored in SQLite alongside the library; tracks are
// referenced by their library id so a playlist follows files as they're re-scanned.

import (
	"fmt"
	"strings"
	"time"
)

type Playlist struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	TrackCount int    `json:"trackCount"`
	CoverPath  string `json:"coverPath"`
}

func CreatePlaylist(name string) (int64, error) {
	if libDB == nil {
		return 0, fmt.Errorf("library not initialized")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "New Playlist"
	}
	r, err := libDB.Exec("INSERT INTO playlists(name, created_at) VALUES(?, ?)", name, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func GetPlaylists() ([]Playlist, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	rows, err := libDB.Query(`SELECT p.id, p.name,
		(SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id=p.id),
		(SELECT t.path FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=p.id ORDER BY pt.position LIMIT 1)
		FROM playlists p ORDER BY p.name COLLATE NOCASE ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Playlist{}
	for rows.Next() {
		var p Playlist
		var cover *string
		if err := rows.Scan(&p.ID, &p.Name, &p.TrackCount, &cover); err != nil {
			return nil, err
		}
		if cover != nil {
			p.CoverPath = *cover
		}
		out = append(out, p)
	}
	return out, nil
}

func RenamePlaylist(id int64, name string) error {
	if libDB == nil {
		return fmt.Errorf("library not initialized")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("name required")
	}
	_, err := libDB.Exec("UPDATE playlists SET name=? WHERE id=?", name, id)
	return err
}

func DeletePlaylist(id int64) error {
	if libDB == nil {
		return fmt.Errorf("library not initialized")
	}
	libDB.Exec("DELETE FROM playlist_tracks WHERE playlist_id=?", id)
	_, err := libDB.Exec("DELETE FROM playlists WHERE id=?", id)
	return err
}

// AddTracksToPlaylist appends tracks (de-duplicated against what's already there).
func AddTracksToPlaylist(id int64, trackIDs []int64) (int, error) {
	if libDB == nil {
		return 0, fmt.Errorf("library not initialized")
	}
	var pos int
	libDB.QueryRow("SELECT COALESCE(MAX(position),-1)+1 FROM playlist_tracks WHERE playlist_id=?", id).Scan(&pos)
	existing := map[int64]bool{}
	rows, _ := libDB.Query("SELECT track_id FROM playlist_tracks WHERE playlist_id=?", id)
	if rows != nil {
		for rows.Next() {
			var tid int64
			if rows.Scan(&tid) == nil {
				existing[tid] = true
			}
		}
		rows.Close()
	}
	added := 0
	for _, tid := range trackIDs {
		if existing[tid] {
			continue
		}
		if _, err := libDB.Exec("INSERT INTO playlist_tracks(playlist_id, track_id, position) VALUES(?,?,?)", id, tid, pos); err == nil {
			existing[tid] = true
			pos++
			added++
		}
	}
	return added, nil
}

func RemoveTrackFromPlaylist(id, trackID int64) error {
	if libDB == nil {
		return fmt.Errorf("library not initialized")
	}
	_, err := libDB.Exec("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?", id, trackID)
	return err
}

func GetPlaylistTracks(id int64) ([]LibraryTrack, error) {
	if libDB == nil {
		return nil, fmt.Errorf("library not initialized")
	}
	rows, err := libDB.Query("SELECT "+trackCols+` FROM tracks
		WHERE id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id=?)
		ORDER BY (SELECT position FROM playlist_tracks WHERE playlist_id=? AND track_id=tracks.id)`, id, id)
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
