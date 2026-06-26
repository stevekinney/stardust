import { spawn } from 'node:child_process';

const generatedEnvironmentChunkWarning = 'Generated an empty chunk: "chunks/env.js".';

function forwardWithoutGeneratedEnvironmentChunkWarning(chunk: Buffer, stream: NodeJS.WriteStream) {
	const lines = chunk.toString().split(/(?<=\n)/);

	for (const line of lines) {
		if (line.trim() === generatedEnvironmentChunkWarning) continue;
		stream.write(line);
	}
}

const buildProcess = spawn('vite', ['build'], {
	env: process.env,
	stdio: ['inherit', 'pipe', 'pipe']
});

buildProcess.stdout.on('data', (chunk: Buffer) => {
	forwardWithoutGeneratedEnvironmentChunkWarning(chunk, process.stdout);
});

buildProcess.stderr.on('data', (chunk: Buffer) => {
	forwardWithoutGeneratedEnvironmentChunkWarning(chunk, process.stderr);
});

buildProcess.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 1);
});
