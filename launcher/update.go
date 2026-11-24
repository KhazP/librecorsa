package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/librecorsa/librecorsa/launcher/internal/release"
)

// The launcher's self-update. A release publishes launcher-latest.json (its version, and each platform's archive with
// its address, size and SHA-256) and the manifest's Ed25519 signature (tools/release, with the LAUNCHER_UPDATE_KEY
// secret). The launcher, built with the public key (update-key.pub, embedded by build.mjs), and when online:
//
//  1. fetches the manifest and its signature at start and every few hours, from the repository's latest release;
//  2. checks the signature against its key, then that the version is newer than its own (never a downgrade);
//  3. downloads its platform's archive over HTTPS only, checking its size and SHA-256 against the manifest;
//  4. unpacks it into <config>/LibreCorsa/update/staged with the archive rules of update_unpack.go, and checks the
//     launcher in it runs and says the version the manifest does;
//  5. puts it in place at the next start, or when the player presses "Restart to update" in the game
//     (update_apply.go). An update that fails to go in place leaves the old version, and isn't tried again.
//
// A build without the key can't check a manifest, so it only tells the player a newer release is out, with a link to
// it. So does a release that can't replace itself (in a folder it can't write, or a macOS app run from where it was
// downloaded). A clone, a build with no version, and --no-update don't ask at all.

// The repository whose releases the launcher updates from
const (
	releasesPage = "https://github.com/librecorsa/librecorsa/releases"
	// latestManifestURL is the newest release's manifest: GitHub sends latest/download/<file> on to the release
	// marked latest
	latestManifestURL = releasesPage + "/latest/download/" + release.ManifestName
	// releaseDownloads is where every release's files are, and the only place an archive may come from
	releaseDownloads = releasesPage + "/download/"
	// releasesAPI lists the releases, for when the latest isn't a launcher's (the desktop app's releases share the
	// repository)
	releasesAPI = "https://api.github.com/repos/librecorsa/librecorsa/releases?per_page=30"
	// launcherTagPrefix starts a launcher release's tag
	launcherTagPrefix = "launcher-v"
)

const (
	// firstCheckAfter is how long after the start the first check waits, so it doesn't slow the game's opening
	firstCheckAfter = 15 * time.Second
	// checkEvery is how often a running launcher checks again
	checkEvery = 6 * time.Hour
	// versionRunTimeout bounds the staged launcher's --version
	versionRunTimeout = 30 * time.Second
)

// updatePublicKeys is the update key the launcher checks manifests with, comma-separated base64 Ed25519 public keys:
// set at build time from update-key.pub (build.mjs: -X main.updatePublicKeys=…). Empty: no self-update.
var updatePublicKeys = ""

// The update's state, as the game's note reads it (updateInfo.State)
const (
	updateNone        = "none"        // nothing newer known
	updateDownloading = "downloading" // fetching or unpacking a newer release
	updateReady       = "ready"       // a newer release is staged: restart to update
	updateAvailable   = "available"   // a newer release is out, which this launcher can't install itself
	updateFailed      = "failed"      // the newer release couldn't be installed
)

// updateInfo is what GET /__launcher/update answers
type updateInfo struct {
	// Version is the running launcher's; Run changes with each start, so a page waiting through a restart sees it
	Version string `json:"version"`
	Run     string `json:"run"`
	State   string `json:"state"`
	Latest  string `json:"latest,omitempty"`
	// SelfUpdate says whether this launcher can install an update itself, and Reason why not
	SelfUpdate bool   `json:"selfUpdate"`
	Reason     string `json:"reason,omitempty"`
	Done       int64  `json:"done,omitempty"`
	Total      int64  `json:"total,omitempty"`
	Error      string `json:"error,omitempty"`
	// ReleaseURL is the release's page on GitHub, to download it by hand
	ReleaseURL string `json:"releaseUrl"`
}

// updater checks for, fetches and installs launcher updates
type updater struct {
	current string
	run     string
	target  release.Target
	keys    []ed25519.PublicKey
	// inst is the release to replace: nil when this launcher can't replace itself (reason says why)
	inst   *installation
	reason string
	// enabled: checks at all
	enabled bool
	dir     string
	client  *http.Client
	// args are the launcher's own, for the new launcher to start with
	args []string

	// Where it asks (fixed above; tests point them elsewhere)
	manifestURL, apiURL, downloadPrefix string

	mu     sync.Mutex
	status updateInfo
	// restart is sent on when the game asks for "Restart to update"
	restart chan struct{}
	// installing is set while an update is put in place: the launcher doesn't quit under it
	installing atomic.Bool
}

// updaterConfig is what newUpdater needs to know of the launcher
type updaterConfig struct {
	version string
	goos    string
	goarch  string
	// exe is the running launcher's path
	exe string
	// clone: run in a clone of the repository (serving ../out, or `go run`)
	clone bool
	// off: --no-update
	off bool
	// keys: updatePublicKeys
	keys string
	// dir: <config>/LibreCorsa/update
	dir  string
	args []string
}

func newUpdater(c updaterConfig) *updater {
	u := &updater{
		current:        c.version,
		run:            randomToken()[:16],
		dir:            c.dir,
		client:         httpsClient(2 * time.Hour),
		args:           c.args,
		manifestURL:    latestManifestURL,
		apiURL:         releasesAPI,
		downloadPrefix: releaseDownloads,
		restart:        make(chan struct{}, 1),
	}
	u.status = updateInfo{State: updateNone}
	target, ok := release.FindTarget(c.goos, c.goarch)
	u.target = target
	_, verr := release.ParseVersion(c.version)
	switch {
	case c.off:
		u.reason = "off"
		return u
	case c.clone || verr != nil:
		u.reason = reasonDev
		return u
	case !ok:
		u.reason = reasonUnsupported
		return u
	}
	u.enabled = true
	keys, err := release.ParsePublicKeys(c.keys)
	if err != nil {
		fmt.Fprintf(os.Stderr, "The update key built in is not one (%v): this launcher can't update itself\n", err)
	}
	u.keys = keys
	if len(u.keys) == 0 {
		u.reason = reasonNoKey
		return u
	}
	u.inst, u.reason = findInstallation(c.goos, c.exe)
	return u
}

// stagedUpdate is a release downloaded and unpacked, waiting to be put in place
type stagedUpdate struct {
	Version  string `json:"version"`
	Platform string `json:"platform"`
	SHA256   string `json:"sha256"`
	// root is the folder the archive held (LibreCorsa.app, LibreCorsa) in the staging folder
	root string
}

func (u *updater) stagedDir() string    { return filepath.Join(u.dir, "staged") }
func (u *updater) stagedRecord() string { return filepath.Join(u.dir, "staged.json") }
func (u *updater) failedRecord() string { return filepath.Join(u.dir, "failed.json") }

// pending is the staged update to install: newer than this launcher, for this platform, not one that failed before.
// A staged release that is no longer newer (installed since, by hand or by this launcher) is cleared away.
func (u *updater) pending() *stagedUpdate {
	if u.inst == nil {
		return nil
	}
	b, err := os.ReadFile(u.stagedRecord())
	if err != nil {
		return nil
	}
	var st stagedUpdate
	if json.Unmarshal(b, &st) != nil || st.Platform != u.target.Platform() {
		u.clearStaged()
		return nil
	}
	if newer, err := release.Newer(st.Version, u.current); err != nil || !newer {
		u.clearStaged()
		return nil
	}
	if f := u.failedVersion(); f == st.Version {
		return nil
	}
	st.root = filepath.Join(u.stagedDir(), release.ArchiveRoot(u.target.GOOS))
	if info, err := os.Lstat(filepath.Join(st.root, filepath.FromSlash(release.Program(u.target.GOOS)))); err != nil || !info.Mode().IsRegular() {
		u.clearStaged()
		return nil
	}
	return &st
}

func (u *updater) clearStaged() {
	os.Remove(u.stagedRecord())
	os.RemoveAll(u.stagedDir())
}

// failedVersion is the version whose install failed, which isn't tried again
func (u *updater) failedVersion() string {
	b, err := os.ReadFile(u.failedRecord())
	if err != nil {
		return ""
	}
	var f struct {
		Version string `json:"version"`
	}
	json.Unmarshal(b, &f)
	return f.Version
}

func (u *updater) markFailed(v string, why error) {
	fmt.Fprintf(os.Stderr, "The update to %s couldn't be installed, so %s stays: %v\n", v, u.current, why)
	b, _ := json.Marshal(map[string]string{"version": v, "error": why.Error()})
	os.MkdirAll(u.dir, 0o700)
	os.WriteFile(u.failedRecord(), b, 0o600)
	u.clearStaged()
	u.set(func(s *updateInfo) {
		s.State, s.Latest, s.Error = updateFailed, v, why.Error()
	})
}

func (u *updater) set(f func(s *updateInfo)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	f(&u.status)
}

// info is the update's state for the game's note
func (u *updater) info() updateInfo {
	u.mu.Lock()
	s := u.status
	u.mu.Unlock()
	s.Version, s.Run = u.current, u.run
	s.SelfUpdate = u.inst != nil
	if !s.SelfUpdate {
		s.Reason = u.reason
	}
	if st := u.pending(); st != nil {
		s.State, s.Latest, s.Error = updateReady, st.Version, ""
	}
	s.ReleaseURL = releasesPage + "/latest"
	if s.Latest != "" {
		s.ReleaseURL = releasesPage + "/tag/" + launcherTagPrefix + s.Latest
	}
	return s
}

// runChecks checks at start and every few hours until ctx ends
func (u *updater) runChecks(ctx context.Context) {
	if !u.enabled {
		return
	}
	wait := firstCheckAfter
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if err := u.check(ctx); err != nil && ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "Update check: %v\n", err)
		}
		wait = checkEvery
	}
}

// check asks for the newest release and, when it is newer and this launcher can install it, fetches it
func (u *updater) check(ctx context.Context) error {
	data, sigURL, err := u.fetchManifest(ctx)
	if err != nil {
		return err
	}
	if len(u.keys) == 0 {
		// Nothing to check it with: only its version is read, to say a newer release is out
		m, err := release.ParseManifest(data)
		if err != nil {
			return err
		}
		if newer, _ := release.Newer(m.Version, u.current); newer {
			u.set(func(s *updateInfo) { s.State, s.Latest = updateAvailable, m.Version })
			fmt.Printf("LibreCorsa %s is out: %s\n", m.Version, releasesPage)
		}
		return nil
	}
	sig, err := u.fetchSmall(ctx, sigURL, release.MaxSignatureBytes)
	if err != nil {
		return fmt.Errorf("the manifest's signature: %w", err)
	}
	if err := release.Verify(u.keys, data, sig); err != nil {
		return err
	}
	m, err := release.ParseManifest(data)
	if err != nil {
		return err
	}
	newer, err := release.Newer(m.Version, u.current)
	if err != nil {
		return err
	}
	if !newer {
		// The newest is this one, or older (never installed: no downgrade)
		return nil
	}
	if u.inst == nil {
		u.set(func(s *updateInfo) { s.State, s.Latest = updateAvailable, m.Version })
		fmt.Printf("LibreCorsa %s is out (%s): %s\n", m.Version, u.reason, releasesPage)
		return nil
	}
	if st := u.pending(); st != nil && st.Version == m.Version {
		return nil
	}
	if u.failedVersion() == m.Version {
		u.set(func(s *updateInfo) { s.State, s.Latest = updateFailed, m.Version })
		return nil
	}
	asset, ok := m.Platforms[u.target.Platform()]
	if !ok {
		return fmt.Errorf("%s has no archive for %s", m.Version, u.target.Platform())
	}
	if !strings.HasPrefix(asset.URL, u.downloadPrefix) {
		return fmt.Errorf("the archive's address %s isn't among the repository's releases", asset.URL)
	}
	fmt.Printf("Downloading LibreCorsa %s (%d MB)\n", m.Version, asset.Size/mb)
	u.set(func(s *updateInfo) {
		s.State, s.Latest, s.Done, s.Total, s.Error = updateDownloading, m.Version, 0, asset.Size, ""
	})
	if err := u.stage(ctx, m.Version, asset); err != nil {
		u.set(func(s *updateInfo) { s.State, s.Done, s.Total, s.Error = updateNone, 0, 0, err.Error() })
		return fmt.Errorf("LibreCorsa %s: %w", m.Version, err)
	}
	u.set(func(s *updateInfo) { s.State, s.Done, s.Total = updateReady, 0, 0 })
	fmt.Printf("LibreCorsa %s is ready: it is installed at the next start, or with Restart to update in the game\n", m.Version)
	return nil
}

// fetchManifest fetches the newest launcher release's manifest, and says where its signature is. The repository's
// latest release may be the desktop app's: then the newest launcher release is looked up in the list of releases.
func (u *updater) fetchManifest(ctx context.Context) ([]byte, string, error) {
	data, err := u.fetchSmall(ctx, u.manifestURL, release.MaxManifestBytes)
	if err == nil {
		return data, strings.TrimSuffix(u.manifestURL, release.ManifestName) + release.SignatureName, nil
	}
	if !errors.Is(err, errNotFound) {
		return nil, "", err
	}
	tag, err := u.newestLauncherTag(ctx)
	if err != nil {
		return nil, "", err
	}
	base := u.downloadPrefix + tag + "/"
	data, err = u.fetchSmall(ctx, base+release.ManifestName, release.MaxManifestBytes)
	return data, base + release.SignatureName, err
}

var errNotFound = errors.New("not found")

// tagPattern is what a launcher release's tag may look like (it goes into an address)
var tagPattern = regexp.MustCompile(`^launcher-v[0-9A-Za-z.-]{1,40}$`)

// newestLauncherTag is the newest published launcher release's tag, from GitHub's list of releases
func (u *updater) newestLauncherTag(ctx context.Context) (string, error) {
	data, err := u.fetchSmall(ctx, u.apiURL, 2<<20)
	if err != nil {
		return "", fmt.Errorf("the list of releases: %w", err)
	}
	var list []struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		return "", fmt.Errorf("the list of releases: %w", err)
	}
	best, bestTag := release.Version{}, ""
	for _, r := range list {
		if r.Draft || r.Prerelease || !tagPattern.MatchString(r.Tag) {
			continue
		}
		v, err := release.ParseVersion(strings.TrimPrefix(r.Tag, launcherTagPrefix))
		if err != nil {
			continue
		}
		if bestTag == "" || release.Compare(v, best) > 0 {
			best, bestTag = v, r.Tag
		}
	}
	if bestTag == "" {
		return "", errors.New("no launcher release is published yet")
	}
	return bestTag, nil
}

// fetchSmall fetches a small file over HTTPS, at most limit bytes
func (u *updater) fetchSmall(ctx context.Context, url string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(url, "https://") {
		return nil, fmt.Errorf("%s: only https", url)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "librecorsa-launcher/"+version)
	res, err := u.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s: %w", url, errNotFound)
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", url, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s: larger than %d bytes", url, limit)
	}
	return data, nil
}

// stage downloads and checks the archive, unpacks it, checks the launcher in it, and records it as staged
func (u *updater) stage(ctx context.Context, v string, asset release.Asset) error {
	if err := os.MkdirAll(u.dir, 0o700); err != nil {
		return err
	}
	downloads := filepath.Join(u.dir, "downloads")
	os.RemoveAll(downloads)
	defer os.RemoveAll(downloads)
	archive, err := fetchVerified(ctx, u.client, pinnedFile{Name: "update", Version: v, URL: asset.URL, SHA256: asset.SHA256, Size: asset.Size},
		downloads, func(done int64) { u.set(func(s *updateInfo) { s.Done = done }) })
	if err != nil {
		return err
	}
	partial := filepath.Join(u.dir, "staging.partial")
	os.RemoveAll(partial)
	if err := unpackUpdate(archive, u.target.Format, release.ArchiveRoot(u.target.GOOS), partial); err != nil {
		os.RemoveAll(partial)
		return err
	}
	os.Remove(archive)
	if err := checkStaged(ctx, filepath.Join(partial, release.ArchiveRoot(u.target.GOOS)), u.target.GOOS, v); err != nil {
		os.RemoveAll(partial)
		return err
	}
	u.clearStaged()
	if err := os.Rename(partial, u.stagedDir()); err != nil {
		os.RemoveAll(partial)
		return err
	}
	b, _ := json.Marshal(stagedUpdate{Version: v, Platform: u.target.Platform(), SHA256: asset.SHA256})
	tmp := u.stagedRecord() + ".partial"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, u.stagedRecord())
}

// checkStaged makes sure an unpacked release is one: the launcher where a release has it, a regular file, that runs
// and says the version the manifest does, and the game beside it
func checkStaged(ctx context.Context, root, goos, want string) error {
	program := filepath.Join(root, filepath.FromSlash(release.Program(goos)))
	info, err := os.Lstat(program)
	if err != nil || !info.Mode().IsRegular() || (goos != "windows" && info.Mode().Perm()&0o100 == 0) {
		return errors.New("the update holds no launcher")
	}
	if !isExport(filepath.Join(root, filepath.FromSlash(release.Resources(goos)), "game")) {
		return errors.New("the update holds no game")
	}
	if goos != runtime.GOOS {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, versionRunTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, "--version")
	cmd.Dir = root
	cmd.Env = withoutHandoff(os.Environ())
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("the update's launcher doesn't run: %w", err)
	}
	if got := strings.TrimSpace(string(out)); got != "LibreCorsa launcher "+want {
		return fmt.Errorf("the update's launcher says %q, the manifest %s", got, want)
	}
	return nil
}

// cleanupAfterStart removes what an earlier update left beside the release: at once, or a few minutes after a start
// that an update made (the launcher that made it may still need the old version, to put it back)
func (u *updater) cleanupAfterStart(ctx context.Context, startedByUpdate bool) {
	if u.inst == nil {
		return
	}
	if !startedByUpdate {
		u.inst.cleanup()
		return
	}
	go func() {
		select {
		case <-ctx.Done():
		case <-time.After(5 * time.Minute):
			u.inst.cleanup()
		}
	}()
}

// requestRestart asks the launcher to put the staged update in place now ("Restart to update")
func (u *updater) requestRestart() {
	select {
	case u.restart <- struct{}{}:
	default:
	}
}

// restartRequested is sent on when the game asked for "Restart to update"
func (u *updater) restartRequested() <-chan struct{} { return u.restart }

// install puts a staged update in place and starts the new launcher with the handoff. nil: the new launcher answers
// at origin, and this one should exit. Otherwise everything is as it was, and the update is marked failed.
func (u *updater) install(st *stagedUpdate, h handoff, origin string) error {
	u.installing.Store(true)
	defer u.installing.Store(false)
	fmt.Printf("Installing LibreCorsa %s\n", st.Version)
	applied, err := u.inst.swap(st.root)
	if err != nil {
		u.markFailed(st.Version, err)
		return err
	}
	h.From = u.current
	started, err := startLauncher(u.inst.program, u.args, h)
	if err == nil {
		if err = waitAnswer(origin, st.Version, started, healthTimeout); err != nil {
			started.stop()
		}
	}
	if err != nil {
		if uerr := applied.undo(); uerr != nil {
			err = errors.Join(err, fmt.Errorf("and the old version couldn't be put back: %w", uerr))
		}
		u.markFailed(st.Version, err)
		return err
	}
	applied.finish()
	u.clearStaged()
	os.Remove(u.failedRecord())
	fmt.Printf("LibreCorsa %s is installed and running\n", st.Version)
	return nil
}

// restartForUpdate installs the staged update and hands the game's window over to the new launcher, once this
// one's server has stopped. If the update can't be installed, this version is started again with the same window.
// It returns the exit code.
func (u *updater) restartForUpdate(h handoff, origin string) int {
	if st := u.pending(); st != nil {
		if u.install(st, h, origin) == nil {
			return 0
		}
	}
	exe, err := os.Executable()
	if err == nil {
		h.From = ""
		var started *launched
		if started, err = startLauncher(exe, u.args, h); err == nil {
			if err = waitAnswer(origin, u.current, started, healthTimeout); err != nil {
				started.stop()
			}
		}
	}
	if err != nil {
		return failStart(true, fmt.Sprintf("LibreCorsa couldn't start again after the update (%v). Start it again.", err))
	}
	return 0
}
