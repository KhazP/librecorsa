# UDP telemetry and the local bridge

LibreCorsa streams 60 Hz vehicle telemetry as compact JSON UDP datagrams for external dashboards, SimHub plugins, bass shakers, and motion rigs. Because browsers cannot open raw UDP sockets directly, telemetry goes through the repository's lightweight Node.js bridge (`scripts/ffb-bridge.ts`)—the same bridge that drives DirectInput force-feedback wheels on Windows.

UDP telemetry relay works on **Windows, macOS, and Linux**, with or without a racing wheel connected.

## Quick start

1. **Install dependencies once** (requires Node.js and a clone of the repository):

   ```bash
   npm install
   ```

2. **Start the bridge:**
   - For **local development** (`http://localhost:3000`):

     ```bash
     npm run ffb -- --telemetry-only
     ```

   - For **`https://librecorsa.org`** (set `FFB_ALLOW_ORIGIN` to the exact site origin, with no trailing slash or path):

     ```bash
     # macOS / Linux
     FFB_ALLOW_ORIGIN=https://librecorsa.org npm run ffb -- --telemetry-only
     ```

     ```powershell
     # Windows (PowerShell)
     $env:FFB_ALLOW_ORIGIN="https://librecorsa.org"; npm run ffb -- --telemetry-only
     ```

     ```cmd
     :: Windows (cmd)
     set "FFB_ALLOW_ORIGIN=https://librecorsa.org" && npm run ffb -- --telemetry-only
     ```

   Omit `--telemetry-only` on Windows if you also want the bridge to drive a DirectInput force-feedback wheel (see [Controls, controllers, and wheels](CONTROLS.md#force-feedback)).

3. **Enable UDP telemetry in-game:**
   Open **Settings > Profile and data > Data > Telemetry**, enable **UDP telemetry**, and confirm the **UDP port** (default `20790`).

Once you go on track, the bridge logs `Telemetry → udp://127.0.0.1:20790` and emits one UTF-8 JSON packet per frame at 60 Hz.

> **Why port `20790` instead of `20777`?** Port `20777` is used by the commercial F1 games' binary UDP protocol—sending JSON there confuses SimHub and dashboards expecting binary F1 structs. LibreCorsa defaults to `20790` and warns in Settings if you enter `20777`.

## CLI flags and environment variables

### Command-line flags (`npm run ffb -- <flags>`)

| Flag | Platform | Description |
| :-- | :-- | :-- |
| `--telemetry-only` | All | Relays UDP telemetry only and never opens a DirectInput wheel (always active automatically on macOS and Linux) |
| `--list` | Windows | Lists connected DirectInput controllers and whether each supports force feedback |
| `--info` | Windows | Prints force-feedback axes and constant-force capability per device |
| `--device "<name>"` | Windows | Selects a specific wheel by substring match on its device name |
| `--max <0..1>` | Windows | Caps DirectInput output torque (e.g., `--max 0.6` limits force to 60% of the driver's strength) |
| `--direction 0` | Windows | Switches DirectInput force sign convention if **Test direction** produces no force |
| `--dry-run` | Windows | Runs without hardware and logs the forces that would be sent to the helper |

### Environment variables

| Variable | Default | Description |
| :-- | :-- | :-- |
| `FFB_PORT` | `18500` | Localhost WebSocket port between the browser and the bridge (`ws://127.0.0.1:<port>`) |
| `FFB_ALLOW_ORIGIN` | Localhost only | Comma-separated list of allowed web origins (e.g., `https://librecorsa.org`) |
| `FFB_TELEMETRY_HOST` | `127.0.0.1` | Target IPv4 address for UDP datagrams. Accepts private LAN addresses (`10.x`, `172.16–31.x`, `192.168.x`) so you can stream directly to a tablet dashboard or second PC on your local network; public IPs are ignored for safety |

### Bridge behaviour and safety

- **Coexisting with WebHID wheels:** On Windows, the bridge only opens DirectInput when the browser actually sends force commands over the bridge, and releases the wheel automatically after 3 seconds of inactivity. You can leave the bridge running for UDP telemetry while driving your wheel over WebHID without conflicts. If DirectInput reports `0x800700AA` (`ERROR_BUSY`), switch WebHID off or launch the bridge with `--telemetry-only`.
- **Single active tab:** Only one browser tab controls the bridge at a time; opening a second tab takes over cleanly and notifies the first tab (`replaced`) so it stops trying to reconnect.
- **Rate and size caps:** The bridge accepts UDP ports `1024`–`65535`, drops packets larger than `8 KB`, and token-bucket limits outgoing datagrams to `120` per second.
- **Status endpoint:** Sending a plain HTTP `GET` to `http://127.0.0.1:18500/` returns current bridge status as JSON.

## Packet format (`TelemetryOutPacket`, `v: 1`)

Every UDP datagram is a single flat JSON object defined in `src/lib/input/telemetry-out.ts`. Four-element wheel arrays are always ordered **`[FL, FR, RL, RR]`** (front-left, front-right, rear-left, rear-right).

| Field | Type | Unit / convention |
| :-- | :-- | :-- |
| `v` | `1` | Packet schema version |
| `car` | `string` | Vehicle model ID (e.g., `"f12026-car"`, `"amg-gt3"`) |
| `track` | `string` | Circuit ID |
| `t` | `number` | Milliseconds since page load |
| `speedKmh` | `number` | Ground speed (`km/h`) |
| `rpm`, `maxRpm` | `number` | Current engine speed and rev limit (`rpm`) |
| `gear` | `number` | `-1` = Reverse, `0` = Neutral, `1..8` = forward gears |
| `throttle`, `brake`, `clutch` | `number` | Pedal positions (`0..1`; `clutch = 1` means engaged) |
| `steer` | `number` | Steering input (`-1..1`, `+` = right) |
| `gLat`, `gLon` | `number` | Lateral (`+` = right) and longitudinal (`+` = forward) acceleration (`g`) |
| `gVert` | `number` | Measured chassis vertical acceleration (`g`, `+` = up): `1` at rest on flat ground, `> 1` over bumps/compressions, `< 1` over crests, `0` airborne. Unaffected by aero downforce; low-passed at `20 Hz` (~`8 ms` lag) for motion rigs and shakers |
| `yawRate` | `number` | Yaw angular velocity (`rad/s`, `+` = turning right) |
| `pitch`, `roll` | `number` | Chassis pitch and roll angles (`rad`) |
| `ersPct` | `number` | Hybrid battery state of charge (`0..100 %`) |
| `boost` | `boolean` | `true` when 2026 Overtake Mode / manual override (`350 kW`) is active |
| `drs` | `boolean` | `true` when rear flap / DRS is open |
| `aeroMode` | `string` | `"Z_MODE"` (high downforce), `"X_MODE"` (low drag), or `""` |
| `fuelKg` | `number` | Fuel on board (`kg`) |
| `tyreTempC` | `number[4]` | Tyre carcass temperatures (`°C`, `[FL, FR, RL, RR]`) |
| `tyrePsi` | `number[4]` | Hot tyre gauge pressures (`psi`, `0` when unavailable) |
| `tyreWearPct` | `number[4]` | Tyre wear (`0..100 %`) |
| `brakeTempC` | `number[4]` | Brake disc temperatures (`°C`) |
| `wheelSlip` | `number[4]` | Longitudinal slip ratio (dimensionless, `+` = traction, `-` = braking) |
| `suspTravelMm` | `number[4]` | Suspension compression (`mm`) |
| `surface` | `string[4]` | Surface under each tyre (`"asphalt"`, `"kerb"`, `"runoff"`, `"grass"`, etc.) |
| `lap` | `number` | Current lap count |
| `lapTimeMs`, `lastLapMs`, `bestLapMs` | `number` | Current, previous, and best lap times (`ms`, `0` when none) |
| `position` | `number` | Race position (`1` = leader, `0` outside a race) |
| `trackPos` | `number` | Normalized progress around the lap (`0..1`) |
| `kerb`, `offTrack` | `boolean` | Whether a tyre is on a kerb or the car is off track |
| `abs`, `tc` | `boolean` | Whether ABS or traction control intervened on the current step |
| `ffb` | `number` | Normalized steering torque from the front tyres (`-1..1`, `+` = turning rim right) |
| `oversteerPct`, `understeerPct` | `number` | Slip-balance cues (`0..100 %`) for haptic shakers or dash indicators |

## Testing the UDP stream

Run a quick listener in Python or Node.js to confirm packets are arriving on port `20790`:

```python
import json, socket

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("127.0.0.1", 20790))
print("Listening on udp://127.0.0.1:20790 ...")

while True:
    data, _ = sock.recvfrom(8192)
    pkt = json.loads(data)
    print(f"{pkt['car']} | {pkt['speedKmh']:5.1f} km/h | G{pkt['gear']} | {pkt['rpm']:5.0f} rpm | gLat={pkt['gLat']:+.2f}")
```
