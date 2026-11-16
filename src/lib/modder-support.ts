/**
 * The modders' own pages for support (Patreon, PayPal, Ko-fi…), by their name as the credits write it. Each Source
 * panel of their work puts it first, before the work itself: the people whose circuits and cars the game is built
 * on get the first word.
 *
 * Add one only from the modder's own page or their word, never a guess from a name that looks alike.
 */

export interface SupportLink {
  url: string;
  /** Where the link goes: "Patreon", "PayPal", "Ko-fi" */
  via: string;
}

export const MODDER_SUPPORT: Readonly<Record<string, SupportLink>> = {
  gregsediting: { url: "https://www.patreon.com/gregsediting", via: "Patreon" },
  "Purple Sector": { url: "https://www.patreon.com/cw/PurpleSector", via: "Patreon" },
};

/** A modder's support page, if they have one on file */
export const supportOf = (author: string | undefined): SupportLink | undefined => (author ? MODDER_SUPPORT[author] : undefined);
