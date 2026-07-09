package backend

// Cover-art handling for the library: detect folder covers (cover.jpg/folder.jpg),
// embed image bytes into FLAC/MP3 (FFmpeg fallback for the rest), and load an
// image from a local path or URL with its resolution for the editor.

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "image/gif"
	_ "image/png"

	"github.com/bogem/id3v2/v2"
	"github.com/go-flac/flacpicture"
	flac "github.com/go-flac/go-flac"
	"go.senan.xyz/taglib"
	_ "golang.org/x/image/webp"
	"golang.org/x/text/unicode/norm"
)

type ImageInfo struct {
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Format  string `json:"format"`
	DataURL string `json:"dataUrl"`
}

var coverFileNames = []string{"cover", "folder", "front", "album", "albumart", "albumartsmall"}
var coverExts = []string{".jpg", ".jpeg", ".png", ".webp"}

// folderCoverPath returns a sidecar cover image in the track's directory, if any.
func folderCoverPath(trackPath string) string {
	dir := filepath.Dir(trackPath)
	for _, name := range coverFileNames {
		for _, ext := range coverExts {
			p := filepath.Join(dir, name+ext)
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return p
			}
			// also try a capitalised first letter (Cover.jpg, Folder.png)
			p2 := filepath.Join(dir, strings.ToUpper(name[:1])+name[1:]+ext)
			if fi, err := os.Stat(p2); err == nil && !fi.IsDir() {
				return p2
			}
		}
	}
	return ""
}

// loadImageBytes reads an image from a local path or http(s) URL.
func loadImageBytes(source string) ([]byte, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return nil, fmt.Errorf("no image source")
	}
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") {
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Get(source)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 30<<20)) // 30 MB cap
	}
	return os.ReadFile(norm.NFC.String(source))
}

// toEmbeddable returns image bytes suitable for embedding (JPEG/PNG kept as-is;
// anything else — e.g. webp — is decoded and re-encoded to JPEG) + a mime type.
func toEmbeddable(data []byte) ([]byte, string, error) {
	_, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", fmt.Errorf("not a readable image: %w", err)
	}
	switch format {
	case "jpeg":
		return data, "image/jpeg", nil
	case "png":
		return data, "image/png", nil
	default:
		img, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, "", err
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 92}); err != nil {
			return nil, "", err
		}
		return buf.Bytes(), "image/jpeg", nil
	}
}

// GetImageInfo loads an image (path or URL) and returns its resolution, format,
// and a data URL for preview.
func GetImageInfo(source string) (ImageInfo, error) {
	var info ImageInfo
	data, err := loadImageBytes(source)
	if err != nil {
		return info, err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return info, fmt.Errorf("not a readable image: %w", err)
	}
	mime := "image/" + format
	info = ImageInfo{
		Width:   cfg.Width,
		Height:  cfg.Height,
		Format:  strings.ToUpper(format),
		DataURL: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data),
	}
	return info, nil
}

// embedCoverBytes writes cover art into a single audio file (merge — other tags
// preserved). FLAC and MP3 are handled natively; other formats via FFmpeg.
func embedCoverBytes(filePath string, imgData []byte, mime string) error {
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".flac":
		return embedCoverFlac(filePath, imgData, mime)
	case ".mp3":
		return embedCoverMp3Bytes(filePath, imgData, mime)
	default:
		return embedCoverFFmpeg(filePath, imgData)
	}
}

func embedCoverFlac(filePath string, imgData []byte, mime string) error {
	f, err := flac.ParseFile(filePath)
	if err != nil {
		return err
	}
	pic, err := flacpicture.NewFromImageData(flacpicture.PictureTypeFrontCover, "Front cover", imgData, mime)
	if err != nil {
		return err
	}
	picBlock := pic.Marshal()
	var kept []*flac.MetaDataBlock
	for _, b := range f.Meta {
		if b.Type != flac.Picture {
			kept = append(kept, b)
		}
	}
	f.Meta = append(kept, &picBlock)
	return f.Save(filePath)
}

func embedCoverMp3Bytes(filePath string, imgData []byte, mime string) error {
	tag, err := id3v2.Open(filePath, id3v2.Options{Parse: true})
	if err != nil {
		return err
	}
	defer tag.Close()
	tag.DeleteFrames(tag.CommonID("Attached picture"))
	tag.AddAttachedPicture(id3v2.PictureFrame{
		Encoding:    id3v2.EncodingUTF8,
		MimeType:    mime,
		PictureType: id3v2.PTFrontCover,
		Description: "Front cover",
		Picture:     imgData,
	})
	return tag.Save()
}

func embedCoverFFmpeg(filePath string, imgData []byte) error {
	ffmpeg, err := GetFFmpegPath()
	if err != nil {
		return fmt.Errorf("cover embedding for this format needs FFmpeg: %w", err)
	}
	tmpImg, err := os.CreateTemp("", "art-*.jpg")
	if err != nil {
		return err
	}
	tmpImg.Write(imgData)
	tmpImg.Close()
	defer os.Remove(tmpImg.Name())

	ext := filepath.Ext(filePath)
	tmpOut, err := os.CreateTemp("", "out-*"+ext)
	if err != nil {
		return err
	}
	tmpOut.Close()
	defer os.Remove(tmpOut.Name())

	cmd := exec.Command(ffmpeg, "-y", "-i", filePath, "-i", tmpImg.Name(),
		"-map", "0", "-map", "1", "-c", "copy", "-disposition:v", "attached_pic", tmpOut.Name())
	setHideWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg embed failed: %s", string(out))
	}
	return replaceFile(tmpOut.Name(), filePath)
}

func replaceFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// EmbedFolderCover embeds a sidecar folder cover into a file that has no embedded
// art. Returns true if it embedded one.
func EmbedFolderCover(filePath string) (bool, error) {
	if existing, _ := taglibReadImageSafe(filePath); len(existing) > 0 {
		return false, nil
	}
	cover := folderCoverPath(filePath)
	if cover == "" {
		return false, nil
	}
	data, err := os.ReadFile(cover)
	if err != nil {
		return false, err
	}
	emb, mime, err := toEmbeddable(data)
	if err != nil {
		return false, err
	}
	if err := embedCoverBytes(filePath, emb, mime); err != nil {
		return false, err
	}
	coverMu.Lock()
	delete(coverCache, norm.NFC.String(filePath))
	coverMu.Unlock()
	return true, nil
}

// EmbedCoverFromSource embeds an image (local path or URL) into every given track.
func EmbedCoverFromSource(trackIDs []int64, source string) (int, error) {
	if libDB == nil || len(trackIDs) == 0 {
		return 0, nil
	}
	raw, err := loadImageBytes(source)
	if err != nil {
		return 0, err
	}
	emb, mime, err := toEmbeddable(raw)
	if err != nil {
		return 0, err
	}
	args := make([]any, len(trackIDs))
	for i, id := range trackIDs {
		args[i] = id
	}
	rows, err := libDB.Query("SELECT path FROM tracks WHERE id IN ("+inPlaceholders(len(trackIDs))+")", args...)
	if err != nil {
		return 0, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if rows.Scan(&p) == nil {
			paths = append(paths, p)
		}
	}
	rows.Close()
	count := 0
	for _, p := range paths {
		if err := embedCoverBytes(p, emb, mime); err == nil {
			coverMu.Lock()
			delete(coverCache, norm.NFC.String(p))
			coverMu.Unlock()
			count++
		}
	}
	return count, nil
}

func taglibReadImageSafe(path string) (data []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("read image panic: %v", r)
		}
	}()
	return taglib.ReadImage(norm.NFC.String(path))
}
