package backend

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

const (
	isrcCacheDBFile = "isrc_cache.db"
	isrcCacheBucket = "SpotifyTrackISRC"
)

type isrcCacheEntry struct {
	TrackID   string `json:"track_id"`
	ISRC      string `json:"isrc"`
	UpdatedAt int64  `json:"updated_at"`
}

var (
	isrcCacheDB   *bolt.DB
	isrcCacheDBMu sync.Mutex
	// When the bolt file can't be opened (locked by another process), back off
	// instead of blocking every lookup for the full open-timeout, and serve
	// this session's resolutions from memory so probes stay fast.
	isrcCacheFailedUntil time.Time
	isrcMemCache         sync.Map // trackID -> isrc
)

func InitISRCCacheDB() error {
	isrcCacheDBMu.Lock()
	defer isrcCacheDBMu.Unlock()

	if isrcCacheDB != nil {
		return nil
	}
	if time.Now().Before(isrcCacheFailedUntil) {
		return fmt.Errorf("isrc cache unavailable (backing off)")
	}

	appDir, err := EnsureAppDir()
	if err != nil {
		return err
	}

	dbPath := filepath.Join(appDir, isrcCacheDBFile)
	db, err := bolt.Open(dbPath, 0o600, &bolt.Options{Timeout: 1 * time.Second})
	if err != nil {
		isrcCacheFailedUntil = time.Now().Add(60 * time.Second)
		return err
	}

	if err := db.Update(func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists([]byte(isrcCacheBucket))
		return err
	}); err != nil {
		db.Close()
		return err
	}

	isrcCacheDB = db
	return nil
}

func CloseISRCCacheDB() {
	isrcCacheDBMu.Lock()
	defer isrcCacheDBMu.Unlock()

	if isrcCacheDB != nil {
		_ = isrcCacheDB.Close()
		isrcCacheDB = nil
	}
}

func GetCachedISRC(trackID string) (string, error) {
	normalizedTrackID := strings.TrimSpace(trackID)
	if normalizedTrackID == "" {
		return "", nil
	}

	if err := InitISRCCacheDB(); err != nil {
		if v, ok := isrcMemCache.Load(normalizedTrackID); ok {
			return v.(string), nil
		}
		return "", err
	}

	var cachedISRC string
	err := isrcCacheDB.View(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte(isrcCacheBucket))
		if bucket == nil {
			return nil
		}

		value := bucket.Get([]byte(normalizedTrackID))
		if len(value) == 0 {
			return nil
		}

		var entry isrcCacheEntry
		if err := json.Unmarshal(value, &entry); err != nil {
			return err
		}

		cachedISRC = strings.ToUpper(strings.TrimSpace(entry.ISRC))
		return nil
	})
	if err != nil {
		return "", err
	}

	return cachedISRC, nil
}

func PutCachedISRC(trackID string, isrc string) error {
	normalizedTrackID := strings.TrimSpace(trackID)
	normalizedISRC := strings.ToUpper(strings.TrimSpace(isrc))
	if normalizedTrackID == "" || normalizedISRC == "" {
		return nil
	}

	if err := InitISRCCacheDB(); err != nil {
		isrcMemCache.Store(normalizedTrackID, normalizedISRC)
		return nil
	}

	entry := isrcCacheEntry{
		TrackID:   normalizedTrackID,
		ISRC:      normalizedISRC,
		UpdatedAt: time.Now().Unix(),
	}

	payload, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("failed to encode ISRC cache entry: %w", err)
	}

	return isrcCacheDB.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists([]byte(isrcCacheBucket))
		if err != nil {
			return err
		}
		return bucket.Put([]byte(normalizedTrackID), payload)
	})
}
