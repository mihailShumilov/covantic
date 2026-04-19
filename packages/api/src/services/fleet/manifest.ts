import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FleetAgent, FleetManifest } from './types.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const DEFAULT_MANIFEST_PATH = resolve(REPO_ROOT, 'keys/fleet.json');

function resolveManifestPath(path?: string): string {
  if (!path) return DEFAULT_MANIFEST_PATH;
  return path.startsWith('/') ? path : resolve(REPO_ROOT, path);
}

/** Load the fleet manifest. Returns a skeleton manifest when the file
 *  doesn't exist yet — bootstrap callers treat this as "empty fleet". */
export function loadManifest(path?: string): FleetManifest {
  const abs = resolveManifestPath(path);
  if (!existsSync(abs)) {
    return {
      version: 1,
      holderKeypairPath: 'keys/fleet-holder.json',
      agents: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const raw = readFileSync(abs, 'utf-8');
  const parsed = JSON.parse(raw) as FleetManifest;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported fleet manifest version: ${parsed.version}`);
  }
  return parsed;
}

/** Write the manifest atomically via tmp+rename so an interrupted write
 *  can't leave a half-written JSON file. */
export function saveManifest(manifest: FleetManifest, path?: string): void {
  const abs = resolveManifestPath(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, abs);
}

/** Return a new manifest with `agent` appended. The caller should save
 *  the returned value. We keep this pure so bootstrap can compose it
 *  with other mutations before a single write. */
export function appendAgent(manifest: FleetManifest, agent: FleetAgent): FleetManifest {
  return {
    ...manifest,
    agents: [...manifest.agents, agent],
    updatedAt: new Date().toISOString(),
  };
}

/** True when an agent with the given name already exists. Prevents
 *  accidental duplicate bootstrapping. */
export function hasAgent(manifest: FleetManifest, name: string): boolean {
  return manifest.agents.some((a) => a.name === name);
}

export { DEFAULT_MANIFEST_PATH };
