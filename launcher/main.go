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
	modsDir := *modsFlag
	if modsDir == "" {
		// Beside the launcher; in a clone (serving ../out, or `go run .`, whose binary sits in a temporary folder) in
		// public/mods, where `npm run mod -- index` lists them for the dev server too
		if inClone || exeDir == "" || isGoRunDir(exeDir) {
			if modsDir, err = filepath.Abs(filepath.Join("..", "public", "mods")); err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 1
			}
		} else {
			modsDir = filepath.Join(exeDir, "mods")
		}
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
	srv := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	// Ctrl+C stops the server cleanly from here on, while a browser starts too
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	fmt.Printf("LibreCorsa %s\n  game: %s\n  mods: %s\n  open: %s\n", version, gameDir, modsDir, playURL)
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
