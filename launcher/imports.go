package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The import folder: where a player copies another game's circuit or car, to be converted into a mod package by the
// converter bundled with a release (launcher/converter/build.mjs). Each folder in it is recognised by what it holds.

// importReadme is written into a new import folder (and a release's, by build.mjs)
//
//go:embed import-readme.txt
var importReadme string

// makeImportDir creates the import folder, with a README on what goes in it, if it isn't there
func makeImportDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	readme := filepath.Join(dir, "README.txt")
	if _, err := os.Lstat(readme); errors.Is(err, os.ErrNotExist) {
		text := importReadme
		if runtime.GOOS == "windows" {
			text = strings.ReplaceAll(text, "\n", "\r\n")
		}
		return os.WriteFile(readme, []byte(text), 0o644)
	}
	return nil
}

// importKinds are the importers (scripts/mods/importers/<kind>.ts) a folder can be recognised for
const (
	kindACTrack      = "ac-track"
	kindACCar        = "ac-car"
	kindSDTrack      = "sd-track"
	kindSDCar        = "sd-car"
	kindF1Track      = "f1-track"
	kindBlenderTrack = "blender-track"
	kindUnknown      = "unknown"
	// An archive (a .zip, .7z or .rar) or another file, not a folder: unpack it first
	kindArchive = "archive"
	kindFile    = "file"
	// A link: not followed, so never converted
	kindLink = "link"
)

// importEntry is one thing in the import folder, as the Mods panel lists it
type importEntry struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
	// Source is what the importer is given, relative to the import folder: the folder, a folder inside it (a folder
	// unzipped into a folder of the same name), or a file in it (F1 25's .erp, a Blender export's .glb)
	Source string `json:"source,omitempty"`
	// Available is false when the release's converter has no importer for the kind
	Available bool `json:"available"`
}

// validImportName reports whether name can be a folder directly in the import folder: one path segment, no `.` or
// `..`, no hidden file, separator, drive letter or control character
func validImportName(name string) bool {
	if name == "" || len(name) > 255 || !utf8.ValidString(name) || name == "." || name == ".." || strings.HasPrefix(name, ".") {
		return false
	}
	return !strings.ContainsAny(name, `/\:`) && !strings.ContainsFunc(name, unicode.IsControl)
}

// listImports lists the import folder's entries, each with the kind it is recognised as. Hidden files and the README
// are left out.
func listImports(root *os.Root, importers []string) ([]importEntry, error) {
	dir, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return nil, err
	}
	list := []importEntry{}
	for _, e := range entries {
		name := e.Name()
		if !validImportName(name) || strings.EqualFold(name, "README.txt") || isArchiveJunk(name) {
			continue
		}
		entry := detectImport(root, name)
		entry.Available = slices.Contains(importers, entry.Kind)
		list = append(list, entry)
	}
	slices.SortFunc(list, func(a, b importEntry) int { return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)) })
	return list, nil
}

// detectImport recognises one entry of the import folder. It never follows a link: a folder that is one, or that
// holds one where it is looked at, isn't recognised.
func detectImport(root *os.Root, name string) importEntry {
	entry := importEntry{Name: name, Kind: kindUnknown}
	info, err := root.Lstat(name)
	if err != nil {
		return entry
	}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		entry.Kind = kindLink
		return entry
	case info.Mode().IsRegular():
		entry.Kind = kindFile
		if archiveFile.MatchString(name) {
			entry.Kind = kindArchive
		}
		return entry
	case !info.IsDir():
		return entry
	}
	folder := name
	sub, err := root.OpenRoot(folder)
	if err != nil {
		return entry
	}
	defer sub.Close()
	// A folder unzipped into a folder of its own: the one inside is the circuit or car
	if only := onlyFolder(sub); only != "" {
		inner, err := sub.OpenRoot(only)
		if err == nil {
			defer inner.Close()
			sub, folder = inner, folder+"/"+only
		}
	}
	kind, file := detectFolder(sub)
	entry.Kind = kind
	if kind != kindUnknown {
		entry.Source = folder
		if file != "" {
			entry.Source = folder + "/" + file
		}
	}
	return entry
}

var archiveFile = regexp.MustCompile(`(?i)\.(zip|7z|rar|tar|gz|tgz|xz)$`)

// onlyFolder is the name of the one entry of a folder when that is a folder (not a link), else ""
func onlyFolder(root *os.Root) string {
	entries := readDir(root, ".")
	var names []fs.DirEntry
	for _, e := range entries {
		if !isArchiveJunk(e.Name()) && !strings.HasPrefix(e.Name(), ".") {
			names = append(names, e)
		}
	}
	if len(names) == 1 && names[0].IsDir() && names[0].Type()&fs.ModeSymlink == 0 && validImportName(names[0].Name()) {
		return names[0].Name()
	}
	return ""
}

// readDir lists a folder of root; nil when it can't be read
func readDir(root *os.Root, name string) []fs.DirEntry {
	d, err := root.Open(name)
	if err != nil {
		return nil
	}
	defer d.Close()
	info, err := d.Stat()
	if err != nil || !info.IsDir() {
		return nil
	}
	entries, _ := d.ReadDir(4096)
	return entries
}

// detectFolder recognises a folder by its own files (and its ui/ and data/ folders): the importer's kind, and for an
// importer that takes a file rather than the folder (F1 25's .erp, a Blender export's .glb) that file
func detectFolder(root *os.Root) (kind, file string) {
	var files, dirs []string
	for _, e := range readDir(root, ".") {
		switch {
		case e.Type()&fs.ModeSymlink != 0:
			// Never followed
		case e.IsDir():
			dirs = append(dirs, e.Name())
		case e.Type().IsRegular():
			files = append(files, e.Name())
		}
	}
	has := func(name string) bool {
		return slices.ContainsFunc(files, func(f string) bool { return strings.EqualFold(f, name) })
	}
	hasDir := func(name string) bool {
		return slices.ContainsFunc(dirs, func(d string) bool { return strings.EqualFold(d, name) })
	}
	withExt := func(ext string) []string {
		var out []string
		for _, f := range files {
			if strings.EqualFold(path.Ext(f), ext) {
				out = append(out, f)
			}
		}
		return out
	}
	kn5 := len(withExt(".kn5")) > 0

	// F1 25: the circuit's .erp archive, which the importer is given (the first by name, when a mod has more)
	if erps := withExt(".erp"); len(erps) > 0 {
		slices.Sort(erps)
		return kindF1Track, erps[0]
	}
	// Assetto Corsa car: its data (packed or not) and its model
	if kn5 && (has("data.acd") || (hasDir("data") && regularIn(root, "data", "car.ini"))) {
		return kindACCar, ""
	}
	// Assetto Corsa circuit: its model (or the list of its models) and its page in the game's menu
	modelsIni := slices.ContainsFunc(files, func(f string) bool {
		l := strings.ToLower(f)
		return strings.HasPrefix(l, "models") && strings.HasSuffix(l, ".ini")
	})
	if (kn5 || modelsIni) && hasDir("ui") && uiTrackJSON(root) {
		return kindACTrack, ""
	}
	// Speed Dreams: a track definition, or a car's settings with a Car section beside its model
	for _, x := range withExt(".xml") {
		head := readHead(root, x, 64*1024)
		if sdTrackdef.Match(head) {
			return kindSDTrack, ""
		}
		if sdCarSection.Match(head) && (len(withExt(".acc")) > 0 || len(withExt(".ac")) > 0) {
			return kindSDCar, ""
		}
	}
	// A circuit modelled in Blender: its .glb export beside its settings, named alike
	for _, g := range withExt(".glb") {
		if has(strings.TrimSuffix(g, path.Ext(g)) + ".json") {
			return kindBlenderTrack, g
		}
	}
	return kindUnknown, ""
}

var (
	// A Speed Dreams (TORCS) track file: <params name="…" type="trackdef" …>
	sdTrackdef = regexp.MustCompile(`(?is)<params\b[^>]*\btype\s*=\s*["']trackdef["']`)
	// A Speed Dreams car file: <section name="Car">
	sdCarSection = regexp.MustCompile(`(?is)<section\b[^>]*\bname\s*=\s*["']Car["']`)
)

// regularIn reports whether dir/name in root is a regular file (not a link)
func regularIn(root *os.Root, dir, name string) bool {
	for _, e := range readDir(root, dir) {
		if strings.EqualFold(e.Name(), name) && e.Type().IsRegular() {
			return true
		}
	}
	return false
}

// uiTrackJSON reports whether ui/ holds a ui_track.json, or one of its layout folders does
func uiTrackJSON(root *os.Root) bool {
	ui := ""
	for _, e := range readDir(root, ".") {
		if strings.EqualFold(e.Name(), "ui") && e.IsDir() && e.Type()&fs.ModeSymlink == 0 {
			ui = e.Name()
		}
	}
	if ui == "" {
		return false
	}
	if regularIn(root, ui, "ui_track.json") {
		return true
	}
	for _, e := range readDir(root, ui) {
		if e.IsDir() && e.Type()&fs.ModeSymlink == 0 && regularIn(root, ui+"/"+e.Name(), "ui_track.json") {
			return true
		}
	}
	return false
}

// readHead reads up to n bytes of a file of root (nothing for a link or another kind of file)
func readHead(root *os.Root, name string, n int64) []byte {
	info, err := root.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	f, err := root.Open(name)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, n))
	return b
}

// maxImportEntries bounds the walk through a folder before it is converted
const maxImportEntries = 200000

// errLinkInImport is a folder that holds a link: the converter reads files by their paths, so a link could hand it
// a file from anywhere on the computer
var errLinkInImport = errors.New("holds a link")

// checkImportTree walks a folder of the import folder before it is converted: everything in it must be a plain file
// or folder (no link, device or pipe), and there is a limit to how many
func checkImportTree(root *os.Root, name string) error {
	sub, err := root.OpenRoot(name)
	if err != nil {
		return err
	}
	defer sub.Close()
	count := 0
	return fs.WalkDir(sub.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		if count > maxImportEntries {
			return fmt.Errorf("holds more than %d files and folders", maxImportEntries)
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%w (%s): copy the files themselves", errLinkInImport, p)
		}
		if !d.IsDir() && !d.Type().IsRegular() {
			return fmt.Errorf("holds %s, which is not a file", p)
		}
		return nil
	})
}

// converterInfo is a release's converter (converter/converter.json, written by launcher/converter/build.mjs)
type converterInfo struct {
	Dir       string   `json:"-"`
	Format    int      `json:"format"`
	Version   string   `json:"version"`
	ModTool   string   `json:"modTool"`
	Importers []string `json:"importers"`
	Python    struct {
		Version      string   `json:"version"`
		Requirements []string `json:"requirements"`
	} `json:"python"`
	// Work are the folders the converters build in before packaging; their folders are removed after a conversion
	Work []string `json:"work"`
	// requirementsHash sums the requirements files, so the toolchain fetches the packages again when they change
	requirementsHash string
}

var (
	importerName  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)
	pythonVersion = regexp.MustCompile(`^3\.[0-9]{1,2}(\.[0-9]{1,3})?$`)
)

// loadConverter reads and checks a converter folder: its manifest, and that the files it names are in it
func loadConverter(dir string) (*converterInfo, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	b, err := root.ReadFile("converter.json")
	if err != nil {
		return nil, err
	}
	var c converterInfo
	dec := json.NewDecoder(bytes.NewReader(b))
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("converter.json: %w", err)
	}
	if c.Format != 1 {
		return nil, fmt.Errorf("converter.json: format %d, this launcher reads 1", c.Format)
	}
	if !isSafeModPath(c.ModTool) || !strings.HasSuffix(c.ModTool, ".mjs") {
		return nil, fmt.Errorf("converter.json: modTool %q", c.ModTool)
	}
	if info, err := root.Stat(c.ModTool); err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("converter.json names %s, which isn't there", c.ModTool)
	}
	for _, name := range c.Importers {
		if !importerName.MatchString(name) {
			return nil, fmt.Errorf("converter.json: importer %q", name)
		}
	}
	if !pythonVersion.MatchString(c.Python.Version) {
		return nil, fmt.Errorf("converter.json: python %q", c.Python.Version)
	}
	h := sha256.New()
	for _, req := range c.Python.Requirements {
		if !isSafeModPath(req) || !strings.HasSuffix(req, ".txt") {
			return nil, fmt.Errorf("converter.json: requirements %q", req)
		}
		data, err := root.ReadFile(req)
		if err != nil {
			return nil, fmt.Errorf("converter.json names %s: %w", req, err)
		}
		fmt.Fprintf(h, "%s\t%x\n", req, sha256.Sum256(data))
	}
	c.requirementsHash = hex.EncodeToString(h.Sum(nil))
	for _, w := range c.Work {
		if !isSafeModPath(w) {
			return nil, fmt.Errorf("converter.json: work %q", w)
		}
	}
	c.Dir, err = filepath.Abs(dir)
	return &c, err
}

// clearWork removes what the converters left in their working folders (a conversion that was stopped, or failed
// before it packaged): every folder in them, through os.Root so nothing outside is touched. Their files (the empty
// circuit list) stay.
func (c *converterInfo) clearWork() {
	root, err := os.OpenRoot(c.Dir)
	if err != nil {
		return
	}
	defer root.Close()
	for _, w := range c.Work {
		for _, e := range readDir(root, w) {
			if e.IsDir() && e.Type()&fs.ModeSymlink == 0 {
				root.RemoveAll(w + "/" + e.Name())
			}
		}
	}
}
