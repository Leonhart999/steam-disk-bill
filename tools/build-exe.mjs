// Packs the app into one Windows executable with Node's single executable application (SEA) support.
// Output: dist/Steam Disk Bill.exe. Needs the dev dependencies (esbuild, postject, rcedit).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { rcedit } from 'rcedit';

const require = createRequire(import.meta.url);
const { inject } = require('postject');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'dist', 'build');
const exe = path.join(root, 'dist', 'Steam Disk Bill.exe');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const ASSETS = ['app/index.html', 'app/styles.css', 'app/app.js', 'app/i18n.js', 'app/history.js', 'src/recycle.ps1'];

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// 1. One CommonJS file: SEA runs a single script and only resolves built-in modules.
await build({
    entryPoints: [path.join(root, 'src', 'server.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(work, 'server.cjs'),
    // assets.mjs only reads import.meta.url outside the exe; give it a value so the bundle stays valid.
    banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': '__importMetaUrl' },
    logLevel: 'warning',
});

// 2. The SEA blob with the page, scripts and the recycle helper embedded as assets.
const config = {
    main: path.join(work, 'server.cjs'),
    output: path.join(work, 'sea.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets: Object.fromEntries(ASSETS.map((name) => [name, path.join(root, name)])),
};
writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')], { stdio: 'inherit' });

// 3. Copy this Node runtime, brand it, then inject the blob.
mkdirSync(path.dirname(exe), { recursive: true });
copyFileSync(process.execPath, exe);
await rcedit(exe, {
    icon: path.join(root, 'assets', 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
        ProductName: 'Steam Disk Bill',
        FileDescription: 'Steam Disk Bill',
        CompanyName: 'Leonhart999',
        LegalCopyright: 'MIT License',
        OriginalFilename: 'Steam Disk Bill.exe',
        InternalName: 'steam-disk-bill',
    },
});
await inject(exe, 'NODE_SEA_BLOB', readFileSync(config.output), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

// 4. Windows GUI subsystem: double-clicking opens only the app window, no console.
const binary = readFileSync(exe);
const header = binary.readUInt32LE(0x3c);
if (binary.toString('latin1', header, header + 4) !== 'PE\0\0') throw new Error('Not a PE file');
binary.writeUInt16LE(2, header + 24 + 68);
writeFileSync(exe, binary);
rmSync(work, { recursive: true, force: true });
console.log(`Built ${path.relative(root, exe)} (${(binary.length / 1024 / 1024).toFixed(1)} MiB, v${version})`);
