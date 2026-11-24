package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// The converter's jobs: setting up the toolchain, or converting one folder of the import folder into a mod package.
// One runs at a time; the Mods panel starts it and polls its status. A job's programs run with a fixed argv (never
// through a shell), in the converter's folder, with an environment of their own, and their output goes only to the
// job's log.

// errBusy is a job asked for while one runs
var errBusy = errors.New("a conversion or download is already running")

type jobState string

const (
	jobRunning   jobState = "running"
	jobDone      jobState = "done"
	jobFailed    jobState = "failed"
	jobCancelled jobState = "cancelled"
)

// jobStatus is what the Mods panel polls (`GET /__launcher/convert`)
type jobStatus struct {
	ID     int      `json:"id"`
	Type   string   `json:"type"` // "toolchain" or "convert"
	State  jobState `json:"state"`
	Folder string   `json:"folder,omitempty"`
	Kind   string   `json:"kind,omitempty"`
	// Step is what it is doing: "uv", "node" (downloading), "python" (uv fetching Python and the packages), "convert"
	Step      string `json:"step,omitempty"`
	Done      int64  `json:"done,omitempty"`
	Total     int64  `json:"total,omitempty"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt,omitempty"`
	Error     string `json:"error,omitempty"`
	// Log is the tail of the programs' output; LogLines counts every line
	Log      []string `json:"log"`
	LogLines int      `json:"logLines"`
	// Packages are the mod packages the conversion wrote or changed, with their credits and licences
	Packages []convertedPackage `json:"packages,omitempty"`
	// Problems are the package check's failures; Notes the lines of the log about the source's licence
	Problems []string `json:"problems,omitempty"`
	Notes    []string `json:"notes,omitempty"`
}

type job struct {
	status jobStatus
	log    *ringLog
	cancel context.CancelFunc
	done   chan struct{}
}

// jobs runs the converter's jobs for one launcher
type jobs struct {
	importDir string
	modsDir   string
	conv      *converterInfo // nil: the release has no converter
	tc        *toolchain

	mu   sync.Mutex
	last *job
	next int
}

func newJobs(importDir, modsDir string, conv *converterInfo, tc *toolchain) *jobs {
	return &jobs{importDir: importDir, modsDir: modsDir, conv: conv, tc: tc}
}

// status is the running or last job's status (nil before the first)
func (js *jobs) status() *jobStatus {
	js.mu.Lock()
	defer js.mu.Unlock()
	if js.last == nil {
		return nil
	}
	s := js.last.status
	s.Log, s.LogLines = js.last.log.tail(logTail)
	if s.Log == nil {
		// An empty list, not null, for the panel
		s.Log = []string{}
	}
	s.Packages = slices.Clone(s.Packages)
	return &s
}

// logTail is how many of the log's last lines a status carries
const logTail = 200

// start begins a job unless one runs: work runs in the background with a context the job's cancel ends
func (js *jobs) start(typ, folder, kind string, work func(ctx context.Context, j *job) error) (*jobStatus, error) {
	js.mu.Lock()
	if js.last != nil && js.last.status.State == jobRunning {
		js.mu.Unlock()
		return nil, errBusy
	}
	js.next++
	ctx, cancel := context.WithTimeout(context.Background(), maxJobTime)
	j := &job{
		status: jobStatus{ID: js.next, Type: typ, State: jobRunning, Folder: folder, Kind: kind, StartedAt: time.Now().UnixMilli()},
		log:    newRingLog(2000),
		cancel: cancel,
		done:   make(chan struct{}),
	}
	js.last = j
	js.mu.Unlock()

	go func() {
		defer close(j.done)
		defer cancel()
		err := work(ctx, j)
		js.mu.Lock()
		defer js.mu.Unlock()
		j.status.EndedAt = time.Now().UnixMilli()
		switch {
		case err == nil:
			j.status.State = jobDone
		case errors.Is(ctx.Err(), context.Canceled):
			j.status.State = jobCancelled
		default:
			j.status.State = jobFailed
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				err = fmt.Errorf("stopped after %s", maxJobTime)
			}
			j.status.Error = err.Error()
		}
	}()
	return js.status(), nil
}

// maxJobTime bounds a job: a large circuit's conversion, racing lines included, takes minutes, not hours
const maxJobTime = 3 * time.Hour

// cancelRunning stops the running job (its programs and theirs); false when none runs
func (js *jobs) cancelRunning() bool {
	js.mu.Lock()
	j := js.last
	running := j != nil && j.status.State == jobRunning
	js.mu.Unlock()
	if !running {
		return false
	}
	j.cancel()
	return true
}

// Close stops a running job and waits a little for its programs to go
func (js *jobs) Close() {
	js.mu.Lock()
	j := js.last
	js.mu.Unlock()
	if j == nil {
		return
	}
	j.cancel()
	select {
	case <-j.done:
	case <-time.After(killGrace + 2*time.Second):
	}
}

func (js *jobs) update(j *job, f func(s *jobStatus)) {
	js.mu.Lock()
	f(&j.status)
	js.mu.Unlock()
}

// startToolchain downloads uv and Node, and has uv fetch Python and the converters' packages
func (js *jobs) startToolchain() (*jobStatus, error) {
	if js.conv == nil {
		return nil, errNoConverter
	}
	if !js.tc.ok {
		return nil, errUnsupported
	}
	return js.start("toolchain", "", "", func(ctx context.Context, j *job) error {
		for _, p := range []pinnedFile{js.tc.pins.UV, js.tc.pins.Node} {
			js.update(j, func(s *jobStatus) { s.Step, s.Done, s.Total = p.Name, 0, p.Size })
			j.log.add(fmt.Sprintf("%s %s: %s (SHA-256 %s)", p.Name, p.Version, p.URL, p.SHA256))
			err := js.tc.install(ctx, p, func(done int64) { js.update(j, func(s *jobStatus) { s.Done = done }) })
			if err != nil {
				return err
			}
			j.log.add(fmt.Sprintf("%s %s: verified and installed in %s", p.Name, p.Version, js.tc.componentDir(p)))
		}
		js.update(j, func(s *jobStatus) { s.Step, s.Done, s.Total = "python", 0, 0 })
		uv := js.tc.uvPath()
		env := js.programEnv()
		python := js.conv.Python.Version
		// Only into the toolchain folder: no `python3.14` on the player's PATH, nothing in the Windows registry
		if err := js.runTool(ctx, j.log, env, uv, "python", "install", "--no-bin", "--no-registry", python); err != nil {
			return fmt.Errorf("uv python install %s: %w", python, err)
		}
		// The converters' packages, fetched into uv's cache the way runPython (scripts/mods/lib/toolchain.ts) asks for
		// them, so the first conversion finds them there
		for _, req := range js.conv.Python.Requirements {
			argv := []string{uv, "run", "--python", python, "--no-project", "--with-requirements", req, "python", "-c", "pass"}
			if err := js.runTool(ctx, j.log, env, argv...); err != nil {
				return fmt.Errorf("the packages in %s: %w", req, err)
			}
		}
		if err := js.tc.markReady(js.conv); err != nil {
			return err
		}
		j.log.add("The converter is ready.")
		return nil
	})
}

var (
	errNoConverter  = errors.New("this launcher has no converter (converter/ beside it)")
	errUnsupported  = errors.New("the converter's downloads aren't available for this computer's system")
	errNotReady     = errors.New("the converter's tools aren't downloaded yet")
	errNoImporter   = errors.New("this folder isn't one the converter knows")
	errBadImportArg = errors.New("not a folder in the import folder")
)

// startConvert converts one folder of the import folder (named as listed) into a package in the mods folder. The
// folder is checked here, then copied (its plain files and folders only, through os.Root) into a folder of the
// launcher's own that no one else can write to, and the copy is converted: what is in the import folder can change
// while the converter runs, minutes later, without reaching it.
func (js *jobs) startConvert(name string) (*jobStatus, error) {
	if js.conv == nil {
		return nil, errNoConverter
	}
	if !validImportName(name) {
		return nil, errBadImportArg
	}
	root, err := os.OpenRoot(js.importDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(name)
	if err != nil || !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return nil, errBadImportArg
	}
	entry := detectImport(root, name)
	if !slices.Contains(js.conv.Importers, entry.Kind) || entry.Source == "" {
		return nil, errNoImporter
	}
	if err := checkImportTree(root, name); err != nil {
		return nil, fmt.Errorf("%s %w", name, err)
	}
	if !js.tc.ready(js.conv) {
		return nil, errNotReady
	}
	return js.start("convert", name, entry.Kind, func(ctx context.Context, j *job) error {
		js.update(j, func(s *jobStatus) { s.Step = "copy" })
		staged, cleanup, err := js.stageImport(ctx, name)
		if err != nil {
			return err
		}
		defer cleanup()
		// Recognised again in the copy, which is what is converted
		stagedRoot, err := os.OpenRoot(staged)
		if err != nil {
			return err
		}
		again := detectImport(stagedRoot, name)
		stagedRoot.Close()
		if again.Kind != entry.Kind || again.Source == "" {
			return fmt.Errorf("%s changed while it was copied: convert it again", name)
		}
		source := filepath.Join(staged, filepath.FromSlash(again.Source))

		js.update(j, func(s *jobStatus) { s.Step = "convert" })
		// What a stopped conversion left, before and after
		js.conv.clearWork()
		defer js.conv.clearWork()
		before := snapshotPackages(js.modsDir)
		modTool := filepath.Join(js.conv.Dir, filepath.FromSlash(js.conv.ModTool))
		env := js.programEnv()
		runErr := js.runTool(ctx, j.log, env, js.tc.nodePath(), modTool, "import", entry.Kind, source, "--out", js.modsDir)
		pkgs := changedPackages(js.modsDir, before)
		lines, _ := j.log.tail(j.log.max)
		notes := licenceLines(lines)
		// Each package written is checked as the game will take it (`mod-tool check`), whatever the importer said
		var problems []string
		if ctx.Err() == nil {
			js.update(j, func(s *jobStatus) { s.Step = "check" })
			for _, p := range pkgs {
				check := newRingLog(500)
				err := js.runTool(ctx, check, env, js.tc.nodePath(), modTool, "check", filepath.Join(js.modsDir, p.ID))
				out, _ := check.tail(check.max)
				for _, l := range out {
					j.log.add(l)
				}
				if found := checkProblems(out); len(found) > 0 {
					problems = append(problems, found...)
				} else if err != nil {
					problems = append(problems, fmt.Sprintf("%s: the check failed (%v)", p.ID, err))
				}
			}
		}
		js.update(j, func(s *jobStatus) {
			s.Packages = pkgs
			s.Problems = capLines(problems, 40)
			s.Notes = notes
		})
		switch {
		case runErr != nil:
			return runErr
		case ctx.Err() != nil:
			return ctx.Err()
		case len(pkgs) == 0:
			return errors.New("the converter finished without writing a package")
		case len(problems) > 0:
			return errors.New("the package has problems: the game won't load what they touch")
		}
		return nil
	})
}

// stagingDir holds the copies of import folders being converted, in the toolchain's folder (this user's alone, and
// on a disk with room: a circuit can be gigabytes, more than a temporary folder held in memory may take)
func (js *jobs) stagingDir() string { return filepath.Join(js.tc.dir, "staging") }

// stageImport copies import/<name> into a new private folder, as <that folder>/<name>, and returns the folder and
// what removes it. What an earlier launcher left there (one that stopped mid-copy) goes first.
func (js *jobs) stageImport(ctx context.Context, name string) (string, func(), error) {
	if err := js.tc.makeDir(); err != nil {
		return "", nil, err
	}
	base := js.stagingDir()
	os.RemoveAll(base)
	if err := os.Mkdir(base, 0o700); err != nil {
		return "", nil, err
	}
	// MkdirTemp makes it 0700
	dir, err := os.MkdirTemp(base, "import-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	if err := copyImportTree(ctx, js.importDir, name, dir); err != nil {
		cleanup()
		return "", nil, err
	}
	return dir, cleanup, nil
}

// errChangedWhileCopied is a file of the import folder that was replaced while it was copied
var errChangedWhileCopied = errors.New("changed while it was copied: convert it again")

// copyImportTree copies importDir/name into destDir/name: its folders and regular files only, each read through
// os.Root (nothing outside the folder can be reached, whatever is swapped in) and refused when it isn't the file the
// walk found (a file replaced by a link meanwhile). A link, a device or a pipe stops the copy, as checkImportTree does.
func copyImportTree(ctx context.Context, importDir, name, destDir string) error {
	src, err := os.OpenRoot(importDir)
	if err != nil {
		return err
	}
	defer src.Close()
	sub, err := src.OpenRoot(name)
	if err != nil {
		return err
	}
	defer sub.Close()
	dst, err := os.OpenRoot(destDir)
	if err != nil {
		return err
	}
	defer dst.Close()
	if err := dst.Mkdir(name, 0o700); err != nil {
		return err
	}
	count := 0
	buf := make([]byte, 1<<20)
	return fs.WalkDir(sub.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		count++
		if count > maxImportEntries {
			return fmt.Errorf("%s holds more than %d files and folders", name, maxImportEntries)
		}
		if p == "." {
			return nil
		}
		to := name + "/" + p
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			return fmt.Errorf("%s %w (%s): copy the files themselves", name, errLinkInImport, p)
		case d.IsDir():
			return dst.Mkdir(to, 0o700)
		case !d.Type().IsRegular():
			return fmt.Errorf("%s holds %s, which is not a file", name, p)
		}
		walked, err := sub.Lstat(p)
		if err != nil || !walked.Mode().IsRegular() {
			return fmt.Errorf("%s: %s %w", name, p, errChangedWhileCopied)
		}
		in, err := sub.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		opened, err := in.Stat()
		if err != nil || !opened.Mode().IsRegular() || !os.SameFile(walked, opened) {
			return fmt.Errorf("%s: %s %w", name, p, errChangedWhileCopied)
		}
		out, err := dst.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		_, err = io.CopyBuffer(out, in, buf)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		return err
	})
}

// runTool runs one of the toolchain's programs (or a program with them on PATH), once uv and Node are found to be
// the pinned ones still
func (js *jobs) runTool(ctx context.Context, log *ringLog, env []string, argv ...string) error {
	if err := js.tc.verifyPrograms(); err != nil {
		return err
	}
	return runProgram(ctx, log, js.conv.Dir, env, argv...)
}

// programEnv is the environment the converter's programs get: not the launcher's, so nothing of the player's
// (NODE_OPTIONS, PYTHONPATH, a uv config) changes what they do. PATH starts with the toolchain's Node and uv; what
// the system needs to start a program (its folders, the user's home and temporary folder, the language) is kept.
func (js *jobs) programEnv() []string {
	keep := []string{"HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "USERPROFILE",
		"APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "windir", "SystemDrive", "ProgramData", "PATHEXT",
		"COMSPEC", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"}
	var env []string
	for _, k := range keep {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	dirs := js.tc.pathDirs()
	if p := os.Getenv("PATH"); p != "" {
		dirs = append(dirs, p)
	}
	env = append(env, "PATH="+strings.Join(dirs, string(os.PathListSeparator)))
	env = append(env, js.tc.uvEnv()...)
	env = append(env,
		// The bundle stays as shipped (no __pycache__ beside the scripts)
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONUTF8=1",
		"PYTHONUNBUFFERED=1",
		"NO_COLOR=1",
	)
	return env
}

// runProgram runs argv[0] with argv[1:] in dir, its output (both streams) into log. Its whole process tree is stopped
// when ctx ends.
func runProgram(ctx context.Context, log *ringLog, dir string, env []string, argv ...string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdin = nil
	cmd.Stdout = log
	cmd.Stderr = log
	log.add("$ " + strings.Join(displayArgv(argv), " "))
	tree, err := startTree(cmd)
	if err != nil {
		return err
	}
	exited := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait()
		tree.release()
		close(exited)
	}()
	select {
	case <-exited:
		log.flush()
		return exitError(waitErr)
	case <-ctx.Done():
		tree.stop(exited)
		select {
		case <-exited:
		case <-time.After(killGrace + 2*time.Second):
		}
		log.flush()
		return ctx.Err()
	}
}

// killGrace is how long a stopped program has to finish before it is killed (a variable for the tests)
var killGrace = 5 * time.Second

func exitError(err error) error {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("exit status %d", exit.ExitCode())
	}
	return err
}

// displayArgv shows a command with its program's name rather than its full path
func displayArgv(argv []string) []string {
	out := slices.Clone(argv)
	out[0] = filepath.Base(out[0])
	return out
}

// snapshotPackages notes each package folder's mod.json time and size before a conversion
func snapshotPackages(modsDir string) map[string]string {
	seen := map[string]string{}
	entries, _ := os.ReadDir(modsDir)
	for _, e := range entries {
		if !packageIDPattern.MatchString(e.Name()) || !e.IsDir() {
			continue
		}
		if info, err := os.Lstat(filepath.Join(modsDir, e.Name(), "mod.json")); err == nil && info.Mode().IsRegular() {
			seen[e.Name()] = fmt.Sprintf("%d-%d", info.ModTime().UnixNano(), info.Size())
		}
	}
	return seen
}

// convertedPackage is a package a conversion wrote, with the credit and licence the Mods panel shows
type convertedPackage struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Version string         `json:"version,omitempty"`
	Credit  map[string]any `json:"credit,omitempty"`
	// Content are its circuits and cars, each with its own credit when it has one
	Content []convertedContent `json:"content,omitempty"`
}

type convertedContent struct {
	Type   string         `json:"type"` // "circuit" or "car"
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Credit map[string]any `json:"credit,omitempty"`
}

// changedPackages lists the packages whose mod.json is new or changed since the snapshot
func changedPackages(modsDir string, before map[string]string) []convertedPackage {
	var out []convertedPackage
	for id, stamp := range snapshotPackages(modsDir) {
		if before[id] == stamp {
			continue
		}
		if p, ok := readConvertedPackage(filepath.Join(modsDir, id, "mod.json")); ok && p.ID == id {
			out = append(out, p)
		}
	}
	slices.SortFunc(out, func(a, b convertedPackage) int { return strings.Compare(a.ID, b.ID) })
	return out
}

func readConvertedPackage(file string) (convertedPackage, bool) {
	f, err := os.Open(file)
	if err != nil {
		return convertedPackage{}, false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 4<<20))
	if err != nil {
		return convertedPackage{}, false
	}
	var m struct {
		ID      string         `json:"id"`
		Name    string         `json:"name"`
		Version string         `json:"version"`
		Credit  map[string]any `json:"credit"`
		Tracks  []struct {
			ID     string         `json:"id"`
			Name   string         `json:"name"`
			Credit map[string]any `json:"credit"`
		} `json:"tracks"`
		Cars []struct {
			ID     string         `json:"id"`
			Title  string         `json:"title"`
			Credit map[string]any `json:"credit"`
		} `json:"cars"`
	}
	if json.NewDecoder(bytes.NewReader(b)).Decode(&m) != nil {
		return convertedPackage{}, false
	}
	p := convertedPackage{ID: m.ID, Name: m.Name, Version: m.Version, Credit: m.Credit}
	for _, t := range m.Tracks {
		p.Content = append(p.Content, convertedContent{Type: "circuit", ID: t.ID, Name: t.Name, Credit: t.Credit})
	}
	for _, c := range m.Cars {
		p.Content = append(p.Content, convertedContent{Type: "car", ID: c.ID, Name: c.Title, Credit: c.Credit})
	}
	return p, true
}

// checkProblems are the problems `mod-tool check` reports (scripts/mods/lib/package-check.ts report): the indented
// lines under its FAIL line
func checkProblems(lines []string) []string {
	var out []string
	failing := false
	for _, l := range lines {
		switch {
		case strings.HasPrefix(l, "FAIL"):
			failing = true
		case failing && strings.HasPrefix(l, "      "):
			out = append(out, strings.TrimSpace(l))
		default:
			failing = false
		}
	}
	return out
}

// licenceTerms finds what an importer says about the source's licence ("for personal use only", "not for
// redistribution"), shown above the log
var licenceTerms = regexp.MustCompile(`(?i)(personal use|private use|non-?commercial|not for (re)?distribution|do not (share|redistribute|upload)|redistribut|licen[cs]e|copyright|all rights reserved)`)

func licenceLines(lines []string) []string {
	var out []string
	for _, l := range lines {
		t := strings.TrimSpace(l)
		if t != "" && !strings.HasPrefix(t, "$ ") && licenceTerms.MatchString(t) && !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	return capLines(out, 20)
}

func capLines(lines []string, n int) []string {
	if len(lines) > n {
		return lines[:n]
	}
	return lines
}

// ringLog keeps the last lines a job's programs wrote. Carriage returns (a progress bar redrawn in place) end a line
// as a newline does, colour codes are taken out, and a very long line is cut.
type ringLog struct {
	mu      sync.Mutex
	lines   []string
	max     int
	total   int
	partial []byte
}

func newRingLog(max int) *ringLog { return &ringLog{max: max} }

const maxLogLine = 2000

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

func (l *ringLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, b := range p {
		if b == '\n' || b == '\r' {
			l.endLine()
			continue
		}
		if len(l.partial) < maxLogLine*4 {
			l.partial = append(l.partial, b)
		}
	}
	return len(p), nil
}

func (l *ringLog) endLine() {
	if len(l.partial) == 0 {
		return
	}
	line := ansiEscape.ReplaceAllString(string(l.partial), "")
	l.partial = l.partial[:0]
	line = strings.ToValidUTF8(line, "�")
	if len(line) > maxLogLine {
		line = line[:maxLogLine] + "…"
	}
	if strings.TrimSpace(line) == "" {
		return
	}
	l.push(line)
}

func (l *ringLog) push(line string) {
	l.total++
	l.lines = append(l.lines, line)
	if len(l.lines) > l.max {
		l.lines = slices.Delete(l.lines, 0, len(l.lines)-l.max)
	}
}

// add writes a line of the launcher's own
func (l *ringLog) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.endLine()
	l.push(line)
}

// flush ends a line the program left unfinished
func (l *ringLog) flush() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.endLine()
}

// tail is the last n lines, and how many there have been
func (l *ringLog) tail(n int) ([]string, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	from := max(0, len(l.lines)-n)
	return slices.Clone(l.lines[from:]), l.total
}

var _ io.Writer = (*ringLog)(nil)
