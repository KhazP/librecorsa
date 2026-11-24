"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, screen, session, shell } = require("electron");
const { APP_URL, NEW_APP_URL, decideNavigation, isAllowedAppUrl, isBrowserUrl } = require("./nav-policy");
const { isAllowedHidDevice, isAllowedOrigin, pickPreferredHidDevice } = require("./hid-policy");

const ALLOWED_PERMISSIONS = new Set([
  "hid",
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
]);

// This is the last version of this app: the new desktop app (librecorsa.org/download) replaces it, and its releases
// take the repository's latest release, where electron-updater would find no update. So it no longer checks, and
// tells players about the new app instead.

/** "Later" keeps the notice about the new app quiet for this long */
const NOTICE_LATER_MS = 3 * 24 * 60 * 60 * 1000;

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Shown once a run at most */
let newAppNoticeShown = false;

// Prefer discrete GPU on multi-GPU laptops before Chromium initializes GPU process.
app.commandLine.appendSwitch("force_high_performance_gpu");

if (process.platform === "win32") {
  app.setAppUserModelId("org.librecorsa.desktop");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function toggleFullscreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Fullscreen",
          accelerator: "F11",
          registerAccelerator: false,
          click: () => toggleFullscreen(),
        },
        ...(isMac ? [{ role: "togglefullscreen" }] : []),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
      ],
    },
    ...(isMac
      ? [
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "close" }],
          },
        ]
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Configure session permissions and silent WebHID grants for DualSense and racing wheels.
 * @param {Electron.Session} ses
 */
function configureSessionSecurity(ses) {
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = (details && details.securityOrigin) || requestingOrigin;
    return (
      !(details && details.embeddingOrigin) &&
      isAllowedOrigin(origin) &&
      ALLOWED_PERMISSIONS.has(permission)
    );
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = (details && details.requestingUrl) || (webContents && webContents.getURL()) || "";
    const isMainFrame = !details || details.isMainFrame !== false;
    callback(isMainFrame && isAllowedOrigin(origin) && ALLOWED_PERMISSIONS.has(permission));
  });

  ses.setDevicePermissionHandler((details) => {
    return (
      details.deviceType === "hid" &&
      isAllowedOrigin(details.origin) &&
      isAllowedHidDevice(details.device)
    );
  });

  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    const frameUrl = details.frame ? details.frame.url : "";
    const chosen = pickPreferredHidDevice(details.deviceList, frameUrl);
    callback(chosen ? chosen.deviceId : undefined);
  });
}

/**
 * Lock down navigation and popups for any WebContents created by this app.
 * @param {Electron.WebContents} contents
 */
function attachNavigationGuards(contents) {
  const guardNavigation = (event, url) => {
    const { allowInApp, openExternal } = decideNavigation(url);
    if (!allowInApp) {
      event.preventDefault();
      if (openExternal) {
        void shell.openExternal(url);
      }
    }
  };

  contents.on("will-navigate", guardNavigation);
  contents.on("will-redirect", guardNavigation);

  contents.setWindowOpenHandler(({ url }) => {
    const { allowInApp, openExternal } = decideNavigation(url);
    if (openExternal) {
      void shell.openExternal(url);
    } else if (allowInApp && mainWindow && !mainWindow.isDestroyed()) {
      void mainWindow.loadURL(url);
    }
    return { action: "deny" };
  });
}

/** Where "Later" is kept: { "laterUntil": <ms since 1970> } */
function noticeFile() {
  return path.join(app.getPath("userData"), "new-app-notice.json");
}

/** @returns {boolean} */
function noticeIsLater() {
  try {
    const { laterUntil } = JSON.parse(fs.readFileSync(noticeFile(), "utf8"));
    return typeof laterUntil === "number" && Date.now() < laterUntil;
  } catch {
    return false;
  }
}

function noticeLater() {
  try {
    fs.mkdirSync(path.dirname(noticeFile()), { recursive: true });
    fs.writeFileSync(noticeFile(), `${JSON.stringify({ laterUntil: Date.now() + NOTICE_LATER_MS })}\n`);
  } catch (err) {
    console.error("[notice]", err && err.message ? err.message : err);
  }
}

/**
 * Tell the player about the new desktop app, over the game's window.
 * @param {BrowserWindow} win
 */
async function showNewAppNotice(win) {
  if (newAppNoticeShown || win.isDestroyed() || noticeIsLater()) return;
  newAppNoticeShown = true;
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    title: "LibreCorsa",
    message: "LibreCorsa has a new desktop app",
    detail:
      "This app gets no more updates. The new one plays offline too, and takes mods.\n\n" +
      "Your laps and settings come with you when you sign in to your account in both apps. The new app signs in " +
      "with a code: in this one, open Settings, then Profile and data, then Account, and choose Show a code for " +
      "another device.",
    buttons: ["Get the new app", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    if (isBrowserUrl(NEW_APP_URL)) void shell.openExternal(NEW_APP_URL);
  } else {
    noticeLater();
  }
}

function createMainWindow() {
  const { width: workW, height: workH } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1920, Math.max(1024, Math.round(workW * 0.9)));
  const height = Math.min(1080, Math.max(640, Math.round(workH * 0.9)));

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 540,
    title: "LibreCorsa",
    backgroundColor: "#08090D",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.key === "F11" &&
      !input.isAutoRepeat &&
      !input.alt &&
      !input.control &&
      !input.meta &&
      !input.shift
    ) {
      event.preventDefault();
      toggleFullscreen();
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    // Ignore benign aborted navigations (-3) and non-main-frame subresource errors.
    if (!isMainFrame || errorCode === -3) return;
    if (validatedURL.startsWith("file://")) return;
    void win.loadFile(path.join(__dirname, "offline.html"));
  });

  // Once the game's page has loaded (not the offline page), and the window is up
  win.webContents.on("did-finish-load", () => {
    if (!isAllowedAppUrl(win.webContents.getURL())) return;
    const show = () => {
      showNewAppNotice(win).catch((err) => {
        console.error("[notice]", err && err.message ? err.message : err);
      });
    };
    if (win.isVisible()) show();
    else win.once("show", show);
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  mainWindow = win;
  void win.loadURL(APP_URL);
}

app.on("web-contents-created", (_event, contents) => {
  attachNavigationGuards(contents);
});

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  buildAppMenu();
  configureSessionSecurity(session.defaultSession);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
