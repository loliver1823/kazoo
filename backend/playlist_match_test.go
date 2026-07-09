package backend

import "testing"

func lm(title, artist, album string, durSecs int) localMatchTrack {
	return localMatchTrack{
		track:         LibraryTrack{Title: title, Artist: artist, Album: album},
		normTitle:     normalizeMatch(title),
		normTitleCore: normalizeMatch(stripVersionTail(title)),
		normArtists:   map[string]bool{normalizeMatch(artist): true},
		normAlbum:     normalizeMatch(album),
		durationMs:    int64(durSecs) * 1000,
	}
}

func scoreRef(name string, artists []string, album string, durMs int64, l localMatchTrack) float64 {
	refArtists := map[string]bool{}
	for _, a := range artists {
		refArtists[normalizeMatch(a)] = true
	}
	return scoreMatch(normalizeMatch(name), normalizeMatch(stripVersionTail(name)), refArtists, normalizeMatch(album), durMs, &l)
}

func TestNormalizeMatchFoldsUnicodePunctuation(t *testing.T) {
	// Library tags carry U+2010 hyphens and curly apostrophes; Spotify sends ASCII.
	if normalizeMatch("blink‐182") != normalizeMatch("blink-182") {
		t.Error("U+2010 hyphen should fold to ASCII")
	}
	if normalizeMatch("M+M’s") != normalizeMatch("M+M's") {
		t.Error("curly apostrophe should fold to ASCII")
	}
}

func TestStripVersionTail(t *testing.T) {
	cases := map[string]string{
		"Down - Single Version":         "Down",
		"Josie - Radio Edit":            "Josie",
		"All The Small Things":          "All The Small Things",
		"Adam's Song (Remastered 2019)": "Adam's Song",
		"Greatest Hits [International Version (Explicit)]": "Greatest Hits",
	}
	for in, want := range cases {
		if got := stripVersionTail(in); got != want {
			t.Errorf("stripVersionTail(%q) = %q, want %q", in, got, want)
		}
	}
}

// The exact real-world misses: Greatest Hits playlist refs against library
// rows tagged with U+2010 in the artist and version suffixes in ref titles.
func TestScoreMatchRealWorldMisses(t *testing.T) {
	album := "Greatest Hits [International Version (Explicit)]"
	cases := []struct {
		name  string
		durMs int64
		local localMatchTrack
	}{
		{"Down - Single Version", 193000, lm("Down", "blink‐182", "Greatest Hits", 193)},
		{"Josie - Radio Edit", 185000, lm("Josie", "blink‐182", "Greatest Hits", 185)},
		{"M+M's", 155000, lm("M+M’s", "blink‐182", "Greatest Hits", 155)},
		{"Man Overboard", 166000, lm("Man Overboard", "blink‐182", "Greatest Hits", 166)},
	}
	for _, c := range cases {
		if s := scoreRef(c.name, []string{"blink-182"}, album, c.durMs, c.local); s < 0.5 {
			t.Errorf("%q vs %q scored %.2f — should match (>= 0.5)", c.name, c.local.track.Title, s)
		}
	}
}
