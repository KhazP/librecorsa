package main

import (
	"fmt"
	"net/http"
	"path"
	"strings"
)

// cataloguePrefix is where a catalogue of packages to download is served (src/lib/mods/mod-catalogue.ts
// CATALOGUE_DIR): the game reads `catalogue.json` there when its Mods panel opens, and downloads the zips it lists.
// They come from the `_catalogue` folder in the mods folder, which `npm run mod -- catalogue` fills.
const cataloguePrefix = modsPrefix + "_catalogue/"

// catalogueFolder is that folder's name in the mods folder: a name no package id can take
const catalogueFolder = "_catalogue"

// catalogueTypes is what the catalogue folder serves, by extension: the catalogue itself (catalogue.json only), the
// zips it lists, and their preview pictures. Nothing a browser would run.
var catalogueTypes = map[string]string{
	".json": "application/json",
	".zip":  "application/zip",
	".webp": "image/webp",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
}

// serveCatalogue answers `/mods/_catalogue/<name>` from the catalogue folder: a file directly in it (no subfolder), of
// a type above, which nothing in the request can leave
func (m *modsFolder) serveCatalogue(w http.ResponseWriter, r *http.Request, name string) {
	ext := strings.ToLower(path.Ext(name))
	ct, allowed := catalogueTypes[ext]
	if !allowed || strings.Contains(name, "/") || !isSafeModPath(name) || (ext == ".json" && name != "catalogue.json") {
		http.NotFound(w, r)
		return
	}
	dir, err := m.root.OpenRoot(catalogueFolder)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer dir.Close()
	f, err := dir.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	// Rewritten in place when a package is added, so the browser asks again each time
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Content-Type", ct)
	h.Set("ETag", fmt.Sprintf(`"%x-%x"`, info.Size(), info.ModTime().UnixNano()))
	http.ServeContent(w, r, name, info.ModTime(), f)
}
