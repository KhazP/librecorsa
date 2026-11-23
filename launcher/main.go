// Command librecorsa serves LibreCorsa's static export and the player's mod packages on 127.0.0.1 and opens the game
// in a Chromium browser as an app window, so the game runs with no network. See README.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// version is set at build time (launcher/build.mjs: -X main.version=<package.json version>)
var version = "dev"

// defaultPort is fixed: the browser keeps a site's saves (laps, settings, imported mods) per origin, and the origin
// includes the port, so a port that changed between runs would start the player over.
const defaultPort = 47826

func main() {
	os.Exit(run())
}

func run() int {
	gameFlag := flag.String("game", "", "folder of the game's static export (default: game/ beside the launcher, else ../out)")
	modsFlag := flag.String("mods", "", "folder of mod packages (default: mods/ beside the launcher, else ../public/mods)")
	importFlag := flag.String("import", "", "folder of circuits and cars to convert (default: import/ beside the launcher)")
	converterFlag := flag.String("converter", "", "the converter bundle (default: converter/ beside the launcher, else dist/converter)")
	toolchainFlag := flag.String("toolchain", "", "where the converter's downloaded tools go (default: beside the browser profile)")
	port := flag.Int("port", defaultPort, "port on 127.0.0.1 (keep it fixed: the browser keeps saves per port)")
	noBrowser := flag.Bool("no-browser", false, "only serve; don't open a browser")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("LibreCorsa launcher", version)
		return 0
	}
	if *port < 1 || *port > 65535 {
		fmt.Fprintf(os.Stderr, "--port %d is not a port\n", *port)
		return 2
	}

	exeDir := executableDir()
	gameDir, inClone, err := resolveGameDir(*gameFlag, exeDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Beside the launcher; in a clone (serving ../out, or `go run .`, whose binary sits in a temporary folder) the mods
	// in public/mods, where `npm run mod -- index` lists them for the dev server too, and the import folder and the
	// converter (launcher/converter/build.mjs) in launcher/
	clone := inClone || exeDir == "" || isGoRunDir(exeDir)
	beside := func(flagValue, release, inClone string) (string, error) {
		switch {
		case flagValue != "":
			return filepath.Abs(flagValue)
		case clone:
			return filepath.Abs(inClone)
		default:
			return filepath.Join(exeDir, release), nil
		}
	}
	modsDir, err := beside(*modsFlag, "mods", filepath.Join("..", "public", "mods"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	importDir, err := beside(*importFlag, "import", "import")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	converterDir, err := beside(*converterFlag, "converter", filepath.Join("dist", "converter"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	toolchainDir := *toolchainFlag
	if toolchainDir == "" {
		toolchainDir = defaultToolchainDir()
	} else if toolchainDir, err = filepath.Abs(toolchainDir); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	origin := fmt.Sprintf("http://127.0.0.1:%d", *port)
	playURL := origin + "/play"

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		if isLauncher(origin) {
			fmt.Printf("LibreCorsa is already running at %s\n", playURL)
			if !*noBrowser {
				openGame(playURL)
			}
			return 0
		}
		fmt.Fprintf(os.Stderr, "Port %d on 127.0.0.1 is in use by another program, so LibreCorsa can't start.\n", *port)
		fmt.Fprintf(os.Stderr, "Close that program, or start with --port <n> (your saves stay with the port they were made on).\n")
		fmt.Fprintf(os.Stderr, "(%v)\n", err)
		return 1
	}
	// After the port: a second start hands over to the first without needing to write anywhere
	if err := os.MkdirAll(modsDir, 0o755); err != nil {
		ln.Close()
		fmt.Fprintf(os.Stderr, "can't create the mods folder %s: %v\n", modsDir, err)
		return 1
	}

	s, err := newServer(gameDir, modsDir, *port)
	if err != nil {
		ln.Close()
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer s.Close()
	// The import folder, and the converter if the release has one: the game runs without either
	convNote := "none (converting circuits and cars needs a release's converter/ folder)"
	conv, convErr := loadConverter(converterDir)
	if convErr == nil {
		convNote = fmt.Sprintf("%s (%s)", conv.Dir, strings.Join(conv.Importers, ", "))
	} else if !errors.Is(convErr, os.ErrNotExist) {
		convNote = fmt.Sprintf("%s can't be used: %v", converterDir, convErr)
	}
	if err := makeImportDir(importDir); err != nil {
		fmt.Fprintf(os.Stderr, "can't create the import folder %s: %v\n", importDir, err)
	} else {
		s.enableImports(importDir, newJobs(importDir, modsDir, conv, newToolchain(toolchainDir, runtime.GOOS, runtime.GOARCH)))
	}
	srv := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	// Ctrl+C stops the server cleanly from here on, while a browser starts too
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Printf("LibreCorsa %s\n  game: %s\n  mods: %s\n  import: %s\n  converter: %s\n  open: %s\n", version, gameDir, modsDir, importDir, convNote, playURL)
	if !*noBrowser {
		openGame(playURL)
	}
	fmt.Println("Press Ctrl+C to stop.")
	select {
	case err := <-served:
		fmt.Fprintln(os.Stderr, err)
		return 1
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Downloads still running after that are cut, before the folders close under them
	if srv.Shutdown(shutdown) != nil {
		srv.Close()
	}
	return 0
}

// executableDir is the folder holding the launcher binary ("" if unknown)
func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

// resolveGameDir picks the export to serve: --game, else game/ beside the launcher (a release), else ../out from the
// working directory (running from launcher/ in a clone after `npm run build`: `inClone`)
func resolveGameDir(flagValue, exeDir string) (dir string, inClone bool, err error) {
	if flagValue != "" {
		if !isExport(flagValue) {
			return "", false, fmt.Errorf("--game %s: no index.html there (expected the game's static export, `out/` after npm run build)", flagValue)
		}
		dir, err = filepath.Abs(flagValue)
		return dir, false, err
	}
	if exeDir != "" && isExport(filepath.Join(exeDir, "game")) {
		return filepath.Join(exeDir, "game"), false, nil
	}
	if clone := filepath.Join("..", "out"); isExport(clone) {
		dir, err = filepath.Abs(clone)
		return dir, true, err
	}
	return "", false, errors.New("can't find the game: put its static export in game/ beside the launcher, or pass --game <dir>")
}

// isGoRunDir reports whether dir is where `go run` builds its binary (a temporary folder that goes when it stops)
func isGoRunDir(dir string) bool {
	return strings.Contains(filepath.ToSlash(dir), "/go-build")
}

func isExport(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, "index.html"))
	return err == nil && info.Mode().IsRegular()
}

// isLauncher reports whether a LibreCorsa launcher answers at origin. Whatever else holds the port is asked no more
// than that: its redirects aren't followed, and only a few KB of its answer are read
func isLauncher(origin string) bool {
	client := &http.Client{
		Timeout:       2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	res, err := client.Get(origin + identityPath)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	var id struct {
		App string `json:"app"`
	}
	return json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&id) == nil && id.App == identityApp
}
