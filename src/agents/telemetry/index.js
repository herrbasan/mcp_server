import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

let localwebUrl = 'http://192.168.0.100:4445';

export async function init(context) {
    localwebUrl = context.config.agents?.telemetry?.localwebUrl ?? localwebUrl;
    return { status: 'initialized', localwebUrl };
}

export async function shutdown() {}

// ── helpers ─────────────────────────────────────────────────────────────

async function fetchJson(path, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${localwebUrl}${path}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

function fmtUptime(ms) {
    if (ms == null) return '-';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function fmtBytes(b) {
    if (b == null) return '-';
    const mb = b / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

function fmtBps(bps) {
    if (bps == null) return '-';
    return bps >= 1000000 ? `${(bps / 1000000).toFixed(1)}MB/s` : `${(bps / 1000).toFixed(0)}KB/s`;
}

// ── section renderers ───────────────────────────────────────────────────

function renderStatus(s) {
    const lines = ['## Environment'];
    lines.push(`uptime: ${Math.floor(s.uptimeSec / 3600)}h${Math.floor((s.uptimeSec % 3600) / 60)}m | PCs online: ${s.activePcsCount} (${s.activePcs.map(p => p.name).join(', ')})`);
    lines.push(`WAN: ↓${fmtBps(s.traffic?.rxTotalBps)} ↑${fmtBps(s.traffic?.txTotalBps)} | latency: ${s.latencyMs}ms | router CPU: ${s.routerCpuLoadPct}%`);
    if (s.weather) lines.push(`weather: ${s.weather.tempC}°C, ${s.weather.condition}, humidity ${s.weather.humidity}%, wind ${s.weather.windSpeed}m/s`);
    return lines.join('\n');
}

function num(v) { return v != null && !Number.isNaN(Number(v)); }

function renderHardware(h) {
    const lines = ['## PCs'];
    for (const host of Object.values(h)) {
        const parts = [host.name];
        if (host.cpu) {
            const c = [`CPU ${host.cpu.loadPct}%`];
            if (num(host.cpu.tempC)) c.push(`${host.cpu.tempC}°C`);
            if (num(host.cpu.powerW)) c.push(`${host.cpu.powerW}W`);
            parts.push(c.join(' @ ').replace(' @ ', host.cpu.tempC != null || host.cpu.powerW != null ? ' ' : ''));
        }
        if (host.gpu) {
            const g = [`GPU ${host.gpu.loadPct}%`];
            if (num(host.gpu.tempC)) g.push(`${host.gpu.tempC}°C`);
            if (num(host.gpu.memoryUsedGB)) g.push(`${host.gpu.memoryUsedGB}GB VRAM`);
            if (num(host.gpu.powerW)) g.push(`${host.gpu.powerW}W`);
            parts.push(g.join(', '));
        }
        if (host.ram && num(host.ram.loadPct)) parts.push(`RAM ${host.ram.loadPct}%`);
        if (Array.isArray(host.storage) && host.storage.length > 0) {
            const disks = host.storage
                .filter(d => num(d.usedPct))
                .map(d => `${(d.name || '').trim().split(/\s+/).slice(-2).join(' ')} ${d.usedPct}%${num(d.tempC) ? ` @ ${d.tempC}°C` : ''}`);
            if (disks.length > 0) parts.push(`disks: ${disks.join(', ')}`);
        }
        parts.push(`(seen ${host.lastSeenAgoSec}s ago)`);
        lines.push(`- ${parts.join(' | ')}`);
    }
    return lines.join('\n');
}

function renderAlerts(a) {
    if (!Array.isArray(a) || a.length === 0) return '## Alerts\nnone — all systems nominal';
    const lines = ['## Alerts'];
    for (const al of a) lines.push(`[${al.level}] ${al.domain}/${al.source} → ${al.target}: ${al.message}`);
    return lines.join('\n');
}

function renderCluster(c) {
    const cl = c.cluster;
    const lines = ['## Cluster'];
    lines.push(`nodes: ${cl.totalOnlinePcs}/${cl.totalRegisteredPcs} online | power: ${cl.totalPowerW}W (CPU ${cl.cpuPowerW}W + GPU ${cl.gpuPowerW}W)`);
    lines.push(`RAM: ${cl.ramUsedGB}/${cl.ramTotalGB}GB (${cl.ramUsedPct}%) | hottest: ${cl.hottest.host} ${cl.hottest.device} @ ${cl.hottest.tempC}°C`);
    if (c.services) lines.push(`services: ${c.services.running}/${c.services.total} running${c.services.error ? `, ${c.services.error} in error` : ''}`);
    return lines.join('\n');
}

function renderServices(o) {
    const lines = ['## Services'];
    const services = Array.isArray(o.services) ? o.services : [];
    for (const s of services) {
        let row = `- ${s.key}: ${s.status}`;
        if (s.status === 'running') row += ` | up ${fmtUptime(s.uptimeMs)} | mem ${fmtBytes(s.memoryBytes)}`;
        if (s.status === 'error' && s.errorMessage) row += ` | ${s.errorMessage}`;
        lines.push(row);
    }
    const an = o.analysis;
    if (an && an.issuesFound > 0) {
        lines.push('');
        lines.push(`LLM findings (${an.issuesFound}):`);
        for (const i of an.issues) lines.push(`- [${i.severity}] ${i.service}: ${i.summary} — ${i.details}`);
    } else if (an) {
        lines.push('');
        lines.push(`LLM findings: none (last scan ${an.lastScanAt ?? 'never'})`);
    }
    return lines.join('\n');
}

// ── tool handler ────────────────────────────────────────────────────────

export async function telemetry_report(args) {
    const wanted = Array.isArray(args?.sections) && args.sections.length > 0
        ? args.sections
        : ['status', 'hardware', 'alerts', 'cluster', 'services'];

    const endpoints = {
        status: { path: '/api/status', render: renderStatus },
        hardware: { path: '/api/hardware', render: renderHardware },
        alerts: { path: '/api/alerts', render: renderAlerts },
        cluster: { path: '/api/cluster/summary', render: renderCluster },
        services: { path: '/api/services/overview', render: renderServices }
    };

    const results = await Promise.allSettled(wanted.map(w => fetchJson(endpoints[w].path)));

    const sections = [];
    const failures = [];
    wanted.forEach((w, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
            sections.push(endpoints[w].render(r.value));
        } else {
            failures.push(w);
            logger.warn(`telemetry_report: section '${w}' failed: ${r.reason?.message ?? r.reason}`, null, 'Telemetry');
        }
    });

    if (failures.length === wanted.length) {
        return {
            content: [{ type: 'text', text: `Telemetry report failed: localweb2 unreachable at ${localwebUrl} (${results[0].reason?.message ?? 'unknown error'}).` }],
            isError: true
        };
    }

    let text = `# Lab Telemetry Report\n${new Date().toISOString()}\n\n${sections.join('\n\n')}`;
    if (failures.length > 0) text += `\n\n(unavailable sections: ${failures.join(', ')})`;

    return { content: [{ type: 'text', text }], isError: false };
}
