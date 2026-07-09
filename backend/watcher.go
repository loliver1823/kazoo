package backend

// Real-time library watching (Plex-style "update automatically"). fsnotify
// gives native OS file events — no polling. Watches cover every directory
// under every library folder; events are debounced so a download writing in
// chunks triggers exactly one scan, and only the touched directories are
// scanned — never the whole library.

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"golang.org/x/text/unicode/norm"
)

type WatchChange struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Removed int `json:"removed"`
}

var (
	watcherMu     sync.Mutex
	watcher       *fsnotify.Watcher
	watchDirty    = map[string]struct{}{}
	watchKick     = make(chan struct{}, 1)
	watchOnChange func(WatchChange)
)

// StartLibraryWatcher begins watching all library folders and reports batched
// changes through onChange. Safe to call once at startup; no-ops thereafter.
func StartLibraryWatcher(onChange func(WatchChange)) error {
	watcherMu.Lock()
	if watcher != nil {
		watcherMu.Unlock()
		return nil
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		watcherMu.Unlock()
		return err
	}
	watcher = w
	watchOnChange = onChange
	watcherMu.Unlock()
	go watchEventLoop(w)
	go watchScanLoop()
	go RefreshLibraryWatcher()
	return nil
}

// RefreshLibraryWatcher rebuilds the watch set from the current library
// folders. Called after scans and folder add/remove so coverage tracks the
// library exactly.
func RefreshLibraryWatcher() {
	watcherMu.Lock()
	w := watcher
	watcherMu.Unlock()
	if w == nil {
		return
	}
	for _, p := range w.WatchList() {
		w.Remove(p)
	}
	folders, err := GetLibraryFolders()
	if err != nil {
		Dbgf("watcher: folders err: %v\n", err)
		return
	}
	added := 0
	for _, f := range folders {
		filepath.WalkDir(f.Path, func(p string, d fs.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				if aerr := w.Add(p); aerr != nil {
					Dbgf("watcher: add %s failed: %v\n", p, aerr)
				} else {
					added++
				}
			}
			return nil
		})
	}
	Dbgf("watcher: watching %d dirs across %d folders\n", added, len(folders))
}

func watchEventLoop(w *fsnotify.Watcher) {
	for {
		select {
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			Dbgf("watcher: event %s %s\n", ev.Op, ev.Name)
			handleWatchEvent(w, ev)
		case _, ok := <-w.Errors:
			if !ok {
				return
			}
		}
	}
}

func handleWatchEvent(w *fsnotify.Watcher, ev fsnotify.Event) {
	p := ev.Name
	if ev.Op.Has(fsnotify.Create) {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			// New directory (e.g. a freshly copied album) — watch the whole
			// subtree and scan everything already inside it.
			filepath.WalkDir(p, func(sub string, d fs.DirEntry, err error) error {
				if err == nil && d.IsDir() {
					w.Add(sub)
					dirtyAdd(sub)
				}
				return nil
			})
			return
		}
	}
	ext := strings.ToLower(filepath.Ext(p))
	if audioExts[ext] {
		dirtyAdd(filepath.Dir(p))
		return
	}
	// Removals/renames can't be stat'ed and carry no reliable extension info
	// for dirs — a directory rename shows up with its old name. Re-check the
	// parent so vanished files get pruned.
	if ev.Op.Has(fsnotify.Remove) || ev.Op.Has(fsnotify.Rename) {
		dirtyAdd(filepath.Dir(p))
	}
}

func dirtyAdd(dir string) {
	watcherMu.Lock()
	watchDirty[dir] = struct{}{}
	watcherMu.Unlock()
	select {
	case watchKick <- struct{}{}:
	default:
	}
}

// watchScanLoop debounces event bursts, then scans only the dirty directories.
func watchScanLoop() {
	for range watchKick {
		for {
			// Let writes settle (downloads/copies arrive in chunks).
			time.Sleep(2 * time.Second)
			watcherMu.Lock()
			dirs := make([]string, 0, len(watchDirty))
			for d := range watchDirty {
				dirs = append(dirs, d)
			}
			watchDirty = map[string]struct{}{}
			cb := watchOnChange
			watcherMu.Unlock()
			if len(dirs) == 0 {
				break
			}
			ch := scanWatchedDirs(dirs)
			Dbgf("watcher: scanned %d dirs → +%d ~%d -%d\n", len(dirs), ch.Added, ch.Updated, ch.Removed)
			if cb != nil && (ch.Added+ch.Updated+ch.Removed) > 0 {
				cb(ch)
			}
			watcherMu.Lock()
			more := len(watchDirty) > 0
			watcherMu.Unlock()
			if !more {
				break
			}
		}
	}
}

// scanWatchedDirs upserts the audio files directly inside each dirty
// directory and prunes DB rows whose files are confirmed gone.
func scanWatchedDirs(dirs []string) WatchChange {
	var ch WatchChange
	if libDB == nil {
		return ch
	}
	stmt, err := libDB.Prepare(trackUpsertSQL)
	if err != nil {
		return ch
	}
	defer stmt.Close()
	now := time.Now().Unix()
	sep := string(filepath.Separator)
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil && !os.IsNotExist(err) {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			p := filepath.Join(dir, e.Name())
			if !audioExts[strings.ToLower(filepath.Ext(p))] {
				continue
			}
			switch upsertTrackFile(stmt, p, now, false) {
			case fileAdded:
				ch.Added++
			case fileUpdated:
				ch.Updated++
			}
		}
		// Prune rows for files that vanished from this directory. Stat each
		// candidate before deleting so a transient lock never drops a track.
		rows, err := libDB.Query("SELECT id, path FROM tracks WHERE path LIKE ?", norm.NFC.String(dir)+sep+"%")
		if err != nil {
			continue
		}
		type cand struct {
			id   int64
			path string
		}
		var cands []cand
		for rows.Next() {
			var c cand
			if rows.Scan(&c.id, &c.path) == nil && filepath.Dir(c.path) == norm.NFC.String(dir) {
				cands = append(cands, c)
			}
		}
		rows.Close()
		for _, c := range cands {
			if _, err := os.Stat(c.path); os.IsNotExist(err) {
				libDB.Exec("DELETE FROM track_artists WHERE track_id=?", c.id)
				libDB.Exec("DELETE FROM tracks WHERE id=?", c.id)
				ch.Removed++
			}
		}
	}
	return ch
}
