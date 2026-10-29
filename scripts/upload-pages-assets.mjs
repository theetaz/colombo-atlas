import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
// The large files go to the "colombo-atlas-assets" bucket on the VPS's Garage S3 store.
// Credentials: COLOMBO_ASSETS_S3_ACCESS_KEY_ID and COLOMBO_ASSETS_S3_SECRET_ACCESS_KEY.
const bucket = process.env.COLOMBO_ASSETS_S3_BUCKET || 'colombo-atlas-assets';
const endpoint = process.env.COLOMBO_ASSETS_S3_ENDPOINT || 'https://s3.prabhavalabs.com';
const accessKey = process.env.COLOMBO_ASSETS_S3_ACCESS_KEY_ID;
const secretKey = process.env.COLOMBO_ASSETS_S3_SECRET_ACCESS_KEY;
if (!accessKey || !secretKey) {
  throw new Error('Set COLOMBO_ASSETS_S3_ACCESS_KEY_ID and COLOMBO_ASSETS_S3_SECRET_ACCESS_KEY to upload the large assets.');
}
const awsEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: accessKey,
  AWS_SECRET_ACCESS_KEY: secretKey,
  AWS_DEFAULT_REGION: 'garage',
  AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
  AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
};
const assets = JSON.parse(await readFile(path.join(root, '.cloudflare-build/assets.json'), 'utf8'));

for (const [url, asset] of Object.entries(assets)) {
  const filename = path.join(root, '.cloudflare-build/files', url.slice(1));
  const bytes = await readFile(filename);
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Asset changed after build: ${url}. Run npm run build:pages again.`);
  }
  const result = spawnSync('aws', ['s3api', 'put-object', '--endpoint-url', endpoint, '--bucket', bucket,
    '--key', asset.key, '--body', filename, '--content-type', asset.contentType,
    '--cache-control', 'public, max-age=31536000, immutable'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: awsEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
