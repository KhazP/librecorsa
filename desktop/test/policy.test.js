"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  APP_URL,
  isAllowedAppUrl,
  isExternalBrowserUrl,
  decideNavigation,
} = require("../src/nav-policy");
const {
  isAllowedOrigin,
  isAllowedHidDevice,
  pickPreferredHidDevice,
} = require("../src/hid-policy");

describe("nav-policy", () => {
  it("pins APP_URL to https://librecorsa.org/play", () => {
    assert.equal(APP_URL, "https://librecorsa.org/play");
  });

  it("allows in-app navigation only on https://librecorsa.org", () => {
    assert.deepEqual(decideNavigation("https://librecorsa.org/play"), {
      allowInApp: true,
      openExternal: false,
    });
    assert.deepEqual(decideNavigation("https://librecorsa.org/tracks?lap=1#hud"), {
      allowInApp: true,
      openExternal: false,
    });
    assert.equal(isAllowedAppUrl("https://librecorsa.org:443/"), true);
  });

  it("routes external http(s) URLs to the system browser", () => {
    assert.deepEqual(decideNavigation("https://github.com/KhazP/librecorsa"), {
      allowInApp: false,
      openExternal: true,
    });
    assert.deepEqual(decideNavigation("https://librecorsa.org.evil.com/play"), {
      allowInApp: false,
      openExternal: true,
    });
    // The docs site is its own origin: the home page's Docs link opens it in the browser, not over the game
    assert.deepEqual(decideNavigation("https://docs.librecorsa.org/porting/cars/"), {
      allowInApp: false,
      openExternal: true,
    });
    assert.deepEqual(decideNavigation("http://librecorsa.org/play"), {
      allowInApp: false,
      openExternal: true,
    });
    assert.equal(isExternalBrowserUrl("https://example.com"), true);
  });

  it("blocks non-http(s) and malformed URLs completely", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://192.168.1.2/share",
      "ms-msdt:/id",
      "data:text/html,hi",
      "",
      null,
      undefined,
      "not a url",
    ]) {
      assert.deepEqual(decideNavigation(url), {
        allowInApp: false,
        openExternal: false,
      });
    }
  });
});

describe("hid-policy", () => {
  it("validates exact https://librecorsa.org origin", () => {
    assert.equal(isAllowedOrigin("https://librecorsa.org"), true);
    assert.equal(isAllowedOrigin("https://librecorsa.org/play"), true);
    assert.equal(isAllowedOrigin("http://librecorsa.org/play"), false);
    assert.equal(isAllowedOrigin("https://evil.librecorsa.org"), false);
    assert.equal(isAllowedOrigin(""), false);
    assert.equal(isAllowedOrigin(null), false);
  });

  it("allows DualSense pads and DualSense Edge", () => {
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x054c,
        productId: 0x0ce6,
        collections: [{ usagePage: 0x01, usage: 0x05 }],
      }),
      true,
    );
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x054c,
        productId: 0x0df2,
        collections: [],
      }),
      true,
    );
  });

  it("allows standard gamepads, joysticks, multi-axis wheels, and PID devices", () => {
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x346e,
        productId: 0x0002,
        collections: [{ usagePage: 0x01, usage: 0x04, children: [{ usagePage: 0x0f, usage: 0x01 }] }],
      }),
      true,
    );
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x045e,
        productId: 0x02ea,
        collections: [{ usagePage: 0x01, usage: 0x08 }],
      }),
      true,
    );
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x044f,
        productId: 0xb66e,
        collections: [],
      }),
      true,
    );
  });

  it("rejects keyboards, mice, receivers, headsets, and security keys", () => {
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x046d,
        productId: 0xc52b,
        collections: [{ usagePage: 0x01, usage: 0x02 }, { usagePage: 0x01, usage: 0x06 }],
      }),
      false,
    );
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x1050,
        productId: 0x0407,
        collections: [{ usagePage: 0xf1d0, usage: 0x01 }],
      }),
      false,
    );
    assert.equal(
      isAllowedHidDevice({
        vendorId: 0x054c,
        productId: 0x0e00,
        collections: [{ usagePage: 0x0c, usage: 0x01 }],
      }),
      false,
    );
    assert.equal(isAllowedHidDevice(null), false);
    assert.equal(isAllowedHidDevice({ vendorId: 1, productId: 2, collections: [] }), false);
  });

  it("prefers the FFB-capable wheel interface over input-only interfaces", () => {
    const g920InputOnly = {
      deviceId: "g920-in",
      vendorId: 0x046d,
      productId: 0xc262,
      collections: [{ usagePage: 0x01, usage: 0x04, outputReports: [] }],
    };
    const g920Hidpp = {
      deviceId: "g920-hidpp",
      vendorId: 0x046d,
      productId: 0xc262,
      collections: [{ usagePage: 0xff00, usage: 0x01, outputReports: [{ reportId: 0x11 }] }],
    };
    const chosen = pickPreferredHidDevice([g920InputOnly, g920Hidpp], "https://librecorsa.org/play");
    assert.equal(chosen && chosen.deviceId, "g920-hidpp");

    const pidWheel = {
      deviceId: "pid-wheel",
      vendorId: 0x0eb7,
      productId: 0x0006,
      collections: [{ usagePage: 0x01, usage: 0x04, children: [{ usagePage: 0x0f, usage: 0x01 }] }],
    };
    const dualsense = {
      deviceId: "dualsense",
      vendorId: 0x054c,
      productId: 0x0ce6,
      collections: [{ usagePage: 0x01, usage: 0x05, outputReports: [{ reportId: 2 }] }],
    };
    assert.equal(
      pickPreferredHidDevice([dualsense, pidWheel], "https://librecorsa.org/play").deviceId,
      "pid-wheel",
    );
    assert.equal(
      pickPreferredHidDevice([dualsense], "https://librecorsa.org/play").deviceId,
      "dualsense",
    );
  });

  it("refuses HID device selection from unauthorized frames or with disallowed devices", () => {
    const keyboard = {
      deviceId: "kbd",
      vendorId: 0x1234,
      productId: 0x5678,
      collections: [{ usagePage: 0x01, usage: 0x06 }],
    };
    const dualsense = {
      deviceId: "dualsense",
      vendorId: 0x054c,
      productId: 0x0ce6,
      collections: [{ usagePage: 0x01, usage: 0x05 }],
    };
    assert.equal(pickPreferredHidDevice([keyboard], "https://librecorsa.org/play"), null);
    assert.equal(pickPreferredHidDevice([dualsense], "https://evil.com/"), null);
  });
});
