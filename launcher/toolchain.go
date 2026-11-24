package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// The converter's toolchain: uv (which fetches Python and the converters' packages) and Node. Nothing is downloaded
// until the player asks; then each comes from a pinned HTTPS URL and is checked against the SHA-256 pinned here before
// anything is extracted or run. Only the program itself is taken out of each archive.

// uvVersion and nodeVersion are the pinned releases (https://github.com/astral-sh/uv/releases, https://nodejs.org/dist)
const (
	uvVersion   = "0.13.9"
	nodeVersion = "v26.13.1"
)

// pythonExcludeNewer holds uv to the packages PyPI had on this date, so the converters' packages (pinned by
// version in their requirements files) bring the same dependencies with them on every machine
const pythonExcludeNewer = "2026-11-20T00:00:00Z"

// pinnedFile is one download: where it is, its SHA-256 and size, and which of its files to keep
type pinnedFile struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"bytes"`
	// Format is "tar.gz" or "zip" (Go's own readers: no .tar.xz)
	Format string `json:"-"`
	// Member is the program's path in the archive; it is extracted as Program into the component's folder
	Member  string `json:"-"`
	Program string `json:"-"`
}

// platformPins are the downloads for each platform a release is built for, with what uv fetches after them
// (Python 3.14 and the converters' packages, estimated from their wheels on PyPI)
type platformPins struct {
	UV, Node     pinnedFile
	PythonApprox int64
}

const mb = 1000 * 1000

var toolchainPins = map[string]platformPins{
	"darwin/arm64": {
		UV:           uvPin("aarch64-apple-darwin", "tar.gz", "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca", 14554974),
		Node:         nodePin("darwin-arm64", "tar.gz", "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735", 58340590),
		PythonApprox: 135 * mb,
	},
	"darwin/amd64": {
		UV:           uvPin("x86_64-apple-darwin", "tar.gz", "617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041", 17362924),
		Node:         nodePin("darwin-x64", "tar.gz", "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f", 59799324),
		PythonApprox: 127 * mb,
	},
	"linux/amd64": {
		UV:           uvPin("x86_64-unknown-linux-gnu", "tar.gz", "a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5", 17068176),
		Node:         nodePin("linux-x64", "tar.gz", "518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778", 62904977),
		PythonApprox: 162 * mb,
	},
	"windows/amd64": {
		UV:           uvPin("x86_64-pc-windows-msvc", "zip", "edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb", 15567875),
		Node:         nodePin("win-x64", "zip", "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7", 41166246),
		PythonApprox: 138 * mb,
	},
}

func uvPin(triple, format, sha string, size int64) pinnedFile {
	name := "uv-" + triple + "." + format
	p := pinnedFile{
		Name: "uv", Version: uvVersion, Format: format, SHA256: sha, Size: size,
		URL: "https://github.com/astral-sh/uv/releases/download/" + uvVersion + "/" + name,
	}
	if format == "zip" {
		// The Windows archive holds the programs at its top
		p.Member, p.Program = "uv.exe", "uv.exe"
	} else {
		p.Member, p.Program = "uv-"+triple+"/uv", "uv"
	}
	return p
}

func nodePin(platform, format, sha string, size int64) pinnedFile {
	dir := "node-" + nodeVersion + "-" + platform
	p := pinnedFile{
		Name: "node", Version: nodeVersion, Format: format, SHA256: sha, Size: size,
		URL: "https://nodejs.org/dist/" + nodeVersion + "/" + dir + "." + format,
	}
	if format == "zip" {
		p.Member, p.Program = dir+"/node.exe", "node.exe"
	} else {
		// In bin/, so that folder can go on PATH for the Python converters that start `node`
		p.Member, p.Program = dir+"/bin/node", "bin/node"
	}
	return p
}

// toolchain is where the downloads live (beside the browser profile) and what is pinned for this platform
type toolchain struct {
	dir  string
	pins platformPins
	ok   bool // whether this platform has pins
	// client fetches the downloads; only HTTPS is followed, redirects included
	client *http.Client
}

func newToolchain(dir, goos, goarch string) *toolchain {
	pins, ok := toolchainPins[goos+"/"+goarch]
	client := &http.Client{
		// Long enough for a slow line; each read is bounded by the transport's timeouts
		Timeout: 30 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" {
				return fmt.Errorf("refused a redirect to %s: only https", req.URL.Redacted())
			}
			if len(via) > 5 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
	return &toolchain{dir: dir, pins: pins, ok: ok, client: client}
}

// defaultToolchainDir is the per-user folder the toolchain is downloaded into, beside the browser profile
func defaultToolchainDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(profileRoot(runtime.GOOS, home), "LibreCorsa", "toolchain")
}

func (t *toolchain) componentDir(p pinnedFile) string {
	return filepath.Join(t.dir, p.Name+"-"+p.Version)
}

// uvPath and nodePath are the programs once downloaded
func (t *toolchain) uvPath() string {
	return filepath.Join(t.componentDir(t.pins.UV), filepath.FromSlash(t.pins.UV.Program))
}
func (t *toolchain) nodePath() string {
	return filepath.Join(t.componentDir(t.pins.Node), filepath.FromSlash(t.pins.Node.Program))
}

// stateFile records what the last complete setup installed, so a newer launcher (other pins) or converter (other
// packages) sets up again
func (t *toolchain) stateFile() string { return filepath.Join(t.dir, "toolchain.json") }

type toolchainState struct {
	UV       string `json:"uv"`
	Node     string `json:"node"`
	Python   string `json:"python"`
	Packages string `json:"packages"`
}

func (t *toolchain) wanted(conv *converterInfo) toolchainState {
	return toolchainState{UV: uvVersion, Node: nodeVersion, Python: conv.Python.Version, Packages: conv.requirementsHash}
}

// ready reports whether the toolchain is set up for this converter: both programs there, and Python and its packages
// fetched for the converter's requirements
func (t *toolchain) ready(conv *converterInfo) bool {
	if !t.ok || conv == nil {
		return false
	}
	var have toolchainState
	b, err := os.ReadFile(t.stateFile())
	if err != nil || json.Unmarshal(b, &have) != nil || have != t.wanted(conv) {
		return false
	}
	return isFile(t.uvPath()) && isFile(t.nodePath())
}

func isFile(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}

// toolchainInfo is what the Mods panel shows before the first download
type toolchainInfo struct {
	State     string       `json:"state"` // "ready", "missing" or "unsupported"
	Dir       string       `json:"dir"`
	Downloads []pinnedFile `json:"downloads,omitempty"`
	// PythonApprox is what uv fetches after them (Python and the converters' packages), roughly
	PythonApprox int64  `json:"pythonApproxBytes,omitempty"`
	Python       string `json:"python,omitempty"`
}

func (t *toolchain) info(conv *converterInfo) toolchainInfo {
	if !t.ok {
		return toolchainInfo{State: "unsupported", Dir: t.dir}
	}
	state := "missing"
	if t.ready(conv) {
		state = "ready"
	}
	var downloads []pinnedFile
	for _, p := range []pinnedFile{t.pins.UV, t.pins.Node} {
		// One already there (an earlier setup that stopped after it) isn't downloaded again
		if !isFile(filepath.Join(t.componentDir(p), filepath.FromSlash(p.Program))) {
			downloads = append(downloads, p)
		}
	}
	info := toolchainInfo{State: state, Dir: t.dir, Downloads: downloads, PythonApprox: t.pins.PythonApprox}
	if conv != nil {
		info.Python = conv.Python.Version
	}
	return info
}

// errHashMismatch is a download whose bytes aren't the pinned ones
var errHashMismatch = errors.New("the download's SHA-256 is not the pinned one")

// fetchVerified downloads p into a file in dir, checks its size and SHA-256 against the pins, and returns the file's
// path. progress is told the bytes so far. A download that doesn't match is deleted.
func (t *toolchain) fetchVerified(ctx context.Context, p pinnedFile, dir string, progress func(done int64)) (string, error) {
	if !strings.HasPrefix(p.URL, "https://") {
		return "", fmt.Errorf("%s: only https downloads", p.URL)
	}
	want, err := hex.DecodeString(p.SHA256)
	if err != nil || len(want) != sha256.Size {
		return "", fmt.Errorf("%s: the pinned SHA-256 is not one", p.Name)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "librecorsa-launcher/"+version)
	res, err := t.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s: %w", p.Name, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: %s answered %s", p.Name, p.URL, res.Status)
	}
	if res.ContentLength > 0 && p.Size > 0 && res.ContentLength != p.Size {
		return "", fmt.Errorf("%s: %d bytes offered, %d pinned", p.Name, res.ContentLength, p.Size)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, p.Name+"-*.download")
	if err != nil {
		return "", err
	}
	name := f.Name()
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(name)
		}
	}()
	h := sha256.New()
	limit := p.Size
	if limit <= 0 {
		limit = 512 * mb
	}
	// One byte past the pinned size is enough to know it isn't the pinned file
	body := io.LimitReader(res.Body, limit+1)
	var done int64
	buf := make([]byte, 256*1024)
	for {
		n, rerr := body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				return "", err
			}
			h.Write(buf[:n])
			done += int64(n)
			if done > limit {
				return "", fmt.Errorf("%s: larger than the pinned %d bytes", p.Name, limit)
			}
			if progress != nil {
				progress(done)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return "", fmt.Errorf("%s: %w", p.Name, rerr)
		}
	}
	if p.Size > 0 && done != p.Size {
		return "", fmt.Errorf("%s: %d bytes received, %d pinned", p.Name, done, p.Size)
	}
	if got := h.Sum(nil); !equalBytes(got, want) {
		return "", fmt.Errorf("%s: %w (got %x)", p.Name, errHashMismatch, got)
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	ok = true
	return name, nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// maxProgramBytes bounds what is extracted: the largest program pinned (Node) is about 120 MB
const maxProgramBytes = 400 * mb

// extractProgram takes the pinned program, and only it, out of a verified archive into destDir/<p.Program>. The
// member must be a regular file at exactly its pinned path: links, devices and every other entry are passed over, and
// nothing can be written outside destDir (os.Root). It is written beside its final name and moved into place.
func extractProgram(archive string, p pinnedFile, destDir string) error {
	if !isSafeArchivePath(p.Member) || !isSafeArchivePath(p.Program) {
		return fmt.Errorf("%s: unsafe pinned path", p.Name)
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	root, err := os.OpenRoot(destDir)
	if err != nil {
		return err
	}
	defer root.Close()
	if dir := path.Dir(p.Program); dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := p.Program + ".partial"
	// What is left of a failed extraction goes, whichever step failed
	placed := false
	defer func() {
		if !placed {
			root.Remove(tmp)
		}
	}()
	write := func(r io.Reader) error {
		out, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		n, err := io.Copy(out, io.LimitReader(r, maxProgramBytes+1))
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err == nil && n > maxProgramBytes {
			err = fmt.Errorf("%s is larger than %d bytes", p.Member, maxProgramBytes)
		}
		return err
	}
	found := false
	switch p.Format {
	case "tar.gz":
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if !isSafeArchivePath(hdr.Name) || hdr.Name != p.Member || hdr.Typeflag != tar.TypeReg {
				continue
			}
			if err := write(tr); err != nil {
				return err
			}
			found = true
			break
		}
	case "zip":
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer zr.Close()
		for _, zf := range zr.File {
			if !isSafeArchivePath(zf.Name) || zf.Name != p.Member || !zf.Mode().IsRegular() {
				continue
			}
			rc, err := zf.Open()
			if err != nil {
				return err
			}
			err = write(rc)
			rc.Close()
			if err != nil {
				return err
			}
			found = true
			break
		}
	default:
		return fmt.Errorf("%s: unknown archive format %q", p.Name, p.Format)
	}
	if !found {
		return fmt.Errorf("%s: %s is not in the archive", p.Name, p.Member)
	}
	if err := root.Chmod(tmp, 0o755); err != nil {
		return err
	}
	if err := root.Rename(tmp, p.Program); err != nil {
		return err
	}
	placed = true
	return nil
}

// isSafeArchivePath reports whether an archive member's name stays inside the folder it is extracted to: relative,
// forward slashes, no `.`, `..` or empty segment, no drive letter or control character
func isSafeArchivePath(name string) bool {
	if name == "" || len(name) > 512 || strings.HasPrefix(name, "/") || strings.ContainsAny(name, "\\:") {
		return false
	}
	if strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return false
	}
	for seg := range strings.SplitSeq(strings.TrimSuffix(name, "/"), "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// install downloads, verifies and extracts one pinned program, unless it is already there
func (t *toolchain) install(ctx context.Context, p pinnedFile, progress func(done int64)) error {
	dest := t.componentDir(p)
	if isFile(filepath.Join(dest, filepath.FromSlash(p.Program))) {
		return nil
	}
	archive, err := t.fetchVerified(ctx, p, filepath.Join(t.dir, "downloads"), progress)
	if err != nil {
		return err
	}
	defer os.Remove(archive)
	return extractProgram(archive, p, dest)
}

// uvEnv is the environment uv runs in: its cache, Python installs and settings in the toolchain folder, no config
// files of the player's, only the Pythons it installed itself, and the packages PyPI had on the pinned date
func (t *toolchain) uvEnv() []string {
	return []string{
		"UV_CACHE_DIR=" + filepath.Join(t.dir, "uv-cache"),
		"UV_PYTHON_INSTALL_DIR=" + filepath.Join(t.dir, "python"),
		"UV_PYTHON_BIN_DIR=" + filepath.Join(t.dir, "python", "bin"),
		"UV_TOOL_DIR=" + filepath.Join(t.dir, "uv-tools"),
		"UV_NO_CONFIG=1",
		"UV_PYTHON_PREFERENCE=only-managed",
		"UV_EXCLUDE_NEWER=" + pythonExcludeNewer,
		"UV_NO_PROGRESS=1",
		"UV_PYTHON_INSTALL_REGISTRY=0",
		"UV_PYTHON_INSTALL_BIN=0",
	}
}

// pathDirs are the folders put first on PATH for the converter: Node's (the Python converters start `node`) and uv's
func (t *toolchain) pathDirs() []string {
	return []string{filepath.Dir(t.nodePath()), filepath.Dir(t.uvPath())}
}

func (t *toolchain) markReady(conv *converterInfo) error {
	b, _ := json.MarshalIndent(t.wanted(conv), "", "  ")
	tmp := t.stateFile() + ".partial"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, t.stateFile())
}
