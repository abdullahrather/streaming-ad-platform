/**
 * prisma/demo-media.ts
 *
 * Makes fictional demo videos with FFmpeg, so the repository doesn't need to
 * hold video files: a short episode for each show, and an ad for each campaign.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';

const MEDIA_DIR = path.resolve(process.env['MEDIA_DIR'] ?? '.data/media');
const EPISODE_SECONDS = 40;
const AD_SECONDS = 10;
const PARALLEL_JOBS = 4;

const FONTS = [
  'C:/Windows/Fonts/arialbd.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
];

// Some FFmpeg builds, such as ffmpeg-static on Linux, can't draw text. Videos then go without it.
const drawsText =
  Boolean(ffmpegPath) &&
  spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-filters'], {
    encoding: 'utf8',
  }).stdout?.includes(' drawtext ');

const font = drawsText ? FONTS.find((candidate) => fs.existsSync(candidate)) : undefined;

export interface DemoVideo {
  key: string;
  title: string;
  subtitle: string;
  colours: [string, string];
  seconds: number;
  /** Musical note for the background tone, in hertz. */
  tone: number;
}

const escapeText = (text: string): string => text.replace(/[\\':%]/g, '\\$&');

const textFilter = (text: string, size: number, y: string): string[] => {
  if (!font) return [];
  const file = font.replace(':', '\\:');
  return [
    `drawtext=fontfile='${file}':text='${escapeText(text)}':fontsize=${size}:fontcolor=white:x=(w-tw)/2:y=${y}`,
  ];
};

const run = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath as unknown as string, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-600);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed: ${stderr}`));
    });
  });

const makeVideo = async (video: DemoVideo): Promise<void> => {
  const output = path.join(MEDIA_DIR, video.key);
  await fsPromises.mkdir(path.dirname(output), { recursive: true });

  const [from, to] = video.colours;
  const filters = [
    ...textFilter(video.title, 58, '(h-th)/2-30'),
    ...textFilter(video.subtitle, 26, '(h-th)/2+40'),
  ];

  await run([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `gradients=s=854x480:c0=${from}:c1=${to}:nb_colors=2:speed=0.01:d=${video.seconds}:r=24`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${video.tone}:duration=${video.seconds}`,
    '-filter:a',
    'volume=0.04',
    ...(filters.length > 0 ? ['-vf', filters.join(',')] : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-shortest',
    '-movflags',
    '+faststart',
    output,
  ]);

  await run([
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    '1',
    '-i',
    output,
    '-frames:v',
    '1',
    path.join(path.dirname(output), 'poster.jpg'),
  ]);
};

/**
 * Empties the media folder rather than removing it: in Docker it's a mounted volume, which
 * can't be removed.
 */
export const clearDemoMedia = async (): Promise<void> => {
  const entries = await fsPromises.readdir(MEDIA_DIR).catch(() => [] as string[]);
  await Promise.all(
    entries.map((entry) =>
      fsPromises.rm(path.join(MEDIA_DIR, entry), { recursive: true, force: true }),
    ),
  );
};

export const makeDemoVideos = async (videos: DemoVideo[]): Promise<void> => {
  const waiting = [...videos];
  const worker = async (): Promise<void> => {
    for (let video = waiting.shift(); video; video = waiting.shift()) {
      await makeVideo(video);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_JOBS }, worker));
};

export const mediaFileSize = (key: string): number => fs.statSync(path.join(MEDIA_DIR, key)).size;

export const EPISODE_LENGTH = EPISODE_SECONDS;
export const AD_LENGTH = AD_SECONDS;
