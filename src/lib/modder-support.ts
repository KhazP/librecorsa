/**
 * The modders' own pages for support (Patreon, PayPal, Ko-fi…), by their name as the credits write it. Each Source
 * panel of their work puts it first, before the work itself: the people whose circuits and cars the game is built
 * on get the first word.
 *
 * Add one only from the modder's own page or their word, never a guess from a name that looks alike.
 */
import { text as t } from "@/lib/text";

export interface SupportLink {
  url: string;
  /** Where the link goes: "Patreon", "PayPal", "Ko-fi" */
  via: string;
}

export const MODDER_SUPPORT: Readonly<Record<string, SupportLink>> = {
  "Mitja Bonca": { url: "https://www.paypal.com/paypalme/mbonca", via: "PayPal" },
  gunnar333: { url: "https://www.paypal.me/GunnarFrei", via: "PayPal" },
  LilSki: { url: "https://www.paypal.com/donate/?cmd=_s-xclick&hosted_button_id=4CU3LGABY58L8", via: "PayPal" },
  "Ddiaz Design": { url: "https://paypal.me/sergiodd", via: "PayPal" },
  gregsediting: { url: "https://www.patreon.com/cw/gregsediting", via: "Patreon" },
  // From their own post on OverTake
  munyuturbo: { url: "https://www.patreon.com/cw/MTRacing651", via: "Patreon" },
  // The tip page his own car descriptions ask for ("feel free to buy me a beer")
  Pfalzdriver: { url: "https://streamlabs.com/pfalzdriver", via: "Streamlabs" },
  "Purple Sector": { url: "https://www.patreon.com/cw/PurpleSector", via: "Patreon" },
  Nukedrop: { url: "https://www.patreon.com/cw/nukedrop/", via: "Patreon" },
  dazzyb2k3: { url: "https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=XT8V5ELVZTGGQ", via: "PayPal" },
  // The Chaparral 2D team's donations go to Pasta, their finances (NPanic's word)
  NPanic: { url: "https://www.paypal.com/paypalme/williampasta", via: "PayPal" },
  sagatron918: { url: "https://www.paypal.me/SagarNaikB", via: "PayPal" },
};

/** The support button's words: a donation on PayPal, support on a membership site */
export const supportLabel = (s: SupportLink): string =>
  s.via === "PayPal" ? t("game.support.donatePayPal") : t("game.support.supportOn", { site: s.via });

/** A modder's support page, if they have one on file */
export const supportOf = (author: string | undefined): SupportLink | undefined => (author ? MODDER_SUPPORT[author] : undefined);
