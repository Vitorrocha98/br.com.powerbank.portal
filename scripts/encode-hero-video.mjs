// Rebuild the scroll assets after replacing the source clip:
// node scripts/encode-hero-video.mjs [path/to/ffmpeg]
// Keep the 24 fps output in sync with CONFIG.videoFPS in index.html.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ffmpeg = process.argv[2] || process.env.FFMPEG_PATH || 'ffmpeg';
for (const [name, scale, quality] of [
  ['desktop', '1280:720', '22'],
  ['mobile', '768:432', '23']
]) {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-i', 'raw-files/Power_bank_charging_smartphone_20260922234940.mp4',
    '-map', '0:v:0', '-an', '-vf', `scale=${scale}:flags=lanczos,fps=24`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', quality,
    // Every frame is a random-access point; no audio or reordered B-frames.
    '-g', '1', '-keyint_min', '1', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-map_metadata', '-1',
    `assets/hero-scroll-${name}.mp4`
  ], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`Generated assets/hero-scroll-${name}.mp4`);
}

// The loading cover must match the decoded opening sample, including framing.
const poster = spawnSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'warning', '-y',
  '-i', 'assets/hero-scroll-desktop.mp4', '-frames:v', '1',
  '-c:v', 'libwebp', '-lossless', '1', 'assets/hero-first-frame.webp'
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (poster.error) throw poster.error;
if (poster.status !== 0) process.exit(poster.status || 1);
console.log('Generated assets/hero-first-frame.webp');
