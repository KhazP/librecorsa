package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeLauncherEnv makes the test binary act as a launcher just installed by an update (TestMain): "<addr> <version>
// ok|fail". "ok" answers /__launcher at addr with the version and the handoff it was given, for a few seconds;
// "fail" ends at once with an error.
const fakeLauncherEnv = "LIBRECORSA_TEST_FAKE_LAUNCHER"

func fakeLauncher(spec string) int {
	parts := strings.Fields(spec)
	if len(parts) != 3 || parts[2] != "ok" {
		return 3
	}
	h := os.Getenv(handoffEnv)
	ln, err := net.Listen("tcp", parts[0])
	if err != nil {
		return 4
	}
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"app": identityApp, "version": parts[1], "handoff": h})
	}))
	time.Sleep(5 * time.Second)
	return 0
}

// installed is a release in base/<name>, with a launcher and a game saying what they are
func installed(t *testing.T, root, what string) {
	t.Helper()
	writeFiles(t, root, map[string]string{"librecorsa": what, "game/index.html": what, "converter/converter.json": what})
}

func readString(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		return "(" + err.Error() + ")"
	}
	return string(b)
}

func TestSwapAndUndo(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		base := t.TempDir()
		root := filepath.Join(base, "LibreCorsa")
		installed(t, root, "old")
		writeFiles(t, root, map[string]string{"user-notes.txt": "mine"})
		in := &installation{goos: goos, root: root, program: filepath.Join(root, "librecorsa")}

		staged := filepath.Join(base, "staged", "LibreCorsa")
		installed(t, staged, "new")
		applied, err := in.swap(staged)
		if err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		if got := readString(t, filepath.Join(root, "game", "index.html")); got != "new" {
			t.Errorf("%s: the game after the swap is %q", goos, got)
		}
		if got := readString(t, in.program); got != "new" {
			t.Errorf("%s: the launcher after the swap is %q", goos, got)
		}
		if err := applied.undo(); err != nil {
			t.Fatalf("%s: undo: %v", goos, err)
		}
		for _, f := range []string{"librecorsa", "game/index.html", "converter/converter.json"} {
			if got := readString(t, filepath.Join(root, f)); got != "old" {
				t.Errorf("%s: %s after the undo is %q", goos, f, got)
			}
		}
		if got := readString(t, filepath.Join(root, "user-notes.txt")); got != "mine" {
			t.Errorf("%s: a file of the player's after the undo is %q", goos, got)
		}
		leftovers, _ := filepath.Glob(filepath.Join(base, ".*"))
		inside, _ := filepath.Glob(filepath.Join(root, ".update*"))
		if len(leftovers)+len(inside) != 0 {
			t.Errorf("%s: left %v %v", goos, leftovers, inside)
		}

		// Again, kept this time
		installed(t, staged, "new")
		applied, err = in.swap(staged)
		if err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		applied.finish()
		if got := readString(t, in.program); got != "new" {
			t.Errorf("%s: the launcher kept is %q", goos, got)
		}
		leftovers, _ = filepath.Glob(filepath.Join(base, ".*"))
		inside, _ = filepath.Glob(filepath.Join(root, ".update*"))
		if len(leftovers)+len(inside) != 0 {
			t.Errorf("%s: the old release is still there: %v %v", goos, leftovers, inside)
		}
		if _, err := os.Stat(staged); err == nil {
			t.Errorf("%s: the staged release is still there", goos)
		}
	}
}

func TestSwapFailureKeepsTheOldRelease(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("folder permissions")
	}
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	base := t.TempDir()
	parent := filepath.Join(base, "apps")
	root := filepath.Join(parent, "LibreCorsa")
	installed(t, root, "old")
	in := &installation{goos: "linux", root: root, program: filepath.Join(root, "librecorsa")}
	staged := filepath.Join(base, "staged", "LibreCorsa")
	installed(t, staged, "new")
	// The folder the release is in can't be written to
	os.Chmod(parent, 0o555)
	defer os.Chmod(parent, 0o755)
	if _, err := in.swap(staged); err == nil {
		t.Fatal("swapped in a read-only folder")
	}
	if got := readString(t, in.program); got != "old" {
		t.Errorf("the launcher is %q", got)
	}
	if canWrite(parent) {
		t.Error("canWrite says a read-only folder is writable")
	}
}

func TestFindInstallation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("paths")
	}
	base := t.TempDir()
	app := filepath.Join(base, "Applications", "LibreCorsa.app")
	writeFiles(t, app, map[string]string{"Contents/MacOS/librecorsa": "x", "Contents/Resources/game/index.html": "x"})
	in, reason := findInstallation("darwin", filepath.Join(app, "Contents", "MacOS", "librecorsa"))
	if in == nil || in.root != app || reason != "" {
		t.Errorf("an app: %+v %q", in, reason)
	}
	if got := resourcesFor(filepath.Join(app, "Contents", "MacOS")); got != filepath.Join(app, "Contents", "Resources") {
		t.Errorf("resourcesFor: %s", got)
	}

	moved := filepath.Join(base, "AppTranslocation", "X", "d", "LibreCorsa.app")
	writeFiles(t, moved, map[string]string{"Contents/MacOS/librecorsa": "x", "Contents/Resources/game/index.html": "x"})
	if _, reason := findInstallation("darwin", filepath.Join(moved, "Contents", "MacOS", "librecorsa")); reason != reasonTranslocated {
		t.Errorf("translocated: %q", reason)
	}

	folder := filepath.Join(base, "LibreCorsa")
	writeFiles(t, folder, map[string]string{"librecorsa": "x", "game/index.html": "x", "renamed": "x"})
	if in, reason := findInstallation("linux", filepath.Join(folder, "librecorsa")); in == nil || in.root != folder {
		t.Errorf("a folder: %+v %q", in, reason)
	}
	if _, reason := findInstallation("darwin", filepath.Join(folder, "librecorsa")); reason != reasonNotApp {
		t.Errorf("macOS outside an app: %q", reason)
	}
	if _, reason := findInstallation("linux", filepath.Join(folder, "renamed")); reason != reasonLayout {
		t.Errorf("a renamed launcher: %q", reason)
	}
	bare := filepath.Join(base, "bare")
	writeFiles(t, bare, map[string]string{"librecorsa": "x"})
	if _, reason := findInstallation("linux", filepath.Join(bare, "librecorsa")); reason != reasonLayout {
		t.Errorf("no game: %q", reason)
	}
}

func TestTakeHandoff(t *testing.T) {
	t.Setenv(handoffEnv, `{"secret":"abc","browserPid":42,"keepWindow":true,"from":"0.2.0"}`)
	h := takeHandoff()
	if h.Secret != "abc" || h.BrowserPID != 42 || !h.KeepWindow || h.From != "0.2.0" {
		t.Errorf("read %+v", h)
	}
	if _, ok := os.LookupEnv(handoffEnv); ok {
		t.Error("the handoff stays in the environment, for the browser and the converter to see")
	}
	if h := takeHandoff(); h != (handoff{}) {
		t.Errorf("read twice: %+v", h)
	}
	if got := withoutHandoff([]string{"A=1", handoffEnv + "=x", "B=2"}); strings.Join(got, ",") != "A=1,B=2" {
		t.Errorf("withoutHandoff: %v", got)
	}
}

// installFixture is a release installed in base/LibreCorsa and an update staged, whose launcher is the test binary
// acting as one
func installFixture(t *testing.T) (*updater, *stagedUpdate, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the test binary stands in for the new launcher under its Linux name")
	}
	f := newUpdateFixture(t, "0.2.0")
	u := f.u
	root := u.inst.root
	installed(t, root, "old")
	st := &stagedUpdate{Version: "0.3.0", Platform: "linux/amd64", root: filepath.Join(u.stagedDir(), "LibreCorsa")}
	installed(t, st.root, "new")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(self)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(filepath.Join(st.root, "librecorsa"), os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(out, in)
	out.Close()
	os.Chmod(filepath.Join(st.root, "librecorsa"), 0o755)
	b, _ := json.Marshal(st)
	os.WriteFile(u.stagedRecord(), b, 0o600)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return u, st, addr
}

func TestInstallHandsOverToTheNewLauncher(t *testing.T) {
	u, st, addr := installFixture(t)
	t.Setenv(fakeLauncherEnv, addr+" 0.3.0 ok")
	secret := strings.Repeat("ab", 32)
	if err := u.install(st, handoff{Secret: secret, BrowserPID: 7, KeepWindow: true}, "http://"+addr); err != nil {
		t.Fatal(err)
	}
	res, err := http.Get("http://" + addr + identityPath)
	if err != nil {
		t.Fatal(err)
	}
	var id struct{ Handoff string }
	json.NewDecoder(res.Body).Decode(&id)
	res.Body.Close()
	var h handoff
	if err := json.Unmarshal([]byte(id.Handoff), &h); err != nil || h.Secret != secret || h.BrowserPID != 7 || !h.KeepWindow || h.From != "0.2.0" {
		t.Errorf("the new launcher was handed %q", id.Handoff)
	}
	if got := readString(t, filepath.Join(u.inst.root, "game", "index.html")); got != "new" {
		t.Errorf("the game is %q", got)
	}
	if u.pending() != nil || u.failedVersion() != "" {
		t.Error("the update is still pending, or marked failed")
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(u.inst.root), ".LibreCorsa*")); len(leftovers) != 0 {
		t.Errorf("left %v", leftovers)
	}
}

func TestInstallThatFailsKeepsTheOldVersion(t *testing.T) {
	u, st, addr := installFixture(t)
	// The new launcher ends at once
	t.Setenv(fakeLauncherEnv, addr+" 0.3.0 fail")
	err := u.install(st, handoff{}, "http://"+addr)
	if err == nil {
		t.Fatal("installed")
	}
	for _, f := range []string{"librecorsa", "game/index.html", "converter/converter.json"} {
		if got := readString(t, filepath.Join(u.inst.root, f)); got != "old" {
			t.Errorf("%s is %q", f, got)
		}
	}
	if u.failedVersion() != "0.3.0" || u.pending() != nil {
		t.Errorf("failed %q, pending %v", u.failedVersion(), u.pending())
	}
	if info := u.info(); info.State != updateFailed || info.Latest != "0.3.0" {
		t.Errorf("info %+v", info)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(u.inst.root), ".LibreCorsa*")); len(leftovers) != 0 {
		t.Errorf("left %v", leftovers)
	}
}
