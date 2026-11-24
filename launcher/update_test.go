package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/librecorsa/librecorsa/launcher/internal/release"
)

// The update is tested against a release served over TLS by the test: its manifest signed with a throwaway key, and a
// Linux archive (a .tar.gz) whose launcher is a script that says its version.

// releaseServer serves a release's files by path, and counts what was asked for
type releaseServer struct {
	*httptest.Server
	mu    sync.Mutex
	files map[string][]byte
	asked map[string]int
}

func newReleaseServer(t *testing.T) *releaseServer {
	rs := &releaseServer{files: map[string][]byte{}, asked: map[string]int{}}
	rs.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.mu.Lock()
		rs.asked[r.URL.Path]++
		b, ok := rs.files[r.URL.Path]
		rs.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(rs.Close)
	return rs
}

func (rs *releaseServer) put(path string, b []byte) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	rs.files[path] = b
}

func (rs *releaseServer) times(path string) int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.asked[path]
}

// releaseArchive is a Linux release of version v: its launcher a script saying v, the game beside it
func releaseArchive(t *testing.T, v string) []byte {
	return tarGz(t, [][2]string{
		{"LibreCorsa/librecorsa", "#!/bin/sh\necho \"LibreCorsa launcher " + v + "\"\n"},
		{"LibreCorsa/game/index.html", "<h1>" + v + "</h1>"},
		{"LibreCorsa/converter/converter.json", "{}"},
	})
}

type updateFixture struct {
	rs   *releaseServer
	key  ed25519.PrivateKey
	u    *updater
	base string
}

// newUpdateFixture is a launcher of version current, installed in base/LibreCorsa, that updates from a test server
func newUpdateFixture(t *testing.T, current string) *updateFixture {
	t.Helper()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	rs := newReleaseServer(t)
	base := t.TempDir()
	root := filepath.Join(base, "LibreCorsa")
	writeFiles(t, root, map[string]string{"librecorsa": "old launcher", "game/index.html": "old game"})
	target, _ := release.FindTarget("linux", "amd64")
	u := &updater{
		current: current, run: "run1", target: target, keys: []ed25519.PublicKey{pub}, enabled: true,
		inst:   &installation{goos: "linux", root: root, program: filepath.Join(root, "librecorsa")},
		dir:    filepath.Join(base, "config", "update"),
		client: rs.Client(), restart: make(chan struct{}, 1),
		manifestURL:    rs.URL + "/latest/download/" + release.ManifestName,
		apiURL:         rs.URL + "/api/releases",
		downloadPrefix: rs.URL + "/download/",
		status:         updateInfo{State: updateNone},
	}
	return &updateFixture{rs: rs, key: key, u: u, base: base}
}

// publish serves a release of version v as the latest, with archive as its Linux archive (nil: a good one), and the
// manifest changed by edit before it is signed (signed by key, or the fixture's)
func (f *updateFixture) publish(t *testing.T, v string, archive []byte, edit func(m *release.Manifest), key ed25519.PrivateKey) {
	t.Helper()
	if archive == nil {
		archive = releaseArchive(t, v)
	}
	name := "LibreCorsa-" + v + "-linux-x64.tar.gz"
	f.rs.put("/download/launcher-v"+v+"/"+name, archive)
	m := &release.Manifest{App: release.App, Format: release.Format, Version: v, Platforms: map[string]release.Asset{
		"linux/amd64": {URL: f.rs.URL + "/download/launcher-v" + v + "/" + name, Size: int64(len(archive)), SHA256: sha(archive)},
	}}
	if edit != nil {
		edit(m)
	}
	data, err := m.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if key == nil {
		key = f.key
	}
	f.rs.put("/latest/download/"+release.ManifestName, data)
	f.rs.put("/latest/download/"+release.SignatureName, release.Sign(key, data))
}

func (f *updateFixture) archiveAsked(v string) int {
	return f.rs.times("/download/launcher-v" + v + "/LibreCorsa-" + v + "-linux-x64.tar.gz")
}

func skipWithoutSh(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the release's launcher is a shell script")
	}
}

func TestUpdateStagesASignedNewerRelease(t *testing.T) {
	skipWithoutSh(t)
	f := newUpdateFixture(t, "0.2.0")
	f.publish(t, "0.3.0", nil, nil, nil)
	if err := f.u.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	st := f.u.pending()
	if st == nil || st.Version != "0.3.0" {
		t.Fatalf("staged %+v", st)
	}
	if b, err := os.ReadFile(filepath.Join(st.root, "game", "index.html")); err != nil || string(b) != "<h1>0.3.0</h1>" {
		t.Errorf("the staged game: %q %v", b, err)
	}
	info := f.u.info()
	if info.State != updateReady || info.Latest != "0.3.0" || !info.SelfUpdate || !strings.HasSuffix(info.ReleaseURL, "/tag/launcher-v0.3.0") {
		t.Errorf("info %+v", info)
	}
	// Asked again, the same release isn't fetched again
	if err := f.u.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := f.archiveAsked("0.3.0"); n != 1 {
		t.Errorf("the archive was fetched %d times", n)
	}
	// Nothing was left in the downloads or half-unpacked
	for _, left := range []string{"downloads", "staging.partial"} {
		if _, err := os.Stat(filepath.Join(f.u.dir, left)); err == nil {
			t.Errorf("%s left behind", left)
		}
	}
}

func TestUpdateRefusesABadSignature(t *testing.T) {
	f := newUpdateFixture(t, "0.2.0")
	_, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	f.publish(t, "0.3.0", nil, nil, otherKey)
	if err := f.u.check(context.Background()); !errors.Is(err, release.ErrBadSignature) {
		t.Fatalf("signed by another key: %v", err)
	}
	// A manifest changed after it was signed
	f.publish(t, "0.3.0", nil, nil, nil)
	data := f.rs.files["/latest/download/"+release.ManifestName]
	f.rs.put("/latest/download/"+release.ManifestName, []byte(strings.Replace(string(data), "0.3.0", "0.3.1", 1)))
	if err := f.u.check(context.Background()); !errors.Is(err, release.ErrBadSignature) {
		t.Fatalf("a changed manifest: %v", err)
	}
	// No signature at all
	delete(f.rs.files, "/latest/download/"+release.SignatureName)
	if err := f.u.check(context.Background()); err == nil {
		t.Fatal("a manifest without its signature was taken")
	}
	if f.archiveAsked("0.3.0") != 0 || f.u.pending() != nil || f.u.info().State != updateNone {
		t.Errorf("an unsigned release was fetched or staged: %+v", f.u.info())
	}
}

func TestUpdateRefusesSizeOrHashMismatch(t *testing.T) {
	f := newUpdateFixture(t, "0.2.0")
	good := releaseArchive(t, "0.3.0")
	cases := map[string]func(m *release.Manifest){
		"a smaller size": func(m *release.Manifest) {
			a := m.Platforms["linux/amd64"]
			a.Size--
			m.Platforms["linux/amd64"] = a
		},
		"a larger size": func(m *release.Manifest) {
			a := m.Platforms["linux/amd64"]
			a.Size++
			m.Platforms["linux/amd64"] = a
		},
		"another SHA-256": func(m *release.Manifest) {
			a := m.Platforms["linux/amd64"]
			a.SHA256 = sha([]byte("something else"))
			m.Platforms["linux/amd64"] = a
		},
	}
	for name, edit := range cases {
		f.publish(t, "0.3.0", good, edit, nil)
		if err := f.u.check(context.Background()); err == nil {
			t.Errorf("%s: staged", name)
		}
		if f.u.pending() != nil {
			t.Errorf("%s: staged", name)
		}
		if info := f.u.info(); info.State != updateNone || info.Error == "" {
			t.Errorf("%s: %+v", name, info)
		}
	}
	// Bytes other than the manifest's, at its size
	evil := []byte(strings.Repeat("x", len(good)))
	f.publish(t, "0.3.0", good, nil, nil)
	f.rs.put("/download/launcher-v0.3.0/LibreCorsa-0.3.0-linux-x64.tar.gz", evil)
	if err := f.u.check(context.Background()); !errors.Is(err, errHashMismatch) {
		t.Errorf("other bytes: %v", err)
	}
	if _, err := os.Stat(f.u.stagedDir()); err == nil {
		t.Error("something was staged")
	}
}

func TestUpdateRefusesADowngrade(t *testing.T) {
	f := newUpdateFixture(t, "0.2.0")
	for _, v := range []string{"0.2.0", "0.1.9", "0.2.0-rc.1"} {
		f.publish(t, v, nil, nil, nil)
		if err := f.u.check(context.Background()); err != nil {
			t.Errorf("%s: %v", v, err)
		}
		if f.archiveAsked(v) != 0 || f.u.pending() != nil || f.u.info().State != updateNone {
			t.Errorf("%s was fetched or offered: %+v", v, f.u.info())
		}
	}
	// A release staged earlier that isn't newer any more (installed since) is cleared, not installed
	os.MkdirAll(filepath.Join(f.u.stagedDir(), "LibreCorsa"), 0o755)
	os.WriteFile(filepath.Join(f.u.stagedDir(), "LibreCorsa", "librecorsa"), []byte("x"), 0o755)
	b, _ := json.Marshal(stagedUpdate{Version: "0.1.0", Platform: "linux/amd64"})
	os.WriteFile(f.u.stagedRecord(), b, 0o600)
	if f.u.pending() != nil {
		t.Error("an older staged release is pending")
	}
	if _, err := os.Stat(f.u.stagedDir()); err == nil {
		t.Error("the older staged release is still there")
	}
}

func TestUpdateRefusesAnArchiveFromElsewhere(t *testing.T) {
	f := newUpdateFixture(t, "0.2.0")
	f.publish(t, "0.3.0", nil, func(m *release.Manifest) {
		a := m.Platforms["linux/amd64"]
		a.URL = f.rs.URL + "/elsewhere/LibreCorsa-0.3.0-linux-x64.tar.gz"
		m.Platforms["linux/amd64"] = a
	}, nil)
	if err := f.u.check(context.Background()); err == nil || f.u.pending() != nil {
		t.Errorf("an archive outside the releases: %v", err)
	}
}

func TestUpdateRefusesAnUnsafeArchive(t *testing.T) {
	skipWithoutSh(t)
	f := newUpdateFixture(t, "0.2.0")
	evil := tarGz(t, [][2]string{
		{"LibreCorsa/librecorsa", "#!/bin/sh\necho \"LibreCorsa launcher 0.3.0\"\n"},
		{"LibreCorsa/game/index.html", "x"},
		{"LibreCorsa/game/escape", "->/etc/passwd"},
	})
	f.publish(t, "0.3.0", evil, nil, nil)
	if err := f.u.check(context.Background()); !errors.Is(err, errUnsafeArchive) {
		t.Fatalf("a link in the archive: %v", err)
	}
	if f.u.pending() != nil {
		t.Error("staged")
	}
	// A launcher that says another version than the manifest
	f.publish(t, "0.3.0", releaseArchive(t, "0.4.0"), nil, nil)
	if runtime.GOOS == "linux" {
		if err := f.u.check(context.Background()); err == nil || f.u.pending() != nil {
			t.Errorf("a launcher of another version: %v", err)
		}
	}
}

func TestUpdateFindsTheLauncherReleaseBehindAnother(t *testing.T) {
	skipWithoutSh(t)
	f := newUpdateFixture(t, "0.2.0")
	// The latest release is the desktop app's: it has no launcher manifest
	f.publish(t, "0.3.0", nil, nil, nil)
	data := f.rs.files["/latest/download/"+release.ManifestName]
	sig := f.rs.files["/latest/download/"+release.SignatureName]
	delete(f.rs.files, "/latest/download/"+release.ManifestName)
	delete(f.rs.files, "/latest/download/"+release.SignatureName)
	f.rs.put("/download/launcher-v0.3.0/"+release.ManifestName, data)
	f.rs.put("/download/launcher-v0.3.0/"+release.SignatureName, sig)
	f.rs.put("/api/releases", []byte(`[
		{"tag_name":"desktop-v9.0.0","draft":false,"prerelease":false},
		{"tag_name":"launcher-v0.4.0-beta.1","draft":false,"prerelease":true},
		{"tag_name":"launcher-v0.9.0","draft":true,"prerelease":false},
		{"tag_name":"launcher-v0.3.0","draft":false,"prerelease":false},
		{"tag_name":"launcher-v0.2.5","draft":false,"prerelease":false},
		{"tag_name":"launcher-v../../x","draft":false,"prerelease":false}
	]`))
	if err := f.u.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := f.u.pending(); st == nil || st.Version != "0.3.0" {
		t.Errorf("staged %+v", st)
	}
}

func TestUpdateWithoutAKeyOnlySaysANewerReleaseIsOut(t *testing.T) {
	f := newUpdateFixture(t, "0.2.0")
	f.u.keys = nil
	f.u.inst = nil
	f.u.reason = reasonNoKey
	f.publish(t, "0.3.0", nil, nil, nil)
	if err := f.u.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	info := f.u.info()
	if info.State != updateAvailable || info.Latest != "0.3.0" || info.SelfUpdate || info.Reason != reasonNoKey {
		t.Errorf("info %+v", info)
	}
	if f.archiveAsked("0.3.0") != 0 || f.rs.times("/latest/download/"+release.SignatureName) != 0 {
		t.Error("a launcher without a key fetched the release")
	}
}

func TestUpdateThatFailedIsNotTriedAgain(t *testing.T) {
	f := newUpdateFixture(t, "0.2.0")
	f.u.markFailed("0.3.0", errors.New("test"))
	f.publish(t, "0.3.0", nil, nil, nil)
	if err := f.u.check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.archiveAsked("0.3.0") != 0 || f.u.info().State != updateFailed {
		t.Errorf("a failed version was fetched again: %+v", f.u.info())
	}
}

func TestNewUpdaterOnlyWhereItCan(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	key := release.FormatPublicKey(pub)
	cases := []struct {
		name    string
		c       updaterConfig
		enabled bool
		reason  string
	}{
		{"a dev build", updaterConfig{version: "dev", goos: "linux", goarch: "amd64", keys: key}, false, reasonDev},
		{"a clone", updaterConfig{version: "0.2.0", goos: "linux", goarch: "amd64", keys: key, clone: true}, false, reasonDev},
		{"--no-update", updaterConfig{version: "0.2.0", goos: "linux", goarch: "amd64", keys: key, off: true}, false, "off"},
		{"another system", updaterConfig{version: "0.2.0", goos: "plan9", goarch: "386", keys: key}, false, reasonUnsupported},
		{"no key", updaterConfig{version: "0.2.0", goos: "linux", goarch: "amd64"}, true, reasonNoKey},
		{"not a release", updaterConfig{version: "0.2.0", goos: "linux", goarch: "amd64", keys: key, exe: "/nowhere/librecorsa"}, true, reasonLayout},
	}
	for _, c := range cases {
		u := newUpdater(c.c)
		if u.enabled != c.enabled || u.reason != c.reason || u.inst != nil {
			t.Errorf("%s: enabled %v reason %q", c.name, u.enabled, u.reason)
		}
		if u.pending() != nil {
			t.Errorf("%s: something pending", c.name)
		}
	}
}
