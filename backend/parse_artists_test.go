package backend

import (
	"testing"

	"go.senan.xyz/taglib"
)

func rolesOf(artists []TrackArtist) map[string]string {
	m := map[string]string{}
	for _, a := range artists {
		m[a.Name] = a.Role
	}
	return m
}

func TestParseArtistsFirstArtistIsPrimary(t *testing.T) {
	// Multi-value ARTIST tag (Bleachers + Lana Del Rey) on a Bleachers album
	// with no feat clause: Lana co-owns the song (collaboration) but the
	// album must still show under her Appears On, not her own Albums shelf.
	display, artists := parseArtists(map[string][]string{taglib.Artist: {"Bleachers", "Lana Del Rey"}}, "Secret Life", "Bleachers")
	roles := rolesOf(artists)
	if roles["Bleachers"] != RolePrimary {
		t.Errorf("Bleachers should be primary, got %q", roles["Bleachers"])
	}
	if roles["Lana Del Rey"] != RoleCollab {
		t.Errorf("Lana Del Rey should be a collaborator, got %q", roles["Lana Del Rey"])
	}
	if display != "Bleachers, Lana Del Rey" {
		t.Errorf("display = %q, want both names", display)
	}
}

func TestParseArtistsCollabWithSeparateFeature(t *testing.T) {
	// Two bands co-own the song; a third band features. The feat clause
	// decides who is a guest — the other co-writer stays a collaborator.
	display, artists := parseArtists(
		map[string][]string{taglib.Artist: {"State Champs", "Simple Plan", "We The Kings"}},
		"Where I Belong (feat. We The Kings)", "State Champs")
	roles := rolesOf(artists)
	if roles["State Champs"] != RolePrimary {
		t.Errorf("State Champs should be primary, got %q", roles["State Champs"])
	}
	if roles["Simple Plan"] != RoleCollab {
		t.Errorf("Simple Plan should be a collaborator, got %q", roles["Simple Plan"])
	}
	if roles["We The Kings"] != RoleFeaturing {
		t.Errorf("We The Kings should be featuring, got %q", roles["We The Kings"])
	}
	if display != "State Champs, Simple Plan" {
		t.Errorf("display = %q, want co-owners only", display)
	}
}

func TestParseArtistsTitleFeatStillDemotes(t *testing.T) {
	// Title feat outranks the artist tag even for the first-listed guest.
	_, artists := parseArtists(map[string][]string{taglib.Artist: {"Lana Del Rey; Bleachers"}}, "Margaret (feat. Bleachers)", "Lana Del Rey")
	roles := rolesOf(artists)
	if roles["Lana Del Rey"] != RolePrimary {
		t.Errorf("Lana Del Rey should be primary, got %q", roles["Lana Del Rey"])
	}
	if roles["Bleachers"] != RoleFeaturing {
		t.Errorf("Bleachers should be featuring, got %q", roles["Bleachers"])
	}
}

func TestParseArtistsSingleArtistUnchanged(t *testing.T) {
	display, artists := parseArtists(map[string][]string{taglib.Artist: {"blink-182"}}, "Dammit", "blink-182")
	roles := rolesOf(artists)
	if roles["blink-182"] != RolePrimary || display != "blink-182" {
		t.Errorf("single artist mangled: display=%q roles=%v", display, roles)
	}
}

func TestParseArtistsAlbumArtistCredited(t *testing.T) {
	// Album artist differing from the track artist still gets a credit row.
	_, artists := parseArtists(map[string][]string{taglib.Artist: {"Casey Edwards"}}, "Bury the Light", "Devil May Cry")
	roles := rolesOf(artists)
	if roles["Casey Edwards"] != RolePrimary {
		t.Errorf("Casey Edwards should be primary, got %q", roles["Casey Edwards"])
	}
	if roles["Devil May Cry"] != RoleAlbumArtist {
		t.Errorf("album artist should be credited, got %q", roles["Devil May Cry"])
	}
}
