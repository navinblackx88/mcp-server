// Persistent-storage helpers: first-boot sample seeding, uploads, and token auth.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, SAMPLE_DIR } from './config.js';
import { HttpError } from './paths.js';

/** On first boot with an empty DATA_DIR, copy the bundled sample files into it. */
export async function seedDataDir() {
  if (!config.dataDir) return;
  await fs.mkdir(config.dataDir, { recursive: true });
  if (!config.seedSamples) return;
  const existing = (await fs.readdir(config.dataDir)).filter((n) => n !== 'lost+found');
  if (existing.length) return;
  try {
    await fs.cp(SAMPLE_DIR, config.dataDir, { recursive: true });
    console.log(`Seeded sample files into ${config.dataDir}`);
  } catch (e) {
    console.warn(`Could not seed sample files: ${e.message}`);
  }
}

/** Express middleware: require "Authorization: Bearer <FILE_SERVER_TOKEN>" when a token is configured. */
export function requireToken(req, res, next) {
  if (!config.token) return next();
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.token);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Missing or invalid token' });
}

// Keep a safe, readable file name: no folders, no leading dots, limited characters.
export function safeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()-]+/gu, '_').replace(/^\.+/, '').trim().slice(0, 150);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new HttpError(400, 'Invalid file name');
  return cleaned;
}

/** Write bytes to UPLOAD_DIR without overwriting: report.pdf, report (1).pdf, ... */
export async function saveUpload(name, buffer) {
  if (!config.uploadsEnabled) throw new HttpError(403, 'Uploads are disabled (set ALLOW_UPLOADS=true or DATA_DIR)');
  if (!buffer?.length) throw new HttpError(400, 'Empty upload');
  const fileName = safeFileName(name);
  await fs.mkdir(config.uploadDir, { recursive: true });
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(config.uploadDir, i === 0 ? fileName : `${stem} (${i})${ext}`);
    try {
      await fs.writeFile(candidate, buffer, { flag: 'wx' }); // fails if the file exists
      return candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new HttpError(409, 'Too many files with this name');
}
