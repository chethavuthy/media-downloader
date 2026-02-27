import { spawn } from 'child_process';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOptions {
  timeout?: number;
  maxBuffer?: number;
}

/**
 * Safely spawn a child process with args as an array — never interpolated into
 * a shell string. This prevents OS command injection via crafted URLs or paths.
 *
 * Unlike execAsync, the first argument is the executable and the second is a
 * proper argv array, so the shell is never involved.
 */
export function spawnAsync(
  command: string,
  args: string[],
  options: SpawnOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024; // 10 MB default
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeout)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        timedOut = true;
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out or exceeded buffer: ${command} ${args[0] ?? ''}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
