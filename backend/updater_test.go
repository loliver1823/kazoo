package backend

import "testing"

func TestVersionNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v1.0.1", "1.0.0", true},
		{"1.0.0", "1.0.0", false},
		{"v1.0.0", "v1.0.1", false},
		{"v1.1.0", "1.0.9", true},
		{"v2.0.0", "1.9.9", true},
		{"v1.0.0.1", "1.0.0", true},
		{"v1.0", "1.0.0", false},
		{"v1.0.1-beta", "1.0.0", true},
		{"garbage", "1.0.0", false},
		{"v1.0.1", "dev", false},
	}
	for _, c := range cases {
		if got := versionNewer(c.latest, c.current); got != c.want {
			t.Errorf("versionNewer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestParseVersion(t *testing.T) {
	if parseVersion("dev") != nil {
		t.Error("dev should not parse as a version")
	}
	if v := parseVersion("v1.2.3"); len(v) != 3 || v[0] != 1 || v[1] != 2 || v[2] != 3 {
		t.Errorf("parseVersion(v1.2.3) = %v", v)
	}
}

func TestExpectedAssetName(t *testing.T) {
	// Sanity: always returns one of the published asset names.
	name := expectedAssetName()
	switch name {
	case "Kazoo.exe", "Kazoo.dmg", "Kazoo.AppImage", "Kazoo-ARM.AppImage":
	default:
		t.Errorf("unexpected asset name %q", name)
	}
}
