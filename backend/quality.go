package backend

// Best-available source quality for a Spotify track, shown on fetch/search cards.
// Qobuz exposes exact max bit-depth/sample-rate cheaply (via the ISRC search), so
// it's the primary signal. If Qobuz has nothing, we fall back to reporting which
// other source carries the track (lossless tier) without an exact figure — fetching
// Tidal's exact bit/sample would require a full playback-manifest call per track.

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"
)

type TrackQuality struct {
	Source     string  `json:"source"`     // "Qobuz" / "Tidal" / "Amazon" / ""
	BitDepth   int     `json:"bitDepth"`   // 0 if unknown
	SampleRate float64 `json:"sampleRate"` // kHz, 0 if unknown
	Label      string  `json:"label"`      // e.g. "24-bit/96 kHz" or "Lossless"
	HiRes      bool    `json:"hiRes"`
	Found      bool    `json:"found"`
}

// QualityRequest pairs a Spotify track id with its ISRC (if already known, to skip
// the extra Spotify lookup).
type QualityRequest struct {
	SpotifyID string `json:"spotifyId"`
	ISRC      string `json:"isrc"`
}

func qualityLabel(bit int, sr float64) string {
	switch {
	case bit > 0 && sr > 0:
		return fmt.Sprintf("%d-bit/%g kHz", bit, sr)
	case bit > 0:
		return fmt.Sprintf("%d-bit", bit)
	default:
		return "Lossless"
	}
}

// Probe results are cached: the download page probes every visible track to
// render its badge, and the queue re-probes the same track minutes later to
// pick the download source — one lookup should serve both. Misses re-check
// sooner in case a source was only momentarily unavailable.
type qualityCacheEntry struct {
	q  TrackQuality
	at time.Time
}

var qualityCache sync.Map // spotify id -> qualityCacheEntry

func bestQualityFor(spotifyID, isrc string) TrackQuality {
	key := strings.TrimSpace(spotifyID)
	if key != "" {
		if v, ok := qualityCache.Load(key); ok {
			e := v.(qualityCacheEntry)
			ttl := 30 * time.Minute
			if !e.q.Found {
				ttl = 5 * time.Minute
			}
			if time.Since(e.at) < ttl {
				return e.q
			}
		}
	}
	out := bestQualityForUncached(spotifyID, isrc)
	if key != "" {
		qualityCache.Store(key, qualityCacheEntry{q: out, at: time.Now()})
	}
	return out
}

func bestQualityForUncached(spotifyID, isrc string) TrackQuality {
	var out TrackQuality
	isrc = strings.TrimSpace(isrc)
	if isrc == "" && strings.TrimSpace(spotifyID) != "" {
		isrc = ResolveTrackISRC(spotifyID)
	}
	if isrc != "" {
		qd := NewQobuzDownloader()
		if tr, err := qd.searchByISRC(isrc, "", "", ""); err == nil && tr != nil && tr.MaximumBitDepth > 0 {
			out.Source = "Qobuz"
			out.BitDepth = tr.MaximumBitDepth
			out.SampleRate = tr.MaximumSamplingRate
			out.HiRes = tr.Hires || tr.HiresStreamable || tr.MaximumBitDepth >= 24 || tr.MaximumSamplingRate > 48
			out.Label = qualityLabel(tr.MaximumBitDepth, tr.MaximumSamplingRate)
			out.Found = true
			return out
		}
	}
	// No Qobuz hit — report which other source carries it (lossless tier).
	if strings.TrimSpace(spotifyID) != "" {
		sl := NewSongLinkClient()
		if av, _ := sl.CheckTrackAvailability(spotifyID); av != nil {
			switch {
			case av.Tidal:
				out.Source = "Tidal"
			case av.Amazon:
				out.Source = "Amazon"
			case av.Qobuz:
				out.Source = "Qobuz"
			}
			if out.Source != "" {
				out.Found = true
				out.Label = "Lossless"
			}
		}
	}
	return out
}

// GetBestTrackQuality returns the best quality found across sources for a track.
func GetBestTrackQuality(spotifyID string) (TrackQuality, error) {
	return bestQualityFor(spotifyID, ""), nil
}

// --- Album-level quality (for discography cards, where per-track data isn't loaded) ---

type qobuzAlbumSearchResult struct {
	Albums struct {
		Items []struct {
			Title               string  `json:"title"`
			MaximumBitDepth     int     `json:"maximum_bit_depth"`
			MaximumSamplingRate float64 `json:"maximum_sampling_rate"`
			Hires               bool    `json:"hires"`
			HiresStreamable     bool    `json:"hires_streamable"`
			Artist              struct {
				Name string `json:"name"`
			} `json:"artist"`
		} `json:"items"`
	} `json:"albums"`
}

// GetBestAlbumQualityByID resolves an album's quality from one real track on
// that specific Spotify album (ISRC-exact), so a deluxe/expanded edition reports
// its own quality rather than the base album's. Falls back to a title match.
func GetBestAlbumQualityByID(spotifyAlbumID string) (TrackQuality, error) {
	if strings.TrimSpace(spotifyAlbumID) == "" {
		return TrackQuality{}, nil
	}
	smc := NewSpotifyMetadataClient()
	album, err := smc.fetchAlbum(context.Background(), spotifyAlbumID, nil)
	if err != nil || album == nil || len(album.Tracks) == 0 {
		return TrackQuality{}, nil
	}
	// Probe the first couple of tracks (an album's tracks share quality).
	for i := 0; i < len(album.Tracks) && i < 2; i++ {
		if id := strings.TrimSpace(album.Tracks[i].ID); id != "" {
			if q := bestQualityFor(id, ""); q.Found {
				return q, nil
			}
		}
	}
	return bestAlbumQuality(album.Name, album.Artists), nil
}

// GetBestAlbumQualitiesByID resolves album quality for many Spotify album ids
// concurrently (each does a fetch + ISRC probe, so the pool is small).
func GetBestAlbumQualitiesByID(albumIDs []string) (map[string]TrackQuality, error) {
	out := make(map[string]TrackQuality, len(albumIDs))
	if len(albumIDs) == 0 {
		return out, nil
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, id := range albumIDs {
		if strings.TrimSpace(id) == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(albumID string) {
			defer wg.Done()
			defer func() { <-sem }()
			q, _ := GetBestAlbumQualityByID(albumID)
			mu.Lock()
			out[albumID] = q
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out, nil
}

// albumBaseName strips edition/qualifier suffixes so a "California (Deluxe
// Edition)" / "One More Time... Part Of The..." still matches Qobuz.
func albumBaseName(s string) string {
	if i := strings.Index(s, "..."); i > 0 {
		s = s[:i]
	}
	if i := strings.IndexAny(s, "([{"); i > 0 {
		s = s[:i]
	}
	if i := strings.Index(s, " - "); i > 0 {
		s = s[:i]
	}
	return strings.TrimSpace(strings.Trim(s, "-. "))
}

func bestAlbumQuality(albumName, artistName string) TrackQuality {
	artist := strings.TrimSpace(artistName)
	name := strings.TrimSpace(albumName)
	if name == "" && artist == "" {
		return TrackQuality{}
	}
	base := albumBaseName(name)
	// Try the full name first, then progressively looser queries.
	var queries []string
	seen := map[string]bool{}
	add := func(q string) {
		q = strings.TrimSpace(q)
		if q != "" && !seen[q] {
			seen[q] = true
			queries = append(queries, q)
		}
	}
	add(artist + " " + name)
	if base != name {
		add(artist + " " + base)
		add(base)
	}
	add(name)

	for _, q := range queries {
		if r := qobuzAlbumSearchOnce(q, name, artist); r.Found {
			return r
		}
	}
	return TrackQuality{}
}

func qobuzAlbumSearchOnce(query, albumName, artistName string) TrackQuality {
	var out TrackQuality
	var resp qobuzAlbumSearchResult
	if err := doQobuzSignedJSONRequest("album/search", url.Values{"query": {query}, "limit": {"10"}}, &resp); err != nil {
		return out
	}
	if len(resp.Albums.Items) == 0 {
		return out
	}
	an := strings.ToLower(strings.TrimSpace(albumName))
	anBase := strings.ToLower(albumBaseName(albumName))
	arn := strings.ToLower(strings.TrimSpace(artistName))
	bestIdx, bestScore, bestBit, bestSr := -1, -1, 0, 0.0
	for i, a := range resp.Albums.Items {
		score := 0
		at := strings.ToLower(a.Title)
		switch {
		case at == an:
			score += 100
		case strings.Contains(at, an) || strings.Contains(an, at):
			score += 60
		case anBase != "" && (strings.Contains(at, anBase) || strings.Contains(anBase, at)):
			score += 40
		}
		if arn != "" && strings.Contains(strings.ToLower(a.Artist.Name), arn) {
			score += 25
		}
		// Same title match → prefer the highest-quality pressing ("best available").
		better := score > bestScore ||
			(score == bestScore && (a.MaximumBitDepth > bestBit ||
				(a.MaximumBitDepth == bestBit && a.MaximumSamplingRate > bestSr)))
		if bestIdx == -1 || better {
			bestIdx, bestScore, bestBit, bestSr = i, score, a.MaximumBitDepth, a.MaximumSamplingRate
		}
	}
	a := resp.Albums.Items[bestIdx]
	if a.MaximumBitDepth > 0 {
		out.Source = "Qobuz"
		out.BitDepth = a.MaximumBitDepth
		out.SampleRate = a.MaximumSamplingRate
		out.HiRes = a.Hires || a.HiresStreamable || a.MaximumBitDepth >= 24 || a.MaximumSamplingRate > 48
		out.Label = qualityLabel(a.MaximumBitDepth, a.MaximumSamplingRate)
		out.Found = true
	}
	return out
}

// GetBestTrackQualities resolves quality for many tracks concurrently, keyed by
// Spotify id.
func GetBestTrackQualities(reqs []QualityRequest) (map[string]TrackQuality, error) {
	out := make(map[string]TrackQuality, len(reqs))
	if len(reqs) == 0 {
		return out, nil
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, r := range reqs {
		if strings.TrimSpace(r.SpotifyID) == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(req QualityRequest) {
			defer wg.Done()
			defer func() { <-sem }()
			q := bestQualityFor(req.SpotifyID, req.ISRC)
			mu.Lock()
			out[req.SpotifyID] = q
			mu.Unlock()
		}(r)
	}
	wg.Wait()
	return out, nil
}
