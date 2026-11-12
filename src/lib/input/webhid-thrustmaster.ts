/**
 * EXPERIMENTAL force feedback over WebHID for the Thrustmaster belt bases that do not speak HID PID: the T300RS
 * (T-GT II), T248 (T128), TX, TS-XW and TS-PC, listed in THRUSTMASTER_WHEELS (wheel-support.ts).
 *
 * The commands are those of the out-of-tree Linux driver hid-tmff2 (github.com/Kimplul/hid-tmff2: src/tmt300rs/
 * hid-tmt300rs.c and the T248, TX, TS-XW and TS-PC backends beside it), the outside source for every byte below; the
 * function named on each one is the hid-tmff2 function that sends the same bytes. The captures of the Windows driver
 * in its docs/FFBEFFECTS.md agree with them. None of it has been checked on a wheel.
 *
 * Transport: every command is output report 0x60 with 63 data bytes (31 on a T300RS in PS4 mode), zero-padded, which
 * is what t300rs_send_buf hands to hid_hw_request. The wheel's own report descriptor gives its output report another
 * id (0x0a on a T300RS); hid-tmff2 rewrites the descriptor (t300rs_wheel_fixup) so that 0x60, the id the firmware
 * reads, is the first byte on the wire. WebHID sees the wheel's own descriptor, so the browser is asked for a report
 * that descriptor does not list: Linux (hidraw) and macOS should pass it on as written, Windows may refuse it, and then
 * the setup fails at once (not retried) with a message that points to the bridge. The setup packets of the T248 family go out the same way,
 * their first byte as the report id (t248_interrupts writes them to the endpoint as they are).
 *
 * One effect: a constant force in effect slot 0, loaded at level 0, started, then its level streamed with the update
 * command. hid-tmff2 sends a playing effect's updates at most every 8 ms (DEFAULT_TIMER_PERIOD), so each streamed
 * write holds the writer that long.
 *
 * Not sent: the centring spring (hid-tmff2 sends t300rs_set_autocenter only when a program asks), and the firmware
 * and attachment reads and the F1 mode switch, which are USB control requests WebHID cannot make.
 */

import {
  defaultFfbDeps,
  ForceWriter,
  type FfbDeps,
  type HidCollectionLike,
  type HidDeviceLike,
  type PidFieldLayout,
  type SessionBase,
  type SetupResult,
} from "./webhid-ffb";
import type { ThrustmasterModel } from "./wheel-support";

/*
 * This module and webhid-ffb.ts import each other: neither may use the other's exports at the top level, only inside
 * functions. The model table and the names for copy live in wheel-support.ts.
 */

/** Report id of every hid-tmff2 command (t300rs_rdesc_nrm_fixed: Report ID (96)) */
export const TMFF2_REPORT_ID = 0x60;

/** Least time between the starts of two streamed writes (ms): hid-tmff2's DEFAULT_TIMER_PERIOD */
export const TMFF2_WRITE_SPACING_MS = 8;

/**
 * Gain sent at setup: hid-tmff2's default `gain` module parameter, 40000 of 65535 (about 61 %), which
 * tmff2_wheel_init passes to t300rs_set_gain. What the base powers up with is not known, so release leaves it as set,
 * as hid-tmff2 does
 */
export const TMFF2_GAIN = 40000;

/**
 * Level of the constant force: signed 16-bit over half the Linux range (t300rs_calculate_constant_level halves the
 * level), held inside the Windows driver's −16385..16381 (docs/FFBEFFECTS.md) on both sides.
 *
 * Sign: `setForce` takes a PID magnitude along +X (90°). Linux plays such an effect at direction 0x4000, where
 * t300rs_scale_direction multiplies the level by sin(direction) = +1, so + force → + level on the wire, the way the
 * Logitech classic driver puts + force above 0x80. Unverified on a wheel: Test direction / Invert.
 */
const TMFF2_FORCE_FIELD: PidFieldLayout = { bitOffset: 0, bitSize: 16, min: -16381, max: 16381, signed: true };

/** One command: the report id it goes out as and its data bytes, zero-padded to the model's report length when sent */
export interface ThrustmasterCommand {
  reportId: number;
  bytes: readonly number[];
}

const command = (bytes: readonly number[], reportId = TMFF2_REPORT_ID): ThrustmasterCommand => ({ reportId, bytes });
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

/** Effect slot 0 as the header names it: t300rs_fill_header writes effect id + 1 */
const EFFECT_ID_BYTE = 0x01;

/* ------------------------------------------------------------------------------------------------------------ */
/* Commands (the bytes after the report id)                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** t248_interrupts (and its copies for the TX, TS-XW and TS-PC): seven setup packets, the first byte the report id */
function tmff2SetupBurst(): ThrustmasterCommand[] {
  return [
    command([0x01], 0x42),
    command([0x04, 0x90, 0x03], 0x0a),
    command([0x04, 0x00, 0x0c], 0x0a),
    command([0x04, 0x12, 0x10], 0x0a),
    command([0x04, 0x00, 0x06], 0x0a),
    command([0x04, 0x00, 0x0e], 0x0a),
    command([0x04, 0x00, 0x0e, 0x01], 0x0a),
  ];
}

/** t300rs_set_gain: 02, then the high byte of the 16-bit gain */
function tmff2Gain(gain: number): ThrustmasterCommand {
  return command([0x02, (gain >> 8) & 0xff]);
}

/** t300rs_set_range: 08 11, then the range times 0x3c, little-endian */
function tmff2Range(deg: number): ThrustmasterCommand {
  return command([0x08, 0x11, ...le16(deg * 0x3c)]);
}

/** t300rs_send_open (01 05); t248_send_open and its copies (01 04, then 01 05) */
function tmff2Open(model: ThrustmasterModel): ThrustmasterCommand[] {
  return model.backend === "t248" ? [command([0x01, 0x04]), command([0x01, 0x05])] : [command([0x01, 0x05])];
}

/** t300rs_send_close (01 00); t248_send_close and its copies (01 05, then 01 00) */
function tmff2Close(model: ThrustmasterModel): ThrustmasterCommand[] {
  return model.backend === "t248" ? [command([0x01, 0x05]), command([0x01, 0x00])] : [command([0x01, 0x00])];
}

/**
 * t300rs_upload_constant for an effect with no envelope and no delay that plays until stopped: header (00, id, 6a),
 * level, the envelope's four 16-bit fields at 0, a 00, then the timing block (t300rs_fill_timing: 4f, duration ff ff,
 * which t300rs_calculate_length writes for an infinite effect, 00 00, offset 00 00, 00, end marker ff ff)
 */
function tmff2UploadConstant(level: number): ThrustmasterCommand {
  return command([
    0x00, EFFECT_ID_BYTE, 0x6a, ...le16(level),
    0, 0, 0, 0, 0, 0, 0, 0,
    0x00,
    0x4f, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
  ]);
}

/**
 * t300rs_update_constant: header (00, id, 6a), level, the envelope at 0, effect type 00, update type 45, duration
 * ff ff, offset 00 00
 */
function tmff2UpdateConstant(level: number): ThrustmasterCommand {
  return command([0x00, EFFECT_ID_BYTE, 0x6a, ...le16(level), 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x45, 0xff, 0xff, 0x00, 0x00]);
}

/** t300rs_play_effect: header (00, id, 89), 41, then the 16-bit play count: 1, what tmff2_play passes for one start */
function tmff2Play(): ThrustmasterCommand {
  return command([0x00, EFFECT_ID_BYTE, 0x89, 0x41, 0x01, 0x00]);
}

/** t300rs_stop_effect: header (00, id, 89), 00 */
function tmff2Stop(): ThrustmasterCommand {
  return command([0x00, EFFECT_ID_BYTE, 0x89, 0x00]);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Session                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

export interface ThrustmasterSession extends SessionBase {
  kind: "thrustmaster";
  model: ThrustmasterModel;
  /** Writes one command, zero-padded to the model's report length; called directly at setup and teardown, else through `writer` */
  send: (c: ThrustmasterCommand) => Promise<void>;
  /** Rotation lock to lock (deg), a stream of `writer`, clamped to the model's range as its set_range clamps it */
  setRange: (deg: number) => void;
  /** A range command went out, so release puts the model's full range back */
  rangeChanged: boolean;
}

export interface ThrustmasterSetupOptions {
  deps?: FfbDeps;
  onFail?: (message: string, fatal: boolean) => void;
  /** Rotation to set, lock to lock (deg), clamped to the model's range; null leaves the wheel's own range */
  rotationDeg?: number | null;
}

/** Largest output report (data bytes) the interface's descriptor lists: the browser refuses a longer write */
function maxOutputReportBytes(collections: readonly HidCollectionLike[]): number {
  let max = 0;
  for (const c of collections) {
    for (const r of c.outputReports ?? []) {
      const bits = (r.items ?? []).reduce((s, i) => s + Math.max(0, i.reportSize ?? 0) * Math.max(0, i.reportCount ?? 0), 0);
      max = Math.max(max, Math.ceil(bits / 8));
    }
    max = Math.max(max, maxOutputReportBytes(c.children ?? []));
  }
  return max;
}

/** Whether this interface can carry the model's command report (an output report at least that long) */
export function thrustmasterInterfaceFits(collections: readonly HidCollectionLike[], model: ThrustmasterModel): boolean {
  return maxOutputReportBytes(collections) >= model.reportBytes;
}

/** The range the model's set_range would apply (rounded, clamped to its range); null for anything but a number */
function tmff2RangeDeg(model: ThrustmasterModel, deg: number | null | undefined): number | null {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return null;
  return Math.min(model.maxRangeDeg, Math.max(model.minRangeDeg, Math.round(deg)));
}

/**
 * What the base gets when the page lets go of it (teardown, emergency stop, a failed setup): level 0 and the effect
 * stopped (when it was loaded), the model's full range back if a range command went out, then the close command(s)
 * that t300rs_close / t248_close send when the last program closes the wheel. The full range is assumed to be what the
 * base powers up with; no wheel has confirmed it. The gain is left as set (see {@link TMFF2_GAIN}).
 */
function releaseCommands(model: ThrustmasterModel, effectLoaded: boolean, rangeChanged: boolean): ThrustmasterCommand[] {
  return [
    ...(effectLoaded ? [tmff2UpdateConstant(0), tmff2Stop()] : []),
    ...(rangeChanged ? [tmff2Range(model.maxRangeDeg)] : []),
    ...tmff2Close(model),
  ];
}

export function thrustmasterReleaseCommands(session: ThrustmasterSession): ThrustmasterCommand[] {
  return releaseCommands(session.model, true, session.rangeChanged);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // device may already be gone
  }
}

/**
 * Connect-time setup of a listed Thrustmaster base, in hid-tmff2's order: the setup burst (T248 family,
 * t248_wheel_init), gain and range (tmff2_wheel_init), open (tmff2_open), then the constant force loaded at level 0
 * and started (the upload and start of tmff2_work_handler). A setup that fails after the device opened sends the
 * release commands for what it had done, close included.
 */
export async function setupThrustmasterDevice(
  device: HidDeviceLike,
  model: ThrustmasterModel,
  options: ThrustmasterSetupOptions = {}
): Promise<SetupResult<ThrustmasterSession>> {
  const deps = options.deps ?? defaultFfbDeps;
  if (!thrustmasterInterfaceFits(device.collections, model)) {
    return { ok: false, unsupported: true, message: `This ${model.name} interface has no ${model.reportBytes}-byte output report for force feedback` };
  }
  const send = (c: ThrustmasterCommand) => {
    const data = new Uint8Array(model.reportBytes);
    for (let i = 0; i < c.bytes.length && i < data.length; i++) data[i] = (c.bytes[i] as number) & 0xff;
    return device.sendReport(c.reportId, data);
  };
  /** A streamed write, then the rest of hid-tmff2's update period before the writer may send again */
  const spaced = async (c: ThrustmasterCommand) => {
    const started = deps.now();
    await send(c);
    const wait = TMFF2_WRITE_SPACING_MS - (deps.now() - started);
    if (wait > 0) await deps.sleep(wait);
  };

  let opened = false;
  let written = 0;
  let rangeChanged = false;
  let effectLoaded = false;
  const write = async (c: ThrustmasterCommand) => {
    await send(c);
    written++;
  };
  try {
    if (!device.opened) await device.open();
    opened = true;
    if (model.backend === "t248") for (const c of tmff2SetupBurst()) await write(c);
    await write(tmff2Gain(TMFF2_GAIN));
    const range = tmff2RangeDeg(model, options.rotationDeg);
    if (range !== null) {
      await write(tmff2Range(range));
      rangeChanged = true;
    }
    for (const c of tmff2Open(model)) await write(c);
    await write(tmff2UploadConstant(0));
    effectLoaded = true;
    await write(tmff2Play());

    const writer = new ForceWriter(TMFF2_FORCE_FIELD, (level) => spaced(tmff2UpdateConstant(level)), deps, options.onFail);
    const session: ThrustmasterSession = {
      kind: "thrustmaster",
      device,
      model,
      writer,
      send,
      rangeChanged,
      setRange: () => {},
    };
    const queueRange = writer.addChannel({
      toRaw: (deg) => deg,
      threshold: 1,
      initialRaw: range,
      send: (deg) => {
        session.rangeChanged = true;
        return spaced(tmff2Range(deg));
      },
    });
    session.setRange = (deg) => {
      const r = tmff2RangeDeg(model, deg);
      if (r !== null) queueRange(r);
    };
    return { ok: true, session };
  } catch (e) {
    if (opened) for (const c of releaseCommands(model, effectLoaded, rangeChanged)) await bestEffort(() => send(c));
    // The very first write failed: most likely the system refuses a report the descriptor does not list, which no
    // retry changes, so it is final at once (a reconnect does not spend its attempts on it)
    if (opened && written === 0) {
      return {
        ok: false,
        unsupported: true,
        message: `The browser could not send the ${model.name} its force-feedback commands (${errorMessage(e)}); Windows may refuse them. Use the native FFB bridge for this wheel`,
      };
    }
    return { ok: false, unsupported: false, message: errorMessage(e) };
  }
}

/** Best-effort shutdown: level 0, the effect stopped, the full range back if it was changed, then close. Never throws. */
export async function teardownThrustmasterSession(session: ThrustmasterSession): Promise<void> {
  await session.writer.close();
  for (const c of thrustmasterReleaseCommands(session)) await bestEffort(() => session.send(c));
}
