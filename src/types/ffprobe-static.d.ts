/**
 * `ffprobe-static` ships no type declarations. It exports the absolute path to
 * a prebuilt ffprobe binary for the current platform.
 */
declare module "ffprobe-static" {
  const ffprobeStatic: { path: string };
  export default ffprobeStatic;
}
