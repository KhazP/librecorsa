# Triple screens

LibreCorsa can draw three monitors side by side as three separate views, one per screen. Each side screen gets a view turned and framed for where that monitor actually stands, so the world runs straight across the seams and the cars beside you look the right size and speed. A single wide view stretched across three angled monitors cannot do this. Menus and the HUD stay on the centre screen.

Set it up under **Settings > Display > Screens**.

## Getting the game across three screens

The game draws into its browser window, so the window has to cover all three monitors.

- **NVIDIA Surround or AMD Eyefinity (recommended):** the driver joins the three monitors into one wide display (for example 5760 x 1080). Put the game in full screen (F11, or the browser's full screen) and it fills all three.
- **Without Surround or Eyefinity:** a browser's full screen covers one monitor only. You can drag the window across all three and maximise its size by hand, with the window's title bar left showing. On macOS, turn off **Displays have separate Spaces** (System Settings > Desktop & Dock) first, or a window can't cross a monitor's edge.

When the window is the shape of three screens and the game still draws one view, the title screen offers to set it up once. With **Three** chosen on a window only one screen wide, the game draws one view and the Screens tab says why.

## Your measurements

| Setting | What to measure |
| :-- | :-- |
| **Screens** | `Three` gives each screen its own view. |
| **Screen size** | One monitor's diagonal in inches, as it was sold (27 for a 27-inch monitor). The game takes the screen's shape from the window. |
| **Distance to screen** | From your eyes to the centre monitor's picture, straight on, in cm. |
| **Bezel** | One monitor's frame beside its picture, in mm: from the edge of the picture to the edge of the monitor. The game counts it twice for each gap, once for each monitor. Set it to `0` when Surround or Eyefinity bezel correction is on (it already hides the frames), and below 0 for strips that hide the frames. |
| **Side screen angle** | How far the side monitors turn in from the centre one. The default, **facing you**, is the angle at which the middle of each side monitor faces your eyes, which is what setup guides recommend. Set your real angle here if your monitors stand differently. |
| **Eye height** (Advanced) | Your eyes above (+) or below (−) the middle of the monitors. |

The drawing under the settings shows your monitors from above with what each one shows. With the game paused, Settings sits on the centre screen and the side screens keep showing the track, so you can change the angle or bezel and watch a wall or a kerb line up across the seams.

## Field of view

- **True field of view** (on by default with three screens): the driver's views show exactly what your monitors frame from where you sit, worked out from the screen size and distance. This is usually narrower than you're used to (about 27° for a 27-inch monitor at 70 cm), and it is the view that makes speed and distances look real. Picking a field of view by hand in the pause menu turns it off. The seat adjustments (hold the camera key, or `[` / `]` in the cockpit) still move each car's seat on top of it.
- With it off, **Settings > Display > Camera > Field of view** sets the centre screen and the side screens follow it.
- With one screen, the Screens tab also works out the true field of view for your monitor and sets it with one press.

The chase, TV and other outside cameras keep their own field of view on the centre screen; the side screens add what lies beyond it.

## Performance

Three screens draw the scene three times each frame, each with its own shadows and sky. On Bugesera that is about 1,900 draw calls a frame against about 870 for one wide view of the same size, so expect a lower frame rate than with one screen.

- **Side screen resolution:** render the side screens at `75%` or `50%`. Your eyes take in less detail at the edges, and the frame rate goes up.
- **Automatic quality** and **Render resolution** apply to all three screens (see [Performance and troubleshooting](PERFORMANCE.md)).
- Very wide canvases are held to what your graphics card can draw (16384 pixels across on most), so three 4K monitors at a high Windows scale render a little below native.

## Known limits

- All three monitors are taken to be the same size and resolution, and the two side monitors turn in by the same angle.
- Rain on the windscreen or visor shows on the centre screen only.
- VR and touch controls use one view; turning on VR switches triple screens off until you leave it (see [VR headsets](VR.md)).
