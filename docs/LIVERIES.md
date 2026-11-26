# Painting liveries

You can paint your own livery for five cars: the 2026 Prototype, the LC25 Prototype, the Mercedes-AMG GT3 Evo, the BMW M4 GT3 Evo and the LC-LMDH. Their bodywork has no UV map, so a livery isn't a texture wrapped around the car like in most sims. It's one square picture with flat views of the car (top, both sides, front and rear, plus the front wing endplates on the F1 cars), and the game projects each view onto the body from that direction, like a slide projector.

Each car has its own template, drawn from its model, so a livery painted for one car won't line up on another, not even between the two F1 cars.

## The templates

Every car has two files, both 2048 × 2048 pixels, the size the game uses:

- **Guide**: the views of the car laid out as the game reads them, with labels, outlines and light fill. Paint over it, or use it to plan.
- **Overlay**: the same outlines and panel borders on a transparent background, to keep as the top layer while you paint.

| Car | Guide | Overlay |
| :--- | :--- | :--- |
| 2026 Prototype | [2026 Prototype guide (PNG, 301 KB)](livery-templates/lc26/lc26-template.png) | [2026 Prototype overlay (PNG, 270 KB)](livery-templates/lc26/lc26-overlay.png) |
| LC25 Prototype | [LC25 Prototype guide (PNG, 294 KB)](livery-templates/lc25/lc25-template.png) | [LC25 Prototype overlay (PNG, 264 KB)](livery-templates/lc25/lc25-overlay.png) |
| Mercedes-AMG GT3 Evo | [AMG GT3 Evo guide (PNG, 356 KB)](livery-templates/amg-gt3/amg-gt3-template.png) | [AMG GT3 Evo overlay (PNG, 320 KB)](livery-templates/amg-gt3/amg-gt3-overlay.png) |
| BMW M4 GT3 Evo | [M4 GT3 Evo guide (PNG, 310 KB)](livery-templates/bmw-m4-gt3/bmw-m4-gt3-template.png) | [M4 GT3 Evo overlay (PNG, 277 KB)](livery-templates/bmw-m4-gt3/bmw-m4-gt3-overlay.png) |
| LC-LMDH | [LC-LMDH guide (PNG, 294 KB)](livery-templates/lc-lmdh/lc-lmdh-template.png) | [LC-LMDH overlay (PNG, 266 KB)](livery-templates/lc-lmdh/lc-lmdh-overlay.png) |

Open a link and save the image (right-click, Save image as).

![The 2026 Prototype's guide. The top half shows the car from above with its nose to the right. Under it are the left side with the nose to the left and the right side with the nose to the right. Along the bottom are the rear view, the front view and the two front wing endplates. Each view is framed and labelled in capitals, the top and side views have an arrow pointing to the front, and dashed lines mark the centre line and the axles.](livery-templates/lc26/lc26-preview.webp)

How to read a guide:

- **Labels and arrows**: every view is named (TOP VIEW, LEFT SIDE, RIGHT SIDE, REAR, FRONT, and FW ENDPLATE L and R on the F1 cars), and the top and side views have an arrow that points to the front of the car. L and R mark the car's left and right halves in the top, front and rear views, on the overlay too. The name tags only ever sit where that view paints nothing, so they never hide part of the car.
- **Big lettering on the car**: words like "← FRONT · LEFT SIDE" or "REAR WING" written across the body show which part of the picture lands on which part of the car. They're there to paint over.
- **Light fill**: where that view really paints the car. Surfaces facing up take the top view, surfaces facing sideways take a side view, and so on, so a sidepod's top takes the top view even though its outline shows in the side view too.
- **Dashed lines**: the centre line and the axles, to line up a stripe or a number between views.
- **Hatched edges**: a narrow hatched strip along the edge of a view marks where part of the car reaches beyond that view. The part takes the colour you paint right at that edge, stretched across it, so keep plain colours there. The LC25 Prototype has them at its front wing tips, rear wing and front wing endplates, and both F1 cars along their front and rear views.
- **Hatched areas on the AMG GT3 Evo**: the front splitter, which always stays bare carbon whatever you paint.

## How to paint one

1. Start from the guide, or start a new 2048 × 2048 canvas and put the overlay on top. Any editor with layers works: Photoshop, GIMP, Krita, Affinity Photo or Photopea.
2. Paint each view the way you'd see the car from that side. The views are already laid out like that, so text and numbers you write the right way round read the right way round on the car. In the left side view the nose points left, in the right side view it points right, the top view has the nose to the right with the car's left side at the top, and the rear and front views are as seen from behind and from in front.
3. Paint past the outlines, and fill every view right up to its frame. Where one view hands over to the next (the top of a sidepod, the edge of the engine cover) the two blend, so carry each colour a little past the outline and make a stripe meet itself where it crosses from the top view to a side view. Any part that reaches beyond a view's frame takes the colour at the very edge of that view, so don't leave the frame lines or the guide's background there.
4. Put text, numbers and logos on surfaces that face one view squarely: sidepod sides, the engine cover and nose from above, the rear wing from behind, doors and bonnet on the GT3s. On curved or angled surfaces they stretch.
5. Near-black becomes carbon. Anything darker than about `#222222` gets a carbon-fibre weave in the game, so use it for bare carbon and a slightly lighter shade (`#333333` or lighter) for black paint.
6. Hide the guide layers and export the picture as a PNG (WebP or JPEG also work). Keep it 2048 × 2048: the game takes any square size from 1024 to 4096, but 2048 is what it's made for, and phones load it at 1024.

Painting a quick test pattern first (the view names, "L" and "R", and a grid) and looking at it on the car is the fastest way to learn a car's layout.

### Where views overlap

A view paints every surface that faces it along its line of sight, so parts that sit in front of one another share the same spot in that view:

- **Rear wing and the deck under it**: on the GT3s and the LC-LMDH, whatever you paint on the rear wing in the top view also lands on the boot lid or engine cover below it, and shows faintly on the wing's underside, mirrored. Keep the wing in the deck's colours, or put the wing's artwork on its rear face in the rear view instead.
- **Inner faces**: surfaces that face the middle of the car, such as the inside of the front wing endplates and of the rear wing endplates, and the inside of the LC25's sidepod channels, take the other side's view. Keep plain colours near the edges of those parts.
- **LC-LMDH fin**: in the side views the shark fin sits over the rear wheel arch, so both take the same part of the picture.

### Car notes

- **2026 Prototype and LC25 Prototype**: separate templates. The LC25 is wider and longer than the painting area in a few places, see the hatching above.
- **The GT3s and the LC-LMDH**: windows, grilles and vents are left out of the views (the grey areas inside the outlines), so paint there never shows.

## Try it in the game

Your own liveries go in a mod package, which the [LibreCorsa desktop app](modding.md) loads (the game on librecorsa.org takes no mods). A package with one livery for the 2026 Prototype is a folder like this:

```text
yourname.lc26-liveries/
  mod.json
  skins/teal-works/atlas.png       your painted picture
  skins/teal-works/thumb.webp      optional picture for the livery picker
```

```json
{
  "format": 1,
  "id": "yourname.lc26-liveries",
  "name": "My 2026 liveries",
  "version": "1.0.0",
  "credit": { "author": "Your Name", "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/" },
  "skins": [
    { "car": "lc26", "id": "teal-works", "name": "Teal Works", "swatch": ["#00a896", "#111827", "#f0f3bd"], "atlas": "atlas.png", "finish": "gloss" }
  ]
}
```

- `car` is `lc26` (2026 Prototype), `lc25` (LC25 Prototype), `amg-gt3`, `bmw-m4-gt3` or `lc-lmdh`.
- `swatch` is two or three of the livery's main colours, shown in the picker.
- `finish` is optional: `gloss` (the default), `satin`, `matte`, `metallic` or `chrome`.

In the desktop app, open **Mods**, choose the folder, then pick your livery in the garage (the F1 cars list it under Installed mods). To have the package checked first, including the picture's size, run `npm run mod -- check <folder>` from a copy of the repository. Only you see a mod livery: online, other players see your car in one of the game's own liveries. [Making mods](modding.md) has every field.

## Send it in

If you'd like your livery in the game for everyone, open a [content request](https://github.com/librecorsa/librecorsa/issues/new?template=content-request.yml) with the picture (or a link to it) and say which licence you're releasing it under (CC BY 4.0 is the simplest). You'll be credited by name. A livery that ships in the game must be your own design and can't carry real teams', sponsors' or drivers' names or logos; made-up sponsors are fine, and so is a colour scheme that only reminds you of a real team. If you use a logo you didn't draw yourself, say where it's from and its licence.

## Where the templates come from

`scripts/cars/build-livery-templates.ts` draws the templates from the cars' own models with the same projection the game uses, so they always match. The models, and so the shapes in the templates, are their authors' work:

- 2026 Prototype: [F1 2026 concept (polygon model)](https://qvistdesigns.framer.website/) by **Qvist Designs**, CC BY 4.0.
- LC25 Prototype: [F1 2025 McLaren MCL39](https://sketchfab.com/3d-models/f1-2025-mclaren-mcl39-c6194270002b401bb25be7e35ab56e34) by **shunqi**, CC BY 4.0.
- LC-LMDH: [LMDh prototype](https://sketchfab.com/models/d786aa263a804254aa92543dda11dba0) by **kilianhoffmann13**, CC BY 4.0.
- Mercedes-AMG GT3 Evo: [Mercedes-AMG GT3](https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07) by **Vecarz**, CC BY-NC-SA 4.0.
- BMW M4 GT3 Evo: [2025 BMW M4 GT3 EVO G82](https://sketchfab.com/3d-models/2025-bmw-m4-gt3-evo-g82-113f83dd87064697a5ec2511d280b9d5) by **Ddiaz Design**, CC BY-NC-SA 4.0.

The two GT3 templates are shared under CC BY-NC-SA 4.0 like their models (non-commercial, share-alike, credit the author); the others under CC BY 4.0.
