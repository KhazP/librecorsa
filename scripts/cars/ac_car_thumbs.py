"""The car browser's pictures of an Assetto Corsa car (scripts/mods/importers/ac-car.ts), each a 480 x 270 WebP: a
skin's preview filling the frame (centred, its overflow cropped), or the car's badge inside it on a transparent ground.

    python -P scripts/cars/ac_car_thumbs.py <jobs.json>

jobs.json: [{"src": <picture>, "out": <.webp>, "fit": "cover" | "contain"}, ...]. A picture that can't be read is
said and not written, and the importer does without it. Pillow alone, so it runs wherever the importer runs (the
launcher's converter has no image library in Node).
"""
import json
import os
import sys

from PIL import Image, ImageOps

SIZE = (480, 270)


def thumb(src, out, fit):
    im = Image.open(src)
    im.load()
    if fit == 'cover':
        ImageOps.fit(im.convert('RGB'), SIZE, Image.LANCZOS).save(out, format='WEBP', quality=82)
        return
    im = im.convert('RGBA')
    k = min(SIZE[0] / im.width, SIZE[1] / im.height)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    ground = Image.new('RGBA', SIZE, (0, 0, 0, 0))
    ground.paste(im, ((SIZE[0] - im.width) // 2, (SIZE[1] - im.height) // 2), im)
    ground.save(out, format='WEBP', quality=82, alpha_quality=90)


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    for job in json.load(open(sys.argv[1], encoding='utf-8')):
        try:
            thumb(job['src'], job['out'], job.get('fit', 'cover'))
        except (OSError, ValueError) as e:
            print(f"  {job['src']}: not made into a picture ({e})")
            if os.path.exists(job['out']):
                os.remove(job['out'])


if __name__ == '__main__':
    main()
