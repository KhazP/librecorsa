package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// importFixture lays out one folder of each kind (and some that aren't) in an import folder
func importFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"README.txt": "readme",
		// Assetto Corsa circuit: a model list and its menu page in a layout folder
		"ks_vallelunga/models_club.ini":       "[MODEL_0]",
		"ks_vallelunga/ks_vallelunga.kn5":     "kn5",
		"ks_vallelunga/ui/club/ui_track.json": "{}",
		"ks_vallelunga/data/surfaces.ini":     "",
		"plain_kn5_track/plain.kn5":           "kn5",
		"plain_kn5_track/ui/ui_track.json":    "{}",
		"ac_track_without_ui/models.ini":      "",
		// Assetto Corsa car: packed data, or a data folder
		"ks_mazda_mx5/data.acd":       "acd",
		"ks_mazda_mx5/mazda_mx5.kn5":  "kn5",
		"ks_mazda_mx5/ui/ui_car.json": "{}",
		"unpacked_car/data/car.ini":   "[HEADER]",
		"unpacked_car/body.kn5":       "kn5",
		"car_without_model/data.acd":  "acd",
		// Speed Dreams circuit and car
		"aalborg/aalborg.xml":          `<?xml version="1.0"?><!DOCTYPE params SYSTEM "../../../src/libs/tgf/params.dtd"><params name="Aalborg" type="trackdef" mode="mw">`,
		"aalborg/aalborg.ac":           "AC3Db",
		"sc-boxer-96/sc-boxer-96.xml":  `<params name="Boxer" type="template"><section name="Car"><attnum name="mass" val="1100"/></section></params>`,
		"sc-boxer-96/sc-boxer-96.acc":  "AC3Db",
		"sd_car_without_model/car.xml": `<params><section name="Car"></section></params>`,
		// F1 25 circuit
		"qiddiya/qiddiya.erp":  "ERP",
		"two_erps/b_track.erp": "ERP",
		"two_erps/a_track.erp": "ERP",
		// A circuit modelled in Blender: the export and its settings
		"my-circuit/my_circuit.glb":      "glTF",
		"my-circuit/my_circuit.json":     "{}",
		"glb_without_settings/thing.glb": "glTF",
		// Unzipped into a folder of its own name
		"nested_track/nested_track/models.ini":       "",
		"nested_track/nested_track/ui/ui_track.json": "{}",
		// Not a folder
		"mx5.zip":            "PK",
		"notes.txt":          "hi",
		"random/readme.md":   "",
		".hidden/models.ini": "",
	})
	return dir
}

func TestDetectImports(t *testing.T) {
	dir := importFixture(t)
	if err := os.Symlink(filepath.Join(dir, "ks_mazda_mx5"), filepath.Join(dir, "linked_car")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	list, err := listImports(root, []string{kindACTrack, kindBlenderTrack})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]importEntry{}
	for _, e := range list {
		got[e.Name] = e
	}
	want := map[string]struct{ kind, source string }{
		"ks_vallelunga":        {kindACTrack, "ks_vallelunga"},
		"plain_kn5_track":      {kindACTrack, "plain_kn5_track"},
		"ac_track_without_ui":  {kindUnknown, ""},
		"ks_mazda_mx5":         {kindACCar, "ks_mazda_mx5"},
		"unpacked_car":         {kindACCar, "unpacked_car"},
		"car_without_model":    {kindUnknown, ""},
		"aalborg":              {kindSDTrack, "aalborg"},
		"sc-boxer-96":          {kindSDCar, "sc-boxer-96"},
		"sd_car_without_model": {kindUnknown, ""},
		"qiddiya":              {kindF1Track, "qiddiya/qiddiya.erp"},
		"two_erps":             {kindF1Track, "two_erps/a_track.erp"},
		"my-circuit":           {kindBlenderTrack, "my-circuit/my_circuit.glb"},
		"glb_without_settings": {kindUnknown, ""},
		"nested_track":         {kindACTrack, "nested_track/nested_track"},
		"mx5.zip":              {kindArchive, ""},
		"notes.txt":            {kindFile, ""},
		"random":               {kindUnknown, ""},
	}
	if _, err := os.Lstat(filepath.Join(dir, "linked_car")); err == nil {
		want["linked_car"] = struct{ kind, source string }{kindLink, ""}
	}
	for name, w := range want {
		e, ok := got[name]
		if !ok {
			t.Errorf("%s: not listed", name)
			continue
		}
		if e.Kind != w.kind || e.Source != w.source {
			t.Errorf("%s: got %s %q, want %s %q", name, e.Kind, e.Source, w.kind, w.source)
		}
		if avail := e.Kind == kindACTrack || e.Kind == kindBlenderTrack; e.Available != avail {
			t.Errorf("%s: available %v, want %v (the converter has only ac-track and blender-track)", name, e.Available, avail)
		}
	}
	for _, hidden := range []string{"README.txt", ".hidden"} {
		if _, ok := got[hidden]; ok {
			t.Errorf("%s is listed", hidden)
		}
	}
	if len(got) != len(want) {
		t.Errorf("listed %d entries, want %d", len(got), len(want))
	}
}

func TestDetectDoesNotFollowLinksInside(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	writeFiles(t, outside, map[string]string{"real/ui_track.json": "{}", "car.ini": "[HEADER]"})
	writeFiles(t, dir, map[string]string{"track/models.ini": "", "car/body.kn5": "kn5"})
	// A ui folder and a data folder that are links leading out of the import folder
	if err := os.Symlink(filepath.Join(outside, "real"), filepath.Join(dir, "track", "ui")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	os.Mkdir(filepath.Join(dir, "car", "data"), 0o755)
	if err := os.Symlink(filepath.Join(outside, "car.ini"), filepath.Join(dir, "car", "data", "car.ini")); err != nil {
		t.Fatal(err)
	}
	root, _ := os.OpenRoot(dir)
	defer root.Close()
	for _, name := range []string{"track", "car"} {
		if e := detectImport(root, name); e.Kind != kindUnknown {
			t.Errorf("%s: recognised as %s through a link", name, e.Kind)
		}
	}
}

func TestValidImportName(t *testing.T) {
	good := []string{"ks_vallelunga", "My Circuit (v2)", "sc-boxer-96", "Ünïcode", "a"}
	bad := []string{"", ".", "..", ".hidden", "a/b", `a\b`, "C:", "a\x00b", "a\nb", "../import", strings.Repeat("x", 256), "\xff"}
	for _, n := range good {
		if !validImportName(n) {
			t.Errorf("%q refused", n)
		}
	}
	for _, n := range bad {
		if validImportName(n) {
			t.Errorf("%q allowed", n)
		}
	}
}

func TestCheckImportTree(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"clean/a/b.txt": "x", "linked/models.ini": "", "secret.txt": "s"})
	root, _ := os.OpenRoot(dir)
	defer root.Close()
	if err := checkImportTree(root, "clean"); err != nil {
		t.Errorf("clean: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "secret.txt"), filepath.Join(dir, "linked", "texture.dds")); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	if err := checkImportTree(root, "linked"); !errors.Is(err, errLinkInImport) {
		t.Errorf("linked: %v, want a link refused", err)
	}
}

func TestLoadConverter(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"converter.json":                  `{"format":1,"version":"0.2.0","modTool":"scripts/mods/mod-tool.mjs","importers":["blender-track","ac-track"],"python":{"version":"3.14","requirements":["scripts/tracks/requirements.txt"]}}`,
		"scripts/mods/mod-tool.mjs":       "",
		"scripts/tracks/requirements.txt": "numpy==2.4.3\n",
	})
	c, err := loadConverter(dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.ModTool != "scripts/mods/mod-tool.mjs" || len(c.Importers) != 2 || c.Python.Version != "3.14" || c.requirementsHash == "" {
		t.Errorf("read %+v", c)
	}
	before := c.requirementsHash
	writeFiles(t, dir, map[string]string{"scripts/tracks/requirements.txt": "numpy==2.4.4\n"})
	if c2, _ := loadConverter(dir); c2 == nil || c2.requirementsHash == before {
		t.Error("a changed requirements file keeps the same hash (the toolchain wouldn't fetch the new packages)")
	}

	bad := map[string]string{
		"traversal tool": `{"format":1,"modTool":"../evil.mjs","python":{"version":"3.14"}}`,
		"absolute tool":  `{"format":1,"modTool":"/bin/sh","python":{"version":"3.14"}}`,
		"not a module":   `{"format":1,"modTool":"scripts/mods/mod-tool.sh","python":{"version":"3.14"}}`,
		"missing tool":   `{"format":1,"modTool":"scripts/other.mjs","python":{"version":"3.14"}}`,
		"bad importer":   `{"format":1,"modTool":"scripts/mods/mod-tool.mjs","importers":["../x"],"python":{"version":"3.14"}}`,
		"bad python":     `{"format":1,"modTool":"scripts/mods/mod-tool.mjs","python":{"version":"3.14; rm -rf"}}`,
		"traversal reqs": `{"format":1,"modTool":"scripts/mods/mod-tool.mjs","python":{"version":"3.14","requirements":["../../etc/passwd.txt"]}}`,
		"another format": `{"format":2,"modTool":"scripts/mods/mod-tool.mjs","python":{"version":"3.14"}}`,
	}
	for name, manifest := range bad {
		writeFiles(t, dir, map[string]string{"converter.json": manifest})
		if _, err := loadConverter(dir); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestMakeImportDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "import")
	if err := makeImportDir(dir); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "README.txt"))
	if err != nil || !strings.Contains(string(b), "Assetto Corsa") {
		t.Fatalf("README: %v %q", err, b)
	}
	// A README the player changed is kept
	os.WriteFile(filepath.Join(dir, "README.txt"), []byte("mine"), 0o644)
	makeImportDir(dir)
	if b, _ := os.ReadFile(filepath.Join(dir, "README.txt")); string(b) != "mine" {
		t.Error("the README was written over")
	}
}

func TestClearWork(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"converter.json":                        `{"format":1,"modTool":"scripts/mods/mod-tool.mjs","python":{"version":"3.14"},"work":["public/tracks"]}`,
		"scripts/mods/mod-tool.mjs":             "",
		"public/tracks/index.json":              "[]",
		"public/tracks/modimport_a_b/track.glb": "x",
		"public/tracks/modimport_c_d/data.json": "x",
	})
	writeFiles(t, outside, map[string]string{"keep/me.txt": "keep"})
	if err := os.Symlink(filepath.Join(outside, "keep"), filepath.Join(dir, "public", "tracks", "link")); err != nil {
		t.Logf("no symlinks here: %v", err)
	}
	c, err := loadConverter(dir)
	if err != nil {
		t.Fatal(err)
	}
	c.clearWork()
	entries, _ := os.ReadDir(filepath.Join(dir, "public", "tracks"))
	for _, e := range entries {
		if e.IsDir() {
			t.Errorf("%s is left", e.Name())
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "tracks", "index.json")); err != nil {
		t.Error("the circuit list went too")
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "keep", "me.txt")); string(b) != "keep" {
		t.Error("a folder a link led to was emptied")
	}
	writeFiles(t, dir, map[string]string{"converter.json": `{"format":1,"modTool":"scripts/mods/mod-tool.mjs","python":{"version":"3.14"},"work":["../.."]}`})
	if _, err := loadConverter(dir); err == nil {
		t.Error("a working folder outside the converter was taken")
	}
}
