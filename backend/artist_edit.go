package backend

// Artist-level metadata editing. An "artist" isn't a file — it's every track that
// credits the name — so editing means rewriting tags across all those tracks.
// Renaming does a targeted replace within the ARTIST/ALBUMARTIST tags so other
// co-artists on a track are preserved (e.g. renaming "zebrahead" → "Zebrahead"
// on a "zebrahead; Guest" track yields "Zebrahead; Guest").

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"go.senan.xyz/taglib"
	"golang.org/x/text/unicode/norm"
)

// --- Plex-style field locks --------------------------------------------------
// When the user manually edits an artist's photo/banner/bio, that field is
// locked so Spotify enrichment never overwrites or refills it — even if the
// user cleared it on purpose.

func artistLockedFields(name string) map[string]bool {
	out := map[string]bool{}
	if libDB == nil {
		return out
	}
	var raw string
	libDB.QueryRow("SELECT COALESCE(locked,'') FROM artist_art WHERE name=?", name).Scan(&raw)
	for _, f := range strings.Split(raw, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out[f] = true
		}
	}
	return out
}

func LockArtistFields(name string, fields []string) error {
	if libDB == nil || len(fields) == 0 {
		return nil
	}
	cur := artistLockedFields(name)
	for _, f := range fields {
		if f = strings.TrimSpace(f); f != "" {
			cur[f] = true
		}
	}
	keys := make([]string, 0, len(cur))
	for k := range cur {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	_, err := libDB.Exec(
		"INSERT INTO artist_art(name, path, locked, updated_at) VALUES(?,'',?,?) ON CONFLICT(name) DO UPDATE SET locked=excluded.locked, updated_at=excluded.updated_at",
		name, strings.Join(keys, ","), time.Now().Unix())
	return err
}

func UnlockArtistFields(name string) error {
	if libDB == nil {
		return nil
	}
	_, err := libDB.Exec("UPDATE artist_art SET locked='' WHERE name=?", name)
	return err
}

func GetArtistLocks(name string) ([]string, error) {
	m := artistLockedFields(name)
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

type ArtistMeta struct {
	Name       string `json:"name"`
	Genre      string `json:"genre"`
	GenreMixed bool   `json:"genreMixed"`
	TrackCount int    `json:"trackCount"`
	Bio        string `json:"bio"`
}

func artistTrackPaths(name string) []string {
	if libDB == nil {
		return nil
	}
	rows, err := libDB.Query(`SELECT DISTINCT t.path FROM tracks t
		LEFT JOIN track_artists ta ON ta.track_id=t.id
		WHERE ta.name=? OR t.album_artist=?`, name, name)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			out = append(out, p)
		}
	}
	return out
}

func GetArtistMeta(name string) (ArtistMeta, error) {
	out := ArtistMeta{Name: name}
	if libDB == nil {
		return out, nil
	}
	rows, err := libDB.Query(`SELECT DISTINCT COALESCE(t.genre,'') FROM tracks t
		LEFT JOIN track_artists ta ON ta.track_id=t.id
		WHERE ta.name=? OR t.album_artist=?`, name, name)
	if err != nil {
		return out, err
	}
	genres := map[string]bool{}
	for rows.Next() {
		var g string
		if rows.Scan(&g) == nil {
			genres[g] = true
		}
	}
	rows.Close()
	libDB.QueryRow(`SELECT COUNT(DISTINCT t.id) FROM tracks t
		LEFT JOIN track_artists ta ON ta.track_id=t.id
		WHERE ta.name=? OR t.album_artist=?`, name, name).Scan(&out.TrackCount)
	switch len(genres) {
	case 1:
		for g := range genres {
			out.Genre = g
		}
	default:
		if len(genres) > 1 {
			out.GenreMixed = true
		}
	}
	libDB.QueryRow("SELECT COALESCE(bio,'') FROM artist_art WHERE name=?", name).Scan(&out.Bio)
	return out, nil
}

// renameArtistInList replaces exact (case-insensitive) occurrences of oldName
// with newName inside a list of artist tag values, splitting joined values on
// ";" so co-artists are kept.
func renameArtistInList(vals []string, oldName, newName string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		parts := strings.Split(v, ";")
		for i, p := range parts {
			tp := strings.TrimSpace(p)
			if strings.EqualFold(tp, oldName) {
				parts[i] = newName
			} else {
				parts[i] = tp
			}
		}
		out = append(out, strings.Join(parts, "; "))
	}
	return out
}

func WriteArtistMetadata(oldName, newName, genre string, fields []string) (int, error) {
	if libDB == nil {
		return 0, nil
	}
	want := map[string]bool{}
	for _, f := range fields {
		want[f] = true
	}
	newName = strings.TrimSpace(newName)
	doRename := want["name"] && newName != "" && !strings.EqualFold(newName, oldName)

	paths := artistTrackPaths(oldName)
	count := 0
	for _, p := range paths {
		np := norm.NFC.String(p)
		tags, err := taglib.ReadTags(np)
		if err != nil {
			continue
		}
		changes := map[string][]string{}
		if doRename {
			if arts := tags[taglib.Artist]; len(arts) > 0 {
				changes[taglib.Artist] = renameArtistInList(arts, oldName, newName)
			}
			if aa := tags[taglib.AlbumArtist]; len(aa) > 0 {
				changes[taglib.AlbumArtist] = renameArtistInList(aa, oldName, newName)
			}
		}
		if want["genre"] {
			setMapStr(changes, taglib.Genre, genre)
		}
		if len(changes) == 0 {
			continue
		}
		if taglib.WriteTags(np, changes, 0) == nil {
			ReindexFile(p)
			count++
		}
	}
	if doRename {
		renameArtistArt(oldName, newName)
	}
	return count, nil
}

// --- Artist photos -----------------------------------------------------------
// Audio files have no standard artist-image tag, so artist photos are stored
// app-side in <appdir>/artist_art and recorded in the artist_art table, keyed
// by the artist name. SetArtistImage also moves the record when an artist is
// renamed via WriteArtistMetadata (see renameArtistArt).

var (
	artistArtCache = map[string]string{}
	artistArtMu    sync.Mutex
)

func artistArtDir() (string, error) {
	dir, err := EnsureAppDir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(dir, "artist_art")
	if err := os.MkdirAll(d, 0o755); err != nil {
		return "", err
	}
	return d, nil
}

func artistArtFile(key, ext string) (string, error) {
	d, err := artistArtDir()
	if err != nil {
		return "", err
	}
	h := sha1.Sum([]byte(key))
	return filepath.Join(d, hex.EncodeToString(h[:])+ext), nil
}

// storeArtistImageFile loads an image (path/URL), normalises it, writes it under
// artist_art keyed by `key`, and returns the destination path + ".jpg"/".png".
func storeArtistImageFile(key, source string) (string, error) {
	raw, err := loadImageBytes(source)
	if err != nil {
		return "", err
	}
	data, mime, err := toEmbeddable(raw)
	if err != nil {
		return "", err
	}
	ext := ".jpg"
	if mime == "image/png" {
		ext = ".png"
	}
	dst, err := artistArtFile(key, ext)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return "", err
	}
	return dst, nil
}

func artistImageDataURL(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return ""
	}
	mime := "image/jpeg"
	if strings.HasSuffix(strings.ToLower(path), ".png") {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

// SetArtistImage stores an image (local path or URL) as the artist's photo.
func SetArtistImage(name, source string) error {
	dst, err := storeArtistImageFile(name, source)
	if err != nil {
		return err
	}
	if libDB != nil {
		libDB.Exec("INSERT INTO artist_art(name, path, updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path, updated_at=excluded.updated_at",
			name, dst, time.Now().Unix())
	}
	artistArtMu.Lock()
	delete(artistArtCache, name)
	artistArtMu.Unlock()
	return nil
}

// SetArtistBanner stores a landscape background image for the artist page.
func SetArtistBanner(name, source string) error {
	dst, err := storeArtistImageFile(name+"::banner", source)
	if err != nil {
		return err
	}
	if libDB != nil {
		libDB.Exec("INSERT INTO artist_art(name, path, banner, updated_at) VALUES(?,'',?,?) ON CONFLICT(name) DO UPDATE SET banner=excluded.banner, updated_at=excluded.updated_at",
			name, dst, time.Now().Unix())
	}
	artistArtMu.Lock()
	delete(artistArtCache, name+"::banner")
	artistArtMu.Unlock()
	return nil
}

// SetArtistBio stores a free-text biography for the artist.
func SetArtistBio(name, bio string) error {
	if libDB == nil {
		return nil
	}
	_, err := libDB.Exec("INSERT INTO artist_art(name, path, bio, updated_at) VALUES(?,'',?,?) ON CONFLICT(name) DO UPDATE SET bio=excluded.bio, updated_at=excluded.updated_at",
		name, bio, time.Now().Unix())
	return err
}

// GetArtistImage returns a data URL for the artist's photo, or "" if none set.
func GetArtistImage(name string) (string, error) {
	return cachedArtistImage(name, "path")
}

// GetArtistBanner returns a data URL for the artist's background banner, or "".
func GetArtistBanner(name string) (string, error) {
	return cachedArtistImage(name+"::banner", "banner")
}

// cachedArtistImage reads either the photo (`path`) or `banner` column for an
// artist, returns a cached data URL. cacheKey distinguishes the two in the cache.
func cachedArtistImage(cacheKey, column string) (string, error) {
	artistArtMu.Lock()
	if v, ok := artistArtCache[cacheKey]; ok {
		artistArtMu.Unlock()
		return v, nil
	}
	artistArtMu.Unlock()

	name := strings.TrimSuffix(cacheKey, "::banner")
	url := ""
	if libDB != nil {
		var p string
		if libDB.QueryRow("SELECT COALESCE("+column+",'') FROM artist_art WHERE name=?", name).Scan(&p) == nil {
			url = artistImageDataURL(p)
		}
	}
	artistArtMu.Lock()
	artistArtCache[cacheKey] = url
	artistArtMu.Unlock()
	return url, nil
}

// renameArtistArt moves an artist-photo record when the artist is renamed.
func renameArtistArt(oldName, newName string) {
	if libDB == nil || strings.EqualFold(oldName, newName) {
		return
	}
	libDB.Exec("UPDATE OR REPLACE artist_art SET name=? WHERE name=?", newName, oldName)
	artistArtMu.Lock()
	for _, k := range []string{oldName, newName, oldName + "::banner", newName + "::banner"} {
		delete(artistArtCache, k)
	}
	artistArtMu.Unlock()
}
