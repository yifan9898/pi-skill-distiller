import { mkdir, open, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

const STALE_LOCK_MS = 10 * 60 * 1000;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function removeStaleLock(lockPath: string): Promise<void> {
	try {
		const info = await stat(lockPath);
		if (Date.now() - info.mtimeMs > STALE_LOCK_MS) await unlink(lockPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function withDistillLock<T>(cwd: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
	const lockPath = join(cwd, ".pi", ".skill-distiller.lock");
	await mkdir(dirname(lockPath), { recursive: true });
	const deadline = Date.now() + timeoutMs;
	let handle: Awaited<ReturnType<typeof open>> | undefined;

	while (!handle) {
		try {
			handle = await open(lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await removeStaleLock(lockPath);
			if (Date.now() >= deadline) throw new Error("Another pi session is currently distilling or reviewing skills.");
			await delay(100);
		}
	}
	try {
		await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
	} catch (error) {
		await handle.close();
		await unlink(lockPath).catch(() => {});
		throw error;
	}
	const heartbeat = setInterval(() => {
		const now = new Date();
		void utimes(lockPath, now, now).catch(() => {});
	}, 60_000);
	heartbeat.unref();

	try {
		return await action();
	} finally {
		clearInterval(heartbeat);
		await handle.close();
		try {
			await unlink(lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
