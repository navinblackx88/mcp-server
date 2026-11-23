// Runtime configuration, all via environment variables.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DIR = path.resolve(__dirname, '../../sample-files');
const env = process.env;

export const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p);

// DATA_DIR: a persistent folder (e.g. a Railway volume). When set, it becomes the only
// readable folder, uploads are saved under DATA_DIR/uploads, and on first boot the
// sample files are copied into it. Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically.
const dataDir = env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || '';

// ALLOWED_ROOTS: folders the server may read from, separated by the OS path delimiter
// (":" on macOS/Linux, ";" on Windows). Use "*" to allow any path on the machine.
// Default: DATA_DIR if set; otherwise the bundled sample-files folder plus your home directory.
const rawRoots = env.ALLOWED_ROOTS ?? (dataDir ? dataDir : [SAMPLE_DIR, os.homedir()].join(path.delimiter));

export const config = {
  // FILE_SERVER_PORT wins so the file server can share a container with another app.
  port: Number(env.FILE_SERVER_PORT || env.PORT || 4000),
  // Locally: 127.0.0.1 only (this server can read your files). In Docker/Railway: HOST=:: (IPv4 + IPv6).
  host: env.HOST || (env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_NAME ? '::' : '127.0.0.1'),
  // Optional shared secret. When set, every request except /health needs "Authorization: Bearer <token>".
  token: env.FILE_SERVER_TOKEN || '',
  dataDir: dataDir ? path.resolve(dataDir) : '',
  seedSamples: env.SEED_SAMPLES !== 'false',
  uploadsEnabled: env.ALLOW_UPLOADS ? env.ALLOW_UPLOADS !== 'false' : Boolean(dataDir),
  allowAll: rawRoots.trim() === '*',
  roots: rawRoots.trim() === '*'
    ? []
    : rawRoots.split(path.delimiter).map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(expandHome(r))),
  // Relative paths are resolved against DEFAULT_DIR (default: first allowed root).
  defaultDir: null,
  uploadDir: null,
  maxFileBytes: Number(env.MAX_FILE_MB || 100) * 1024 * 1024,
  charsPerVirtualPage: Number(env.CHARS_PER_PAGE || 3000),
  defaultMaxChars: 20000,
  listLimit: 2000,
  maxDepth: 6,
};
config.defaultDir = path.resolve(expandHome(env.DEFAULT_DIR || config.roots[0] || process.cwd()));
config.uploadDir = path.resolve(expandHome(env.UPLOAD_DIR || path.join(config.dataDir || config.defaultDir, 'uploads')));
