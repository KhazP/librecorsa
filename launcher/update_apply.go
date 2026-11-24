package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/librecorsa/librecorsa/launcher/internal/release"
)

// Putting an update in place, and handing over to it. The staged release (update.go) replaces the installed one:
//
//   - macOS: the app bundle, whole. LibreCorsa.app moves aside to .LibreCorsa.app.update-old beside it, and the new one
//     takes its name.
//   - Linux: the launcher's folder, whole, the same way.
//   - Windows: each thing in the launcher's folder the release brings (LibreCorsa.exe, game, converter). A running
//     program can be renamed but not deleted, so each moves aside into .update-old-<time> in the folder first, the
//     launcher itself with the rest, and the new one takes its place.
//
// The new launcher is then started and must answer on the launcher's port with its new version within a time limit.
// If anything fails (a move, the start, the answer) the moves are undone and the old version stays: an update that
// fails to install is marked failed and not tried again. What was moved aside goes once the new launcher answers, or
// at the next start (Windows: the old launcher's own program, which can't go while it runs).

// installation is the release the running launcher belongs to
type installation struct {
	goos string
	// root is what an update replaces: the app bundle (macOS) or the launcher's folder
	root string
	// program is the launcher inside it
	program string
}

// Why an installation can't update itself (updateInfo.Reason)
const (
	reasonDev          = "dev"          // a build with no version, or run in a clone
	reasonNoKey        = "no-key"       // built without update-key.pub: it can only say a newer release is out
	reasonUnsupported  = "unsupported"  // no release is built for this system
	reasonNotApp       = "not-app"      // macOS: not run from LibreCorsa.app
	reasonTranslocated = "translocated" // macOS: run from where it was downloaded, through App Translocation
	reasonReadOnly     = "read-only"    // the folder it is in can't be written to
	reasonLayout       = "layout"       // its folder isn't laid out as a release's
)

// findInstallation is the release the launcher at exe belongs to, or why it can't update itself
func findInstallation(goos, exe string) (*installation, string) {
	exeDir := filepath.Dir(exe)
	in := &installation{goos: goos}
	switch goos {
	case "darwin":
		bundle := appBundleOf(exeDir)
		if bundle == "" {
			return nil, reasonNotApp
		}
		// Opened from Downloads without being moved, macOS runs a read-only copy from a random place
		if strings.Contains(filepath.ToSlash(bundle), "/AppTranslocation/") {
			return nil, reasonTranslocated
		}
		in.root = bundle
	default:
		in.root = exeDir
	}
	in.program = filepath.Join(in.root, filepath.FromSlash(release.Program(goos)))
	if !sameFile(exe, in.program) {
		// Renamed, or not where a release puts it: an update would put another program beside it
		return nil, reasonLayout
	}
	if !isExport(filepath.Join(in.root, filepath.FromSlash(release.Resources(goos)), "game")) {
		return nil, reasonLayout
	}
	if !canWrite(in.changedDir()) {
		return nil, reasonReadOnly
	}
	return in, ""
}

func sameFile(a, b string) bool {
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	return err == nil && os.SameFile(ai, bi)
}

// changedDir is the folder an update renames things in: the one holding the bundle or the folder, or on Windows the
// launcher's folder itself
func (in *installation) changedDir() string {
	if in.goos == "windows" {
		return in.root
	}
	return filepath.Dir(in.root)
}

// canWrite reports whether a file can be created (and removed) in dir
func canWrite(dir string) bool {
	f, err := os.CreateTemp(dir, ".librecorsa-write-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	return os.Remove(name) == nil
}

// Names beside the installation that an update leaves while it works
func (in *installation) newPath() string {
	if in.goos == "windows" {
		return filepath.Join(in.root, ".update-new")
	}
	return filepath.Join(filepath.Dir(in.root), "."+filepath.Base(in.root)+".update-new")
}

func (in *installation) oldPathPrefix() string {
	if in.goos == "windows" {
		return filepath.Join(in.root, ".update-old")
	}
	return filepath.Join(filepath.Dir(in.root), "."+filepath.Base(in.root)+".update-old")
}

// cleanup removes what an earlier update left: the release it replaced, and a new one it didn't get to put in place.
// Something still in use (on Windows, the program of a launcher that is ending) stays for the next time.
func (in *installation) cleanup() {
	os.RemoveAll(in.newPath())
	matches, _ := filepath.Glob(in.oldPathPrefix() + "*")
	for _, m := range matches {
		os.RemoveAll(m)
	}
}

// appliedUpdate is an update put in place, until the new launcher answers (finish) or doesn't (undo)
type appliedUpdate struct {
	undo   func() error
	finish func()
}

// swap puts the staged release (the folder an archive held: LibreCorsa.app or LibreCorsa) in the installation's place
func (in *installation) swap(staged string) (*appliedUpdate, error) {
	next := in.newPath()
	os.RemoveAll(next)
	if err := moveTree(staged, next); err != nil {
		os.RemoveAll(next)
		return nil, fmt.Errorf("couldn't copy the update beside LibreCorsa: %w", err)
	}
	if in.goos == "windows" {
		return in.swapItems(next)
	}
	old := in.oldPathPrefix()
	if err := os.RemoveAll(old); err != nil {
		os.RemoveAll(next)
		return nil, err
	}
	if err := os.Rename(in.root, old); err != nil {
		os.RemoveAll(next)
		return nil, fmt.Errorf("couldn't move the installed LibreCorsa aside: %w", err)
	}
	if err := os.Rename(next, in.root); err != nil {
		if rerr := os.Rename(old, in.root); rerr != nil {
			return nil, fmt.Errorf("couldn't put the update in place (%v), nor the old LibreCorsa back (%v): it is in %s", err, rerr, old)
		}
		os.RemoveAll(next)
		return nil, fmt.Errorf("couldn't put the update in place: %w", err)
	}
	return &appliedUpdate{
		undo: func() error {
			if err := os.Rename(in.root, next); err != nil {
				return err
			}
			if err := os.Rename(old, in.root); err != nil {
				return err
			}
			os.RemoveAll(next)
			return nil
		},
		finish: func() { os.RemoveAll(old) },
	}, nil
}

// swapItems replaces each thing in the launcher's folder the release in next brings (Windows), moving the installed
// one aside first: the running launcher is renamed, never deleted
func (in *installation) swapItems(next string) (*appliedUpdate, error) {
	entries, err := os.ReadDir(next)
	if err != nil {
		os.RemoveAll(next)
		return nil, err
	}
	old := fmt.Sprintf("%s-%d", in.oldPathPrefix(), time.Now().UnixNano())
	if err := os.Mkdir(old, 0o755); err != nil {
		os.RemoveAll(next)
		return nil, err
	}
	var movedAside, placed []string
	undo := func() error {
		var errs []error
		for i := len(placed) - 1; i >= 0; i-- {
			if err := os.Rename(filepath.Join(in.root, placed[i]), filepath.Join(next, placed[i])); err != nil {
				errs = append(errs, err)
			}
		}
		for i := len(movedAside) - 1; i >= 0; i-- {
			if err := os.Rename(filepath.Join(old, movedAside[i]), filepath.Join(in.root, movedAside[i])); err != nil {
				errs = append(errs, err)
			}
		}
		if len(errs) == 0 {
			os.RemoveAll(next)
			os.RemoveAll(old)
		}
		return errors.Join(errs...)
	}
	for _, e := range entries {
		name := e.Name()
		target := filepath.Join(in.root, name)
		if _, err := os.Lstat(target); err == nil {
			if err := os.Rename(target, filepath.Join(old, name)); err != nil {
				uerr := undo()
				return nil, errors.Join(fmt.Errorf("couldn't move %s aside: %w", name, err), uerr)
			}
			movedAside = append(movedAside, name)
		}
		if err := os.Rename(filepath.Join(next, name), target); err != nil {
			uerr := undo()
			return nil, errors.Join(fmt.Errorf("couldn't put the new %s in place: %w", name, err), uerr)
		}
		placed = append(placed, name)
	}
	return &appliedUpdate{
		undo: undo,
		finish: func() {
			os.RemoveAll(next)
			// The old launcher's own program can't go while it runs: the next start removes it
			os.RemoveAll(old)
		},
	}, nil
}

// moveTree moves a folder, or copies it (folders and regular files) and removes the original when it is on another
// disk than the destination
func moveTree(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	if err := copyTree(src, dst); err != nil {
		return err
	}
	return os.RemoveAll(src)
}

// handoffEnv carries what a launcher tells the one it starts after an update (in the environment: other users can't
// read it, as they can a command line)
const handoffEnv = "LIBRECORSA_HANDOFF"

// handoff is what the launcher that installed an update passes to the new one
type handoff struct {
	// Secret is the session's (session.go), so the game's open window keeps it
	Secret string `json:"secret,omitempty"`
	// BrowserPID is the browser the game's window is in, to be watched instead of opening another
	BrowserPID int `json:"browserPid,omitempty"`
	// KeepWindow: the game's window is open; don't open another
	KeepWindow bool `json:"keepWindow,omitempty"`
	// From is the version that installed it. A launcher started this way shows no message box (the one waiting for
	// it reports a failure and puts the old version back) and leaves the old release's files to that one.
	From string `json:"from,omitempty"`
}

// takeHandoff reads, and removes from the environment, what the launcher that started this one passed
func takeHandoff() handoff {
	raw, ok := os.LookupEnv(handoffEnv)
	if !ok {
		return handoff{}
	}
	os.Unsetenv(handoffEnv)
	var h handoff
	if json.Unmarshal([]byte(raw), &h) != nil {
		return handoff{}
	}
	return h
}

// withoutHandoff is an environment without a handoff in it
func withoutHandoff(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if !strings.HasPrefix(kv, handoffEnv+"=") {
			out = append(out, kv)
		}
	}
	return out
}

// launched is a launcher this one started
type launched struct {
	cmd *exec.Cmd
	// ended is closed when it ends, with err its exit
	ended chan struct{}
	err   error
}

// stop ends it, and waits until it has
func (l *launched) stop() {
	l.cmd.Process.Kill()
	<-l.ended
}

// startLauncher starts program with args and the handoff: on its own (it outlives this launcher), with its output
// going to its own log
func startLauncher(program string, args []string, h handoff) (*launched, error) {
	b, err := json.Marshal(h)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(program, args...)
	cmd.Env = append(withoutHandoff(os.Environ()), handoffEnv+"="+string(b))
	// Not this launcher's log pipe, which ends with it
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	l := &launched{cmd: cmd, ended: make(chan struct{})}
	go func() {
		l.err = cmd.Wait()
		close(l.ended)
	}()
	return l, nil
}

// healthTimeout is how long a launcher just started has to answer
const healthTimeout = 45 * time.Second

// waitAnswer waits for the launcher l, of version want, to answer at origin; it fails when l ends first or none
// answers in time
func waitAnswer(origin, want string, l *launched, timeout time.Duration) error {
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-l.ended:
			err := l.err
			if err == nil {
				err = errors.New("it ended at once")
			}
			return fmt.Errorf("the new launcher didn't start: %w", err)
		case <-time.After(250 * time.Millisecond):
		}
		if v, ok := launcherVersionAt(client, origin); ok && v == want {
			return nil
		}
	}
	return fmt.Errorf("the new launcher didn't answer within %s", timeout)
}

// launcherVersionAt is the version of the launcher answering at origin
func launcherVersionAt(client *http.Client, origin string) (string, bool) {
	res, err := client.Get(origin + identityPath)
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	var id struct {
		App     string `json:"app"`
		Version string `json:"version"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&id) != nil || id.App != identityApp {
		return "", false
	}
	return id.Version, true
}
