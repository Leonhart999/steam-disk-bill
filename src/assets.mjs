// Reads bundled files. Inside the packaged exe they are embedded as SEA assets;
// from source they are read from the project folder.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sea from 'node:sea';

const embedded = sea.isSea();
let root = '';

export function readAsset(name) {
    if (embedded) return Buffer.from(sea.getRawAsset(name));
    root ||= path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(path.join(root, name));
}
