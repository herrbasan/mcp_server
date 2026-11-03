// nConvert ingest queue — one heavy job at a time (fast-lane design,
// 2026-11-03): mechanical conversions run inline in the caller; deep/large
// jobs serialize through here so gateway tokens, PDFium and disk are never
// contended. The job store is one JSON file (atomic tmp+rename) that
// survives restarts; a restart re-queues interrupted running jobs.
//
// Progress is a STEP MODEL, not a percentage: jobs carry the full step list
// with per-step status and real i/n where it exists. Every transition is
// persisted and pushed to subscribers (the SSE route feeds dashboards).
//
// The executor is injected, so the queue is testable without conversions.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

export class CancelledError extends Error {
    constructor() {
        super('job cancelled');
        this.name = 'CancelledError';
    }
}

const STEP_LABELS = {
    detecting: 'Detecting format',
    converting: 'Mechanical conversion',
    rendering: 'Rendering pages',
    vision: 'Vision structuring',
    retry: 'Coverage retry',
    summarizing: 'Generating summary',
    done: 'Done'
};

let seq = 0;

function newJobId() {
    seq = (seq + 1) % 0xffff;
    return `j_${Date.now().toString(36)}${seq.toString(36).padStart(2, '0')}${crypto.randomBytes(3).toString('hex')}`;
}

export class IngestQueue {
    constructor({ file, executor, maxHistory = 200 }) {
        if (typeof executor !== 'function') throw new Error('IngestQueue: executor (job, progress) => result is required');
        this.file = file;
        this.executor = executor;
        this.maxHistory = maxHistory;
        this.jobs = [];
        this.busy = false;
        this.events = new EventEmitter();
        this.events.setMaxListeners(50);
        this.progressCtx = null; // active job's ctx, for cancel flags
        this.load();
    }

    // ── persistence ──────────────────────────────────────────────────────

    load() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            this.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
        } catch {
            this.jobs = []; // absent or corrupt store starts fresh (loudly)
        }
        let requeued = 0;
        for (const job of this.jobs) {
            if (job.state === 'running') {
                job.state = 'queued';
                job.requeued = true;
                requeued++;
            }
            if (job.state === 'queued') this.pumpSoon();
        }
        if (requeued > 0) {
            this.persist();
            this.events.emit('log', { requeued });
        }
    }

    persist() {
        // retention: keep the newest maxHistory finished jobs
        const finished = this.jobs.filter((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled');
        if (finished.length > this.maxHistory) {
            const cutoff = finished.slice().sort((a, b) => a.createdAt - b.createdAt)
                .slice(0, finished.length - this.maxHistory);
            const drop = new Set(cutoff.map((j) => j.id));
            this.jobs = this.jobs.filter((j) => !drop.has(j.id));
        }
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 2), 'utf8');
        fs.renameSync(tmp, this.file);
    }

    // ── submission ───────────────────────────────────────────────────────

    // Dedup: the same source bytes already queued/running → same job back.
    enqueue({ source, args, sha, heavy, steps }) {
        if (sha) {
            const existing = this.jobs.find(
                (j) => (j.state === 'queued' || j.state === 'running') && j.sha === sha
            );
            if (existing) return { job: existing, deduped: true };
        }
        const job = {
            id: newJobId(),
            state: 'queued',
            heavy: Boolean(heavy),
            source,
            sha: sha ?? null,
            args,
            steps: (steps ?? []).map((id) => ({
                id, label: STEP_LABELS[id] ?? id, status: 'pending', i: null, n: null, detail: null
            })),
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            result: null,
            error: null
        };
        this.jobs.push(job);
        this.persist();
        this.emit(job, 'job.queued');
        if (heavy) this.pumpSoon();
        return { job, deduped: false };
    }

    // Mechanical fast lane: execute in the caller's turn, but record the job
    // (complete) so the dashboard's history covers every ingest.
    async runInline({ source, args, sha, steps }) {
        const { job } = this.enqueue({ source, args, sha, heavy: false, steps });
        const progress = this.makeProgress(job);
        job.state = 'running';
        job.startedAt = Date.now();
        try {
            job.result = await this.executor(job, progress);
            job.state = 'done';
        } catch (e) {
            job.state = e instanceof CancelledError ? 'cancelled' : 'failed';
            job.error = e.message;
        }
        job.finishedAt = Date.now();
        this.closeActiveSteps(job);
        this.persist();
        this.emit(job, `job.${job.state}`);
        return job;
    }

    // completion closes any still-active step (the last step has no successor)
    closeActiveSteps(job) {
        for (const s of job.steps) if (s.status === 'active') s.status = 'done';
    }

    // ── worker (one heavy job at a time) ─────────────────────────────────

    pumpSoon() {
        setImmediate(() => this.pump());
    }

    pump() {
        if (this.busy) return;
        const next = this.jobs
            .filter((j) => j.state === 'queued' && j.heavy)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) return;
        this.busy = true;
        next.state = 'running';
        next.startedAt = Date.now();
        this.persist();
        this.emit(next, 'job.started'); // positions shift for the rest
        const progress = this.makeProgress(next);
        this.progressCtx = progress;
        Promise.resolve()
            .then(() => this.executor(next, progress))
            .then((result) => {
                next.result = result;
                if (next.state === 'running') next.state = 'done';
            })
            .catch((e) => {
                if (next.state === 'cancelled') return; // cancel already finalized
                next.state = e instanceof CancelledError ? 'cancelled' : 'failed';
                if (!(e instanceof CancelledError)) next.error = e.message;
            })
            .finally(() => {
                if (next.state === 'running') next.state = 'failed'; // defensive: never stuck
                if (!next.finishedAt) next.finishedAt = Date.now();
                this.closeActiveSteps(next);
                this.busy = false;
                this.progressCtx = null;
                this.persist();
                this.emit(next, `job.${next.state}`);
                this.pump();
            });
    }

    makeProgress(job) {
        const q = this; // object-literal methods below do not inherit `this`
        const find = (id) => job.steps.find((s) => s.id === id);
        return {
            jobId: job.id,
            async step(id, { i = null, n = null, detail = null } = {}) {
                // close any active step, open (or update) this one
                for (const s of job.steps) if (s.status === 'active' && s.id !== id) s.status = 'done';
                let s = find(id);
                if (!s) {
                    s = { id, label: STEP_LABELS[id] ?? id, status: 'active', i: null, n: null, detail: null };
                    job.steps.push(s);
                }
                s.status = 'active';
                s.i = i;
                s.n = n;
                s.detail = detail;
                q.persist();
                q.emit(job, 'job.update');
            },
            finishStep(id, { detail = null } = {}) {
                const s = find(id);
                if (s && s.status === 'active') {
                    s.status = 'done';
                    if (detail != null) s.detail = detail;
                    q.persist();
                    q.emit(job, 'job.update');
                }
            },
            checkCancelled() {
                if (job.cancelRequested) throw new CancelledError();
            },
            job
        };
    }

    // ── queries & control ────────────────────────────────────────────────

    get(id) {
        return this.jobs.find((j) => j.id === id) ?? null;
    }

    // queued (with live positions) + running + recent history
    list({ state = null, limit = 50 } = {}) {
        let position = 0;
        const positions = new Map();
        for (const j of this.jobs) {
            if (j.state === 'queued' && j.heavy) positions.set(j.id, ++position);
        }
        let jobs = this.jobs.slice().sort((a, b) => b.createdAt - a.createdAt);
        if (state) jobs = jobs.filter((j) => j.state === state);
        return jobs.slice(0, limit).map((j) => ({ ...this.publicJob(j), position: positions.get(j.id) ?? null }));
    }

    publicJob(j) {
        return {
            id: j.id,
            state: j.state,
            heavy: j.heavy,
            source: j.source,
            sha: j.sha,
            args: j.args,
            steps: j.steps,
            createdAt: j.createdAt,
            startedAt: j.startedAt,
            finishedAt: j.finishedAt,
            result: j.result,
            error: j.error,
            cancelRequested: j.cancelRequested ?? false,
            requeued: j.requeued ?? false
        };
    }

    cancel(id) {
        const job = this.get(id);
        if (!job) throw new Error(`no such job: ${id}`);
        if (job.state !== 'queued' && job.state !== 'running') {
            throw new Error(`job ${id} is ${job.state} — only queued/running jobs can be cancelled`);
        }
        if (job.state === 'queued') {
            job.state = 'cancelled';
            job.finishedAt = Date.now();
            this.persist();
            this.emit(job, 'job.cancelled');
        } else {
            // running: cooperative — the executor checks between steps/chunks
            job.cancelRequested = true;
            this.persist();
            this.emit(job, 'job.update');
        }
        return this.publicJob(job);
    }

    // ── events (SSE feeds from this) ─────────────────────────────────────

    subscribe(fn) {
        this.events.on('job', fn);
        return () => this.events.off('job', fn);
    }

    emit(job, type) {
        this.events.emit('job', { type, at: Date.now(), job: this.publicJob(job) });
    }
}
