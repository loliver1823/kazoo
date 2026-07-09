package backend

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Self-updater: checks GitHub Releases for a newer tag and swaps the running
// binary in place (Windows exe / Linux AppImage). macOS gets the new DMG
// downloaded and opened, since replacing a mounted .app bundle in place is
// not reliable without signing.

const updateRepo = "loliver1823/spindle"

type UpdateInfo struct {
	Available      bool   `json:"available"`
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	ReleaseNotes   string `json:"release_notes"`
	ReleaseURL     string `json:"release_url"`
	AssetURL       string `json:"asset_url"`
	AssetName      string `json:"asset_name"`
}

type ghRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// parseVersion turns "v1.2.3" / "1.2.3" into comparable parts.
func parseVersion(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		// tolerate suffixes like "1.0.0-beta"
		p = strings.SplitN(p, "-", 2)[0]
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func versionNewer(latest, current string) bool {
	l, c := parseVersion(latest), parseVersion(current)
	if l == nil || c == nil {
		return false
	}
	for i := 0; i < len(l) || i < len(c); i++ {
		var lv, cv int
		if i < len(l) {
			lv = l[i]
		}
		if i < len(c) {
			cv = c[i]
		}
		if lv != cv {
			return lv > cv
		}
	}
	return false
}

// expectedAssetName picks the release asset for this platform.
func expectedAssetName() string {
	switch runtime.GOOS {
	case "windows":
		return "Spindle.exe"
	case "darwin":
		return "Spindle.dmg"
	default:
		if runtime.GOARCH == "arm64" {
			return "Spindle-ARM.AppImage"
		}
		return "Spindle.AppImage"
	}
}

func CheckForUpdate() (UpdateInfo, error) {
	info := UpdateInfo{CurrentVersion: strings.TrimPrefix(AppVersion, "v")}
	// Dev builds (no real version) never self-update.
	if parseVersion(AppVersion) == nil {
		return info, nil
	}
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", "https://api.github.com/repos/"+updateRepo+"/releases/latest", nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("User-Agent", "Spindle Music Manager/"+AppVersion)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return info, fmt.Errorf("release check failed: HTTP %d", resp.StatusCode)
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info, err
	}
	info.LatestVersion = strings.TrimPrefix(rel.TagName, "v")
	info.ReleaseNotes = rel.Body
	info.ReleaseURL = rel.HTMLURL
	if !versionNewer(rel.TagName, AppVersion) {
		return info, nil
	}
	want := expectedAssetName()
	for _, a := range rel.Assets {
		if a.Name == want {
			info.Available = true
			info.AssetURL = a.BrowserDownloadURL
			info.AssetName = a.Name
			break
		}
	}
	return info, nil
}

func downloadUpdateAsset(url, dest string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Spindle Music Manager/"+AppVersion)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(dest)
		return err
	}
	return out.Close()
}

// ApplyUpdate downloads the asset and stages the swap. Returns restarting=true
// when the caller should quit the app so the swap can complete.
func ApplyUpdate(assetURL string) (restarting bool, message string, err error) {
	switch runtime.GOOS {
	case "windows":
		exe, err := os.Executable()
		if err != nil {
			return false, "", err
		}
		exe, _ = filepath.EvalSymlinks(exe)
		newExe := exe + ".new"
		if err := downloadUpdateAsset(assetURL, newExe); err != nil {
			return false, "", err
		}
		// A helper batch script waits for this process to release the exe,
		// swaps the files and relaunches.
		bat := filepath.Join(os.TempDir(), "spindle-update.bat")
		script := "@echo off\r\n" +
			":try\r\n" +
			"timeout /t 1 /nobreak >nul\r\n" +
			"move /y \"" + newExe + "\" \"" + exe + "\" >nul 2>&1\r\n" +
			"if errorlevel 1 goto try\r\n" +
			"start \"\" \"" + exe + "\"\r\n" +
			"del \"%~f0\"\r\n"
		if err := os.WriteFile(bat, []byte(script), 0o755); err != nil {
			return false, "", err
		}
		cmd := exec.Command("cmd", "/c", "start", "/min", "", bat)
		setHideWindow(cmd)
		if err := cmd.Start(); err != nil {
			return false, "", err
		}
		return true, "Restarting to finish the update…", nil

	case "linux":
		target := os.Getenv("APPIMAGE")
		if target == "" {
			return false, "", fmt.Errorf("not running from an AppImage — download the update from the releases page")
		}
		newFile := target + ".new"
		if err := downloadUpdateAsset(assetURL, newFile); err != nil {
			return false, "", err
		}
		if err := os.Chmod(newFile, 0o755); err != nil {
			os.Remove(newFile)
			return false, "", err
		}
		if err := os.Rename(newFile, target); err != nil {
			os.Remove(newFile)
			return false, "", err
		}
		cmd := exec.Command(target)
		if err := cmd.Start(); err != nil {
			return false, "", err
		}
		return true, "Restarting to finish the update…", nil

	default: // darwin
		dest := filepath.Join(os.TempDir(), "Spindle.dmg")
		if err := downloadUpdateAsset(assetURL, dest); err != nil {
			return false, "", err
		}
		if err := exec.Command("open", dest).Start(); err != nil {
			return false, "", err
		}
		return false, "Update downloaded — drag Spindle to Applications to finish.", nil
	}
}
