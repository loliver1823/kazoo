package backend

// Local playback support: an HTTP handler that streams library tracks to the
// WebView's <audio> element (with Range support so seeking works), an FFmpeg
// transcode path for codecs the WebView can't decode natively (ALAC, APE,
// WavPack, WMA, AIFF, DSD, …), and waveform peak extraction for the seek bar.

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"go.senan.xyz/taglib"
	xdraw "golang.org/x/image/draw"
	"golang.org/x/text/unicode/norm"
)

// Codecs the embedded Chromium (WebView2) plays natively — everything else
// goes through the transcode path.
var nativePlayback = map[string]bool{
	".mp3": true, ".flac": true, ".wav": true, ".ogg": true, ".oga": true,
	".opus": true, ".aac": true, ".webm": true, ".mp4": true,
	// .m4a is *usually* AAC (native) but may be ALAC — the frontend retries
	// with ?transcode=1 when the audio element errors, so optimistic is fine.
	".m4a": true,
}

var mediaContentTypes = map[string]string{
	".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
	".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
	".m4a": "audio/mp4", ".aac": "audio/aac", ".webm": "audio/webm", ".mp4": "audio/mp4",
}

func trackPathByID(id int64) string {
	if libDB == nil {
		return ""
	}
	var p string
	libDB.QueryRow("SELECT path FROM tracks WHERE id=?", id).Scan(&p)
	return p
}

// MediaHTTPHandler serves the player/artwork endpoints:
//
//	/media/{trackID}[?transcode=1]  – audio streaming with Range support
//	/cover?path=…&s=320             – downscaled cover thumbnails (disk-cached)
//	/artistart?name=…&kind=banner   – artist photo/banner files
//
// Wired as the Wails asset-server fallback handler. Serving art over HTTP
// (instead of base64 across the JS bridge) lets the browser lazy-load,
// decode off-thread, and cache with 304s — the library grids stay snappy.
func MediaHTTPHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/cover":
			serveCoverThumb(w, r)
			return
		case r.URL.Path == "/artistart":
			serveArtistArt(w, r)
			return
		}
		rest, ok := strings.CutPrefix(r.URL.Path, "/media/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		id, err := strconv.ParseInt(rest, 10, 64)
		if err != nil {
			http.Error(w, "bad track id", http.StatusBadRequest)
			return
		}
		p := trackPathByID(id)
		if p == "" {
			http.NotFound(w, r)
			return
		}
		if _, err := os.Stat(p); err != nil {
			http.NotFound(w, r)
			return
		}
		ext := strings.ToLower(filepath.Ext(p))
		wantTranscode := r.URL.Query().Get("transcode") == "1" || !nativePlayback[ext]
		if wantTranscode {
			tp, err := ensureTranscoded(id, p)
			if err != nil {
				http.Error(w, fmt.Sprintf("transcode failed: %v", err), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "audio/flac")
			http.ServeFile(w, r, tp)
			return
		}
		if ct := mediaContentTypes[ext]; ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		http.ServeFile(w, r, p)
	})
}

// --- Cover thumbnails -----------------------------------------------------

var thumbLocks sync.Map // cache key -> *sync.Mutex

func serveCoverThumb(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path required", http.StatusBadRequest)
		return
	}
	size := 320
	if s, err := strconv.Atoi(r.URL.Query().Get("s")); err == nil && s >= 64 && s <= 1280 {
		size = s
	}
	thumb := ensureCoverThumb(path, size)
	if thumb == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, thumb)
}

// ensureCoverThumb extracts the track's art (embedded, else folder cover),
// downscales it to `size` and caches the JPEG on disk. The cache key includes
// the audio file's mtime, so edited covers regenerate automatically.
func ensureCoverThumb(audioPath string, size int) string {
	st, err := os.Stat(audioPath)
	if err != nil {
		return ""
	}
	dir, err := EnsureAppDir()
	if err != nil {
		return ""
	}
	cacheDir := filepath.Join(dir, "thumbs")
	os.MkdirAll(cacheDir, 0o755)
	sum := sha1.Sum([]byte(audioPath))
	key := hex.EncodeToString(sum[:])[:16]
	out := filepath.Join(cacheDir, fmt.Sprintf("%s_%d_%d.jpg", key, st.ModTime().Unix(), size))

	muIface, _ := thumbLocks.LoadOrStore(out, &sync.Mutex{})
	mu := muIface.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()

	if fi, err := os.Stat(out); err == nil && fi.Size() > 0 {
		return out
	}

	data, err := taglib.ReadImage(norm.NFC.String(audioPath))
	if err != nil || len(data) == 0 {
		if cover := folderCoverPath(audioPath); cover != "" {
			data, _ = os.ReadFile(cover)
		}
	}
	if len(data) == 0 {
		return ""
	}
	// Drop stale thumbs for this file (older mtimes / other sizes stay valid
	// per-size; only same-size older-mtime entries are junk).
	if old, err := filepath.Glob(filepath.Join(cacheDir, fmt.Sprintf("%s_*_%d.jpg", key, size))); err == nil {
		for _, f := range old {
			if f != out {
				os.Remove(f)
			}
		}
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		// Undecodable (e.g. webp) — serve the original bytes; browsers sniff.
		tmp := out + ".part"
		if os.WriteFile(tmp, data, 0o644) == nil && os.Rename(tmp, out) == nil {
			return out
		}
		return ""
	}
	b := img.Bounds()
	wpx, hpx := b.Dx(), b.Dy()
	if wpx > size || hpx > size {
		scale := float64(size) / float64(wpx)
		if hpx > wpx {
			scale = float64(size) / float64(hpx)
		}
		nw, nh := int(float64(wpx)*scale+0.5), int(float64(hpx)*scale+0.5)
		dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
		xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), img, b, xdraw.Over, nil)
		img = dst
	}
	tmp := out + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return ""
	}
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 82}); err != nil {
		f.Close()
		os.Remove(tmp)
		return ""
	}
	f.Close()
	if os.Rename(tmp, out) != nil {
		return ""
	}
	return out
}

func serveArtistArt(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" || libDB == nil {
		http.NotFound(w, r)
		return
	}
	col := "path"
	if r.URL.Query().Get("kind") == "banner" {
		col = "banner"
	}
	var p string
	libDB.QueryRow("SELECT COALESCE("+col+",'') FROM artist_art WHERE name=?", name).Scan(&p)
	if strings.TrimSpace(p) == "" {
		http.NotFound(w, r)
		return
	}
	if _, err := os.Stat(p); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
	http.ServeFile(w, r, p)
}

var transcodeLocks sync.Map // trackID -> *sync.Mutex

// ensureTranscoded converts a track to FLAC (fast to encode, natively
// playable, lossless) in the app cache and returns the cached path. The
// cache key includes the source mtime so edited files re-transcode.
func ensureTranscoded(id int64, src string) (string, error) {
	st, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	dir, err := EnsureAppDir()
	if err != nil {
		return "", err
	}
	cacheDir := filepath.Join(dir, "transcode")
	os.MkdirAll(cacheDir, 0o755)
	out := filepath.Join(cacheDir, fmt.Sprintf("%d_%d.flac", id, st.ModTime().Unix()))

	muIface, _ := transcodeLocks.LoadOrStore(id, &sync.Mutex{})
	mu := muIface.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()

	if fi, err := os.Stat(out); err == nil && fi.Size() > 0 {
		return out, nil
	}
	ffmpeg, err := GetFFmpegPath()
	if err != nil {
		return "", fmt.Errorf("FFmpeg is required to play this format (install it in Settings)")
	}
	// Stale cache entries for this track (older mtimes) can go.
	if old, err := filepath.Glob(filepath.Join(cacheDir, fmt.Sprintf("%d_*.flac", id))); err == nil {
		for _, f := range old {
			os.Remove(f)
		}
	}
	tmp := out + ".part"
	cmd := exec.Command(ffmpeg, "-y", "-i", src, "-vn", "-acodec", "flac", "-compression_level", "0", "-f", "flac", tmp)
	setHideWindow(cmd)
	if outb, err := cmd.CombinedOutput(); err != nil {
		os.Remove(tmp)
		tail := string(outb)
		if len(tail) > 300 {
			tail = tail[len(tail)-300:]
		}
		return "", fmt.Errorf("%v: %s", err, tail)
	}
	if err := os.Rename(tmp, out); err != nil {
		return "", err
	}
	return out, nil
}

// --- Now-playing audio info ---------------------------------------------------

type TrackAudioInfo struct {
	Codec      string `json:"codec"`
	SampleRate int    `json:"sampleRate"` // Hz
	Bitrate    int    `json:"bitrate"`    // kbit/s
	BitDepth   int    `json:"bitDepth"`   // 0 when unknown/not applicable (lossy)
}

// flacBitDepth reads bits-per-sample straight out of the STREAMINFO block —
// no external tools needed.
func flacBitDepth(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	hdr := make([]byte, 4+4+34)
	if _, err := f.Read(hdr); err != nil {
		return 0
	}
	if string(hdr[:4]) != "fLaC" {
		return 0
	}
	// hdr[4:8] = first metadata block header (STREAMINFO is always first);
	// STREAMINFO data starts at 8. Bits-per-sample-1 is 5 bits spanning
	// data bytes 12-13 (after 10 bytes of block/frame sizes + 20 bits rate
	// + 3 bits channels).
	d := hdr[8:]
	bps := int((d[12]&0x01)<<4|d[13]>>4) + 1
	if bps < 4 || bps > 32 {
		return 0
	}
	return bps
}

var lossyCodecs = map[string]bool{"mp3": true, "aac": true, "m4a": true, "ogg": true, "opus": true, "oga": true, "wma": true}

// GetTrackAudioInfo returns codec/sample-rate/bitrate (from the library) plus
// bit depth (FLAC header directly; ffprobe for other lossless formats).
func GetTrackAudioInfo(id int64) (TrackAudioInfo, error) {
	var info TrackAudioInfo
	if libDB == nil {
		return info, nil
	}
	var path string
	libDB.QueryRow("SELECT path, codec, sample_rate, bitrate FROM tracks WHERE id=?", id).
		Scan(&path, &info.Codec, &info.SampleRate, &info.Bitrate)
	if path == "" {
		return info, nil
	}
	codec := strings.ToLower(info.Codec)
	switch {
	case codec == "flac":
		info.BitDepth = flacBitDepth(path)
	case lossyCodecs[codec]:
		// bit depth isn't meaningful for lossy codecs
	default:
		if ffprobe, err := GetFFprobePath(); err == nil {
			cmd := exec.Command(ffprobe, "-v", "quiet", "-select_streams", "a:0",
				"-show_entries", "stream=bits_per_raw_sample,bits_per_sample", "-of", "json", path)
			setHideWindow(cmd)
			if out, err := cmd.Output(); err == nil {
				var parsed struct {
					Streams []struct {
						BitsPerRawSample string `json:"bits_per_raw_sample"`
						BitsPerSample    int    `json:"bits_per_sample"`
					} `json:"streams"`
				}
				if json.Unmarshal(out, &parsed) == nil && len(parsed.Streams) > 0 {
					s := parsed.Streams[0]
					if n, err := strconv.Atoi(s.BitsPerRawSample); err == nil && n > 0 {
						info.BitDepth = n
					} else if s.BitsPerSample > 0 {
						info.BitDepth = s.BitsPerSample
					}
				}
			}
		}
	}
	return info, nil
}

// --- Waveform peaks -----------------------------------------------------------

const waveformBuckets = 480

// Bump when the peak algorithm changes so cached waveforms regenerate.
const waveformVersion = 2

func ensureWaveformTable() {
	if libDB == nil {
		return
	}
	libDB.Exec(`CREATE TABLE IF NOT EXISTS waveforms (
		track_id INTEGER PRIMARY KEY,
		mtime INTEGER NOT NULL,
		ver INTEGER NOT NULL DEFAULT 0,
		peaks TEXT NOT NULL
	)`)
	libDB.Exec("ALTER TABLE waveforms ADD COLUMN ver INTEGER NOT NULL DEFAULT 0")
}

var waveformLocks sync.Map // trackID -> *sync.Mutex

// GetTrackWaveform returns ~480 normalized peaks (0..1) for the track,
// generating and caching them on first request. Returns nil when FFmpeg is
// unavailable — the UI falls back to a plain seek bar.
func GetTrackWaveform(id int64) ([]float64, error) {
	if libDB == nil {
		return nil, nil
	}
	p := trackPathByID(id)
	if p == "" {
		return nil, nil
	}
	st, err := os.Stat(p)
	if err != nil {
		return nil, nil
	}
	ensureWaveformTable()

	muIface, _ := waveformLocks.LoadOrStore(id, &sync.Mutex{})
	mu := muIface.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()

	var mtime int64
	var ver int
	var peaksJSON string
	libDB.QueryRow("SELECT mtime, COALESCE(ver,0), peaks FROM waveforms WHERE track_id=?", id).Scan(&mtime, &ver, &peaksJSON)
	if mtime == st.ModTime().Unix() && ver == waveformVersion && peaksJSON != "" {
		var peaks []float64
		if json.Unmarshal([]byte(peaksJSON), &peaks) == nil && len(peaks) > 0 {
			return peaks, nil
		}
	}

	ffmpeg, err := GetFFmpegPath()
	if err != nil {
		return nil, nil
	}
	// Mono 4 kHz 16-bit PCM is plenty of resolution for 480 visual buckets
	// and keeps decode fast even for long tracks.
	cmd := exec.Command(ffmpeg, "-i", p, "-ac", "1", "-ar", "4000", "-f", "s16le", "-v", "quiet", "-")
	setHideWindow(cmd)
	raw, err := cmd.Output()
	if err != nil || len(raw) < 2 {
		return nil, nil
	}
	samples := len(raw) / 2
	peaks := make([]float64, waveformBuckets)
	per := samples / waveformBuckets
	if per == 0 {
		per = 1
	}
	// RMS energy per bucket rather than raw peaks: brickwall-mastered tracks
	// have near-constant peaks (a solid block), but their average energy
	// still varies — RMS keeps the waveform readable.
	maxV := 0.0
	for b := 0; b < waveformBuckets; b++ {
		start, end := b*per, (b+1)*per
		if start >= samples {
			break
		}
		if end > samples {
			end = samples
		}
		var sum float64
		for i := start; i < end; i++ {
			v := float64(int16(uint16(raw[2*i]) | uint16(raw[2*i+1])<<8)) / 32768.0
			sum += v * v
		}
		if end > start {
			peaks[b] = math.Sqrt(sum / float64(end-start))
		}
		if peaks[b] > maxV {
			maxV = peaks[b]
		}
	}
	if maxV > 0 {
		for i := range peaks {
			// Normalize, then a contrast curve so dense masters still show
			// their quieter passages instead of rendering as a solid block.
			peaks[i] = math.Pow(peaks[i]/maxV, 1.6)
		}
	}
	if buf, err := json.Marshal(peaks); err == nil {
		libDB.Exec("INSERT OR REPLACE INTO waveforms(track_id, mtime, ver, peaks) VALUES(?,?,?,?)", id, st.ModTime().Unix(), waveformVersion, string(buf))
	}
	return peaks, nil
}
