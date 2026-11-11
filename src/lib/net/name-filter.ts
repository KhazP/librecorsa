/**
 * Names a driver can't race under on the online boards: slurs and profanity (English and Turkish), and names that
 * pass for the game's own. The game checks before it uploads a lap or changes a name; the board (cloudflare/api, which
 * imports this file) checks again, and its check is the one that counts.
 *
 * A name is read the way a person would read it: lower case, accents and Turkish letters folded (ş → s, ı → i), digits
 * and symbols taken for the letters they stand in for (0 → o, 1 → i, @ → a, $ → s), separators ignored, and any letter
 * allowed to repeat. Unambiguous words are refused anywhere in the name; short or ambiguous ones only as a word of
 * their own, so names like Cockburn, Dickens, Hancock or Scunthorpe stay allowed.
 */

/** Refused anywhere in the name, separators and repeats included ("F.u.u.c.k", "sh1tty") */
const ANYWHERE = [
  // English
  "fuck",
  "shit",
  "bitch",
  "nigger",
  "nigga",
  "faggot",
  "whore",
  "wank",
  "dildo",
  "pussy",
  "asshole",
  "retard",
  "hitler",
  "porn",
  // Turkish
  "orospu",
  "siktir",
  "sikeyim",
  "sikerim",
  "siktim",
  "yarrak",
  "amcik",
  "aminakoy",
  "pezevenk",
  // Passing for the game's own
  "librecorsa",
];

/** Refused only as a word of their own, with an optional plural s ("Dick" and "Dicks", not "Dickens") */
const AS_WORD = [
  // English
  "ass",
  "cock",
  "dick",
  "cunt",
  "cum",
  "tit",
  "twat",
  "slut",
  "rape",
  "rapist",
  "nazi",
  "spic",
  "chink",
  "fag",
  "piss",
  "jizz",
  "anal",
  // Turkish
  "amk",
  "sik",
  "ibne",
  "kahpe",
  "gavat",
  "yarak",
  // Passing for the game's staff
  "admin",
  "administrator",
  "moderator",
  "official",
];

/** Digits and symbols read as the letters they stand in for */
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", $: "s", "!": "i", "|": "i", "+": "t" };

/** "fuck" → /f+u+c+k+/: each letter may repeat */
const stretched = (word: string) => word.split("").map((c) => `${c}+`).join("");
const ANYWHERE_RE = new RegExp(ANYWHERE.map(stretched).join("|"));
const AS_WORD_RE = new RegExp(`^(?:${AS_WORD.map(stretched).join("|")})s*$`);

/** Lower case, accents and Turkish letters folded, lookalikes read as letters; everything else becomes a space */
function readable(name: string): string {
  return name
    .replace(/[İI]/g, "i")
    .toLowerCase()
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[0-9@$!|+]/g, (c) => LOOKALIKE[c] ?? c)
    .replace(/[^a-z]+/g, " ")
    .trim();
}

/** Null when a driver may race under `name` on the online boards, else what to tell them */
export function nameProblem(name: string): string | null {
  const text = readable(name);
  const words = text.split(" ").filter(Boolean);
  if (ANYWHERE_RE.test(text.replace(/ /g, "")) || words.some((w) => AS_WORD_RE.test(w))) return "Pick another name";
  return null;
}
