package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// The launcher's API for the app around the game, beside the import folder's (api.go), with the same checks:
//
//	POST /__launcher/open-folder      { "folder": "mods" | "import" }: open it in Finder, Explorer or the file manager
//	POST /__launcher/alive            { "page": "<id>", "closing": false }: a page of the game is open (lifetime.go)
//
// The alive call alone doesn't need the session: any window of the game keeps the launcher running, even one opened
// by typing the address (it still needs the header, the Origin and a same-origin fetch, so no other site can).

const (
	openFolderPath = identityPath + "/open-folder"
	alivePath      = identityPath + "/alive"
)

// appMethods are the methods each of these paths takes
var appMethods = map[string]string{
	openFolderPath: "POST",
	alivePath:      "POST",
}

// isAppPath reports whether p is one of these paths
func isAppPath(p string) bool {
	_, ok := appMethods[p]
	return ok
}

// appAPI answers these paths for one launcher
type appAPI struct {
	// folders are the ones the game may have opened, by name
	folders map[string]string
	life    *lifetime
	// open opens a folder in the system's file manager (a variable so the tests can see what is opened)
	open func(dir string) error
}

// enableApp turns these paths on (they live beside the import folder's API, so a server without it has none)
func (s *server) enableApp(a *appAPI) {
	if s.imports != nil {
		s.imports.app = a
	}
}

func (a *appAPI) serve(w http.ResponseWriter, r *http.Request, p string) {
	switch p {
	case openFolderPath:
		var body struct {
			Folder string `json:"folder"`
		}
		if !readJSONBody(w, r, &body) {
			return
		}
		dir, ok := a.folders[body.Folder]
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "bad-folder", "no such folder")
			return
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "open-failed", err.Error())
			return
		}
		if err := a.open(dir); err != nil {
			writeAPIError(w, http.StatusInternalServerError, "open-failed", err.Error())
			return
		}
		writeAPI(w, http.StatusOK, map[string]any{"opened": dir})
	case alivePath:
		var body struct {
			Page    string `json:"page"`
			Closing bool   `json:"closing"`
		}
		if !readJSONBody(w, r, &body) {
			return
		}
		if !pageIDPattern.MatchString(body.Page) {
			writeAPIError(w, http.StatusBadRequest, "body", "page is not a page's id")
			return
		}
		if a.life != nil {
			a.life.beat(body.Page, body.Closing)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// openFolder opens dir in the system's file manager. The folder is an argument of its own, never through a shell.
func openFolder(dir string) error {
	name, args, err := openFolderCommand(runtime.GOOS, dir, os.Getenv, exec.LookPath)
	if err != nil {
		return err
	}
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	// Explorer answers 1 even when it opened the folder: only a failure to start counts
	go cmd.Wait()
	return nil
}

// openFolderCommand is the program that opens a folder on goos
func openFolderCommand(goos, dir string, getenv func(string) string, lookPath func(string) (string, error)) (string, []string, error) {
	switch goos {
	case "darwin":
		return "/usr/bin/open", []string{dir}, nil
	case "windows":
		root := getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		return filepath.Join(root, "explorer.exe"), []string{dir}, nil
	default:
		p, err := lookPath("xdg-open")
		if err != nil {
			return "", nil, fmt.Errorf("no xdg-open to open %s with", dir)
		}
		return p, []string{dir}, nil
	}
}
