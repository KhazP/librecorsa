package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"slices"
	"strings"
)

// The launcher's API for the Mods panel: the import folder's list, the first-use download of the converter's tools,
// and a conversion's start, status and cancel. Only the game's own page, in the window the launcher opened, may call
// it:
//
//   - the Host check every request passes (DNS rebinding);
//   - every call carries this run's session cookie (session.go), which only the window the launcher opened holds:
//     another user of the computer can reach 127.0.0.1 too;
//   - every call carries the header apiHeader, which a page of another site can only send after a CORS preflight that
//     is never answered, and a form or a link can't send at all;
//   - a call that changes something (POST) must also come from the launcher's own origin (`Origin`), and a fetch
//     the browser marks as from another site (`Sec-Fetch-Site`) is refused.

// apiHeader is the header every call to the API carries, with the value "1"
const apiHeader = "X-LibreCorsa-Launcher"

const (
	importsPath   = identityPath + "/imports"
	convertPath   = identityPath + "/convert"
	cancelPath    = identityPath + "/convert/cancel"
	toolchainPath = identityPath + "/toolchain"
)

// importsAPI answers the API's paths for one launcher
type importsAPI struct {
	importDir string
	modsDir   string
	jobs      *jobs
}

// enableImports turns on the import folder and its API (a server without it answers those paths with 404)
func (s *server) enableImports(importDir string, js *jobs) {
	s.imports = &importsAPI{importDir: importDir, modsDir: js.modsDir, jobs: js}
}

// isAPIPath reports whether p is one of the API's paths
func isAPIPath(p string) bool {
	switch p {
	case importsPath, convertPath, cancelPath, toolchainPath:
		return true
	}
	return false
}

// checkAPICall returns why a call to the API is refused, and the code the panel tells it by ("" when it isn't). The
// Host is already checked.
func (s *server) checkAPICall(r *http.Request) (code, why string) {
	if r.Header.Get(apiHeader) != "1" {
		return "forbidden", "missing the " + apiHeader + " header"
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		return "forbidden", "not from the game's own page"
	}
	if r.Method == http.MethodPost {
		origin := r.Header.Get("Origin")
		if origin == "" || origin != "http://"+strings.ToLower(r.Host) {
			return "forbidden", "not from the game's own page (Origin)"
		}
	}
	if !s.session.valid(r) {
		return "session", "not from the window the launcher opened (no session)"
	}
	return "", ""
}

func (a *importsAPI) serve(s *server, w http.ResponseWriter, r *http.Request, p string) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	allow := map[string]string{importsPath: "GET", convertPath: "GET, POST", cancelPath: "POST", toolchainPath: "POST"}[p]
	if !slices.Contains(strings.Split(allow, ", "), r.Method) {
		h.Set("Allow", allow)
		writeAPIError(w, http.StatusMethodNotAllowed, "method", "method not allowed")
		return
	}
	if code, why := s.checkAPICall(r); code != "" {
		writeAPIError(w, http.StatusForbidden, code, why)
		return
	}
	switch {
	case p == importsPath:
		a.serveImports(w)
	case p == convertPath && r.Method == http.MethodGet:
		writeAPI(w, http.StatusOK, map[string]any{"job": a.jobs.status(), "toolchain": a.jobs.tc.info(a.jobs.conv)})
	case p == convertPath:
		var body struct {
			Folder string `json:"folder"`
		}
		if !readJSONBody(w, r, &body) {
			return
		}
		st, err := a.jobs.startConvert(body.Folder)
		a.answerStart(w, st, err)
	case p == toolchainPath:
		if !readJSONBody(w, r, nil) {
			return
		}
		st, err := a.jobs.startToolchain()
		a.answerStart(w, st, err)
	case p == cancelPath:
		if !readJSONBody(w, r, nil) {
			return
		}
		if !a.jobs.cancelRunning() {
			writeAPIError(w, http.StatusConflict, "idle", "nothing is running")
			return
		}
		writeAPI(w, http.StatusOK, map[string]any{"job": a.jobs.status()})
	}
}

// serveImports lists the import folder, with the converter's and the toolchain's state and the running or last job
func (a *importsAPI) serveImports(w http.ResponseWriter) {
	var importers []string
	conv := map[string]any{"available": false}
	if c := a.jobs.conv; c != nil {
		importers = c.Importers
		conv = map[string]any{"available": true, "version": c.Version, "importers": c.Importers}
	}
	folders := []importEntry{}
	if root, err := os.OpenRoot(a.importDir); err == nil {
		folders, err = listImports(root, importers)
		root.Close()
		if err != nil {
			folders = []importEntry{}
		}
	}
	writeAPI(w, http.StatusOK, map[string]any{
		"importDir": a.importDir,
		"modsDir":   a.modsDir,
		"converter": conv,
		"toolchain": a.jobs.tc.info(a.jobs.conv),
		"folders":   folders,
		"job":       a.jobs.status(),
	})
}

// answerStart answers a request that started a job (202 with its status) or couldn't
func (a *importsAPI) answerStart(w http.ResponseWriter, st *jobStatus, err error) {
	switch {
	case err == nil:
		writeAPI(w, http.StatusAccepted, map[string]any{"job": st})
	case errors.Is(err, errBusy):
		writeAPIError(w, http.StatusConflict, "busy", err.Error())
	case errors.Is(err, errNotReady):
		writeAPIError(w, http.StatusConflict, "not-ready", err.Error())
	case errors.Is(err, errBadImportArg):
		writeAPIError(w, http.StatusBadRequest, "bad-folder", err.Error())
	case errors.Is(err, errNoImporter):
		writeAPIError(w, http.StatusUnprocessableEntity, "no-importer", err.Error())
	case errors.Is(err, errLinkInImport):
		writeAPIError(w, http.StatusUnprocessableEntity, "link", err.Error())
	case errors.Is(err, errNoConverter):
		writeAPIError(w, http.StatusNotFound, "no-converter", err.Error())
	case errors.Is(err, errUnsupported):
		writeAPIError(w, http.StatusNotImplemented, "unsupported", err.Error())
	default:
		writeAPIError(w, http.StatusUnprocessableEntity, "refused", err.Error())
	}
}

// readJSONBody reads a POST's body: JSON (as a form can't send), small, into v (nil: an empty object, or nothing)
func readJSONBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.ContentLength != 0 || r.Header.Get("Content-Type") != "" {
		mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mt != "application/json" {
			writeAPIError(w, http.StatusUnsupportedMediaType, "content-type", "the body must be application/json")
			return false
		}
	}
	body := http.MaxBytesReader(w, r.Body, 4096)
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	var into any = v
	if v == nil {
		into = &struct{}{}
	}
	if err := dec.Decode(into); err != nil {
		if v == nil && errors.Is(err, io.EOF) {
			return true
		}
		writeAPIError(w, http.StatusBadRequest, "body", "the body isn't the JSON expected")
		return false
	}
	return true
}

func writeAPI(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeAPI(w, status, map[string]string{"code": code, "error": message})
}
