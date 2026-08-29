import type { LightingStyle, SubjectKind, TimeOfDay } from "@/lib/spec/vocab";

/**
 * Keyword lexicon for the heuristic director.
 *
 * Bilingual (English + Turkish) because the product brief's own worked example
 * is a Turkish prompt. Adding a language means adding terms here — no engine
 * changes required.
 */

export interface SubjectTerm {
  /** Terms that identify this subject. Matched as whole words where possible. */
  terms: string[];
  kind: SubjectKind;
  /** Stable key used across the spec. */
  key: string;
  /** Canonical English description injected into the brief. */
  description: string;
  identityNotes?: string[];
}

export const SUBJECT_TERMS: readonly SubjectTerm[] = [
  {
    terms: ["iced latte", "ice latte", "buzlu latte", "cold brew", "iced coffee", "buzlu kahve", "soğuk kahve"],
    kind: "beverage",
    key: "iced_latte",
    description: "a tall clear glass of iced latte with visible ice and a layered milk-and-espresso gradient",
    identityNotes: ["layered espresso over milk", "clear glass vessel", "visible ice cubes", "beaded condensation"],
  },
  {
    terms: ["latte", "cappuccino", "flat white", "espresso", "americano", "coffee", "kahve", "filtre kahve"],
    kind: "beverage",
    key: "coffee",
    description: "a freshly made coffee in a ceramic cup with visible crema",
    identityNotes: ["crema surface", "ceramic cup and saucer"],
  },
  {
    terms: ["tea", "matcha", "çay", "bitki çayı"],
    kind: "beverage",
    key: "tea",
    description: "a hot tea served in a glass, steam rising from the surface",
  },
  {
    terms: ["cocktail", "drink", "smoothie", "juice", "içecek", "kokteyl"],
    kind: "beverage",
    key: "drink",
    description: "a cold drink in a glass with condensation on the outside",
  },
  {
    terms: ["cake", "croissant", "pastry", "dessert", "burger", "pizza", "pasta", "tatlı", "kek", "yemek", "food"],
    kind: "food",
    key: "food_item",
    description: "a freshly prepared food item plated with natural, appetising imperfection",
  },
  {
    terms: ["bottle", "can", "jar", "tube", "package", "packaging", "box", "şişe", "kutu", "ambalaj"],
    kind: "product",
    key: "packaged_product",
    description: "the branded product container standing upright on the surface",
    identityNotes: ["label placement", "container silhouette"],
  },
  {
    terms: ["sneaker", "shoe", "watch", "bag", "phone", "perfume", "cosmetic", "serum", "ayakkabı", "saat", "çanta", "parfüm"],
    kind: "product",
    key: "hero_product",
    description: "the hero product presented as the focus of the frame",
  },
  {
    terms: ["woman", "girl", "man", "guy", "person", "model", "influencer", "creator", "kız", "kadın", "adam", "erkek", "kişi"],
    kind: "human",
    key: "person",
    description: "a young adult, dressed casually and behaving naturally rather than posing",
    identityNotes: ["same face throughout", "same clothing throughout"],
  },
  {
    terms: ["hand", "hands", "fingers", "el", "eller", "parmak"],
    kind: "hands",
    key: "hands",
    description: "a pair of hands entering frame naturally to interact with the subject",
  },
  {
    terms: ["logo", "brand mark", "label", "amblem", "marka"],
    kind: "text_or_logo",
    key: "brand_mark",
    description: "the brand mark, printed crisply and legibly on the product",
  },
  {
    terms: ["cat", "dog", "kedi", "köpek"],
    kind: "animal",
    key: "animal",
    description: "the animal moving naturally in the space",
  },
  {
    terms: ["car", "bike", "motorcycle", "araba", "motosiklet"],
    kind: "vehicle",
    key: "vehicle",
    description: "the vehicle parked in the scene, paintwork catching the light",
  },
];

export interface EnvironmentTerm {
  terms: string[];
  setting: string;
  lighting: LightingStyle;
  key: string;
}

export const ENVIRONMENT_TERMS: readonly EnvironmentTerm[] = [
  {
    terms: ["cafe", "café", "coffee shop", "coffeeshop", "kafe", "kahveci"],
    setting: "a modern speciality café with wooden tables, warm pendant lights and a soft-focus interior behind",
    lighting: "practical_ambient",
    key: "cafe",
  },
  {
    terms: ["kitchen", "mutfak"],
    setting: "a bright modern kitchen with a stone worktop and daylight from a side window",
    lighting: "natural_window",
    key: "kitchen",
  },
  {
    terms: ["restaurant", "bar", "bistro", "restoran"],
    setting: "an intimate restaurant interior with low warm lighting and blurred background diners",
    lighting: "practical_ambient",
    key: "restaurant",
  },
  {
    terms: ["street", "city", "outdoor", "outside", "sokak", "şehir", "dışarıda"],
    setting: "an urban street with shallow-focus city life behind the subject",
    lighting: "mixed_night_city",
    key: "street",
  },
  {
    terms: ["studio", "seamless", "stüdyo"],
    setting: "a clean studio set with a seamless backdrop and controlled light",
    lighting: "studio_controlled",
    key: "studio",
  },
  {
    terms: ["home", "living room", "bedroom", "apartment", "ev", "salon", "yatak odası"],
    setting: "a lived-in modern home interior with soft daylight and personal objects in the background",
    lighting: "natural_window",
    key: "home",
  },
  {
    terms: ["office", "desk", "ofis", "masa başı"],
    setting: "a calm modern workspace with a wooden desk and window light",
    lighting: "natural_window",
    key: "office",
  },
  {
    terms: ["beach", "pool", "sahil", "plaj", "havuz"],
    setting: "an open coastal setting with bright natural light and a soft-focus horizon",
    lighting: "hard_directional",
    key: "beach",
  },
];

export const TIME_TERMS: ReadonlyArray<{ terms: string[]; time: TimeOfDay }> = [
  { terms: ["night", "nighttime", "at night", "evening", "gece", "akşam"], time: "night" },
  { terms: ["morning", "sunrise", "breakfast", "sabah", "kahvaltı"], time: "morning" },
  { terms: ["golden hour", "sunset", "gün batımı", "altın saat"], time: "golden_hour" },
  { terms: ["midday", "noon", "öğlen"], time: "midday" },
  { terms: ["dawn", "şafak"], time: "dawn" },
  { terms: ["dusk", "alacakaranlık"], time: "dusk" },
];

export const MOOD_TERMS: ReadonlyArray<{ terms: string[]; mood: string }> = [
  { terms: ["cozy", "warm", "sıcak", "samimi"], mood: "cozy" },
  { terms: ["energetic", "fast", "dynamic", "enerjik", "hızlı"], mood: "energetic" },
  { terms: ["calm", "relax", "slow", "sakin", "huzurlu"], mood: "calm" },
  { terms: ["premium", "luxury", "elegant", "lüks", "şık"], mood: "premium" },
  { terms: ["fun", "playful", "eğlenceli"], mood: "playful" },
  { terms: ["refreshing", "cold", "ferahlatıcı", "serin"], mood: "refreshing" },
  { terms: ["nostalgic", "retro", "nostaljik"], mood: "nostalgic" },
  { terms: ["intimate", "close", "yakın"], mood: "intimate" },
];

/** Turkish stopwords/diacritics used for a crude language guess. */
const TURKISH_MARKERS = [
  "için",
  "gibi",
  "olsun",
  "bir ",
  "ile",
  "çek",
  "video",
  "kahve",
  "masada",
  "gece",
  "ğ",
  "ş",
  "ı",
  "ö",
  "ü",
  "ç",
];

/** Very small language detector — enough to record provenance in the spec. */
export function detectLanguage(prompt: string): string {
  const text = prompt.toLowerCase();
  const hits = TURKISH_MARKERS.filter((m) => text.includes(m)).length;
  return hits >= 3 ? "tr" : "en";
}

/** Parses "15 second", "15s", "15 saniye", "yarım dakika" style durations. */
export function detectDurationSec(prompt: string): number | null {
  const text = prompt.toLowerCase();
  const patterns: RegExp[] = [
    /(\d+(?:[.,]\d+)?)\s*(?:seconds?|secs?|s\b|saniye|sn\b)/,
    /(\d+(?:[.,]\d+)?)\s*(?:minutes?|mins?|dakika|dk\b)/,
  ];
  for (const [i, re] of patterns.entries()) {
    const m = text.match(re);
    if (m) {
      const value = Number(m[1].replace(",", "."));
      if (!Number.isFinite(value)) continue;
      const sec = i === 1 ? value * 60 : value;
      if (sec >= 2 && sec <= 60) return sec;
    }
  }
  return null;
}

/**
 * Matches a term in the prompt.
 *
 * Whole-word matching is the base rule, but that alone fails badly on
 * agglutinative languages: Turkish writes "in the café" as "kafede", so a
 * strict boundary match on "kafe" finds nothing. So a single-word term of four
 * or more characters also matches as a *stem* — the word may carry up to four
 * trailing letters. That covers "kafede", "masada", "telefonuyla" without
 * matching short accidental prefixes like "car" inside "carpet".
 */
export function containsTerm(haystack: string, term: string): boolean {
  if (term.includes(" ")) return haystack.includes(term);

  const escaped = escapeRegExp(term);
  const whole = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u");
  if (whole.test(haystack)) return true;

  if (term.length < 4) return false;
  const stem = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}\\p{L}{1,4}($|[^\\p{L}\\p{N}])`, "u");
  return stem.test(haystack);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
