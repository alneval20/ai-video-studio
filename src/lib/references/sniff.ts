/**
 * Content sniffing for uploads.
 *
 * The browser-supplied `Content-Type` on a multipart part is attacker-supplied
 * and must not be trusted: it decides the stored extension and is handed to
 * FFmpeg later. Sniffing the magic bytes means the file we store is genuinely
 * the image type we claim it is.
 */

export type SniffedImageType = "image/png" | "image/jpeg" | "image/webp" | "image/avif";

function startsWith(buffer: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buffer[offset + i] === b);
}

function ascii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buffer[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Returns the real image type, or null when the bytes are not a supported image. */
export function sniffImageType(buffer: Uint8Array): SniffedImageType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // RIFF....WEBP
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && ascii(buffer, 8, "WEBP")) return "image/webp";

  // ISO-BMFF box at offset 4: "ftyp", then an AVIF-family brand.
  if (ascii(buffer, 4, "ftyp")) {
    for (const brand of ["avif", "avis", "mif1", "msf1"]) {
      if (ascii(buffer, 8, brand)) return "image/avif";
    }
  }

  return null;
}

/** How many leading bytes `sniffImageType` needs. */
export const SNIFF_BYTES = 32;
