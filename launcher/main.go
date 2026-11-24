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
	os.Args = dropFinderArgs(os.Args)
	code := run()
	closeLog()
	os.Exit(code)
}

func run() int {
	gameFlag := flag.String("game", "", "folder of the game's static export (default: game/ beside the launcher, else ../out)")
	modsFlag := flag.String("mods", "", "folder of mod packages (default: Documents/LibreCorsa/mods; in a clone ../public/mods)")
	importFlag := flag.String("import", "", "folder of circuits and cars to convert (default: Documents/LibreCorsa/import; in a clone import/)")
	converterFlag := flag.String("converter", "", "the converter bundle (default: converter/ beside the launcher, else dist/converter)")
	toolchainFlag := flag.String("toolchain", "", "where the converter's downloaded tools go (default: beside the browser profile)")
	port := flag.Int("port", defaultPort, "port on 127.0.0.1 (keep it fixed: the browser keeps saves per port)")
	noBrowser := flag.Bool("no-browser", false, "only serve; don't open a browser")
	noUpdate := flag.Bool("no-update", false, "don't check for updates, nor install one")
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

	// A window app has no terminal: what it prints goes to the log too (applog.go)
	attachParentConsole()
	startLog(logPath())
	// From the launcher that installed an update, if it started this one (update_apply.go)
	handedOver := takeHandoff()

	exeDir := programDir()
	// Started as an app (not with --no-browser from a terminal, nor by go run, nor by an update trying itself), a
	// failure to start is shown in a message box too
	asApp := !*noBrowser && handedOver.From == "" && exeDir != "" && !isGoRunDir(exeDir)
	gameDir, inClone, err := resolveGameDir(*gameFlag, exeDir)
	if err != nil {
		return failStart(asApp, err.Error())
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
	// The player's folders: in Documents/LibreCorsa (folders.go), or in a clone where they were
	modsDir, err := playerFolder(*modsFlag, "mods", filepath.Join("..", "public", "mods"), clone)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	importDir, err := playerFolder(*importFlag, "import", "import", clone)
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
		return failStart(asApp, fmt.Sprintf("Port %d on 127.0.0.1 is in use by another program, so LibreCorsa can't start.\n"+
			"Close that program, or start with --port <n> (your saves stay with the port they were made on).\n(%v)", *port, err))
	}
	// An update downloaded earlier goes in place now, before anything is opened, and the new launcher takes over
	exe, _ := os.Executable()
	updates := newUpdater(updaterConfig{
		version: version, goos: runtime.GOOS, goarch: runtime.GOARCH, exe: exe, clone: clone, off: *noUpdate,
		keys: updatePublicKeys, dir: filepath.Join(configDir(), "update"), args: os.Args[1:],
	})
	if st := updates.pending(); st != nil && handedOver.From == "" {
		ln.Close()
		if updates.install(st, handoff{}, origin) == nil {
			return 0
		}
		if ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port)); err != nil {
			return failStart(asApp, fmt.Sprintf("LibreCorsa couldn't take port %d back after a failed update: %v", *port, err))
		}
	}
	// After the port: a second start hands over to the first without needing to write anywhere
	if err := makeModsDir(modsDir); err != nil {
		ln.Close()
		return failStart(asApp, fmt.Sprintf("Can't create the mods folder %s: %v", modsDir, err))
	}

	s, err := newServer(gameDir, modsDir, *port)
	if err != nil {
		ln.Close()
		return failStart(asApp, err.Error())
	}
	defer s.Close()
	if handedOver.Secret != "" {
		s.session.adopt(handedOver.Secret)
	}
	// The import folder, and the converter if the release has one: the game runs without either
	convNote := "none (converting circuits and cars needs a release's converter/ folder)"
	conv, convErr := loadConverter(writableConverter(converterDir))
	if convErr == nil {
		convNote = fmt.Sprintf("%s (%s)", conv.Dir, strings.Join(conv.Importers, ", "))
	} else if !errors.Is(convErr, os.ErrNotExist) {
		convNote = fmt.Sprintf("%s can't be used: %v", converterDir, convErr)
	}
	if err := makeImportDir(importDir); err != nil {
		fmt.Fprintf(os.Stderr, "can't create the import folder %s: %v\n", importDir, err)
	}
	// The API answers even without the folder (the panel lists it empty): the app's calls (appapi.go) go through it
	s.enableImports(importDir, newJobs(importDir, modsDir, conv, newToolchain(toolchainDir, runtime.GOOS, runtime.GOARCH)))
	srv := &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()

	// Ctrl+C stops the server cleanly from here on, while a browser starts too
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The app around the game (appapi.go, lifetime.go): it quits with the game's window, opens the player's folders, and
	// updates itself
	converting := func() bool { return s.imports != nil && s.imports.jobs.running() }
	var endsBrowser func(int) error
	if runtime.GOOS == "darwin" {
		endsBrowser = endBrowser
	}
	life := newLifetime(*noBrowser, func() bool { return converting() || updates.installing.Load() }, endsBrowser)
	s.enableApp(&appAPI{
		folders: map[string]string{"mods": modsDir, "import": importDir},
		life:    life, updates: updates, busy: converting, open: openFolder,
	})
	updates.cleanupAfterStart(ctx, handedOver.From != "")
	go updates.runChecks(ctx)
	if runtime.GOOS == "linux" && !clone {
		installDesktopEntry(exeDir)
	}

	// The address that opens the game with this run's session (session.go), good once: the window it opens may convert
	openURL := s.session.openURL(origin)
	shown := playURL
	if *noBrowser {
		shown = openURL + "\n        (once; then " + playURL + ")"
	}
	fmt.Printf("LibreCorsa %s\n  game: %s\n  mods: %s\n  import: %s\n  converter: %s\n  open: %s\n", version, gameDir, modsDir, importDir, convNote, shown)
	switch {
	case handedOver.KeepWindow:
		// The game's window stayed open through the update: this launcher lives with its browser
		life.watch(watchPID(handedOver.BrowserPID))
	case !*noBrowser:
		life.watch(openGame(openURL))
	}
	go life.run(ctx)
	if *noBrowser {
		fmt.Println("Press Ctrl+C to stop.")
	} else {
		fmt.Println("Close the game's window to quit.")
	}
	restart := false
	select {
	case err := <-served:
		fmt.Fprintln(os.Stderr, err)
		return 1
	case <-ctx.Done():
	case <-life.Done():
		fmt.Printf("Quitting: %s\n", life.Reason())
	case <-updates.restartRequested():
		restart = true
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Downloads still running after that are cut, before the folders close under them
	if srv.Shutdown(shutdown) != nil {
		srv.Close()
	}
	if restart {
		// "Restart to update": the new launcher takes the port, the session and the game's window
		stop()
		s.Close()
		return updates.restartForUpdate(handoff{Secret: s.session.current(), BrowserPID: life.browserPID(), KeepWindow: true}, origin)
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
