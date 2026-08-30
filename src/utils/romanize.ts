import { KaraokeLine, KaraokeSyllable } from '../types/karaoke';

/**
 * Romanize Korean lyrics, syllable by syllable.
 *
 * The point of doing this here rather than asking for a romaji lyric sheet is
 * that a Korean line is already cut into syllables and timed. One Hangul
 * syllable is one romaji unit, so a transliteration inherits the timings and
 * every per-word setting exactly, instead of having to be matched back onto
 * them and corrected by hand.
 *
 * Sound changes across syllable boundaries are what make the result readable —
 * 들리는 is "deullineun", not "deulrineun" — so they are applied here too,
 * within a word.
 *
 * The spelling follows the conventions K-pop lyric sheets actually use rather
 * than strict Revised Romanization, because that is what the words are going
 * to sit under: 시 is "shi", not "si", and ㅝ is "weo", not "wo".
 */

const SBASE = 0xac00;
const SCOUNT = 11172;

/** Onsets, indexed by the leading jamo. ㅇ is silent. */
const ONSET = [
  'g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h',
];

const VOWEL = [
  'a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'weo', 'we',
  'wi', 'yu', 'eu', 'ui', 'i',
];

/** Codas, indexed by the trailing jamo. 0 is no coda. */
const CODA = [
  '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'p', 'l', 'l', 'p', 'l', 'm', 'p', 'p',
  't', 't', 'ng', 't', 't', 'k', 't', 'p', 'h',
];

/**
 * The same codas as they sound once they slide onto a following vowel.
 *
 * Indexed by *trailing* jamo, which is a different alphabet from the leading
 * one — reading an onset out of the leading table with a trailing index is
 * exactly the kind of quiet mistake that turns 얼음 into "eoppeum".
 */
const CODA_AS_ONSET = [
  '', 'g', 'kk', '', 'n', '', '', 'd', 'r', '', '', '', '', '', '', '', 'm', 'b', '', 's', 'ss',
  '', 'j', 'ch', 'k', 't', 'p', '',
];

// Jamo indices worth naming, so the rules below read as rules.
const T_NONE = 0;
const T_L = 8; // ㄹ
const T_N = 4; // ㄴ
const T_NG = 21; // ㅇ
const T_M = 16; // ㅁ
const T_H = 27; // ㅎ
const T_D = 7; // ㄷ
const T_T = 25; // ㅌ

const L_N = 2; // ㄴ
const L_R = 5; // ㄹ
const L_M = 6; // ㅁ
const L_S = 9; // ㅅ
const L_SILENT = 11; // ㅇ
const L_H = 18; // ㅎ

/** Vowels that turn ㅅ into "sh": 시 is "shi", 셔 is "sheo". */
const SH_VOWELS = new Set([2, 3, 6, 7, 12, 16, 17, 20]);

/**
 * Compound codas, as (what stays, what can move to the next onset).
 *
 * When the next syllable starts with a vowel the second half slides over —
 * 앉아 is "anja" — and otherwise only the first half is pronounced. `keep` is a
 * trailing jamo; `move` is a leading one.
 */
const COMPOUND: Record<number, { keep: number; move: number }> = {
  3: { keep: 1, move: 9 }, // ㄳ = ㄱ + ㅅ
  5: { keep: 4, move: 12 }, // ㄵ = ㄴ + ㅈ
  6: { keep: 4, move: 18 }, // ㄶ = ㄴ + ㅎ
  9: { keep: 8, move: 0 }, // ㄺ = ㄹ + ㄱ
  10: { keep: 8, move: 6 }, // ㄻ = ㄹ + ㅁ
  11: { keep: 8, move: 7 }, // ㄼ = ㄹ + ㅂ
  12: { keep: 8, move: 9 }, // ㄽ = ㄹ + ㅅ
  13: { keep: 8, move: 16 }, // ㄾ = ㄹ + ㅌ
  14: { keep: 8, move: 17 }, // ㄿ = ㄹ + ㅍ
  15: { keep: 8, move: 18 }, // ㅀ = ㄹ + ㅎ
  18: { keep: 17, move: 9 }, // ㅄ = ㅂ + ㅅ
};

/** Codas that share a closing sound, which is what the rules below key on. */
const K_CODAS = new Set([1, 2, 9, 24]);
const T_CODAS = new Set([7, 19, 20, 22, 23, 25, 27]);
const P_CODAS = new Set([11, 14, 17, 18, 26]);

/** A ㅎ either side of these turns them into the aspirated pair. */
const ASPIRATED_ONSET: Record<number, string> = { 0: 'k', 3: 't', 12: 'ch', 9: 's' };
const ASPIRATED_CODA: Record<number, string> = { 1: 'k', 7: 't', 17: 'p', 22: 'ch' };

/**
 * Words that are spelled, not romanized.
 *
 * A name has one right spelling and it is rarely the one the rules produce:
 * 이즈나 is izna, never "ijeuna". Each entry gives the romaji for each of the
 * word's syllables in turn, so the timings still line up one to one.
 */
export const NAME_SPELLINGS: { hangul: string; parts: string[] }[] = [
  { hangul: '이즈나', parts: ['i', 'z', 'na'] },
];

interface Syl {
  onset: number;
  vowel: number;
  coda: number;
}

function decompose(code: number): Syl | null {
  const index = code - SBASE;
  if (index < 0 || index >= SCOUNT) return null;
  return {
    onset: Math.floor(index / 588),
    vowel: Math.floor((index % 588) / 28),
    coda: index % 28,
  };
}

export function isHangulSyllable(ch: string): boolean {
  return decompose(ch.charCodeAt(0)) !== null;
}

/** The onset as written, with the "sh" spelling applied where it belongs. */
function onsetFor(syl: Syl): string {
  if (syl.onset === L_S && SH_VOWELS.has(syl.vowel)) return 'sh';
  return ONSET[syl.onset];
}

/**
 * The onset and vowel written together.
 *
 * "sh" already carries the glide, so the vowel drops its own: 셔 is "sheo",
 * not "shyeo".
 */
function head(onset: string, vowel: number): string {
  const written = VOWEL[vowel];
  return onset.endsWith('sh') ? onset + written.replace(/^y/, '') : onset + written;
}

/**
 * Romanize one syllable, given the syllable that follows it in the same word.
 *
 * Returns the text for this syllable and, when a consonant slides forward, the
 * onset the next one must use instead of its own.
 */
function romanizeSyllable(
  syl: Syl,
  next: Syl | null,
  forcedOnset: string | null
): { text: string; nextOnset: string | null } {
  const onset = forcedOnset ?? onsetFor(syl);
  const start = head(onset, syl.vowel);

  if (syl.coda === T_NONE || next === null) {
    return { text: start + CODA[syl.coda], nextOnset: null };
  }

  const compound = COMPOUND[syl.coda];
  const nextOnset = next.onset;

  // A following vowel pulls the coda across: 아름 + 다움, 널 + 아프게.
  if (nextOnset === L_SILENT) {
    if (syl.coda === T_NG) return { text: start + 'ng', nextOnset: null };
    if (syl.coda === T_H) return { text: start, nextOnset: '' }; // 좋아 → joa
    if (compound) {
      // ㄶ and ㅀ lose their ㅎ rather than carrying it over: 많아 → mana.
      if (compound.move === L_H) {
        return { text: start, nextOnset: ONSET[compound.keep === T_N ? L_N : L_R] };
      }
      return { text: start + CODA[compound.keep], nextOnset: ONSET[compound.move] };
    }
    // 굳이 → guji, 같이 → gachi: a ㄷ or ㅌ before "i" softens.
    if (next.vowel === 20) {
      if (syl.coda === T_D) return { text: start, nextOnset: 'j' };
      if (syl.coda === T_T) return { text: start, nextOnset: 'ch' };
    }
    // ㅅ carried onto an "i" is spelled sh too: 옷이 → oshi.
    if (CODA_AS_ONSET[syl.coda] === 's' && SH_VOWELS.has(next.vowel)) {
      return { text: start, nextOnset: 'sh' };
    }
    return { text: start, nextOnset: CODA_AS_ONSET[syl.coda] };
  }

  // The coda that is actually pronounced, once a compound has dropped half.
  const spoken = compound ? compound.keep : syl.coda;

  // ㅎ either side aspirates: 좋다 → jota, 축하 → chuka.
  if ((syl.coda === T_H || compound?.move === L_H) && ASPIRATED_ONSET[nextOnset] !== undefined) {
    const kept = compound ? CODA[compound.keep] : '';
    return { text: start + kept, nextOnset: ASPIRATED_ONSET[nextOnset] };
  }
  if (nextOnset === L_H && ASPIRATED_CODA[spoken] !== undefined) {
    return { text: start, nextOnset: ASPIRATED_CODA[spoken] };
  }

  // ㄹ beside ㄹ or ㄴ doubles: 들리는 deullineun, 설날 seollal, 돌려 dollyeo.
  if (spoken === T_L && nextOnset === L_R) return { text: start + 'l', nextOnset: 'l' };
  if (spoken === T_N && nextOnset === L_R) return { text: start + 'l', nextOnset: 'l' };
  if (spoken === T_L && nextOnset === L_N) return { text: start + 'l', nextOnset: 'l' };

  // A stop before a nasal becomes one: 국물 gungmul, 믿는 minneun.
  if (nextOnset === L_N || nextOnset === L_M) {
    if (K_CODAS.has(spoken)) return { text: start + 'ng', nextOnset: null };
    if (T_CODAS.has(spoken)) return { text: start + 'n', nextOnset: null };
    if (P_CODAS.has(spoken)) return { text: start + 'm', nextOnset: null };
  }

  // ㄹ after anything but ㄹ or ㄴ turns into ㄴ, nasalizing a stop with it:
  // 종로 jongno, 독립 dongnip.
  if (nextOnset === L_R) {
    if (K_CODAS.has(spoken)) return { text: start + 'ng', nextOnset: 'n' };
    if (T_CODAS.has(spoken)) return { text: start + 'n', nextOnset: 'n' };
    if (P_CODAS.has(spoken)) return { text: start + 'm', nextOnset: 'n' };
    if (spoken === T_M || spoken === T_NG) {
      return { text: start + CODA[spoken], nextOnset: 'n' };
    }
  }

  return { text: start + CODA[spoken], nextOnset: null };
}

/**
 * Romanize each unit of a line, keeping the unit boundaries.
 *
 * Sound changes need the next syllable, which may live in the next unit, so the
 * line is romanized as a whole and then cut back up. They stop at anything that
 * is not Hangul — a space, a bracket — because that is where one word ends.
 */
export function romanizeUnits(units: string[]): string[] {
  // Flatten to characters, remembering which unit each came from.
  const chars: { ch: string; unit: number }[] = [];
  units.forEach((text, unit) => {
    for (const ch of text) chars.push({ ch, unit });
  });

  const out = units.map(() => '');
  let forcedOnset: string | null = null;

  for (let i = 0; i < chars.length; i++) {
    const { ch, unit } = chars[i];
    const syl = decompose(ch.charCodeAt(0));

    if (!syl) {
      // A consonant waiting to slide forward has nowhere to go now.
      forcedOnset = null;
      out[unit] += ch;
      continue;
    }

    // A name is spelled, not worked out. Only at the start of a word, so a
    // chance match inside a longer word cannot hijack it.
    const spelled = spellingAt(chars, i);
    if (spelled) {
      for (let k = i; k <= spelled.last; k++) {
        const part = spelled.parts.get(k);
        out[chars[k].unit] += part ?? chars[k].ch;
      }
      i = spelled.last;
      forcedOnset = null;
      continue;
    }

    const following = chars[i + 1];
    const next = following ? decompose(following.ch.charCodeAt(0)) : null;

    const { text, nextOnset } = romanizeSyllable(syl, next, forcedOnset);
    out[unit] += text;
    forcedOnset = nextOnset;
  }

  return out;
}

/**
 * A known name starting at `i`, if the characters there spell one.
 *
 * Separators inside the name are stepped over and left where they are, so a
 * chant that spells the name out — 이.즈.나.야 — is still recognised as the
 * name. Returns which character each part belongs to, and where the name ends.
 */
function spellingAt(
  chars: { ch: string; unit: number }[],
  i: number
): { parts: Map<number, string>; last: number } | null {
  const startsWord = i === 0 || !isHangulSyllable(chars[i - 1].ch);
  if (!startsWord) return null;

  for (const entry of NAME_SPELLINGS) {
    const letters = [...entry.hangul];
    if (letters.length !== entry.parts.length) continue;

    const parts = new Map<number, string>();
    let at = i;
    let matched = 0;
    while (matched < letters.length && at < chars.length) {
      const ch = chars[at].ch;
      if (ch === letters[matched]) {
        parts.set(at, entry.parts[matched]);
        matched += 1;
        at += 1;
      } else if (!isHangulSyllable(ch) && SEPARATORS.test(ch) && matched > 0) {
        at += 1; // A dot or dash between the letters, kept as it is.
      } else {
        break;
      }
    }
    if (matched === letters.length) return { parts, last: at - 1 };
  }
  return null;
}

/** Characters that may sit between a name's syllables without breaking it. */
const SEPARATORS = /[.\-·・ㆍ]/;

/** Romanize a run of text, leaving anything that is not Hangul alone. */
export function romanizeText(text: string): string {
  return romanizeUnits([text])[0];
}

/**
 * Build a romaji line from a Korean one.
 *
 * Everything but the text is carried across unchanged — timings, colours,
 * opacity, strikes, fades, the block it belongs to and where it sits — because
 * the romaji says the same thing at the same moment and should look the same
 * doing it.
 */
export function romanizeLine(line: KaraokeLine): KaraokeLine {
  const romanized = romanizeUnits(line.syllables.map((s) => s.text));
  const syllables: KaraokeSyllable[] = line.syllables.map((syl, i) => ({
    ...syl,
    text: romanized[i],
  }));
  return { ...line, id: `${line.id}-ro`, syllables };
}

/** The whole track, line for line. */
export function romanizeLines(lines: KaraokeLine[]): KaraokeLine[] {
  return lines.map(romanizeLine);
}

/** True when a line has Hangul in it, and so has something to transliterate. */
export function hasHangul(line: KaraokeLine): boolean {
  return line.syllables.some((s) => [...s.text].some(isHangulSyllable));
}
