import { Converter } from "opencc-js/t2cn";

/**
 * Traditional → Simplified, character level.
 *
 * Whisper transcribes Mandarin into Traditional characters by default, which is
 * wrong for this audience. The ASR prompt is written in Simplified to bias the
 * model, but prompting alone is not reliable, so every stored string is also
 * converted deterministically here.
 *
 * Character level is deliberate: `tw2sp` would also rewrite regional vocabulary
 * (網路 → 网络, 軟體 → 软件), which would put words in a speaker's mouth. If
 * someone actually says 網路, it should come back as 网路, not 网络.
 */
const convert = Converter({ from: "t", to: "cn" });

export function toSimplified(value: string): string {
  if (!value) return value;
  return convert(value);
}

/** Recursively convert every string in a JSON-shaped value. */
export function deepSimplify<T>(value: T): T {
  if (typeof value === "string") return toSimplified(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => deepSimplify(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepSimplify(item);
    }
    return out as unknown as T;
  }
  return value;
}

/** Whether conversion is switched on for this environment. */
export function simplifyEnabled(setting: string | undefined): boolean {
  return (setting ?? "simplified").toLowerCase() !== "off";
}
