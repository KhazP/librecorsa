// Package release is what a launcher release publishes for the launchers already installed to update themselves: the
// update manifest (launcher-latest.json), its Ed25519 signature, the archives it names, and how versions compare.
// The launcher reads them (launcher/update.go); tools/release writes and signs them for a release
// (.github/workflows/release-launcher.yml).
package release

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// App is the manifest's "app": a manifest for anything else is refused, whatever signed it
const App = "librecorsa-launcher"

// Format is the manifest format this package reads and writes
const Format = 1

// The files a release publishes beside its archives
const (
	ManifestName  = "launcher-latest.json"
	SignatureName = ManifestName + ".sig"
)

// Bounds on what is read: a manifest and its signature are small, an archive holds the game's export
const (
	MaxManifestBytes  = 64 << 10
	MaxSignatureBytes = 1 << 10
	MaxArchiveBytes   = 8 << 30
)

// Target is one platform a release is built for, with how its archive is named and packed
type Target struct {
	GOOS, GOARCH string
	// Label names the platform in the archive's file name, as people know it
	Label string
	// Format is the archive's: "zip" or "tar.gz"
	Format string
}

// Targets are the platforms a release is built for
var Targets = []Target{
	{"darwin", "arm64", "mac-arm64", "zip"},
	{"darwin", "amd64", "mac-x64", "zip"},
	{"windows", "amd64", "win-x64", "zip"},
	{"linux", "amd64", "linux-x64", "tar.gz"},
}

// FindTarget is the target for goos/goarch, if a release is built for it
func FindTarget(goos, goarch string) (Target, bool) {
	for _, t := range Targets {
		if t.GOOS == goos && t.GOARCH == goarch {
			return t, true
		}
	}
	return Target{}, false
}

// Platform is a target's key in the manifest's "platforms"
func (t Target) Platform() string { return t.GOOS + "/" + t.GOARCH }

// ArchiveName is the file a release publishes for the target
func (t Target) ArchiveName(version string) string {
	return "LibreCorsa-" + version + "-" + t.Label + "." + t.Format
}

// ArchiveRoot is the one folder an archive holds: the app bundle on macOS, a folder elsewhere
func ArchiveRoot(goos string) string {
	if goos == "darwin" {
		return "LibreCorsa.app"
	}
	return "LibreCorsa"
}

// Program is where the launcher is inside the archive's root
func Program(goos string) string {
	switch goos {
	case "darwin":
		return "Contents/MacOS/librecorsa"
	case "windows":
		return "LibreCorsa.exe"
	default:
		return "librecorsa"
	}
}

// Resources is the folder inside the archive's root that holds the game and the converter
func Resources(goos string) string {
	if goos == "darwin" {
		return "Contents/Resources"
	}
	return "."
}

// Asset is one platform's archive
type Asset struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// Manifest is launcher-latest.json: the newest release and each platform's archive
type Manifest struct {
	App       string           `json:"app"`
	Format    int              `json:"format"`
	Version   string           `json:"version"`
	Released  string           `json:"released,omitempty"`
	Platforms map[string]Asset `json:"platforms"`
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ParseManifest decodes a manifest and checks its fields (not its signature: see Verify). Fields it doesn't know are
// passed over, so a later format can add some.
func ParseManifest(data []byte) (*Manifest, error) {
	if len(data) > MaxManifestBytes {
		return nil, errors.New("the manifest is too large")
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("the manifest isn't JSON: %w", err)
	}
	if m.App != App {
		return nil, fmt.Errorf("the manifest is for %q, not %q", m.App, App)
	}
	if m.Format != Format {
		return nil, fmt.Errorf("the manifest's format is %d, this reads %d", m.Format, Format)
	}
	if _, err := ParseVersion(m.Version); err != nil {
		return nil, err
	}
	for platform, a := range m.Platforms {
		if err := a.check(); err != nil {
			return nil, fmt.Errorf("%s: %w", platform, err)
		}
	}
	return &m, nil
}

func (a Asset) check() error {
	if !strings.HasPrefix(a.URL, "https://") || len(a.URL) > 2048 {
		return fmt.Errorf("the archive's address %q isn't https", a.URL)
	}
	if a.Size <= 0 || a.Size > MaxArchiveBytes {
		return fmt.Errorf("the archive's size %d is out of bounds", a.Size)
	}
	if !sha256Hex.MatchString(a.SHA256) {
		return fmt.Errorf("the archive's SHA-256 %q isn't one", a.SHA256)
	}
	return nil
}

// Encode writes a manifest as the file a release publishes
func (m *Manifest) Encode() ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(m); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ParsePublicKeys reads the public keys an update may be signed with: update-key.pub's lines (or a comma-separated
// list, as a build passes them), each a base64 Ed25519 public key. Blank lines and lines starting with # are passed
// over. More than one lets a release that ships a new key still be checked against the old one.
func ParsePublicKeys(text string) ([]ed25519.PublicKey, error) {
	var keys []ed25519.PublicKey
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' }) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		for _, field := range strings.Split(line, ",") {
			field = strings.TrimSpace(field)
			b, err := base64.StdEncoding.DecodeString(field)
			if err != nil || len(b) != ed25519.PublicKeySize {
				return nil, fmt.Errorf("%q is not a base64 Ed25519 public key", field)
			}
			keys = append(keys, ed25519.PublicKey(b))
		}
	}
	return keys, nil
}

// FormatPublicKey is a public key as update-key.pub holds it
func FormatPublicKey(key ed25519.PublicKey) string { return base64.StdEncoding.EncodeToString(key) }

// ErrBadSignature is a manifest that none of the keys signed
var ErrBadSignature = errors.New("the update manifest's signature doesn't match the launcher's key")

// Verify checks a manifest's signature (the .sig file: the base64 signature of the manifest's exact bytes) against
// each key
func Verify(keys []ed25519.PublicKey, manifest, sig []byte) error {
	if len(keys) == 0 {
		return errors.New("no key to check the update manifest with")
	}
	if len(sig) > MaxSignatureBytes {
		return ErrBadSignature
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || len(raw) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	for _, k := range keys {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, manifest, raw) {
			return nil
		}
	}
	return ErrBadSignature
}

// ParsePrivateKey reads a private key as LAUNCHER_UPDATE_KEY holds it: the base64 of its 32-byte seed
func ParsePrivateKey(text string) (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("the private key is not the base64 of a 32-byte Ed25519 seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// FormatPrivateKey is a private key as LAUNCHER_UPDATE_KEY holds it
func FormatPrivateKey(key ed25519.PrivateKey) string {
	return base64.StdEncoding.EncodeToString(key.Seed())
}

// Sign is the .sig file for a manifest's bytes
func Sign(key ed25519.PrivateKey, manifest []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(key, manifest)) + "\n")
}

// Version is a release's version: MAJOR.MINOR.PATCH with an optional -prerelease, compared as Semantic Versioning
// compares them (no build metadata)
type Version struct {
	Major, Minor, Patch int
	Pre                 []string
}

var versionRe = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-([0-9A-Za-z-]{1,20}(?:\.[0-9A-Za-z-]{1,20}){0,4}))?$`)

// ParseVersion reads a version, strictly
func ParseVersion(s string) (Version, error) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return Version{}, fmt.Errorf("%q is not a version (MAJOR.MINOR.PATCH)", s)
	}
	var v Version
	v.Major, _ = strconv.Atoi(m[1])
	v.Minor, _ = strconv.Atoi(m[2])
	v.Patch, _ = strconv.Atoi(m[3])
	if m[4] != "" {
		v.Pre = strings.Split(m[4], ".")
		for _, id := range v.Pre {
			if isNumeric(id) && len(id) > 1 && id[0] == '0' {
				return Version{}, fmt.Errorf("%q: a numeric prerelease part has a leading zero", s)
			}
		}
	}
	return v, nil
}

func (v Version) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if len(v.Pre) > 0 {
		s += "-" + strings.Join(v.Pre, ".")
	}
	return s
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// Compare is -1, 0 or 1 as a is older than, the same as or newer than b. A prerelease is older than its release.
func Compare(a, b Version) int {
	if c := cmpInt(a.Major, b.Major); c != 0 {
		return c
	}
	if c := cmpInt(a.Minor, b.Minor); c != 0 {
		return c
	}
	if c := cmpInt(a.Patch, b.Patch); c != 0 {
		return c
	}
	switch {
	case len(a.Pre) == 0 && len(b.Pre) == 0:
		return 0
	case len(a.Pre) == 0:
		return 1
	case len(b.Pre) == 0:
		return -1
	}
	for i := 0; i < len(a.Pre) && i < len(b.Pre); i++ {
		x, y := a.Pre[i], b.Pre[i]
		xn, yn := isNumeric(x), isNumeric(y)
		switch {
		case xn && yn:
			xi, _ := strconv.Atoi(x)
			yi, _ := strconv.Atoi(y)
			if c := cmpInt(xi, yi); c != 0 {
				return c
			}
		case xn:
			return -1
		case yn:
			return 1
		default:
			if c := strings.Compare(x, y); c != 0 {
				return c
			}
		}
	}
	return cmpInt(len(a.Pre), len(b.Pre))
}

// Newer reports whether candidate is a newer version than current. Either one that isn't a version is an error: a
// build whose version is unknown ("dev") never updates.
func Newer(candidate, current string) (bool, error) {
	c, err := ParseVersion(candidate)
	if err != nil {
		return false, err
	}
	cur, err := ParseVersion(current)
	if err != nil {
		return false, err
	}
	return Compare(c, cur) > 0, nil
}

// SHA256Hex is a digest as the manifest writes it
func SHA256Hex(sum []byte) string { return hex.EncodeToString(sum) }
