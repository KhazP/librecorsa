/**
 * An Assetto Corsa car mod (its folder: content/cars/<id>) as a mod package, in one command and with no setup for the
 * car: its body and liveries ported into the game's rig (scripts/cars/port_ac_car.py, its preset when the repository
 * has one, else an automatic one), its sound bank (scripts/audio/port_ac_bank.py, a config made from the bank's sample
 * names), and its physics as a patch on the base vehicle model its class, drivetrain, mass and power choose
 * (scripts/cars/ac-physics-patch.ts), driven headless before it is packaged. Kunos's own cars are refused. A mod whose
 * author states no licence that allows sharing is packaged for its importer alone, and its credit says so.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { VEHICLE_MODELS } from '../../../src/lib/cars/vehicle-models';
import type { ModCarClass, ModSkin } from '../../../src/lib/mods/mod-manifest';
import type { VehicleModelId } from '../../../src/types/f1';
import { findKn5, kn5IsPlain, kunosContent, PERSONAL_USE_NOTE, readLicence, readUiCar } from '../../cars/ac-car-info';
import { acCarFacts, acPhysicsPatch, BASE_MODELS, chooseBaseModel, driveCheck, type AcPhysicsPatch } from '../../cars/ac-physics-patch';
import { ModData } from '../../lib/mod-data';
import { packageCar, type CarSkinSource } from '../lib/car-package';
import { importTarget, PACKAGE_USAGE, parseImportArgs, type Importer } from '../lib/importer';
import { localIdFrom, packageCredit } from '../lib/manifest-file';
import { report } from '../lib/package-check';
import { runPython } from '../lib/toolchain';

/** What port_ac_car.py --report writes */
interface PortReport {
  car: string;
  preset: { title?: string; paint?: string[]; windscreen?: string[] };
  detected: Record<string, unknown> | null;
  skin: string | null;
  extras: { wheelbaseM: number; tyreRadius: Record<string, number> };
  skins: { id: string; name: string; number: string; swatch: string[]; files?: string[]; folder?: string; variant?: string }[] | null;
}

const DRIVE: Record<string, string> = { RWD: 'rear-wheel drive', FWD: 'front-wheel drive', AWD: 'four-wheel drive', AWD2: 'four-wheel drive' };

/** The ffmpeg the sound porter needs: on the PATH, else Homebrew's */
function ffmpegPath(): string | null {
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : null;
}

/** A picture as the car browser's (480 × 270 webp): a skin's preview filling it, or a badge inside it */
async function thumbFrom(src: string, out: string, fit: 'cover' | 'contain'): Promise<boolean> {
  try {
    await sharp(src)
      .resize(480, 270, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 82, alphaQuality: 90 })
      .toFile(out);
    return true;
  } catch {
    return false;
  }
}

/** A skin folder's preview picture (AC's `preview.jpg`), whatever its case */
function previewOf(carDir: string, folder: string | undefined): string | null {
  if (!folder) return null;
  const dir = join(carDir, 'skins', folder);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /^preview\.(jpe?g|png)$/i.test(n));
  return f ? join(dir, f) : null;
}

/** Ids unique within the car, made from the skins' folder ids */
function skinIds(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.map((id) => {
    const base = localIdFrom(id);
    let out = base;
    for (let n = 2; seen.has(out); n++) out = `${base.slice(0, 16 - String(n).length - 1)}-${n}`;
    seen.add(out);
    return out;
  });
}

const swatchOf = (s: string[]): ModSkin['swatch'] => (s.length >= 2 ? [s[0], s[1]] : [s[0] ?? '#808080', s[0] ?? '#808080']);

const importer: Importer = {
  summary: 'an Assetto Corsa car mod (its content/cars/<car> folder): body, liveries, sound and physics',
  usage: `<car folder> [--base <model>] [--no-physics] [--skins all|<skin,skin,…>] [--id <car id>]
  --base <model>           the vehicle model it drives on (default: chosen by its class, drivetrain, mass and power):
                           ${BASE_MODELS.join(', ')}
  --no-physics             drive exactly as the base model, with none of the car's own physics
  --skins all|<list>       the liveries to package: all (the default) or skin folders, comma-separated, the first the
                           paint the model is made in
  --id <id>                the car's id in the package (default: made from its name)
${PACKAGE_USAGE}`,
  async run(argv) {
    const { values, positionals } = parseImportArgs(argv, {
      base: { type: 'string' },
      'no-physics': { type: 'boolean' },
      skins: { type: 'string' },
      id: { type: 'string' },
    });
    const carDir = positionals[0] && resolve(positionals[0]);
    if (!carDir || !existsSync(carDir) || !statSync(carDir).isDirectory()) throw new Error('name the car\'s folder (content/cars/<car> in Assetto Corsa)');
    const ui = readUiCar(carDir);
    const kunos = kunosContent(carDir, ui);
    if (kunos) throw new Error(`refused: ${kunos}. Kunos's cars are the game's own content, never converted or packaged.`);
    const mod = new ModData(carDir);
    if (!mod.present) throw new Error(`${carDir}: no car data (data/ or data.acd with car.ini): not an Assetto Corsa car folder`);
    const kn5 = findKn5(carDir, mod.text('lods.ini', 'LOD_0', 'FILE'));
    if (!kn5) throw new Error(`${carDir}: no .kn5 model in the folder`);
    if (!kn5IsPlain(join(carDir, kn5))) throw new Error(`refused: ${kn5} is encrypted, as Kunos's own cars and some paid mods are: it can't be read`);
    if (values.base && !BASE_MODELS.includes(values.base as VehicleModelId)) throw new Error(`--base ${values.base}: the bases are ${BASE_MODELS.join(', ')}`);

    // The package: named for the author and the car, its credit with what the author allows
    const folder = basename(carDir);
    const name = ui.name ?? folder;
    const licence = readLicence(carDir, ui);
    const credit = packageCredit({
      author: ui.author,
      url: ui.url,
      license: licence.license,
      licenseUrl: licence.licenseUrl,
      note: licence.shareable ? null : PERSONAL_USE_NOTE,
    });
    const localId = localIdFrom(values.id ?? name);
    const { info, packageDir } = importTarget(values, { author: credit.author, name, credit, description: ui.description?.slice(0, 1000) });

    // Physics: the patch, checked as the game checks it, then driven
    const facts = acCarFacts(mod, ui);
    let physics: AcPhysicsPatch | null = null;
    let base = (values.base as VehicleModelId | undefined) ?? chooseBaseModel(facts).base;
    if (!values['no-physics']) {
      physics = acPhysicsPatch(carDir, { base: values.base as VehicleModelId | undefined, ui });
      base = physics.base;
      console.log(`physics: on ${physics.base} (${physics.why}): ${physics.mapped.length} values from the car's data, ${physics.unmapped.length} not carried`);
      for (const u of physics.unmapped) console.log(`  not carried: ${u.from}: ${u.why}`);
      const drive = await driveCheck(physics.profile, { lap: true });
      console.log(
        `  driven: 0–100 km/h ${drive.t100.toFixed(2)} s, ${drive.topKmh.toFixed(0)} km/h flat out (${drive.straightSlipDeg.toFixed(1)}° of slip), ` +
          `${drive.brakeFromKmh}→0 km/h in ${drive.brakeM.toFixed(0)} m (${drive.brakeG.toFixed(2)} g)` +
          (drive.lap ? `; a RISE lap on the autopilot ${drive.lap.done ? `${drive.lap.lapS.toFixed(2)} s` : 'not finished'}` : ''),
      );
      if (!drive.ok) {
        throw new Error(`its physics don't drive sanely on ${physics.base}: ${drive.problems.join('; ')}. Try another --base, or --no-physics to drive as the base does`);
      }
    } else console.log(`physics: none of its own: it drives as ${base}${values.base ? '' : ` (${chooseBaseModel(facts).why})`}`);

    const work = mkdtempSync(join(tmpdir(), `ac-car-${localId}-`));
    // The converters' lines in order with these, when the output is piped (the launcher's log)
    process.env.PYTHONUNBUFFERED = '1';
    try {
      // Body and liveries
      const glb = join(work, `${localId}.glb`);
      const skinsOut = join(work, 'skins');
      const reportPath = join(work, 'report.json');
      const only = values.skins && values.skins !== 'all' ? values.skins.split(',').map((s) => s.trim()).filter(Boolean) : null;
      runPython(
        'scripts/cars/port_ac_car.py',
        [carDir, glb, '--skins-out', skinsOut, '--report', reportPath, ...(only ? ['--skin', only[0], '--skins-only', only.join(',')] : [])],
        { withPackages: ['numpy', 'pillow'], requirements: null },
      );
      const port = JSON.parse(readFileSync(reportPath, 'utf8')) as PortReport;
      if (port.detected) console.log(`body: an automatic preset: ${JSON.stringify(port.detected)}`);
      else console.log(`body: the repository's preset "${port.car}"`);

      // Sound: the bank in sfx/, ported by its sample names
      const limiter = mod.num('engine.ini', 'ENGINE_DATA', 'LIMITER');
      const idle = mod.num('engine.ini', 'ENGINE_DATA', 'MINIMUM');
      const bank = existsSync(join(carDir, 'sfx')) ? readdirSync(join(carDir, 'sfx')).find((f) => /\.bank$/i.test(f) && !/^GUIDs/i.test(f)) : undefined;
      const audio = join(work, 'audio');
      let sound: { dir: string; limiterRpm: number } | { car: string } = { car: base };
      const ffmpeg = ffmpegPath();
      if (bank && ffmpeg && limiter > 0) {
        mkdirSync(audio, { recursive: true });
        try {
          runPython(
            'scripts/audio/port_ac_bank.py',
            ['--auto', join(carDir, 'sfx', bank), '--out', audio, '--limiter', String(limiter), '--idle', String(idle > 0 ? idle : 1000), '--boost', String(facts.turbo ? 1 : 0), '--source', `${name} (${folder}/sfx/${bank})`, '--ffmpeg', ffmpeg],
            { withPackages: ['numpy', 'scipy', 'fsb5'], requirements: null },
          );
          sound = { dir: audio, limiterRpm: limiter };
        } catch (err) {
          console.log(`sound: its bank couldn't be ported (${(err as Error).message}): it uses ${base}'s`);
        }
      } else console.log(`sound: ${!bank ? 'no sound bank in sfx/' : !ffmpeg ? 'no ffmpeg to encode it' : 'no limiter in engine.ini'}: it uses ${base}'s`);

      // Pictures: the car's from its first livery's preview (else its badge), each livery's from its own
      // The livery the model is painted in first (an automatic preset's export lists it first; a preset's, by name)
      const listing = [...(port.skins ?? [])].sort((a, b) => Number((b.folder ?? b.id) === port.skin) - Number((a.folder ?? a.id) === port.skin));
      const paintEntry = listing[0];
      const thumb = join(work, 'thumb.webp');
      const preview = previewOf(carDir, paintEntry ? (paintEntry.folder ?? paintEntry.id) : (port.skin ?? undefined));
      const hasThumb = (preview && (await thumbFrom(preview, thumb, 'cover'))) || (existsSync(join(carDir, 'ui', 'badge.png')) && (await thumbFrom(join(carDir, 'ui', 'badge.png'), thumb, 'contain')));
      const ids = skinIds(listing.map((s) => s.id));
      const skins: CarSkinSource[] = [];
      for (let i = 1; i < listing.length; i++) {
        const s = listing[i];
        // A livery that changes nothing the model shows is the model's paint again
        if (s.files && !s.files.length) continue;
        const dir = join(skinsOut, s.id);
        mkdirSync(dir, { recursive: true });
        const own = previewOf(carDir, s.folder ?? s.id);
        if (own) await thumbFrom(own, join(dir, 'thumb.webp'), 'cover');
        skins.push({ id: ids[i], name: (s.number ? `#${s.number} ` : '') + (s.name || s.folder || s.id), swatch: swatchOf(s.swatch), dir, ...(s.files ? { files: s.files } : {}), ...(s.variant ? { variant: s.variant } : {}) });
      }
      if (skins.length > 63) skins.length = 63;
      const paint = paintEntry
        ? { id: ids[0], name: (paintEntry.number ? `#${paintEntry.number} ` : '') + (paintEntry.name || paintEntry.folder || paintEntry.id), swatch: swatchOf(paintEntry.swatch) }
        : { id: 'factory', name: 'Factory', swatch: ['#808080', '#202020'] as ModSkin['swatch'] };

      const traction = DRIVE[facts.traction] ?? 'rear-wheel drive';
      const bhp = ui.specs.bhp ?? `${Math.round(facts.peakKw * 1.341)} bhp`;
      const out = packageCar({
        packageDir,
        info,
        car: {
          localId,
          title: name.slice(0, 80),
          sub: [ui.year, bhp, traction].filter(Boolean).join(' · ').slice(0, 120),
          badge: (ui.brand ?? name).slice(0, 16),
          classId: VEHICLE_MODELS[base].classId as ModCarClass,
          year: ui.year && ui.year >= 1890 && ui.year <= 2100 ? ui.year : new Date().getFullYear(),
          base,
          ...(physics ? { physicsPatch: physics.file.profile } : {}),
        },
        model: glb,
        thumb: hasThumb ? thumb : undefined,
        paint,
        skins,
        sound,
      });
      report(packageDir, out.checked);
      if (out.skipped.length) console.log(`      left out: ${out.skipped.join(', ')}`);
      console.log(`      ${out.contentId} in ${packageDir}: ${skins.length + 1} liveries, ${'dir' in sound ? 'its own sound' : `${sound.car}'s sound`}, ${physics ? `its physics on ${base}` : `${base}'s physics`}`);
      console.log(`      licence: ${licence.license} (${licence.reason})`);
      if (!licence.shareable) console.log(`      ${PERSONAL_USE_NOTE}. Keep the package to yourself unless ${credit.author} says otherwise.`);
      if (!out.checked.ok) throw new Error('the package fails the game\'s checks (above)');
    } finally {
      if (values['keep-build']) console.log(`      kept the working copy in ${work}`);
      else rmSync(work, { recursive: true, force: true });
    }
  },
};

export default importer;
