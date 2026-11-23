/**
 * The soundtrack: public-domain classical recordings (CC0 or US government works), one MP3 each under /music/,
 * loudness-matched to -16 LUFS (each one's remainder in gainDb). Each track belongs to one pool, and the music director
 * picks the pool from where the player is (music-director.ts): the menus, a race, or the results and replays.
 */
import { text as tx } from "@/lib/text";
import { withBasePath } from "@/lib/base-path";

export type MusicPool = "menu" | "race" | "results";

export interface MusicTrack {
  /** The file's name under /music/ and the id the settings keep */
  id: string;
  title: string;
  composer: string;
  performer: string;
  pool: MusicPool;
  /** The file's level against the -16 LUFS target: what the player adds to match the others (scripts/music-cues.ts) */
  gainDb: number;
  /**
   * Where a play from the top starts (s): past the head silence, or for a race track with a quiet opening, at its first
   * loud section, so the music arrives at the lights out instead of under the engine
   */
  startS?: number;
  /** Where the music ends before a silent tail (s): the next track starts there; the file's end without one */
  endS?: number;
  licence: "CC0" | "Public domain";
  /** Where the recording comes from */
  source: string;
  /** One of these opens the menus the first time they play */
  opener?: boolean;
}

const COMMONS = "Wikimedia Commons";
const MUSOPEN = "Musopen Kickstarter recordings (Internet Archive)";

export const MUSIC_TRACKS: readonly MusicTrack[] = [
  // The menus: one pool for every menu screen, so a track plays on across them
  { id: "air", title: "Air on the G String", composer: "J.S. Bach", performer: "US Air Force Strings", pool: "menu", gainDb: -0.7, startS: 4.24, endS: 178.8, licence: "Public domain", source: COMMONS, opener: true },
  { id: "clair-de-lune", title: "Clair de Lune", composer: "Claude Debussy", performer: "US Air Force Band of Flight, Wright Brass", pool: "menu", gainDb: -0.1, startS: 0.6, endS: 235.4, licence: "Public domain", source: COMMONS, opener: true },
  { id: "gymnopedie-1", title: "Gymnopédie No. 1", composer: "Erik Satie", performer: "Teknopazzo", pool: "menu", gainDb: -0.2, startS: 0.15, endS: 204.5, licence: "CC0", source: COMMONS },
  { id: "cello-suite-1-prelude", title: "Cello Suite No. 1: Prélude", composer: "J.S. Bach", performer: "Chris (Fopseh)", pool: "menu", gainDb: -0.4, startS: 0.22, endS: 154.6, licence: "CC0", source: COMMONS },
  { id: "nocturne-op9-2", title: "Nocturne in E-flat major, Op. 9 No. 2", composer: "Frédéric Chopin", performer: "Peter Johnston", pool: "menu", gainDb: 0.0, licence: "CC0", source: COMMONS },
  { id: "pathetique-rondo", title: "Sonata \"Pathétique\": III. Rondo", composer: "Ludwig van Beethoven", performer: "Paul Pitman", pool: "menu", gainDb: 0.2, startS: 0.04, endS: 275.1, licence: "CC0", source: COMMONS },
  { id: "grieg-morning", title: "Peer Gynt: Morning Mood", composer: "Edvard Grieg", performer: "Czech National Symphony Orchestra", pool: "menu", gainDb: 0.5, startS: 0.08, endS: 227.6, licence: "CC0", source: MUSOPEN },
  { id: "goldberg-aria", title: "Goldberg Variations: Aria", composer: "J.S. Bach", performer: "Shelley Katz", pool: "menu", gainDb: -0.8, startS: 4.09, licence: "CC0", source: MUSOPEN },
  { id: "suk-meditation", title: "Meditation on an Old Czech Chorale", composer: "Josef Suk", performer: "Musopen String Quartet", pool: "menu", gainDb: -1.0, startS: 0.37, endS: 404.7, licence: "CC0", source: MUSOPEN },
  { id: "dvorak-american-lento", title: "\"American\" Quartet: II. Lento", composer: "Antonín Dvořák", performer: "Musopen String Quartet", pool: "menu", gainDb: 0.3, startS: 0.28, licence: "CC0", source: MUSOPEN },
  { id: "haydn-lark-adagio", title: "\"Lark\" Quartet: II. Adagio cantabile", composer: "Joseph Haydn", performer: "Musopen String Quartet", pool: "menu", gainDb: 0.7, startS: 0.2, endS: 290.4, licence: "CC0", source: MUSOPEN },
  { id: "schubert-d664-andante", title: "Sonata in A major, D. 664: II. Andante", composer: "Franz Schubert", performer: "Paul Pitman", pool: "menu", gainDb: 0.4, startS: 2.0, endS: 290.7, licence: "CC0", source: MUSOPEN },
  { id: "hebrides-overture", title: "The Hebrides (Fingal's Cave)", composer: "Felix Mendelssohn", performer: "Czech National Symphony Orchestra", pool: "menu", gainDb: 0.8, startS: 0.41, licence: "CC0", source: MUSOPEN },

  // Racing: from the lights out (or the first metres of a lap) to the flag. The Saltarello, the Magic Flute and Egmont
  // open quietly (their first 20 s sit 4-10 LU under the whole): they start at their first loud section
  { id: "william-tell", title: "William Tell Overture: Finale", composer: "Gioachino Rossini", performer: "US Marine Band", pool: "race", gainDb: -0.8, licence: "Public domain", source: COMMONS },
  { id: "toreador", title: "Carmen: Toreador", composer: "Georges Bizet", performer: "Musopen", pool: "race", gainDb: 0.7, startS: 0.07, endS: 270.4, licence: "CC0", source: COMMONS },
  { id: "hall-of-the-mountain-king", title: "In the Hall of the Mountain King", composer: "Edvard Grieg", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: -2.0, startS: 0.17, endS: 151.9, licence: "CC0", source: MUSOPEN },
  { id: "italian-saltarello", title: "\"Italian\" Symphony: IV. Saltarello", composer: "Felix Mendelssohn", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: 0.6, startS: 28.3, endS: 366.2, licence: "CC0", source: MUSOPEN },
  { id: "mozart-40-allegro", title: "Symphony No. 40: I. Molto allegro", composer: "W.A. Mozart", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: 0.1, startS: 0.23, endS: 357.9, licence: "CC0", source: MUSOPEN },
  { id: "figaro-overture", title: "The Marriage of Figaro: Overture", composer: "W.A. Mozart", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: -0.1, startS: 0.08, endS: 239.3, licence: "CC0", source: MUSOPEN },
  { id: "magic-flute-overture", title: "The Magic Flute: Overture", composer: "W.A. Mozart", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: 0.4, startS: 90.4, licence: "CC0", source: MUSOPEN },
  { id: "brahms-4-giocoso", title: "Symphony No. 4: III. Allegro giocoso", composer: "Johannes Brahms", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: 0.2, startS: 0.15, endS: 378.5, licence: "CC0", source: MUSOPEN },
  { id: "tchaikovsky-6-march", title: "\"Pathétique\" Symphony: III. Allegro molto vivace", composer: "Pyotr Ilyich Tchaikovsky", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: -1.2, startS: 0.32, endS: 592.6, licence: "CC0", source: MUSOPEN },
  { id: "egmont-overture", title: "Egmont Overture", composer: "Ludwig van Beethoven", performer: "Czech National Symphony Orchestra", pool: "race", gainDb: -0.2, startS: 150.1, endS: 540.3, licence: "CC0", source: MUSOPEN },

  // The flag, the cool-down lap, the podium, the results and the replays
  { id: "canon-in-d", title: "Canon in D", composer: "Johann Pachelbel", performer: "US Air Force Strolling Strings", pool: "results", gainDb: -0.4, startS: 0.45, endS: 224.2, licence: "Public domain", source: COMMONS },
  { id: "italian-allegro", title: "\"Italian\" Symphony: I. Allegro vivace", composer: "Felix Mendelssohn", performer: "Czech National Symphony Orchestra", pool: "results", gainDb: -0.1, startS: 0.17, endS: 461.9, licence: "CC0", source: MUSOPEN },
  { id: "brahms-2-finale", title: "Symphony No. 2: IV. Allegro con spirito", composer: "Johannes Brahms", performer: "Czech National Symphony Orchestra", pool: "results", gainDb: -0.3, startS: 0.23, endS: 583.8, licence: "CC0", source: MUSOPEN },
  { id: "haydn-lark-allegro", title: "\"Lark\" Quartet: I. Allegro moderato", composer: "Joseph Haydn", performer: "Musopen String Quartet", pool: "results", gainDb: 0.1, startS: 0.13, endS: 370.9, licence: "CC0", source: MUSOPEN },
  { id: "dvorak-american-finale", title: "\"American\" Quartet: IV. Finale", composer: "Antonín Dvořák", performer: "Musopen String Quartet", pool: "results", gainDb: -0.5, startS: 0.13, endS: 350.4, licence: "CC0", source: MUSOPEN },
];

export const MUSIC_TRACK_IDS: ReadonlySet<string> = new Set(MUSIC_TRACKS.map((t) => t.id));

export const musicTrack = (id: string): MusicTrack | undefined => MUSIC_TRACKS.find((t) => t.id === id);

export const musicUrl = (track: MusicTrack): string => withBasePath(`/music/${track.id}.mp3`);

export const POOL_LABEL: Record<MusicPool, string> = {
  get menu() { return tx("game.music.poolMenu"); },
  get race() { return tx("game.music.poolRace"); },
  get results() { return tx("game.music.poolResults"); },
};
