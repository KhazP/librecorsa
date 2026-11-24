package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The test binary stands in for the converter's programs: copied to where the toolchain's Node and uv go, it acts as
// the mod tool (`node <converter>/scripts/mods/mod-tool.mjs import <kind> <source> --out <mods>`) or as uv. It also
// stands in for a launcher an update installed (update_apply_test.go).
func TestMain(m *testing.M) {
	if spec := os.Getenv(fakeLauncherEnv); spec != "" {
		os.Exit(fakeLauncher(spec))
	}
	if len(os.Args) > 1 {
		switch {
		case strings.HasSuffix(filepath.ToSlash(os.Args[1]), "scripts/mods/mod-tool.mjs"):
			os.Exit(fakeModTool(os.Args[2:]))
		case os.Args[1] == "python" || os.Args[1] == "run":
			fmt.Println("uv:", strings.Join(os.Args[1:], " "))
			os.Exit(0)
		}
	}
	os.Exit(m.Run())
}

// fakeModTool imports by the source folder's name: "slow" runs until stopped, "fail" fails the package check, anything
// else writes a package with a personal-use licence
func fakeModTool(args []string) int {
	if len(args) == 2 && args[0] == "check" {
		b, err := os.ReadFile(filepath.Join(args[1], "mod.json"))
		if err != nil || strings.Contains(string(b), `"country":""`) {
			fmt.Println("FAIL  " + args[1])
			fmt.Println("      tracks[0].country: must be a non-empty string")
			return 1
		}
		fmt.Println("OK    " + filepath.Base(args[1]) + " (1 files) in " + args[1])
		return 0
	}
	if len(args) != 5 || args[0] != "import" || args[3] != "--out" {
		fmt.Println("usage: import <kind> <source> --out <mods>, got", args)
		return 2
	}
	kind, source, mods := args[1], args[2], args[4]
	cwd, _ := os.Getwd()
	fmt.Printf("importing %s from %s in %s\n", kind, filepath.Base(source), filepath.Base(cwd))
	fmt.Printf("source path %s\n", source)
	fmt.Printf("NODE_OPTIONS %s\n", map[bool]string{true: "set", false: "unset"}[os.Getenv("NODE_OPTIONS") != ""])
	fmt.Printf("PATH starts with %s\n", strings.Split(os.Getenv("PATH"), string(os.PathListSeparator))[0])
	name := filepath.Base(filepath.Dir(source))
	if !strings.HasSuffix(source, ".glb") {
		name = filepath.Base(source)
	}
	switch {
	case strings.Contains(name, "slow"):
		fmt.Println("working")
		time.Sleep(time.Minute)
		return 0
	case strings.Contains(name, "fail"):
		fmt.Println("FAIL  tests.fail: track_data.json names ring.glb, which isn't there")
		fmt.Fprintln(os.Stderr, "the package has problems")
		return 1
	}
	id := "tests." + strings.ToLower(strings.ReplaceAll(name, "_", "-"))
	dir := filepath.Join(mods, id)
	os.MkdirAll(dir, 0o755)
	country := "Testland"
	if strings.Contains(name, "broken") {
		// Written with a problem, and the importer still says it is done: the launcher's check finds it
		country = ""
	}
	manifest := fmt.Sprintf(`{"format":1,"id":%q,"name":"Converted %s","version":"1.0.0","credit":{"author":"Someone","license":"Personal use only","note":"From the source: for personal use only"},"tracks":[{"id":"ring","name":"Ring","country":%q,"credit":{"author":"Original Studio","license":"All rights reserved"}}]}`, id, name, country)
	os.WriteFile(filepath.Join(dir, "mod.json"), []byte(manifest), 0o644)
	fmt.Println("\x1b[32mOK\x1b[0m    " + id)
	fmt.Println("      Licence: for personal use only, do not redistribute")
	return 0
}

// convertFixture is a launcher with an import folder, a converter and a toolchain set up whose Node is the test binary
func convertFixture(t *testing.T) (*server, string) {
	t.Helper()
	s, base := fixture(t)
	importDir := filepath.Join(base, "import")
	writeFiles(t, importDir, map[string]string{
		"my_circuit/my_circuit.glb":  "glTF",
		"my_circuit/my_circuit.json": "{}",
		"slow_circuit/slow.glb":      "glTF",
		"slow_circuit/slow.json":     "{}",
		"fail_circuit/fail.glb":      "glTF",
		"fail_circuit/fail.json":     "{}",
		"broken_circuit/broken.glb":  "glTF",
		"broken_circuit/broken.json": "{}",
		"random/notes.md":            "",
		"secret.txt":                 secret,
	})
	if err := os.Symlink(filepath.Join(importDir, "my_circuit"), filepath.Join(importDir, "linked_circuit")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}
	convDir := filepath.Join(base, "converter")
	writeFiles(t, convDir, map[string]string{
		"converter.json":                  `{"format":1,"version":"0.2.0","modTool":"scripts/mods/mod-tool.mjs","importers":["blender-track","ac-track"],"python":{"version":"3.14","requirements":["scripts/tracks/requirements.txt"]}}`,
		"scripts/mods/mod-tool.mjs":       "// stands in for the bundle",
		"scripts/tracks/requirements.txt": "numpy==2.4.3\n",
	})
	conv, err := loadConverter(convDir)
	if err != nil {
		t.Fatal(err)
	}
	tc := testToolchain(t, filepath.Join(base, "toolchain"))
	if err := tc.markReady(conv); err != nil {
		t.Fatal(err)
	}
	s.enableImports(importDir, newJobs(importDir, filepath.Join(base, "mods"), conv, tc))
	return s, base
}

// testToolchain is a toolchain whose Node and uv are copies of the test binary
func testToolchain(t *testing.T, dir string) *toolchain {
	t.Helper()
	tc := newToolchain(dir, runtime.GOOS, runtime.GOARCH)
	if !tc.ok {
		tc = newToolchain(dir, "darwin", "arm64")
		tc.ok = true
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{tc.nodePath(), tc.uvPath()} {
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, exe, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	pinProgram(&tc.pins.UV, exe)
	pinProgram(&tc.pins.Node, exe)
	return tc
}

// pinProgram pins b as p's program
func pinProgram(p *pinnedFile, b []byte) {
	p.ProgramSHA256, p.ProgramSize = sha(b), int64(len(b))
}

// call makes an API request as the game's page makes it, in the window the launcher opened (with its session
// cookie), with changes: "-Header" leaves a header out ("-Cookie" the session)
func call(s http.Handler, method, target, body string, header ...string) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.Host = fmt.Sprintf("127.0.0.1:%d", testPort)
	r.Header.Set(apiHeader, "1")
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	if method == http.MethodPost {
		r.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", testPort))
	}
	if srv, ok := s.(*server); ok {
		r.AddCookie(sessionCookie(srv))
	}
	for i := 0; i < len(header); i++ {
		if name, ok := strings.CutPrefix(header[i], "-"); ok {
			r.Header.Del(name)
			continue
		}
		if i+1 < len(header) {
			if header[i] == "Host" {
				r.Host = header[i+1]
			} else {
				r.Header.Set(header[i], header[i+1])
			}
			i++
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

// sessionCookie is the cookie a window the launcher opened holds
func sessionCookie(s *server) *http.Cookie {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, s.session.openURL(fmt.Sprintf("http://127.0.0.1:%d", testPort)), nil)
	s.session.serveOpen(w, r)
	for _, c := range w.Result().Cookies() {
		if c.Name == s.session.cookieName() {
			return c
		}
	}
	panic("no session cookie")
}

type statusAnswer struct {
	Job       *jobStatus    `json:"job"`
	Toolchain toolchainInfo `json:"toolchain"`
	Code      string        `json:"code"`
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("%d %s: %v", w.Code, w.Body.String(), err)
	}
	return v
}

// waitJob polls the status until the job is no longer running
func waitJob(t *testing.T, s http.Handler) *jobStatus {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		st := decode[statusAnswer](t, call(s, http.MethodGet, convertPath, ""))
		if st.Job != nil && st.Job.State != jobRunning {
			return st.Job
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the job didn't finish")
	return nil
}

func TestAPIRefusesOtherPages(t *testing.T) {
	s, _ := convertFixture(t)
	convert := `{"folder":"my_circuit"}`
	cases := []struct {
		name         string
		method, path string
		body         string
		header       []string
		want         int
	}{
		{"list without the session", http.MethodGet, importsPath, "", []string{"-Cookie"}, http.StatusForbidden},
		{"status without the session", http.MethodGet, convertPath, "", []string{"-Cookie"}, http.StatusForbidden},
		{"convert without the session", http.MethodPost, convertPath, convert, []string{"-Cookie"}, http.StatusForbidden},
		{"toolchain without the session", http.MethodPost, toolchainPath, "", []string{"-Cookie"}, http.StatusForbidden},
		{"cancel without the session", http.MethodPost, cancelPath, "", []string{"-Cookie"}, http.StatusForbidden},
		{"convert with another session", http.MethodPost, convertPath, convert, []string{"Cookie", fmt.Sprintf("librecorsa_launcher_%d=%s", testPort, strings.Repeat("0", 64))}, http.StatusForbidden},
		{"list without the header", http.MethodGet, importsPath, "", []string{"-" + apiHeader}, http.StatusForbidden},
		{"status without the header", http.MethodGet, convertPath, "", []string{"-" + apiHeader}, http.StatusForbidden},
		{"header with another value", http.MethodGet, importsPath, "", []string{apiHeader, "yes"}, http.StatusForbidden},
		{"list from another site", http.MethodGet, importsPath, "", []string{"Sec-Fetch-Site", "cross-site"}, http.StatusForbidden},
		{"convert without the header", http.MethodPost, convertPath, convert, []string{"-" + apiHeader}, http.StatusForbidden},
		{"convert without Origin", http.MethodPost, convertPath, convert, []string{"-Origin"}, http.StatusForbidden},
		{"convert from another origin", http.MethodPost, convertPath, convert, []string{"Origin", "http://evil.example"}, http.StatusForbidden},
		{"convert from a null origin", http.MethodPost, convertPath, convert, []string{"Origin", "null"}, http.StatusForbidden},
		{"convert from another port", http.MethodPost, convertPath, convert, []string{"Origin", "http://127.0.0.1:1"}, http.StatusForbidden},
		{"convert from localhost to 127.0.0.1", http.MethodPost, convertPath, convert, []string{"Origin", fmt.Sprintf("http://localhost:%d", testPort)}, http.StatusForbidden},
		{"convert from a same-site page", http.MethodPost, convertPath, convert, []string{"Sec-Fetch-Site", "same-site"}, http.StatusForbidden},
		{"convert by a rebinding name", http.MethodPost, convertPath, convert, []string{"Host", fmt.Sprintf("evil.example:%d", testPort), "Origin", fmt.Sprintf("http://evil.example:%d", testPort)}, http.StatusForbidden},
		{"list by a rebinding name", http.MethodGet, importsPath, "", []string{"Host", "evil.example"}, http.StatusForbidden},
		{"toolchain without Origin", http.MethodPost, toolchainPath, "", []string{"-Origin"}, http.StatusForbidden},
		{"cancel from another origin", http.MethodPost, cancelPath, "", []string{"Origin", "http://evil.example"}, http.StatusForbidden},
		{"convert as a form", http.MethodPost, convertPath, "folder=my_circuit", []string{"Content-Type", "application/x-www-form-urlencoded"}, http.StatusUnsupportedMediaType},
		{"convert as text", http.MethodPost, convertPath, convert, []string{"Content-Type", "text/plain"}, http.StatusUnsupportedMediaType},
		{"convert with other fields", http.MethodPost, convertPath, `{"folder":"my_circuit","argv":["sh"]}`, nil, http.StatusBadRequest},
		{"convert with a body too large", http.MethodPost, convertPath, `{"folder":"` + strings.Repeat("a", 5000) + `"}`, nil, http.StatusBadRequest},
		{"list by POST", http.MethodPost, importsPath, "", nil, http.StatusMethodNotAllowed},
		{"convert by PUT", http.MethodPut, convertPath, convert, nil, http.StatusMethodNotAllowed},
		{"a preflight", http.MethodOptions, convertPath, "", []string{"Access-Control-Request-Method", "POST", "Origin", "http://evil.example"}, http.StatusMethodNotAllowed},
		{"cancel by GET", http.MethodGet, cancelPath, "", nil, http.StatusMethodNotAllowed},
	}
	for _, c := range cases {
		w := call(s, c.method, c.path, c.body, c.header...)
		if w.Code != c.want {
			t.Errorf("%s: %d %s, want %d", c.name, w.Code, strings.TrimSpace(w.Body.String()), c.want)
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("%s: answers with CORS", c.name)
		}
	}
	// None of those started anything
	if st := decode[statusAnswer](t, call(s, http.MethodGet, convertPath, "")); st.Job != nil {
		t.Errorf("a refused call started %+v", st.Job)
	}
	// Other paths still take no POST
	if w := call(s, http.MethodPost, "/mods/_index.json", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST to a file: %d", w.Code)
	}
}

func TestAPIRefusesFoldersOutsideTheImportFolder(t *testing.T) {
	s, base := convertFixture(t)
	names := []string{"", ".", "..", "../mods", "../../etc", "my_circuit/../../mods", "/etc", `..\mods`, "C:", ".hidden",
		"my_circuit/sub", "missing", "secret.txt", "my_circuit\x00", base}
	if _, err := os.Lstat(filepath.Join(base, "import", "linked_circuit")); err == nil {
		names = append(names, "linked_circuit")
	}
	for _, name := range names {
		body, _ := json.Marshal(map[string]string{"folder": name})
		w := call(s, http.MethodPost, convertPath, string(body))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%q: %d %s, want 400", name, w.Code, strings.TrimSpace(w.Body.String()))
		}
	}
	if w := call(s, http.MethodPost, convertPath, `{"folder":"random"}`); w.Code != http.StatusUnprocessableEntity {
		t.Errorf("a folder of no known kind: %d %s", w.Code, w.Body.String())
	}
	if st := decode[statusAnswer](t, call(s, http.MethodGet, convertPath, "")); st.Job != nil {
		t.Errorf("started %+v", st.Job)
	}
}

func TestAPIRefusesALinkInsideTheFolder(t *testing.T) {
	s, base := convertFixture(t)
	if err := os.Symlink(filepath.Join(base, "secret.txt"), filepath.Join(base, "import", "my_circuit", "texture.dds")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	w := call(s, http.MethodPost, convertPath, `{"folder":"my_circuit"}`)
	if w.Code != http.StatusUnprocessableEntity || decode[statusAnswer](t, w).Code != "link" {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
}

func TestImportsList(t *testing.T) {
	s, base := convertFixture(t)
	w := call(s, http.MethodGet, importsPath, "")
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var got struct {
		ImportDir string        `json:"importDir"`
		Folders   []importEntry `json:"folders"`
		Converter struct {
			Available bool     `json:"available"`
			Importers []string `json:"importers"`
		} `json:"converter"`
		Toolchain toolchainInfo `json:"toolchain"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.ImportDir != filepath.Join(base, "import") || !got.Converter.Available || got.Toolchain.State != "ready" {
		t.Errorf("%+v", got)
	}
	kinds := map[string]string{}
	for _, f := range got.Folders {
		kinds[f.Name] = f.Kind
	}
	if kinds["my_circuit"] != kindBlenderTrack || kinds["random"] != kindUnknown || kinds["secret.txt"] != kindFile {
		t.Errorf("kinds %v", kinds)
	}
	if !strings.Contains(get(s, identityPath).Body.String(), `"imports":true`) {
		t.Error("/__launcher doesn't say it has the import folder")
	}
}

func TestConvert(t *testing.T) {
	s, base := convertFixture(t)
	t.Setenv("NODE_OPTIONS", "--require /tmp/evil.js")
	w := call(s, http.MethodPost, convertPath, `{"folder":"my_circuit"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	job := waitJob(t, s)
	log := strings.Join(job.Log, "\n")
	if job.State != jobDone || job.Kind != kindBlenderTrack || job.Folder != "my_circuit" {
		t.Fatalf("%+v\n%s", job, log)
	}
	for _, want := range []string{"importing blender-track from my_circuit.glb in converter", "NODE_OPTIONS unset", "OK    tests.my-circuit"} {
		if !strings.Contains(log, want) {
			t.Errorf("the log hasn't %q:\n%s", want, log)
		}
	}
	if strings.Contains(log, "\x1b[") {
		t.Error("colour codes in the log")
	}
	tc := s.imports.jobs.tc
	if !strings.Contains(log, "PATH starts with "+filepath.Dir(tc.nodePath())) {
		t.Errorf("Node's folder isn't first on PATH:\n%s", log)
	}
	if len(job.Packages) != 1 || job.Packages[0].ID != "tests.my-circuit" || job.Packages[0].Credit.License != "Personal use only" {
		t.Fatalf("packages %+v", job.Packages)
	}
	if c := job.Packages[0].Content; len(c) != 1 || c[0].Credit.License != "All rights reserved" {
		t.Errorf("content %+v", c)
	}
	if len(job.Notes) == 0 || !strings.Contains(job.Notes[0], "personal use") {
		t.Errorf("notes %v", job.Notes)
	}
	if _, err := os.Stat(filepath.Join(base, "mods", "tests.my-circuit", "mod.json")); err != nil {
		t.Error("the package isn't in the mods folder")
	}
	// The importer was given a copy, in the toolchain's staging folder, which is gone once the job ends
	var source string
	for _, l := range job.Log {
		if p, ok := strings.CutPrefix(l, "source path "); ok {
			source = p
		}
	}
	if !strings.HasPrefix(source, s.imports.jobs.stagingDir()+string(filepath.Separator)) || filepath.Base(source) != "my_circuit.glb" {
		t.Errorf("converted %q, not a copy in %s", source, s.imports.jobs.stagingDir())
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Errorf("the copy is left: %v", err)
	}
	// The game lists it on its next start
	if !strings.Contains(get(s, "/mods/_index.json").Body.String(), "tests.my-circuit") {
		t.Error("not in /mods/_index.json")
	}
}

func TestConvertFailureShowsProblems(t *testing.T) {
	s, _ := convertFixture(t)
	if w := call(s, http.MethodPost, convertPath, `{"folder":"fail_circuit"}`); w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	job := waitJob(t, s)
	if job.State != jobFailed || !strings.Contains(job.Error, "exit status 1") || len(job.Packages) != 0 {
		t.Errorf("%+v", job)
	}
	if !strings.Contains(strings.Join(job.Log, "\n"), "FAIL  tests.fail") {
		t.Errorf("the importer's output isn't in the log: %v", job.Log)
	}
}

func TestConvertChecksThePackage(t *testing.T) {
	s, _ := convertFixture(t)
	if w := call(s, http.MethodPost, convertPath, `{"folder":"broken_circuit"}`); w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	job := waitJob(t, s)
	if job.State != jobFailed || len(job.Packages) != 1 || len(job.Problems) != 1 || job.Problems[0] != "tracks[0].country: must be a non-empty string" {
		t.Errorf("%+v", job)
	}
}

func TestOneJobAtATime(t *testing.T) {
	s, _ := convertFixture(t)
	if w := call(s, http.MethodPost, cancelPath, ""); w.Code != http.StatusConflict {
		t.Errorf("cancel with nothing running: %d", w.Code)
	}
	if w := call(s, http.MethodPost, convertPath, `{"folder":"slow_circuit"}`); w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	// Wait for the program to be under way
	deadline := time.Now().Add(20 * time.Second)
	for {
		st := decode[statusAnswer](t, call(s, http.MethodGet, convertPath, ""))
		if strings.Contains(strings.Join(st.Job.Log, "\n"), "working") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the slow conversion didn't start: %+v", st.Job)
		}
		time.Sleep(20 * time.Millisecond)
	}
	for _, c := range []struct{ path, body string }{{convertPath, `{"folder":"my_circuit"}`}, {convertPath, `{"folder":"slow_circuit"}`}, {toolchainPath, ""}} {
		w := call(s, http.MethodPost, c.path, c.body)
		if w.Code != http.StatusConflict || decode[statusAnswer](t, w).Code != "busy" {
			t.Errorf("%s %s while one runs: %d %s", c.path, c.body, w.Code, w.Body.String())
		}
	}
	started := time.Now()
	if w := call(s, http.MethodPost, cancelPath, ""); w.Code != http.StatusOK {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}
	job := waitJob(t, s)
	if job.State != jobCancelled || job.Folder != "slow_circuit" {
		t.Errorf("%+v", job)
	}
	if time.Since(started) > killGrace+3*time.Second {
		t.Errorf("cancelling took %s", time.Since(started))
	}
	// And the next one runs
	if w := call(s, http.MethodPost, convertPath, `{"folder":"my_circuit"}`); w.Code != http.StatusAccepted {
		t.Fatalf("after the cancel: %d %s", w.Code, w.Body.String())
	}
	if job := waitJob(t, s); job.State != jobDone {
		t.Errorf("%+v", job)
	}
}

func TestStartTogetherRunsOne(t *testing.T) {
	s, _ := convertFixture(t)
	codes := make(chan int, 8)
	for range 8 {
		go func() { codes <- call(s, http.MethodPost, convertPath, `{"folder":"slow_circuit"}`).Code }()
	}
	accepted := 0
	for range 8 {
		switch c := <-codes; c {
		case http.StatusAccepted:
			accepted++
		case http.StatusConflict:
		default:
			t.Errorf("answered %d", c)
		}
	}
	if accepted != 1 {
		t.Errorf("%d conversions started at once", accepted)
	}
	call(s, http.MethodPost, cancelPath, "")
	waitJob(t, s)
}

func TestConvertNeedsTheToolchain(t *testing.T) {
	s, _ := convertFixture(t)
	os.Remove(s.imports.jobs.tc.stateFile())
	w := call(s, http.MethodPost, convertPath, `{"folder":"my_circuit"}`)
	if w.Code != http.StatusConflict || decode[statusAnswer](t, w).Code != "not-ready" {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
}

func TestToolchainJob(t *testing.T) {
	s, base := convertFixture(t)
	js := s.imports.jobs
	self, _ := os.Executable()
	exe, _ := os.ReadFile(self)
	uvArchive := tarGz(t, [][2]string{{"uv-test/uv", string(exe)}})
	// Node isn't run while setting up, so a stand-in will do
	nodeArchive := tarGz(t, [][2]string{{"node-test/bin/node", "node"}})
	srv, dl := downloadServer(t, map[string][]byte{"/uv.tar.gz": uvArchive, "/node.tar.gz": nodeArchive, "/bad.tar.gz": []byte("not it")})
	tc := newToolchain(filepath.Join(base, "fresh-toolchain"), "darwin", "arm64")
	tc.client = dl.client
	tc.pins = platformPins{
		UV:   pinnedFile{Name: "uv", Version: "1", URL: srv.URL + "/uv.tar.gz", SHA256: sha(uvArchive), Size: int64(len(uvArchive)), Format: "tar.gz", Member: "uv-test/uv", Program: "uv"},
		Node: pinnedFile{Name: "node", Version: "1", URL: srv.URL + "/bad.tar.gz", SHA256: sha(nodeArchive), Size: int64(len(nodeArchive)), Format: "tar.gz", Member: "node-test/bin/node", Program: "bin/node"},
	}
	pinProgram(&tc.pins.UV, exe)
	pinProgram(&tc.pins.Node, []byte("node"))
	js.tc = tc

	// Node's download doesn't match its pin: the setup stops there, and nothing of it is kept
	if w := call(s, http.MethodPost, toolchainPath, ""); w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	job := waitJob(t, s)
	if job.State != jobFailed || !strings.Contains(job.Error, "node") {
		t.Fatalf("%+v", job)
	}
	if tc.checkProgram(tc.pins.Node, false) == nil || tc.ready(js.conv) {
		t.Fatal("a download that didn't verify was installed")
	}
	if err := tc.checkProgram(tc.pins.UV, false); err != nil {
		t.Errorf("uv, which verified, wasn't kept: %v", err)
	}

	tc.pins.Node.URL = srv.URL + "/node.tar.gz"
	if w := call(s, http.MethodPost, toolchainPath, ""); w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	job = waitJob(t, s)
	log := strings.Join(job.Log, "\n")
	if job.State != jobDone || !tc.ready(js.conv) {
		t.Fatalf("%+v\n%s", job, log)
	}
	for _, want := range []string{"uv: python install --no-bin --no-registry 3.14", "uv: run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt python -c pass"} {
		if !strings.Contains(log, want) {
			t.Errorf("the log hasn't %q:\n%s", want, log)
		}
	}
	st := decode[statusAnswer](t, call(s, http.MethodGet, convertPath, ""))
	if st.Toolchain.State != "ready" {
		t.Errorf("toolchain %+v", st.Toolchain)
	}
}

func TestCancelStopsTheToolchainDownload(t *testing.T) {
	s, base := convertFixture(t)
	js := s.imports.jobs
	release := make(chan struct{})
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000000")
		w.Write(bytes.Repeat([]byte("x"), 1000))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	tc := newToolchain(filepath.Join(base, "slow-toolchain"), "darwin", "arm64")
	tc.client.Transport = srv.Client().Transport
	tc.pins.UV = pinnedFile{Name: "uv", Version: "1", URL: srv.URL + "/uv", SHA256: strings.Repeat("0", 64), Size: 1000000, Format: "tar.gz", Member: "uv", Program: "uv"}
	js.tc = tc
	call(s, http.MethodPost, toolchainPath, "")
	deadline := time.Now().Add(10 * time.Second)
	for decode[statusAnswer](t, call(s, http.MethodGet, convertPath, "")).Job.Done == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no progress")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// A conversion asked for meanwhile is told one runs, not that the tools aren't there yet
	if w := call(s, http.MethodPost, convertPath, `{"folder":"my_circuit"}`); w.Code != http.StatusConflict || decode[statusAnswer](t, w).Code != "busy" {
		t.Errorf("a conversion during the download: %d %s", w.Code, w.Body.String())
	}
	call(s, http.MethodPost, cancelPath, "")
	if job := waitJob(t, s); job.State != jobCancelled || job.Step != "uv" || job.Total != 1000000 {
		t.Errorf("%+v", job)
	}
	if left, _ := os.ReadDir(filepath.Join(tc.dir, "downloads")); len(left) != 0 {
		t.Errorf("a cancelled download is left: %v", left)
	}
}

func TestRingLog(t *testing.T) {
	l := newRingLog(3)
	io.WriteString(l, "one\ntwo\r\nthree\x1b[1m!\x1b[0m\rfour\nfi")
	l.flush()
	lines, total := l.tail(10)
	if strings.Join(lines, "|") != "three!|four|fi" || total != 5 {
		t.Errorf("%q %d", lines, total)
	}
	l.Write([]byte(strings.Repeat("x", 3*maxLogLine) + "\n"))
	if lines, _ := l.tail(1); len(lines[0]) > maxLogLine+4 {
		t.Errorf("a long line kept at %d", len(lines[0]))
	}
}

func TestProgramEnvIsItsOwn(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--require evil")
	t.Setenv("PYTHONPATH", "/evil")
	t.Setenv("UV_INDEX_URL", "https://evil.example/simple")
	js := newJobs(t.TempDir(), t.TempDir(), nil, newToolchain(t.TempDir(), "darwin", "arm64"))
	env := strings.Join(js.programEnv(), "\n")
	for _, bad := range []string{"NODE_OPTIONS", "PYTHONPATH", "UV_INDEX_URL"} {
		if strings.Contains(env, bad+"=") {
			t.Errorf("%s passed on", bad)
		}
	}
	for _, want := range []string{"UV_NO_CONFIG=1", "UV_PYTHON_PREFERENCE=only-managed", "UV_EXCLUDE_NEWER=" + pythonExcludeNewer, "PYTHONDONTWRITEBYTECODE=1"} {
		if !strings.Contains(env, want) {
			t.Errorf("no %s", want)
		}
	}
}
