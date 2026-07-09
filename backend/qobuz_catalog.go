package backend

// Qobuz catalog browsing: a fallback discography source for artists whose
// Spotify catalog is missing or sparse (e.g. artists who pulled their music
// from Spotify). Produces the same ArtistDiscographyPayload the Spotify path
// does, with track IDs in the existing "qobuz_<id>" convention so the queue
// downloads them without a Spotify ID.

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type qobuzImage struct {
	Large  string `json:"large"`
	Small  string `json:"small"`
	Erimax string `json:"extralarge"`
}

type qobuzArtistBrief struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	AlbumsCount int        `json:"albums_count"`
	Image       *qobuzImage `json:"image"`
	Picture     string     `json:"picture"`
}

type qobuzArtistSearchResponse struct {
	Artists struct {
		Items []qobuzArtistBrief `json:"items"`
		Total int                `json:"total"`
	} `json:"artists"`
}

type qobuzCatalogTrack struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	Version     string `json:"version"`
	ISRC        string `json:"isrc"`
	Duration    int    `json:"duration"`
	TrackNumber int    `json:"track_number"`
	MediaNumber int    `json:"media_number"`
	Copyright   string `json:"copyright"`
	Performer   struct {
		Name string `json:"name"`
	} `json:"performer"`
}

type qobuzCatalogAlbum struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Version     string `json:"version"`
	ReleaseType string `json:"release_type"`
	Artist      struct {
		Name string `json:"name"`
	} `json:"artist"`
	ReleaseDateOriginal string      `json:"release_date_original"`
	TracksCount         int         `json:"tracks_count"`
	MediaCount          int         `json:"media_count"`
	Image               *qobuzImage `json:"image"`
	UPC                 string      `json:"upc"`
	Label               struct {
		Name string `json:"name"`
	} `json:"label"`
	ParentalWarning bool `json:"parental_warning"`
	Tracks          struct {
		Items []qobuzCatalogTrack `json:"items"`
	} `json:"tracks"`
}

type qobuzArtistGetResponse struct {
	ID     int64       `json:"id"`
	Name   string      `json:"name"`
	Image  *qobuzImage `json:"image"`
	Albums struct {
		Items []qobuzCatalogAlbum `json:"items"`
		Total int                 `json:"total"`
	} `json:"albums"`
}

func qobuzImageURL(img *qobuzImage, fallback string) string {
	if img == nil {
		return fallback
	}
	if img.Large != "" {
		return img.Large
	}
	if img.Erimax != "" {
		return img.Erimax
	}
	if img.Small != "" {
		return img.Small
	}
	return fallback
}

func qobuzTitleWithVersion(title, version string) string {
	version = strings.TrimSpace(version)
	// Qobuz sometimes repeats the title (or part of it) as the version.
	if version == "" || strings.Contains(normalizeMatch(title), normalizeMatch(version)) {
		return title
	}
	return fmt.Sprintf("%s (%s)", title, version)
}

func qobuzReleaseType(a qobuzCatalogAlbum) string {
	switch strings.ToLower(strings.TrimSpace(a.ReleaseType)) {
	case "single":
		return "single"
	case "ep", "epmini":
		return "ep"
	case "compilation", "anthology", "bestof":
		return "compilation"
	case "album", "":
		if a.ReleaseType == "" && a.TracksCount <= 3 {
			return "single"
		}
		return "album"
	default:
		return strings.ToLower(strings.TrimSpace(a.ReleaseType))
	}
}

// QobuzArtistHit is a search result for the download page's Qobuz mode.
type QobuzArtistHit struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	AlbumsCount int    `json:"albumsCount"`
	Image       string `json:"image"`
}

// SearchQobuzArtists finds artists in Qobuz's catalog — the entry point for
// artists who have no Spotify presence at all.
func SearchQobuzArtists(query string) ([]QobuzArtistHit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []QobuzArtistHit{}, nil
	}
	var search qobuzArtistSearchResponse
	if err := doQobuzSignedJSONRequest("artist/search", url.Values{
		"query": {query}, "limit": {"8"},
	}, &search); err != nil {
		return nil, fmt.Errorf("qobuz artist search: %w", err)
	}
	out := make([]QobuzArtistHit, 0, len(search.Artists.Items))
	for _, a := range search.Artists.Items {
		out = append(out, QobuzArtistHit{
			ID:          a.ID,
			Name:        a.Name,
			AlbumsCount: a.AlbumsCount,
			Image:       qobuzImageURL(a.Image, a.Picture),
		})
	}
	return out, nil
}

// GetQobuzArtistDiscography searches Qobuz for the artist and assembles their
// full discography (albums + every track) as an ArtistDiscographyPayload.
func GetQobuzArtistDiscography(name string) (*ArtistDiscographyPayload, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("empty artist name")
	}

	var search qobuzArtistSearchResponse
	if err := doQobuzSignedJSONRequest("artist/search", url.Values{
		"query": {name}, "limit": {"10"},
	}, &search); err != nil {
		return nil, fmt.Errorf("qobuz artist search: %w", err)
	}
	if len(search.Artists.Items) == 0 {
		return nil, fmt.Errorf("no Qobuz artist found for %q", name)
	}
	// Prefer an exact (normalized) name match; fall back to the top result.
	best := search.Artists.Items[0]
	want := normalizeMatch(name)
	for _, a := range search.Artists.Items {
		if normalizeMatch(a.Name) == want {
			best = a
			break
		}
	}

	// Page through the artist's albums (main-artist releases).
	albums := []qobuzCatalogAlbum{}
	artistImage := ""
	offset := 0
	for {
		var got qobuzArtistGetResponse
		if err := doQobuzSignedJSONRequest("artist/get", url.Values{
			"artist_id": {strconv.FormatInt(best.ID, 10)},
			"extra":     {"albums"},
			"limit":     {"100"},
			"offset":    {strconv.Itoa(offset)},
		}, &got); err != nil {
			return nil, fmt.Errorf("qobuz artist albums: %w", err)
		}
		if artistImage == "" {
			artistImage = qobuzImageURL(got.Image, best.Picture)
		}
		albums = append(albums, got.Albums.Items...)
		offset += len(got.Albums.Items)
		if len(got.Albums.Items) == 0 || offset >= got.Albums.Total || offset >= 500 {
			break
		}
	}
	if len(albums) == 0 {
		return nil, fmt.Errorf("Qobuz lists no releases for %q", best.Name)
	}

	sort.SliceStable(albums, func(i, j int) bool {
		return albums[i].ReleaseDateOriginal > albums[j].ReleaseDateOriginal
	})

	// Fetch every album's tracks with modest concurrency.
	type albumTracks struct {
		idx    int
		tracks []qobuzCatalogTrack
	}
	results := make([]albumTracks, len(albums))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i := range albums {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			var full qobuzCatalogAlbum
			if err := doQobuzSignedJSONRequest("album/get", url.Values{
				"album_id": {albums[idx].ID},
			}, &full); err != nil {
				Dbgf("qobuz album/get %s failed: %v\n", albums[idx].ID, err)
				results[idx] = albumTracks{idx: idx}
				return
			}
			results[idx] = albumTracks{idx: idx, tracks: full.Tracks.Items}
		}(i)
	}
	wg.Wait()

	payload := &ArtistDiscographyPayload{
		ArtistInfo: ArtistInfoMetadata{
			Name:            best.Name,
			Genres:          []string{}, // nil marshals to null and crashes genres.length
			Images:          artistImage,
			ExternalURL:     fmt.Sprintf("https://open.qobuz.com/artist/%d", best.ID),
			DiscographyType: "qobuz",
			TotalAlbums:     len(albums),
		},
		AlbumList: make([]DiscographyAlbumMetadata, 0, len(albums)),
		TrackList: []AlbumTrackMetadata{},
	}

	for i, a := range albums {
		albumName := qobuzTitleWithVersion(a.Title, a.Version)
		albumArtist := a.Artist.Name
		if albumArtist == "" {
			albumArtist = best.Name
		}
		cover := qobuzImageURL(a.Image, "")
		payload.AlbumList = append(payload.AlbumList, DiscographyAlbumMetadata{
			ID:          "qobuz_album_" + a.ID,
			Name:        albumName,
			AlbumType:   qobuzReleaseType(a),
			ReleaseDate: a.ReleaseDateOriginal,
			TotalTracks: a.TracksCount,
			Artists:     albumArtist,
			Images:      cover,
			ExternalURL: "https://open.qobuz.com/album/" + a.ID,
			IsExplicit:  a.ParentalWarning,
		})

		for _, tr := range results[i].tracks {
			artist := tr.Performer.Name
			if artist == "" {
				artist = albumArtist
			}
			payload.TrackList = append(payload.TrackList, AlbumTrackMetadata{
				SpotifyID:   fmt.Sprintf("qobuz_%d", tr.ID),
				Artists:     artist,
				Name:        qobuzTitleWithVersion(tr.Title, tr.Version),
				AlbumName:   albumName,
				AlbumArtist: albumArtist,
				AlbumType:   qobuzReleaseType(a),
				DurationMS:  tr.Duration * 1000,
				Images:      cover,
				ReleaseDate: a.ReleaseDateOriginal,
				TrackNumber: tr.TrackNumber,
				TotalTracks: a.TracksCount,
				DiscNumber:  tr.MediaNumber,
				TotalDiscs:  a.MediaCount,
				UPC:         a.UPC,
				ExternalURL: fmt.Sprintf("https://open.qobuz.com/track/%d", tr.ID),
				AlbumID:     "qobuz_album_" + a.ID,
				AlbumURL:    "https://open.qobuz.com/album/" + a.ID,
				IsExplicit:  a.ParentalWarning,
			})
		}
	}

	return payload, nil
}
