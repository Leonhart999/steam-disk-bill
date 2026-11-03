import { scan, formatBytes } from '../src/scan.mjs';

const daysFlag = process.argv.indexOf('--days');
const coldDays = daysFlag >= 0 ? Number(process.argv[daysFlag + 1]) : 730;
const started = Date.now();
const report = scan(coldDays);

console.log(`Steam: ${report.steamPath}`);
console.log(`Cold window: ${report.coldDays} days`);
for (const library of report.libraryRows) {
    const state = library.online
        ? `${formatBytes(library.installed)} installed, ${formatBytes(library.free)} free, ${library.count} apps`
        : `offline, last known ${formatBytes(library.installed)} across ${library.count} apps`;
    console.log(`Library ${library.path}: ${state}`);
}
const totals = report.totals;
console.log('---');
console.log(`Installed          ${formatBytes(totals.installed)}`);
console.log(`Cold installs      ${formatBytes(totals.cold)}`);
console.log(`Shader on installs ${formatBytes(totals.shader)}`);
console.log(`Workshop on installs ${formatBytes(totals.workshop)}`);
console.log(`Orphan shader      ${formatBytes(totals.orphanShader)} (${report.orphans.shader.length})`);
console.log(`Empty shader dirs  ${totals.emptyShaderDirs}`);
console.log(`Orphan workshop    ${formatBytes(totals.orphanWorkshop)} (${report.orphans.workshop.length})`);
console.log(`Downloads          ${formatBytes(totals.downloads)}`);
console.log(`Temp               ${formatBytes(totals.temp)}`);
console.log(`Reclaimable        ${formatBytes(totals.reclaimable)}`);
console.log(`Scanned in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (report.errors.length > 0) {
    console.log('--- warnings ---');
    for (const warning of report.errors) {
        console.log(warning);
    }
}
