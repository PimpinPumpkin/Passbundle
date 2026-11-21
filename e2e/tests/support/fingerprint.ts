// What a fingerprint phrase looks like, as the web vault, the extension, the
// command-line tool, and our apps' core write it: five words of EFF's long
// word list joined with hyphens (upstream's `hashPhrase`; the core's
// `fingerprint_phrase`). Four of the list's words have a hyphen of their own,
// so a phrase with one of them has more than five parts: about one phrase in
// 390, such as "heritage-atom-kilometer-scandal-drop-down", which a check for
// five plain words refused. Both devices show the same phrase either way
// (DESIGN.md, "Approving a sign-in from another device", "The fingerprint
// phrase").
const word = "(?:drop-down|felt-tip|t-shirt|yo-yo|[a-z]+)";

/** A fingerprint phrase, to find within a longer text. */
export const fingerprintPhraseSource = `${word}(?:-${word}){4}`;

/** A fingerprint phrase, the whole text. */
export const fingerprintPhrase = new RegExp(`^${fingerprintPhraseSource}$`);
