package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"kazoo/backend"
)

// The download queue runner: a single backend worker that consumes queued
// items one at a time. The frontend only enqueues (and renders queue state) —
// closing the app mid-batch is safe, and restarts resume automatically.

type runnerSettings struct {
	downloader              string
	autoOrder               []string
	downloadPath            string
	folderTemplate          string
	filenameTemplate        string
	albumFilenameTemplate   string
	useSeparateAlbumFile    bool
	applyFolderToSingle     bool
	trackNumber             bool
	useFirstArtistOnly      bool
	useSingleGenre          bool
	embedGenre              bool
	embedLyrics             bool
	embedMaxQualityCover    bool
	saveCover               bool
	autoDownloadLyrics      bool
	customTidalAPI          string
	customQobuzAPI          string
}

func settingsString(m map[string]interface{}, key, def string) string {
	if v, ok := m[key].(string); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return def
}

func settingsBool(m map[string]interface{}, key string, def bool) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return def
}

func sanitizeOrder(order string) []string {
	allowed := map[string]bool{"tidal": true, "qobuz": true, "amazon": true}
	seen := map[string]bool{}
	out := []string{}
	for _, p := range strings.Split(strings.ToLower(order), "-") {
		p = strings.TrimSpace(p)
		if allowed[p] && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{"tidal", "qobuz", "amazon"}
	}
	return out
}

func (a *App) loadRunnerSettings() runnerSettings {
	m, err := a.LoadSettings()
	if err != nil || m == nil {
		m = map[string]interface{}{}
	}
	rs := runnerSettings{
		downloader:            settingsString(m, "downloader", "auto"),
		autoOrder:             sanitizeOrder(settingsString(m, "autoOrder", "tidal-qobuz-amazon")),
		downloadPath:          settingsString(m, "downloadPath", ""),
		folderTemplate:        settingsString(m, "folderTemplate", ""),
		filenameTemplate:      settingsString(m, "filenameTemplate", "{title}"),
		albumFilenameTemplate: settingsString(m, "albumFilenameTemplate", ""),
		useSeparateAlbumFile:  settingsBool(m, "useSeparateAlbumFilename", false),
		applyFolderToSingle:   settingsBool(m, "applyFolderToSingleTrack", false),
		trackNumber:           settingsBool(m, "trackNumber", false),
		useFirstArtistOnly:    settingsBool(m, "useFirstArtistOnly", false),
		useSingleGenre:        settingsBool(m, "useSingleGenre", false),
		embedGenre:            settingsBool(m, "embedGenre", false),
		embedLyrics:           settingsBool(m, "embedLyrics", false),
		embedMaxQualityCover:  settingsBool(m, "embedMaxQualityCover", false),
		saveCover:             settingsBool(m, "saveCover", false),
		autoDownloadLyrics:    settingsBool(m, "autoDownloadLyrics", true),
	}
	if v := settingsString(m, "customTidalApi", ""); strings.HasPrefix(strings.TrimSpace(v), "https://") {
		rs.customTidalAPI = strings.TrimRight(strings.TrimSpace(v), "/")
	}
	if v := settingsString(m, "customQobuzApi", ""); strings.HasPrefix(strings.TrimSpace(v), "https://") {
		rs.customQobuzAPI = strings.TrimRight(strings.TrimSpace(v), "/")
	}
	return rs
}

func firstArtist(artists string) string {
	for _, sep := range []string{";", ","} {
		if i := strings.Index(artists, sep); i >= 0 {
			return strings.TrimSpace(artists[:i])
		}
	}
	return strings.TrimSpace(artists)
}

func categoryLabel(albumType string) string {
	switch strings.ToLower(strings.TrimSpace(albumType)) {
	case "single":
		return "Singles"
	case "compilation":
		return "Compilations"
	case "ep":
		return "EPs"
	default:
		return "Albums"
	}
}

// renderFolderTemplate ports the frontend template: {artist} {artists} {album}
// {album_artist} {title} {isrc} {track} {total_tracks} {total_discs} {year}
// {date} {playlist}. Slashes inside values become spaces; each rendered
// segment is sanitized for the filesystem.
func renderFolderTemplate(tpl string, values map[string]string) []string {
	if strings.TrimSpace(tpl) == "" {
		return nil
	}
	out := tpl
	for k, v := range values {
		out = strings.ReplaceAll(out, "{"+k+"}", strings.ReplaceAll(v, "/", " "))
	}
	segs := []string{}
	for _, part := range strings.Split(out, "/") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		segs = append(segs, backend.SanitizeFilename(part))
	}
	return segs
}

func isCooldownError(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "short break") || strings.Contains(lower, "scheduled") || strings.Contains(lower, "cooldown")
}

// ensureCooldownClock guarantees the shared cooldown timer is running when a
// source reported a break only via its error text — otherwise the runner
// would requeue and re-attempt the same item in a hot loop.
func ensureCooldownClock(msg string) {
	if backend.CooldownRemainingSecs() > 0 {
		return
	}
	secs := 300
	lower := strings.ToLower(msg)
	if m := regexp.MustCompile(`(\d+)\s*minute`).FindStringSubmatch(lower); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			secs = n*60 + 15
		}
	} else if m := regexp.MustCompile(`(\d+)\s*second`).FindStringSubmatch(lower); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			secs = n + 15
		}
	}
	if secs > 5400 {
		secs = 5400
	}
	backend.SetCommunityCooldown(float64(secs), msg)
}

// backfillItemMetadata fills gaps from a single-track Spotify fetch so the
// folder template and tags always have album artist / release date / number.
func (a *App) backfillItemMetadata(item *backend.DownloadItem) {
	if item.SpotifyID == "" {
		return
	}
	if item.ReleaseDate != "" && item.TrackNo > 0 && item.AlbumArtist != "" && item.Category != "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	data, err := backend.GetFilteredSpotifyData(ctx, "https://open.spotify.com/track/"+item.SpotifyID, false, 0, ", ", nil)
	if err != nil {
		return
	}
	var resp struct {
		Track struct {
			AlbumName   string `json:"album_name"`
			AlbumArtist string `json:"album_artist"`
			AlbumType   string `json:"album_type"`
			ReleaseDate string `json:"release_date"`
			TrackNumber int    `json:"track_number"`
			DiscNumber  int    `json:"disc_number"`
			TotalTracks int    `json:"total_tracks"`
			TotalDiscs  int    `json:"total_discs"`
			Images      string `json:"images"`
			UPC         string `json:"upc"`
			Copyright   string `json:"copyright"`
			Publisher   string `json:"publisher"`
			Artists     string `json:"artists"`
			DurationMs  int    `json:"duration_ms"`
		} `json:"track"`
	}
	raw, err := json.Marshal(data)
	if err != nil || json.Unmarshal(raw, &resp) != nil {
		return
	}
	t := resp.Track
	if item.AlbumName == "" && t.AlbumName != "" {
		item.AlbumName = t.AlbumName
	}
	if item.AlbumArtist == "" && t.AlbumArtist != "" {
		item.AlbumArtist = t.AlbumArtist
	}
	if item.ReleaseDate == "" && t.ReleaseDate != "" {
		item.ReleaseDate = t.ReleaseDate
	}
	if item.TrackNo == 0 && t.TrackNumber > 0 {
		item.TrackNo = t.TrackNumber
	}
	if item.DiscNo == 0 && t.DiscNumber > 0 {
		item.DiscNo = t.DiscNumber
	}
	if item.TotalTracks == 0 && t.TotalTracks > 0 {
		item.TotalTracks = t.TotalTracks
	}
	if item.TotalDiscs == 0 && t.TotalDiscs > 0 {
		item.TotalDiscs = t.TotalDiscs
	}
	if item.CoverURL == "" && t.Images != "" {
		item.CoverURL = t.Images
	}
	if item.UPC == "" && t.UPC != "" {
		item.UPC = t.UPC
	}
	if item.Copyright == "" && t.Copyright != "" {
		item.Copyright = t.Copyright
	}
	if item.Publisher == "" && t.Publisher != "" {
		item.Publisher = t.Publisher
	}
	if item.Artists == "" && t.Artists != "" {
		item.Artists = t.Artists
	}
	if item.DurationMs == 0 && t.DurationMs > 0 {
		item.DurationMs = t.DurationMs
	}
	if item.Category == "" && t.AlbumType != "" {
		item.Category = categoryLabel(t.AlbumType)
	}
}

// resolveItemOutputDir computes the destination folder from settings + item.
func resolveItemOutputDir(rs runnerSettings, item *backend.DownloadItem, displayArtist, displayAlbumArtist string) (outputDir string, trackForTemplate int) {
	outputDir = rs.downloadPath
	hasSubfolder := strings.TrimSpace(rs.folderTemplate) != "" && (item.ApplyFolder || rs.applyFolderToSingle)
	trackForTemplate = item.Position
	if hasSubfolder && item.TrackNo > 0 {
		trackForTemplate = item.TrackNo
	}
	if !hasSubfolder {
		return outputDir, trackForTemplate
	}
	year := ""
	if len(item.ReleaseDate) >= 4 {
		year = item.ReleaseDate[:4]
	}
	albumArtist := displayAlbumArtist
	if albumArtist == "" {
		albumArtist = displayArtist
	}
	values := map[string]string{
		"artist":       displayArtist,
		"artists":      item.Artists,
		"album":        item.AlbumName,
		"album_artist": albumArtist,
		"title":        item.TrackName,
		"isrc":         item.ISRC,
		"track":        fmt.Sprintf("%02d", trackForTemplate),
		"total_tracks": fmt.Sprintf("%d", item.TotalTracks),
		"total_discs":  fmt.Sprintf("%d", item.TotalDiscs),
		"year":         year,
		"date":         item.ReleaseDate,
		"playlist":     "",
	}
	for _, seg := range renderFolderTemplate(rs.folderTemplate, values) {
		outputDir = filepath.Join(outputDir, seg)
	}
	return outputDir, trackForTemplate
}

// runDownloadQueue is the worker loop. Started once at app startup.
func (a *App) runDownloadQueue() {
	for {
		if backend.IsQueuePaused() {
			time.Sleep(1500 * time.Millisecond)
			continue
		}
		if secs := backend.CooldownRemainingSecs(); secs > 0 {
			sleep := secs
			if sleep > 15 {
				sleep = 15
			}
			time.Sleep(time.Duration(sleep) * time.Second)
			continue
		}
		item, ok := backend.ClaimNextQueued()
		if !ok {
			time.Sleep(1200 * time.Millisecond)
			continue
		}
		a.processQueueItem(item)
	}
}

func (a *App) processQueueItem(item backend.DownloadItem) {
	rs := a.loadRunnerSettings()
	a.backfillItemMetadata(&item)

	displayArtist := item.ArtistName
	if displayArtist == "" {
		displayArtist = item.Artists
	}
	fullArtists := item.Artists
	if fullArtists == "" {
		fullArtists = item.ArtistName
	}
	if rs.useFirstArtistOnly {
		displayArtist = firstArtist(displayArtist)
	}
	displayAlbumArtist := item.AlbumArtist
	if rs.useFirstArtistOnly && displayAlbumArtist != "" {
		displayAlbumArtist = firstArtist(displayAlbumArtist)
	}

	outputDir, trackForTemplate := resolveItemOutputDir(rs, &item, displayArtist, displayAlbumArtist)
	hasSubfolder := strings.TrimSpace(rs.folderTemplate) != "" && (item.ApplyFolder || rs.applyFolderToSingle)
	filenameFormat := rs.filenameTemplate
	if item.ApplyFolder && rs.useSeparateAlbumFile && strings.TrimSpace(rs.albumFilenameTemplate) != "" {
		filenameFormat = rs.albumFilenameTemplate
	}

	// Already in the library? Mark skipped without downloading.
	if item.TrackName != "" && displayArtist != "" {
		checks := a.CheckFilesExistence(outputDir, rs.downloadPath, []CheckFileExistenceRequest{{
			SpotifyID:           item.SpotifyID,
			TrackName:           item.TrackName,
			ArtistName:          displayArtist,
			Artists:             fullArtists,
			AlbumName:           item.AlbumName,
			AlbumArtist:         displayAlbumArtist,
			Category:            item.Category,
			UPC:                 item.UPC,
			ReleaseDate:         item.ReleaseDate,
			ISRC:                item.ISRC,
			TrackNumber:         item.TrackNo,
			DiscNumber:          item.DiscNo,
			TotalTracks:         item.TotalTracks,
			TotalDiscs:          item.TotalDiscs,
			Position:            trackForTemplate,
			UseAlbumTrackNumber: hasSubfolder,
			FilenameFormat:      filenameFormat,
			IncludeTrackNumber:  rs.trackNumber,
			AudioFormat:         "flac",
		}})
		if len(checks) > 0 && checks[0].Exists {
			backend.SkipDownloadItem(item.ID, checks[0].FilePath)
			return
		}
	}

	baseReq := DownloadRequest{
		TrackName:            item.TrackName,
		ArtistName:           displayArtist,
		AlbumName:            item.AlbumName,
		AlbumArtist:          displayAlbumArtist,
		ReleaseDate:          item.ReleaseDate,
		CoverURL:             item.CoverURL,
		OutputDir:            outputDir,
		FilenameFormat:       filenameFormat,
		Artists:              fullArtists,
		Category:             item.Category,
		UPC:                  item.UPC,
		TrackNumber:          rs.trackNumber,
		Position:             trackForTemplate,
		UseAlbumTrackNumber:  hasSubfolder,
		SpotifyID:            item.SpotifyID,
		EmbedLyrics:          rs.embedLyrics,
		EmbedMaxQualityCover: rs.embedMaxQualityCover,
		Duration:             item.DurationMs / 1000,
		ItemID:               item.ID,
		SpotifyTrackNumber:   item.TrackNo,
		SpotifyDiscNumber:    item.DiscNo,
		SpotifyTotalTracks:   item.TotalTracks,
		SpotifyTotalDiscs:    item.TotalDiscs,
		ISRC:                 item.ISRC,
		Copyright:            item.Copyright,
		Publisher:            item.Publisher,
		UseFirstArtistOnly:   rs.useFirstArtistOnly,
		UseSingleGenre:       rs.useSingleGenre,
		EmbedGenre:           rs.embedGenre,
		SaveCover:            rs.saveCover,
		TidalAPIURL:          rs.customTidalAPI,
		QobuzAPIURL:          rs.customQobuzAPI,
	}
	if item.TrackName != "" && displayArtist != "" {
		baseReq.Query = item.TrackName + " " + displayArtist
	}

	service := item.Service
	if service == "" {
		service = rs.downloader
	}

	tryService := func(svc, serviceURL string) DownloadResponse {
		req := baseReq
		req.Service = svc
		req.ServiceURL = serviceURL
		resp, err := a.DownloadTrack(req)
		if err != nil && resp.Error == "" {
			resp.Error = err.Error()
		}
		return resp
	}

	finish := func(resp DownloadResponse, lastErr string, tried int) {
		if resp.Success {
			if rs.autoDownloadLyrics && resp.File != "" && item.SpotifyID != "" && !resp.AlreadyExists {
				go func() {
					client := backend.NewLyricsClient()
					client.DownloadLyricsForFile(resp.File, item.SpotifyID, item.TrackName, displayArtist, item.AlbumName)
				}()
			}
			return
		}
		if resp.Cancelled {
			return // already marked skipped/cancelled downstream
		}
		msg := lastErr
		if msg == "" {
			msg = "Download failed"
		}
		if tried > 1 {
			msg = fmt.Sprintf("%s (%d sources tried)", msg, tried)
		}
		if isCooldownError(msg) {
			ensureCooldownClock(msg)
		}
		// FailDownloadItem parks cooldown failures back to queued.
		backend.FailDownloadItem(item.ID, msg)
	}

	if service != "auto" {
		resp := tryService(service, "")
		finish(resp, resp.Error, 1)
		return
	}

	// Auto: walk the source order; songlink URLs fetched lazily only when a
	// tidal/amazon leg is actually reached.
	var urls *backend.SongLinkURLs
	urlsFetched := false
	ensureURLs := func() {
		if urlsFetched || item.SpotifyID == "" {
			return
		}
		urlsFetched = true
		client := backend.NewSongLinkClient()
		if u, err := client.GetAllURLsFromSpotify(item.SpotifyID, ""); err == nil {
			urls = u
		}
	}

	lastErr := ""
	tried := 0
	var lastResp DownloadResponse
	for _, svc := range rs.autoOrder {
		serviceURL := ""
		switch svc {
		case "tidal":
			ensureURLs()
			if urls == nil || urls.TidalURL == "" {
				continue
			}
			serviceURL = urls.TidalURL
		case "amazon":
			ensureURLs()
			if urls == nil || urls.AmazonURL == "" {
				continue
			}
			serviceURL = urls.AmazonURL
		}
		tried++
		resp := tryService(svc, serviceURL)
		lastResp = resp
		if resp.Success || resp.Cancelled {
			finish(resp, "", tried)
			return
		}
		lastErr = resp.Error
		if lastErr == "" {
			lastErr = resp.Message
		}
		if isCooldownError(lastErr) {
			// Park it and let the runner loop wait the break out.
			ensureCooldownClock(lastErr)
			backend.FailDownloadItem(item.ID, lastErr)
			return
		}
	}
	if tried == 0 {
		lastResp = DownloadResponse{Success: false}
		lastErr = "No matching sources found"
	}
	finish(lastResp, lastErr, tried)
}
