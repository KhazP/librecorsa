package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// appFixture is a launcher with the import folder's API and the app's, its folders opened into a list
func appFixture(t *testing.T) (*server, *appAPI, *[]string) {
	t.Helper()
	s, base := convertFixture(t)
	opened := &[]string{}
	f := newUpdateFixture(t, "0.2.0")
	a := &appAPI{
		folders: map[string]string{"mods": filepath.Join(base, "mods"), "import": filepath.Join(base, "import")},
		life:    newLifetime(false, nil, nil),
		updates: f.u,
		busy:    func() bool { return s.imports.jobs.running() },
		open: func(dir string) error {
			*opened = append(*opened, dir)
			return nil
		},
	}
	s.enableApp(a)
	return s, a, opened
}

func TestOpenFolder(t *testing.T) {
	s, a, opened := appFixture(t)
	if w := call(s, http.MethodPost, openFolderPath, `{"folder":"mods"}`); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if w := call(s, http.MethodPost, openFolderPath, `{"folder":"import"}`); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if strings.Join(*opened, "|") != a.folders["mods"]+"|"+a.folders["import"] {
		t.Errorf("opened %v", *opened)
	}
	// Only those two, by name; never a path, nor with the checks every call passes missing
	cases := []struct {
		name   string
		body   string
		header []string
		want   int
	}{
		{"a path", `{"folder":"/etc"}`, nil, http.StatusBadRequest},
		{"a parent", `{"folder":"../mods"}`, nil, http.StatusBadRequest},
		{"the toolchain", `{"folder":"toolchain"}`, nil, http.StatusBadRequest},
		{"another field", `{"folder":"mods","path":"/etc"}`, nil, http.StatusBadRequest},
		{"no session", `{"folder":"mods"}`, []string{"-Cookie"}, http.StatusForbidden},
		{"no header", `{"folder":"mods"}`, []string{"-" + apiHeader}, http.StatusForbidden},
		{"another origin", `{"folder":"mods"}`, []string{"Origin", "http://evil.example"}, http.StatusForbidden},
		{"no origin", `{"folder":"mods"}`, []string{"-Origin"}, http.StatusForbidden},
		{"another site", `{"folder":"mods"}`, []string{"Sec-Fetch-Site", "cross-site"}, http.StatusForbidden},
		{"a form", "folder=mods", []string{"Content-Type", "application/x-www-form-urlencoded"}, http.StatusUnsupportedMediaType},
	}
	for _, c := range cases {
		if w := call(s, http.MethodPost, openFolderPath, c.body, c.header...); w.Code != c.want {
			t.Errorf("%s: %d %s, want %d", c.name, w.Code, strings.TrimSpace(w.Body.String()), c.want)
		}
	}
	if w := call(s, http.MethodGet, openFolderPath, ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d", w.Code)
	}
	if len(*opened) != 2 {
		t.Errorf("a refused call opened something: %v", *opened)
	}
	// A folder that went is made again, and a file manager that won't start says so
	os.RemoveAll(a.folders["mods"])
	a.open = func(string) error { return errors.New("no file manager") }
	w := call(s, http.MethodPost, openFolderPath, `{"folder":"mods"}`)
	if w.Code != http.StatusInternalServerError || decode[map[string]string](t, w)["code"] != "open-failed" {
		t.Errorf("a failure: %d %s", w.Code, w.Body)
	}
	if info, err := os.Stat(a.folders["mods"]); err != nil || !info.IsDir() {
		t.Error("the mods folder wasn't made again")
	}
}

func TestAliveKeepsTheLauncher(t *testing.T) {
	s, a, _ := appFixture(t)
	if w := call(s, http.MethodPost, alivePath, `{"page":"page-abc-123"}`); w.Code != http.StatusNoContent {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	// Any window of the game counts, without the session; another site's page doesn't
	if w := call(s, http.MethodPost, alivePath, `{"page":"page-def-456"}`, "-Cookie"); w.Code != http.StatusNoContent {
		t.Errorf("without the session: %d %s", w.Code, w.Body)
	}
	if len(a.life.pages) != 2 {
		t.Errorf("pages %v", a.life.pages)
	}
	if w := call(s, http.MethodPost, alivePath, `{"page":"page-abc-123","closing":true}`); w.Code != http.StatusNoContent {
		t.Errorf("closing: %d", w.Code)
	}
	if _, ok := a.life.pages["page-abc-123"]; ok || len(a.life.pages) != 1 {
		t.Errorf("a closed page is still counted: %v", a.life.pages)
	}
	for name, c := range map[string]struct {
		body   string
		header []string
	}{
		"another origin":  {`{"page":"page-xyz-789"}`, []string{"Origin", "http://evil.example"}},
		"no header":       {`{"page":"page-xyz-789"}`, []string{"-" + apiHeader}},
		"another site":    {`{"page":"page-xyz-789"}`, []string{"Sec-Fetch-Site", "cross-site"}},
		"a rebinding":     {`{"page":"page-xyz-789"}`, []string{"Host", "evil.example"}},
		"a bad id":        {`{"page":"<script>"}`, nil},
		"a short id":      {`{"page":"x"}`, nil},
		"no id":           {`{}`, nil},
		"another field":   {`{"page":"page-xyz-789","pid":1}`, nil},
		"not JSON at all": {`page=page-xyz-789`, []string{"Content-Type", "application/x-www-form-urlencoded"}},
	} {
		if w := call(s, http.MethodPost, alivePath, c.body, c.header...); w.Code < 400 {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	if len(a.life.pages) != 1 {
		t.Errorf("a refused call counted: %v", a.life.pages)
	}
}

func TestUpdateAPI(t *testing.T) {
	s, a, _ := appFixture(t)
	info := decode[updateInfo](t, call(s, http.MethodGet, updatePath, ""))
	if info.Version != "0.2.0" || info.State != updateNone || info.Run == "" || !strings.HasPrefix(info.ReleaseURL, releasesPage) {
		t.Errorf("info %+v", info)
	}
	if w := call(s, http.MethodGet, updatePath, "", "-Cookie"); w.Code != http.StatusForbidden {
		t.Errorf("without the session: %d", w.Code)
	}
	// Nothing to restart for
	w := call(s, http.MethodPost, restartPath, "")
	if w.Code != http.StatusConflict || decode[map[string]string](t, w)["code"] != "not-ready" {
		t.Errorf("restart with nothing staged: %d %s", w.Code, w.Body)
	}
	// Staged
	u := a.updates
	writeFiles(t, filepath.Join(u.stagedDir(), "LibreCorsa"), map[string]string{"librecorsa": "x", "game/index.html": "x"})
	writeFiles(t, u.dir, map[string]string{"staged.json": `{"version":"0.3.0","platform":"linux/amd64"}`})
	if info := decode[updateInfo](t, call(s, http.MethodGet, updatePath, "")); info.State != updateReady || info.Latest != "0.3.0" {
		t.Errorf("staged: %+v", info)
	}
	for name, c := range map[string][]string{
		"no session":     {"-Cookie"},
		"another origin": {"Origin", "http://evil.example"},
		"no header":      {"-" + apiHeader},
	} {
		if w := call(s, http.MethodPost, restartPath, "", c...); w.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, w.Code)
		}
	}
	select {
	case <-u.restartRequested():
		t.Fatal("a refused call asked for the restart")
	default:
	}
	// Not under a conversion
	if w := call(s, http.MethodPost, convertPath, `{"folder":"slow_circuit"}`); w.Code != http.StatusAccepted {
		t.Fatalf("convert: %d %s", w.Code, w.Body)
	}
	if w := call(s, http.MethodPost, restartPath, ""); w.Code != http.StatusConflict {
		t.Errorf("restart under a conversion: %d", w.Code)
	}
	call(s, http.MethodPost, cancelPath, "")
	waitJob(t, s)
	if w := call(s, http.MethodPost, restartPath, ""); w.Code != http.StatusAccepted {
		t.Fatalf("restart: %d %s", w.Code, w.Body)
	}
	select {
	case <-u.restartRequested():
	case <-time.After(time.Second):
		t.Fatal("the restart wasn't asked for")
	}
}

func TestAppPathsWithoutTheApp(t *testing.T) {
	s, _ := convertFixture(t)
	for p := range appMethods {
		if w := call(s, http.MethodPost, p, "{}"); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d", p, w.Code)
		}
	}
}

func TestOpenFolderCommand(t *testing.T) {
	env := func(k string) string { return map[string]string{"SystemRoot": `D:\Win`}[k] }
	found := func(name string) (string, error) { return "/usr/bin/" + name, nil }
	missing := func(name string) (string, error) { return "", fmt.Errorf("no %s", name) }
	if name, args, _ := openFolderCommand("darwin", "/Users/p/Documents/LibreCorsa/mods", env, found); name != "/usr/bin/open" || len(args) != 1 || args[0] != "/Users/p/Documents/LibreCorsa/mods" {
		t.Errorf("darwin: %s %v", name, args)
	}
	if name, args, _ := openFolderCommand("windows", `C:\Users\p\Documents\LibreCorsa\mods`, env, found); !strings.HasSuffix(name, "explorer.exe") || !strings.HasPrefix(name, `D:\Win`) || args[0] != `C:\Users\p\Documents\LibreCorsa\mods` {
		t.Errorf("windows: %s %v", name, args)
	}
	if name, args, _ := openFolderCommand("linux", "/home/p/Documents/LibreCorsa/mods", env, found); name != "/usr/bin/xdg-open" || args[0] != "/home/p/Documents/LibreCorsa/mods" {
		t.Errorf("linux: %s %v", name, args)
	}
	if _, _, err := openFolderCommand("linux", "/x", env, missing); err == nil {
		t.Error("linux without xdg-open")
	}
}
