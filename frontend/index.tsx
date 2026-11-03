import { definePlugin } from 'millennium';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

type AppRow = {
    appid: string;
    name: string;
    library: string;
    size: number;
    last_played: number;
    shader: number;
    workshop: number;
    offline: boolean;
    incomplete: boolean;
    install_missing: boolean;
    redistributable: boolean;
    never_played: boolean;
    cold: boolean;
    missing_deps: string[];
};

type CacheRow = {
    appid: string;
    library: string;
    bytes: number;
};

type Report = {
    ok: boolean;
    error?: string;
    steam_path?: string;
    scanned_at?: number;
    cold_days?: number;
    libraries: LibraryRow[];
    apps: AppRow[];
    orphan_shader: CacheRow[];
    orphan_workshop: CacheRow[];
    downloads: { name: string; library: string; bytes: number }[];
    totals: {
        installed: number;
        cold: number;
        shader: number;
        workshop: number;
        orphan_shader: number;
        orphan_workshop: number;
        downloads: number;
        temp: number;
        reclaimable: number;
        empty_shader_dirs: number;
        empty_workshop_dirs: number;
    };
    errors: string[];
};

type LibraryRow = {
    path: string;
    online: boolean;
    capacity: number;
    free: number;
    installed_bytes: number;
    app_count: number;
    error?: string;
};

type Filter = 'all' | 'cold' | 'never' | 'shader';

const DAY_PRESETS = [180, 365, 730];

function formatBytes(bytes: number): string {
    if (!bytes) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatPlayed(unix: number): string {
    if (!unix) {
        return 'Never played';
    }
    const then = new Date(unix * 1000);
    const days = Math.floor((Date.now() - then.getTime()) / 86400000);
    if (days < 1) {
        return 'Played today';
    }
    if (days < 60) {
        return `${days} days ago`;
    }
    return then.toLocaleDateString();
}

function storeUrl(appid: string): string {
    return `https://store.steampowered.com/app/${appid}`;
}

function DiskIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        </svg>
    );
}

const panelStyle: CSSProperties = {
    color: '#c7d5e0',
    fontSize: 13,
    lineHeight: 1.45,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
};

const cardStyle: CSSProperties = {
    background: 'rgba(0, 0, 0, 0.28)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 6,
    padding: '8px 10px',
};

const buttonStyle: CSSProperties = {
    background: '#1a9fff',
    color: '#04121d',
    border: 'none',
    borderRadius: 4,
    padding: '6px 10px',
    fontWeight: 600,
    cursor: 'pointer',
};

function BillPanel() {
    const [days, setDays] = useState(730);
    const [filter, setFilter] = useState<Filter>('all');
    const [report, setReport] = useState<Report | null>(null);
    const [status, setStatus] = useState('Not scanned yet');
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);

    async function scan(nextDays = days) {
        setBusy(true);
        setCopied(false);
        setStatus('Scanning libraries and caches. This can take a minute.');
        try {
            const raw = await backend.scan_disk(nextDays);
            const parsed = JSON.parse(raw) as Report;
            if (!parsed.ok) {
                setReport(null);
                setStatus(parsed.error || 'Scan failed');
                return;
            }
            setReport(parsed);
            setStatus(`Updated ${new Date((parsed.scanned_at || 0) * 1000).toLocaleTimeString()}`);
        } catch (error) {
            setReport(null);
            setStatus(error instanceof Error ? error.message : 'Scan failed');
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        void scan(730);
        // The first scan uses the default window. Later scans go through the button.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const visibleApps = useMemo(() => {
        const apps = report?.apps ?? [];
        return apps.filter((app) => {
            if (app.offline || app.redistributable) {
                return false;
            }
            if (filter === 'cold') {
                return app.cold;
            }
            if (filter === 'never') {
                return app.never_played;
            }
            if (filter === 'shader') {
                return app.shader > 0 || app.workshop > 0;
            }
            return true;
        });
    }, [filter, report]);

    const tools = useMemo(
        () => (report?.apps ?? []).filter((app) => app.redistributable && !app.offline),
        [report],
    );
    const offline = useMemo(() => (report?.apps ?? []).filter((app) => app.offline), [report]);

    async function copyReport() {
        if (!report) {
            return;
        }
        const lines = [
            `Disk Bill (cold after ${report.cold_days} days)`,
            `Reclaimable ${formatBytes(report.totals.reclaimable)}`,
            `Installed ${formatBytes(report.totals.installed)}`,
            `Cold installs ${formatBytes(report.totals.cold)}`,
            `Orphan shader ${formatBytes(report.totals.orphan_shader)}`,
            `Orphan workshop ${formatBytes(report.totals.orphan_workshop)}`,
            '',
            'Cold installs:',
            ...report.apps
                .filter((app) => app.cold)
                .map((app) => `- ${app.name} (${app.appid}) ${formatBytes(app.size)}`),
            '',
            'Leftover shader caches:',
            ...report.orphan_shader.map(
                (row) => `- ${row.appid} ${formatBytes(row.bytes)} ${row.library}`,
            ),
        ];
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            setCopied(true);
        } catch {
            setStatus('Clipboard is not available in this panel');
        }
    }

    return (
        <div style={panelStyle}>
            <div>
                <div style={{ fontSize: 16, fontWeight: 650, color: '#ffffff' }}>Disk Bill</div>
                <div style={{ color: '#8f98a0' }}>
                    Local Steam libraries only. Nothing is deleted or uninstalled.
                </div>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {DAY_PRESETS.map((preset) => (
                    <button
                        key={preset}
                        type="button"
                        onClick={() => setDays(preset)}
                        style={{
                            ...buttonStyle,
                            background: days === preset ? '#67c1f5' : 'transparent',
                            color: days === preset ? '#04121d' : '#c7d5e0',
                            border: '1px solid rgba(255,255,255,0.15)',
                        }}
                    >
                        {preset}d
                    </button>
                ))}
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void scan()}>
                    {busy ? 'Scanning…' : 'Scan'}
                </button>
            </div>
            <div style={{ color: '#8f98a0' }}>{status}</div>

            {report && (
                <>
                    <div style={cardStyle}>
                        <div style={{ color: '#8f98a0' }}>Reclaimable</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: '#f5c16c' }}>
                            {formatBytes(report.totals.reclaimable)}
                        </div>
                        <div style={{ color: '#8f98a0' }}>
                            Cold installs plus caches whose game is already gone. In-progress downloads are
                            excluded.
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        <Stat label="Installed" value={formatBytes(report.totals.installed)} />
                        <Stat label="Cold installs" value={formatBytes(report.totals.cold)} />
                        <Stat label="Shader on installed" value={formatBytes(report.totals.shader)} />
                        <Stat label="Workshop on installed" value={formatBytes(report.totals.workshop)} />
                        <Stat label="Orphan shader" value={formatBytes(report.totals.orphan_shader)} />
                        <Stat label="Orphan workshop" value={formatBytes(report.totals.orphan_workshop)} />
                    </div>

                    <section>
                        <Heading>Libraries</Heading>
                        {report.libraries.map((library) => (
                            <div key={library.path} style={{ marginBottom: 6 }}>
                                <div>{library.path}</div>
                                <div style={{ color: '#8f98a0' }}>
                                    {library.online
                                        ? `${formatBytes(library.installed_bytes)} installed · ${formatBytes(library.free)} free`
                                        : `Offline · last known ${formatBytes(library.installed_bytes)} across ${library.app_count} apps`}
                                </div>
                            </div>
                        ))}
                    </section>

                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(
                            [
                                ['all', 'Installed'],
                                ['cold', 'Cold'],
                                ['never', 'Never played'],
                                ['shader', 'Has cache'],
                            ] as const
                        ).map(([id, label]) => (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setFilter(id)}
                                style={{
                                    ...buttonStyle,
                                    background: filter === id ? '#2a475e' : 'transparent',
                                    color: '#c7d5e0',
                                    border: '1px solid rgba(255,255,255,0.12)',
                                }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <section>
                        {visibleApps.length === 0 && <div style={{ color: '#8f98a0' }}>Nothing in this view.</div>}
                        {visibleApps.map((app) => (
                            <AppLine key={`${app.library}:${app.appid}`} app={app} />
                        ))}
                    </section>

                    {offline.length > 0 && (
                        <section>
                            <Heading>Offline library</Heading>
                            {offline.map((app) => (
                                <div key={`${app.library}:${app.appid}`} style={{ color: '#8f98a0' }}>
                                    {app.appid} · {formatBytes(app.size)}
                                </div>
                            ))}
                        </section>
                    )}

                    <CacheList title="Leftover shader caches" rows={report.orphan_shader} />
                    <CacheList title="Leftover workshop files" rows={report.orphan_workshop} />

                    {report.totals.downloads > 0 && (
                        <section>
                            <Heading>Downloads in progress</Heading>
                            <div style={{ color: '#8f98a0' }}>{formatBytes(report.totals.downloads)} — left alone</div>
                        </section>
                    )}
                    {report.totals.temp > 0 && (
                        <div style={{ color: '#8f98a0' }}>Staging temp {formatBytes(report.totals.temp)}</div>
                    )}
                    {report.totals.empty_shader_dirs > 0 && (
                        <div style={{ color: '#8f98a0' }}>
                            {report.totals.empty_shader_dirs} empty shader folders (0 bytes, ignored)
                        </div>
                    )}

                    {tools.length > 0 && (
                        <details>
                            <summary style={{ cursor: 'pointer', color: '#8f98a0' }}>
                                Redistributables ({formatBytes(tools.reduce((sum, app) => sum + app.size, 0))})
                            </summary>
                            {tools.map((app) => (
                                <div key={app.appid}>
                                    {app.name} · {formatBytes(app.size)}
                                </div>
                            ))}
                        </details>
                    )}

                    {report.errors.length > 0 && (
                        <details>
                            <summary style={{ cursor: 'pointer', color: '#e06c75' }}>
                                {report.errors.length} scan warnings
                            </summary>
                            {report.errors.map((error) => (
                                <div key={error} style={{ color: '#8f98a0' }}>
                                    {error}
                                </div>
                            ))}
                        </details>
                    )}

                    <button type="button" style={{ ...buttonStyle, background: 'transparent', color: '#c7d5e0', border: '1px solid rgba(255,255,255,0.15)' }} onClick={() => void copyReport()}>
                        {copied ? 'Copied' : 'Copy report'}
                    </button>
                </>
            )}
        </div>
    );
}

function Stat(props: { label: string; value: string }) {
    return (
        <div style={cardStyle}>
            <div style={{ color: '#8f98a0' }}>{props.label}</div>
            <div style={{ fontWeight: 650 }}>{props.value}</div>
        </div>
    );
}

function Heading(props: { children: string }) {
    return <div style={{ fontWeight: 650, marginBottom: 4 }}>{props.children}</div>;
}

function AppLine(props: { app: AppRow }) {
    const { app } = props;
    const tags = [
        app.cold ? 'cold' : '',
        app.never_played ? 'never played' : '',
        app.install_missing ? 'install folder missing' : '',
        app.incomplete ? 'incomplete' : '',
        app.missing_deps.length > 0 ? `needs ${app.missing_deps.join(', ')}` : '',
    ].filter(Boolean);

    return (
        <details style={{ marginBottom: 6 }}>
            <summary style={{ cursor: 'pointer' }}>
                <span style={{ fontWeight: 600 }}>{app.name}</span>
                <span style={{ color: '#8f98a0' }}> · {formatBytes(app.size + app.shader + app.workshop)}</span>
            </summary>
            <div style={{ color: '#8f98a0', paddingLeft: 12 }}>
                <div>
                    Install {formatBytes(app.size)}
                    {app.shader > 0 ? ` · shader ${formatBytes(app.shader)}` : ''}
                    {app.workshop > 0 ? ` · workshop ${formatBytes(app.workshop)}` : ''}
                </div>
                <div>{formatPlayed(app.last_played)}</div>
                {tags.length > 0 && <div>{tags.join(' · ')}</div>}
                <div>{app.library}</div>
                <a href={storeUrl(app.appid)} target="_blank" rel="noreferrer" style={{ color: '#67c1f5' }}>
                    Store page
                </a>
            </div>
        </details>
    );
}

function CacheList(props: { title: string; rows: CacheRow[] }) {
    if (props.rows.length === 0) {
        return null;
    }
    const shown = props.rows.slice(0, 12);
    return (
        <section>
            <Heading>{props.title}</Heading>
            {shown.map((row) => (
                <div key={`${row.library}:${row.appid}`} style={{ marginBottom: 4 }}>
                    <a href={storeUrl(row.appid)} target="_blank" rel="noreferrer" style={{ color: '#67c1f5' }}>
                        {row.appid}
                    </a>
                    <span style={{ color: '#8f98a0' }}> · {formatBytes(row.bytes)}</span>
                </div>
            ))}
            {props.rows.length > shown.length && (
                <div style={{ color: '#8f98a0' }}>{props.rows.length - shown.length} more in the copied report</div>
            )}
        </section>
    );
}

export default definePlugin(() => {
    return {
        title: 'Disk Bill',
        icon: <DiskIcon />,
        content: <BillPanel />,
    };
});
