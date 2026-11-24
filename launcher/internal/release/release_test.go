package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	order := []string{"0.1.0", "0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.beta", "0.2.0-beta", "0.2.0-beta.2", "0.2.0-beta.11", "0.2.0-rc.1", "0.2.0", "0.2.1", "0.10.0", "1.0.0"}
	for i := range order {
		for j := range order {
			a, err := ParseVersion(order[i])
			if err != nil {
				t.Fatal(err)
			}
			b, _ := ParseVersion(order[j])
			want := cmpInt(i, j)
			if got := Compare(a, b); got != want {
				t.Errorf("Compare(%s, %s) = %d, want %d", order[i], order[j], got, want)
			}
		}
	}
}

func TestNewerRefusesDowngradesAndJunk(t *testing.T) {
	cases := []struct {
		candidate, current string
		newer, err         bool
	}{
		{"0.3.0", "0.2.0", true, false},
		{"0.2.0", "0.2.0", false, false},
		{"0.1.9", "0.2.0", false, false},
		{"0.2.0-rc.1", "0.2.0", false, false},
		{"0.2.0", "0.2.0-rc.1", true, false},
		{"0.3.0", "dev", false, true},
		{"v0.3.0", "0.2.0", false, true},
		{"0.3", "0.2.0", false, true},
		{"0.3.0+build", "0.2.0", false, true},
		{"01.3.0", "0.2.0", false, true},
		{"0.3.0-01", "0.2.0", false, true},
		{"0.3.0 ", "0.2.0", false, true},
	}
	for _, c := range cases {
		newer, err := Newer(c.candidate, c.current)
		if newer != c.newer || (err != nil) != c.err {
			t.Errorf("Newer(%q, %q) = %v, %v", c.candidate, c.current, newer, err)
		}
	}
}

func TestSignAndVerify(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	key, err := ParsePrivateKey(FormatPrivateKey(priv))
	if err != nil || !key.Equal(priv) {
		t.Fatalf("private key round trip: %v", err)
	}
	// As keygen writes it: comments (with commas in them), then the key
	keys, err := ParsePublicKeys("# The launcher's update key (Ed25519, base64), made by keygen\n" + FormatPublicKey(otherPub) + "\n\n" + FormatPublicKey(pub) + "\n")
	if err != nil || len(keys) != 2 {
		t.Fatalf("ParsePublicKeys: %v (%d keys)", err, len(keys))
	}
	manifest := []byte(`{"app":"librecorsa-launcher","format":1,"version":"1.0.0","platforms":{}}`)
	sig := Sign(key, manifest)
	if err := Verify(keys, manifest, sig); err != nil {
		t.Fatalf("a good signature: %v", err)
	}
	if err := Verify(keys[:1], manifest, sig); err != ErrBadSignature {
		t.Errorf("another key's: %v", err)
	}
	tampered := []byte(strings.Replace(string(manifest), "1.0.0", "9.0.0", 1))
	if err := Verify(keys, tampered, sig); err != ErrBadSignature {
		t.Errorf("a changed manifest: %v", err)
	}
	for _, bad := range []string{"", "not base64!", "AAAA", strings.Repeat("A", 2000)} {
		if err := Verify(keys, manifest, []byte(bad)); err != ErrBadSignature {
			t.Errorf("signature %.20q: %v", bad, err)
		}
	}
	if err := Verify(nil, manifest, sig); err == nil {
		t.Error("no keys verified something")
	}
	if _, err := ParsePublicKeys("AAAA"); err == nil {
		t.Error("a short key was read")
	}
	if keys, err := ParsePublicKeys(FormatPublicKey(pub) + "," + FormatPublicKey(otherPub)); err != nil || len(keys) != 2 {
		t.Errorf("a comma-separated list: %v", err)
	}
}

func TestParseManifest(t *testing.T) {
	good := `{"app":"librecorsa-launcher","format":1,"version":"0.3.0","released":"2026-11-24","future":"ignored",
		"platforms":{"darwin/arm64":{"url":"https://example.org/a.zip","size":10,"sha256":"` + strings.Repeat("a", 64) + `"}}}`
	m, err := ParseManifest([]byte(good))
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "0.3.0" || m.Platforms["darwin/arm64"].Size != 10 {
		t.Errorf("read %+v", m)
	}
	for name, bad := range map[string]string{
		"another app":     strings.Replace(good, `"librecorsa-launcher"`, `"other"`, 1),
		"another format":  strings.Replace(good, `"format":1`, `"format":2`, 1),
		"a bad version":   strings.Replace(good, `"0.3.0"`, `"latest"`, 1),
		"http":            strings.Replace(good, "https://", "http://", 1),
		"no size":         strings.Replace(good, `"size":10`, `"size":0`, 1),
		"a short hash":    strings.Replace(good, strings.Repeat("a", 64), strings.Repeat("a", 63), 1),
		"an upper hash":   strings.Replace(good, strings.Repeat("a", 64), strings.Repeat("A", 64), 1),
		"not JSON":        "{",
		"a huge manifest": strings.Repeat(" ", MaxManifestBytes+1) + good,
	} {
		if _, err := ParseManifest([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	enc, err := m.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if again, err := ParseManifest(enc); err != nil || again.Version != m.Version {
		t.Errorf("encode round trip: %v", err)
	}
}

func TestTargets(t *testing.T) {
	tg, ok := FindTarget("darwin", "arm64")
	if !ok || tg.ArchiveName("0.3.0") != "LibreCorsa-0.3.0-mac-arm64.zip" || tg.Platform() != "darwin/arm64" {
		t.Errorf("darwin/arm64: %+v", tg)
	}
	if tg, _ := FindTarget("linux", "amd64"); tg.ArchiveName("1.0.0") != "LibreCorsa-1.0.0-linux-x64.tar.gz" {
		t.Errorf("linux: %s", tg.ArchiveName("1.0.0"))
	}
	if _, ok := FindTarget("plan9", "386"); ok {
		t.Error("plan9 has a target")
	}
}
