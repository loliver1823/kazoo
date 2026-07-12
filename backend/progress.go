package backend

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type DownloadStatus string

const (
	StatusQueued      DownloadStatus = "queued"
	StatusDownloading DownloadStatus = "downloading"
	StatusCompleted   DownloadStatus = "completed"
	StatusFailed      DownloadStatus = "failed"
	StatusSkipped     DownloadStatus = "skipped"
)

type DownloadItem struct {
	ID           string         `json:"id"`
	TrackName    string         `json:"track_name"`
	ArtistName   string         `json:"artist_name"`
	AlbumName    string         `json:"album_name"`
	SpotifyID    string         `json:"spotify_id"`
	Status       DownloadStatus `json:"status"`
	Progress     float64        `json:"progress"`
	TotalSize    float64        `json:"total_size"`
	Speed        float64        `json:"speed"`
	StartTime    int64          `json:"start_time"`
	EndTime      int64          `json:"end_time"`
	ErrorMessage string         `json:"error_message"`
	FilePath     string         `json:"file_path"`
	// Track metadata captured at enqueue time so the backend queue runner can
	// download without the frontend — and so restarts resume with everything.
	Artists     string `json:"artists,omitempty"`
	AlbumArtist string `json:"album_artist,omitempty"`
	ReleaseDate string `json:"release_date,omitempty"`
	CoverURL    string `json:"cover_url,omitempty"`
	DurationMs  int    `json:"duration_ms,omitempty"`
	TrackNo     int    `json:"track_no,omitempty"`
	DiscNo      int    `json:"disc_no,omitempty"`
	TotalTracks int    `json:"total_tracks,omitempty"`
	TotalDiscs  int    `json:"total_discs,omitempty"`
	Copyright   string `json:"copyright,omitempty"`
	Publisher   string `json:"publisher,omitempty"`
	ISRC        string `json:"isrc,omitempty"`
	AlbumID     string `json:"album_id,omitempty"`
	Category    string `json:"category,omitempty"`
	UPC         string `json:"upc,omitempty"`
	Position    int    `json:"position,omitempty"`
	// Service pin: "" = follow settings; "qobuz" = Qobuz-direct search result.
	Service string `json:"service,omitempty"`
	// ApplyFolder: render the folder template for this item (batch downloads
	// always do; singles follow the applyFolderToSingleTrack setting).
	ApplyFolder bool `json:"apply_folder,omitempty"`
}

var (
	currentProgress     float64
	currentProgressLock sync.RWMutex
	isDownloading       bool
	downloadingLock     sync.RWMutex
	currentSpeed        float64
	speedLock           sync.RWMutex

	rateLimitUntilMs int64
	rateLimitLock    sync.RWMutex

	// Cooldowns are tracked per source service — community endpoints take
	// their breaks on independent schedules, and a single shared clock made
	// the countdown bounce whenever a different service's 503 overwrote it.
	// Readers report the soonest-ending active entry: when the next source
	// comes back.
	cooldownByService = map[string]serviceCooldown{}
	cooldownEventID   int64
	cooldownLock      sync.RWMutex

	downloadQueue       []DownloadItem
	downloadQueueLock   sync.RWMutex
	queuePaused         bool
	queuePausedLock     sync.RWMutex
	queuePersistLock    sync.Mutex
	currentItemID       string
	currentItemLock     sync.RWMutex
	totalDownloaded     float64
	totalDownloadedLock sync.RWMutex
	sessionStartTime    int64
	sessionStartLock    sync.RWMutex
)

type ProgressInfo struct {
	IsDownloading   bool    `json:"is_downloading"`
	MBDownloaded    float64 `json:"mb_downloaded"`
	SpeedMBps       float64 `json:"speed_mbps"`
	RateLimited     bool    `json:"rate_limited"`
	RateLimitSecs   int     `json:"rate_limit_secs"`
	Cooldown        bool    `json:"cooldown"`
	CooldownSecs    int     `json:"cooldown_secs"`
	CooldownMessage string  `json:"cooldown_message"`
	CooldownEventID int64   `json:"cooldown_event_id"`
}

type DownloadQueueInfo struct {
	IsDownloading    bool           `json:"is_downloading"`
	Queue            []DownloadItem `json:"queue"`
	CurrentSpeed     float64        `json:"current_speed"`
	TotalDownloaded  float64        `json:"total_downloaded"`
	SessionStartTime int64          `json:"session_start_time"`
	QueuedCount      int            `json:"queued_count"`
	CompletedCount   int            `json:"completed_count"`
	FailedCount      int            `json:"failed_count"`
	SkippedCount     int            `json:"skipped_count"`
	// Community-server cooldown ("scheduled break") — the queue waits this
	// out instead of failing items.
	Cooldown        bool   `json:"cooldown"`
	CooldownSecs    int    `json:"cooldown_secs"`
	CooldownMessage string `json:"cooldown_message"`
	// Paused: downloads hold between tracks until resumed.
	Paused bool `json:"paused"`
}

// --- Queue persistence ------------------------------------------------------
// The queue survives app restarts: saved to queue.json on every state change,
// restored at startup with any in-flight item parked back to "queued".

func queueFilePath() string {
	dir, err := EnsureAppDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "queue.json")
}

func persistQueue() {
	path := queueFilePath()
	if path == "" {
		return
	}
	downloadQueueLock.RLock()
	snapshot := make([]DownloadItem, len(downloadQueue))
	copy(snapshot, downloadQueue)
	downloadQueueLock.RUnlock()
	data, err := json.Marshal(snapshot)
	if err != nil {
		return
	}
	queuePersistLock.Lock()
	os.WriteFile(path, data, 0o644)
	queuePersistLock.Unlock()
}

// LoadDownloadQueue restores the persisted queue at startup. Items that were
// mid-download when the app closed go back to "queued".
func LoadDownloadQueue() {
	path := queueFilePath()
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var items []DownloadItem
	if json.Unmarshal(data, &items) != nil {
		return
	}
	for i := range items {
		if items[i].Status == StatusDownloading {
			items[i].Status = StatusQueued
			items[i].Progress = 0
			items[i].Speed = 0
		} else {
			items[i].Speed = 0
		}
	}
	downloadQueueLock.Lock()
	downloadQueue = items
	downloadQueueLock.Unlock()
}

// SetQueuePaused pauses/resumes the download queue (takes effect between
// tracks; the current file finishes).
func SetQueuePaused(paused bool) {
	queuePausedLock.Lock()
	queuePaused = paused
	queuePausedLock.Unlock()
}

func IsQueuePaused() bool {
	queuePausedLock.RLock()
	defer queuePausedLock.RUnlock()
	return queuePaused
}

// GetQueueItemStatus returns an item's current status ("" if it was removed
// from the queue) — batch loops check this so removing an upcoming track
// actually stops it from downloading.
func GetQueueItemStatus(id string) string {
	downloadQueueLock.RLock()
	defer downloadQueueLock.RUnlock()
	for i := range downloadQueue {
		if downloadQueue[i].ID == id {
			return string(downloadQueue[i].Status)
		}
	}
	return ""
}

// RemoveDownloadItems deletes the given items from the queue.
func RemoveDownloadItems(ids []string) {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	downloadQueueLock.Lock()
	kept := downloadQueue[:0]
	for _, item := range downloadQueue {
		if !want[item.ID] {
			kept = append(kept, item)
		}
	}
	downloadQueue = kept
	downloadQueueLock.Unlock()
	persistQueue()
}

// RequeueDownloadItems puts failed/skipped items back to "queued".
func RequeueDownloadItems(ids []string) {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	downloadQueueLock.Lock()
	for i := range downloadQueue {
		if want[downloadQueue[i].ID] && downloadQueue[i].Status != StatusDownloading {
			downloadQueue[i].Status = StatusQueued
			downloadQueue[i].ErrorMessage = ""
			downloadQueue[i].Progress = 0
			downloadQueue[i].Speed = 0
		}
	}
	downloadQueueLock.Unlock()
	persistQueue()
}

func GetDownloadProgress() ProgressInfo {
	downloadingLock.RLock()
	downloading := isDownloading
	downloadingLock.RUnlock()

	currentProgressLock.RLock()
	progress := currentProgress
	currentProgressLock.RUnlock()

	speedLock.RLock()
	speed := currentSpeed
	speedLock.RUnlock()

	rateLimitLock.RLock()
	untilMs := rateLimitUntilMs
	rateLimitLock.RUnlock()

	rateLimited := false
	rateLimitSecs := 0
	if untilMs > 0 {
		remainingMs := untilMs - getCurrentTimeMillis()
		if remainingMs > 0 {
			rateLimited = true
			rateLimitSecs = int((remainingMs + 999) / 1000)
		}
	}

	now := getCurrentTimeMillis()
	cooldownLock.RLock()
	cdUntilMs, cdMessage := soonestCooldownLocked(now)
	cdEventID := cooldownEventID
	cooldownLock.RUnlock()

	cooldown := false
	cooldownSecs := 0
	if cdUntilMs > 0 {
		cooldown = true
		cooldownSecs = int((cdUntilMs - now + 999) / 1000)
	}

	return ProgressInfo{
		IsDownloading:   downloading,
		MBDownloaded:    progress,
		SpeedMBps:       speed,
		RateLimited:     rateLimited,
		RateLimitSecs:   rateLimitSecs,
		Cooldown:        cooldown,
		CooldownSecs:    cooldownSecs,
		CooldownMessage: cdMessage,
		CooldownEventID: cdEventID,
	}
}

func SetRateLimitCooldown(seconds float64) {
	rateLimitLock.Lock()
	if seconds <= 0 {
		rateLimitUntilMs = 0
	} else {
		rateLimitUntilMs = getCurrentTimeMillis() + int64(seconds*1000)
	}
	rateLimitLock.Unlock()
}

func ClearRateLimitCooldown() {
	rateLimitLock.Lock()
	rateLimitUntilMs = 0
	rateLimitLock.Unlock()
}

type serviceCooldown struct {
	untilMs int64
	message string
}

// soonestCooldownLocked returns the active entry that ends first (0 if none).
// Expired entries are skipped, not deleted — callers may hold only RLock and
// the map never outgrows the handful of sources.
func soonestCooldownLocked(nowMs int64) (int64, string) {
	var bestUntil int64
	var bestMsg string
	for _, c := range cooldownByService {
		if c.untilMs <= nowMs {
			continue
		}
		if bestUntil == 0 || c.untilMs < bestUntil {
			bestUntil, bestMsg = c.untilMs, c.message
		}
	}
	return bestUntil, bestMsg
}

// SetServiceCooldown records a scheduled break for one source service.
// seconds <= 0 clears that service's entry.
func SetServiceCooldown(service string, seconds float64, message string) {
	cooldownLock.Lock()
	if seconds <= 0 {
		delete(cooldownByService, service)
	} else {
		cooldownByService[service] = serviceCooldown{
			untilMs: getCurrentTimeMillis() + int64(seconds*1000),
			message: message,
		}
		cooldownEventID++
	}
	cooldownLock.Unlock()
}

// SetCommunityCooldown keeps the old service-less entry point (parsed error
// text with no service attribution).
func SetCommunityCooldown(seconds float64, message string) {
	SetServiceCooldown("", seconds, message)
}

func ClearCommunityCooldown() {
	cooldownLock.Lock()
	cooldownByService = map[string]serviceCooldown{}
	cooldownLock.Unlock()
}

func SetDownloadSpeed(mbps float64) {
	speedLock.Lock()
	currentSpeed = mbps
	speedLock.Unlock()
}

func SetDownloadProgress(mbDownloaded float64) {
	currentProgressLock.Lock()
	currentProgress = mbDownloaded
	currentProgressLock.Unlock()
}

func SetDownloading(downloading bool) {
	downloadingLock.Lock()
	isDownloading = downloading
	downloadingLock.Unlock()

	if !downloading {

		SetDownloadProgress(0)
		SetDownloadSpeed(0)
		ClearRateLimitCooldown()
	}
}

type ProgressWriter struct {
	writer      io.Writer
	total       int64
	lastPrinted int64
	startTime   int64
	lastTime    int64
	lastBytes   int64
	itemID      string
	totalBytes  int64
}

func NewProgressWriter(writer io.Writer) *ProgressWriter {
	now := getCurrentTimeMillis()
	return &ProgressWriter{
		writer:      writer,
		total:       0,
		lastPrinted: 0,
		startTime:   now,
		lastTime:    now,
		lastBytes:   0,
		// Attribute progress to whichever queue item is being downloaded —
		// this is what drives the per-track progress bar.
		itemID: GetCurrentItemID(),
	}
}

// SetTotalBytes records the expected file size (from Content-Length) so the
// queue can show a percentage bar instead of a raw MB counter.
func (pw *ProgressWriter) SetTotalBytes(n int64) {
	if n > 0 {
		pw.totalBytes = n
	}
}

func getCurrentTimeMillis() int64 {
	return time.Now().UnixMilli()
}

func (pw *ProgressWriter) Write(p []byte) (int, error) {
	if err := CheckDownloadCancelled(); err != nil {
		return 0, err
	}

	n, err := pw.writer.Write(p)
	pw.total += int64(n)

	if pw.total-pw.lastPrinted >= 256*1024 {
		mbDownloaded := float64(pw.total) / (1024 * 1024)

		now := getCurrentTimeMillis()
		timeDiff := float64(now-pw.lastTime) / 1000.0
		bytesDiff := float64(pw.total - pw.lastBytes)

		var speedMBps float64
		if timeDiff > 0 {
			speedMBps = (bytesDiff / (1024 * 1024)) / timeDiff
			SetDownloadSpeed(speedMBps)
			Dbgf("\rDownloaded: %.2f MB (%.2f MB/s)", mbDownloaded, speedMBps)
		} else {
			Dbgf("\rDownloaded: %.2f MB", mbDownloaded)
		}

		SetDownloadProgress(mbDownloaded)

		if pw.itemID != "" {
			UpdateItemProgressEx(pw.itemID, mbDownloaded, speedMBps, float64(pw.totalBytes)/(1024*1024))
		}

		pw.lastPrinted = pw.total
		pw.lastTime = now
		pw.lastBytes = pw.total
	}

	return n, err
}

func (pw *ProgressWriter) GetTotal() int64 {
	return pw.total
}

func AddToQueue(id, trackName, artistName, albumName, spotifyID string) {
	downloadQueueLock.Lock()
	defer downloadQueueLock.Unlock()

	item := DownloadItem{
		ID:         id,
		TrackName:  trackName,
		ArtistName: artistName,
		AlbumName:  albumName,
		SpotifyID:  spotifyID,
		Status:     StatusQueued,
		Progress:   0,
		TotalSize:  0,
		Speed:      0,
		StartTime:  0,
		EndTime:    0,
	}

	downloadQueue = append(downloadQueue, item)

	sessionStartLock.Lock()
	if sessionStartTime == 0 {
		sessionStartTime = time.Now().Unix()
	}
	sessionStartLock.Unlock()

	go persistQueue()
}

// AddToQueueEx enqueues a metadata-rich item for the backend queue runner.
// Returns the item's ID (assigned when empty).
func AddToQueueEx(item DownloadItem) string {
	// The same track queued or downloading already covers this request —
	// return its ID so callers can track it instead of double-queueing.
	if item.SpotifyID != "" {
		downloadQueueLock.Lock()
		for i := range downloadQueue {
			q := &downloadQueue[i]
			if q.SpotifyID == item.SpotifyID && (q.Status == StatusQueued || q.Status == StatusDownloading) {
				id := q.ID
				downloadQueueLock.Unlock()
				return id
			}
		}
		downloadQueueLock.Unlock()
	}
	if item.ID == "" {
		base := item.SpotifyID
		if base == "" {
			base = item.TrackName + "-" + item.ArtistName
		}
		item.ID = base + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	item.Status = StatusQueued
	item.Progress = 0
	item.TotalSize = 0
	item.Speed = 0
	item.StartTime = 0
	item.EndTime = 0
	item.ErrorMessage = ""
	item.FilePath = ""

	downloadQueueLock.Lock()
	downloadQueue = append(downloadQueue, item)
	downloadQueueLock.Unlock()

	sessionStartLock.Lock()
	if sessionStartTime == 0 {
		sessionStartTime = time.Now().Unix()
	}
	sessionStartLock.Unlock()

	go persistQueue()
	return item.ID
}

// ClaimNextQueued returns a copy of the oldest queued item without changing
// its status (the download flow flips it to downloading itself).
func ClaimNextQueued() (DownloadItem, bool) {
	downloadQueueLock.RLock()
	defer downloadQueueLock.RUnlock()
	for i := range downloadQueue {
		if downloadQueue[i].Status == StatusQueued {
			return downloadQueue[i], true
		}
	}
	return DownloadItem{}, false
}

// CooldownRemainingSecs reports how long the community cooldown has left.
func CooldownRemainingSecs() int {
	now := time.Now().UnixMilli()
	cooldownLock.RLock()
	defer cooldownLock.RUnlock()
	until, _ := soonestCooldownLocked(now)
	if until == 0 {
		return 0
	}
	return int((until - now) / 1000)
}

func StartDownloadItem(id string) {
	downloadQueueLock.Lock()
	defer downloadQueueLock.Unlock()

	for i := range downloadQueue {
		if downloadQueue[i].ID == id {
			downloadQueue[i].Status = StatusDownloading
			downloadQueue[i].StartTime = time.Now().Unix()
			downloadQueue[i].Progress = 0
			break
		}
	}

	currentItemLock.Lock()
	currentItemID = id
	currentItemLock.Unlock()

	go persistQueue()
}

func UpdateItemProgressEx(id string, progress, speed, totalMB float64) {
	downloadQueueLock.Lock()
	defer downloadQueueLock.Unlock()

	for i := range downloadQueue {
		if downloadQueue[i].ID == id {
			downloadQueue[i].Progress = progress
			downloadQueue[i].Speed = speed
			if totalMB > 0 {
				downloadQueue[i].TotalSize = totalMB
			}
			break
		}
	}
}

func GetCurrentItemID() string {
	currentItemLock.RLock()
	defer currentItemLock.RUnlock()
	return currentItemID
}

func CompleteDownloadItem(id, filePath string, finalSize float64) {
	downloadQueueLock.Lock()
	for i := range downloadQueue {
		if downloadQueue[i].ID == id {
			downloadQueue[i].Status = StatusCompleted
			downloadQueue[i].EndTime = time.Now().Unix()
			downloadQueue[i].FilePath = filePath
			downloadQueue[i].Progress = finalSize
			downloadQueue[i].TotalSize = finalSize

			totalDownloadedLock.Lock()
			totalDownloaded += finalSize
			totalDownloadedLock.Unlock()
			break
		}
	}
	downloadQueueLock.Unlock()
	go persistQueue()
}

func FailDownloadItem(id, errorMsg string) {
	downloadQueueLock.Lock()

	// A user cancel is not a failure either — show it as skipped/"Cancelled".
	lower := strings.ToLower(errorMsg)
	if strings.Contains(lower, "cancelled") || strings.Contains(lower, "canceled") {
		for i := range downloadQueue {
			if downloadQueue[i].ID == id {
				downloadQueue[i].Status = StatusSkipped
				downloadQueue[i].EndTime = time.Now().Unix()
				downloadQueue[i].ErrorMessage = "Cancelled"
				break
			}
		}
		downloadQueueLock.Unlock()
		go persistQueue()
		return
	}

	// A community-server break is not a failure: park the item back in the
	// queue so it resumes when the break ends, instead of painting it red.
	if strings.Contains(lower, "short break") || strings.Contains(lower, "scheduled") || strings.Contains(lower, "cooldown") {
		for i := range downloadQueue {
			if downloadQueue[i].ID == id {
				downloadQueue[i].Status = StatusQueued
				downloadQueue[i].ErrorMessage = ""
				downloadQueue[i].Progress = 0
				downloadQueue[i].Speed = 0
				break
			}
		}
		downloadQueueLock.Unlock()
		go persistQueue()
		return
	}

	for i := range downloadQueue {
		if downloadQueue[i].ID == id {
			downloadQueue[i].Status = StatusFailed
			downloadQueue[i].EndTime = time.Now().Unix()
			downloadQueue[i].ErrorMessage = errorMsg
			break
		}
	}
	downloadQueueLock.Unlock()
	go persistQueue()
}

func SkipDownloadItem(id, filePath string) {
	SkipDownloadItemWithNote(id, filePath, "")
}

// SkipDownloadItemWithNote marks an item skipped with an explanation shown in
// the queue (e.g. which album already carries the recording).
func SkipDownloadItemWithNote(id, filePath, note string) {
	downloadQueueLock.Lock()
	for i := range downloadQueue {
		if downloadQueue[i].ID == id {
			downloadQueue[i].Status = StatusSkipped
			downloadQueue[i].EndTime = time.Now().Unix()
			downloadQueue[i].FilePath = filePath
			downloadQueue[i].ErrorMessage = note
			break
		}
	}
	downloadQueueLock.Unlock()
	go persistQueue()
}

func GetDownloadQueue() DownloadQueueInfo {

	ResetSessionIfComplete()

	downloadQueueLock.RLock()
	defer downloadQueueLock.RUnlock()

	downloadingLock.RLock()
	downloading := isDownloading
	downloadingLock.RUnlock()

	speedLock.RLock()
	speed := currentSpeed
	speedLock.RUnlock()

	totalDownloadedLock.RLock()
	total := totalDownloaded
	totalDownloadedLock.RUnlock()

	sessionStartLock.RLock()
	sessionStart := sessionStartTime
	sessionStartLock.RUnlock()

	var queued, completed, failed, skipped int
	for _, item := range downloadQueue {
		switch item.Status {
		case StatusQueued:
			queued++
		case StatusCompleted:
			completed++
		case StatusFailed:
			failed++
		case StatusSkipped:
			skipped++
		}
	}

	queueCopy := make([]DownloadItem, len(downloadQueue))
	copy(queueCopy, downloadQueue)

	nowMs := getCurrentTimeMillis()
	cooldownLock.RLock()
	cdUntilMs, cdMessage := soonestCooldownLocked(nowMs)
	cooldownLock.RUnlock()
	cd := false
	cdSecs := 0
	if cdUntilMs > 0 {
		cd = true
		cdSecs = int((cdUntilMs - nowMs + 999) / 1000)
	}

	return DownloadQueueInfo{
		IsDownloading:    downloading,
		Queue:            queueCopy,
		CurrentSpeed:     speed,
		TotalDownloaded:  total,
		SessionStartTime: sessionStart,
		QueuedCount:      queued,
		CompletedCount:   completed,
		FailedCount:      failed,
		SkippedCount:     skipped,
		Cooldown:         cd,
		CooldownSecs:     cdSecs,
		CooldownMessage:  cdMessage,
		Paused:           IsQueuePaused(),
	}
}

// GetDownloadQueueCounts returns just the badge numbers so background
// pollers don't marshal the whole queue every couple of seconds.
func GetDownloadQueueCounts() (queued int, downloading int) {
	downloadQueueLock.Lock()
	defer downloadQueueLock.Unlock()
	for _, item := range downloadQueue {
		switch item.Status {
		case StatusQueued:
			queued++
		case StatusDownloading:
			downloading++
		}
	}
	return
}

func ClearDownloadQueue() {
	downloadQueueLock.Lock()
	newQueue := make([]DownloadItem, 0)
	for _, item := range downloadQueue {
		if item.Status == StatusQueued || item.Status == StatusDownloading {
			newQueue = append(newQueue, item)
		}
	}
	downloadQueue = newQueue
	downloadQueueLock.Unlock()
	go persistQueue()
}

func ClearAllDownloads() {
	downloadQueueLock.Lock()
	downloadQueue = []DownloadItem{}
	downloadQueueLock.Unlock()
	go persistQueue()

	totalDownloadedLock.Lock()
	totalDownloaded = 0
	totalDownloadedLock.Unlock()

	sessionStartLock.Lock()
	sessionStartTime = 0
	sessionStartLock.Unlock()

	currentItemLock.Lock()
	currentItemID = ""
	currentItemLock.Unlock()

	SetDownloadProgress(0)
	SetDownloadSpeed(0)
}

func CancelAllQueuedItems() {
	downloadQueueLock.Lock()
	for i := range downloadQueue {
		if downloadQueue[i].Status == StatusQueued {
			downloadQueue[i].Status = StatusSkipped
			downloadQueue[i].EndTime = time.Now().Unix()
			downloadQueue[i].ErrorMessage = "Cancelled"
		}
	}
	downloadQueueLock.Unlock()
	go persistQueue()
}

func CancelQueuedAndDownloadingItems() {
	downloadQueueLock.Lock()
	for i := range downloadQueue {
		if downloadQueue[i].Status == StatusQueued || downloadQueue[i].Status == StatusDownloading {
			downloadQueue[i].Status = StatusSkipped
			downloadQueue[i].EndTime = time.Now().Unix()
			downloadQueue[i].ErrorMessage = "Cancelled"
		}
	}
	downloadQueueLock.Unlock()

	currentItemLock.Lock()
	currentItemID = ""
	currentItemLock.Unlock()

	SetDownloadProgress(0)
	SetDownloadSpeed(0)
}

func ResetSessionIfComplete() {
	downloadQueueLock.RLock()
	hasActiveOrQueued := false
	for _, item := range downloadQueue {
		if item.Status == StatusQueued || item.Status == StatusDownloading {
			hasActiveOrQueued = true
			break
		}
	}
	downloadQueueLock.RUnlock()

	if !hasActiveOrQueued {
		sessionStartLock.Lock()
		sessionStartTime = 0
		sessionStartLock.Unlock()

		totalDownloadedLock.Lock()
		totalDownloaded = 0
		totalDownloadedLock.Unlock()
	}
}
