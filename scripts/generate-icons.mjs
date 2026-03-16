import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const rootDir = path.resolve(import.meta.dirname, '..');
const sourceIcon = path.join(rootDir, 'app-icon.png');
const publicDir = path.join(rootDir, 'public');
const androidResDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'res');

async function walkPngFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkPngFiles(fullPath);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) return [fullPath];
      return [];
    })
  );
  return files.flat();
}

async function ensureSourceExists() {
  try {
    await fs.access(sourceIcon);
  } catch {
    throw new Error(`未找到源图标: ${sourceIcon}`);
  }
}

async function getTargetSize(filePath, fallbackSize) {
  if (fallbackSize) return fallbackSize;
  const meta = await sharp(filePath).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`无法读取目标尺寸: ${filePath}`);
  }
  return { width: meta.width, height: meta.height };
}

async function renderContainedPng(targetPath, size, scale = 1) {
  const innerWidth = Math.max(1, Math.round(size.width * scale));
  const innerHeight = Math.max(1, Math.round(size.height * scale));
  const iconBuffer = await sharp(sourceIcon)
    .resize(innerWidth, innerHeight, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: size.width,
      height: size.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: iconBuffer,
        left: Math.floor((size.width - innerWidth) / 2),
        top: Math.floor((size.height - innerHeight) / 2),
      },
    ])
    .png()
    .toFile(targetPath);
}

async function main() {
  await ensureSourceExists();

  const publicTargets = [
    { file: path.join(publicDir, 'icon-192.png'), size: { width: 192, height: 192 } },
    { file: path.join(publicDir, 'icon-512.png'), size: { width: 512, height: 512 } },
  ];

  const androidTargets = (await walkPngFiles(androidResDir)).map((file) => ({ file }));
  const allTargets = [...publicTargets, ...androidTargets];

  for (const target of allTargets) {
    const size = await getTargetSize(target.file, target.size);
    const baseName = path.basename(target.file).toLowerCase();
    const scale = baseName === 'ic_launcher_foreground.png' ? 0.72 : 1;
    await renderContainedPng(target.file, size, scale);
  }

  console.log(`已更新 ${allTargets.length} 个图标文件`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
