import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';

let seq = 0;

// PDFium is process-parallel, not thread-parallel: pdfium-render permits one
// binding per process and its thread_safe feature serializes calls. Persistent
// workers also isolate native crashes and avoid process startup per page.
export class NativeProcessPool {
    constructor({ size = 16, workerFile, tmpDir }) {
        if (!Number.isInteger(size) || size < 1) throw new Error('NativeProcessPool: size must be a positive integer');
        if (!workerFile) throw new Error('NativeProcessPool: workerFile is required');
        if (!tmpDir) throw new Error('NativeProcessPool: tmpDir is required');
        this.size = size;
        this.workerFile = workerFile;
        this.tmpDir = tmpDir;
        this.workers = new Set();
        this.pending = [];
        this.closing = false;
        fs.mkdirSync(tmpDir, { recursive: true });
    }

    run(task) {
        if (this.closing) return Promise.reject(new Error('native process pool is shutting down'));
        return new Promise((resolve, reject) => {
            this.pending.push({ task: { ...task, id: ++seq }, resolve, reject });
            this.pump();
        });
    }

    spawn() {
        const child = fork(this.workerFile, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
        const worker = { child, current: null };
        this.workers.add(worker);
        child.on('message', (message) => this.finish(worker, message));
        child.on('error', (error) => this.terminate(worker, error));
        child.on('exit', (code, signal) => {
            if (!this.workers.has(worker)) return;
            this.terminate(worker, new Error(`native worker exited (code ${code}, signal ${signal})`), false);
        });
        return worker;
    }

    pump() {
        if (this.closing) return;
        while (this.pending.length > 0) {
            let worker = [...this.workers].find((w) => w.current === null);
            if (!worker && this.workers.size < this.size) worker = this.spawn();
            if (!worker) return;
            const item = this.pending.shift();
            worker.current = item;
            if (item.task.op === 'convert') {
                item.task.resultPath = path.join(this.tmpDir, `${process.pid}-${item.task.id}.json`);
            }
            worker.child.send(item.task, (error) => {
                if (error) this.terminate(worker, error);
            });
        }
    }

    async finish(worker, message) {
        const item = worker.current;
        if (!item || item.task.id !== message.id) {
            this.terminate(worker, new Error('native worker protocol violation: response does not match active task'));
            return;
        }
        let result;
        let failure = null;
        try {
            if (!message.ok) throw new Error(message.error);
            result = item.task.op === 'convert'
                ? await fs.promises.readFile(item.task.resultPath, 'utf8')
                : message.result;
        } catch (error) {
            failure = error;
        }
        if (item.task.resultPath) await fs.promises.rm(item.task.resultPath, { force: true });
        worker.current = null;
        if (failure) item.reject(failure);
        else item.resolve(result);
        this.pump();
    }

    terminate(worker, error, kill = true) {
        if (!this.workers.delete(worker)) return;
        const item = worker.current;
        if (item) {
            item.reject(error);
            if (item.task.resultPath) fs.rmSync(item.task.resultPath, { force: true });
            worker.current = null;
        }
        if (kill && worker.child.connected) worker.child.kill();
        this.pump();
    }

    async close() {
        if (this.closing) return;
        this.closing = true;
        for (const item of this.pending.splice(0)) item.reject(new Error('native process pool closed'));
        const exits = [];
        for (const worker of this.workers) {
            if (worker.current) worker.current.reject(new Error('native process pool closed'));
            worker.current = null;
            if (worker.child.exitCode !== null || worker.child.signalCode !== null) continue;
            exits.push(new Promise((resolve) => worker.child.once('exit', resolve)));
            worker.child.kill();
        }
        this.workers.clear();
        await Promise.all(exits);
    }
}
