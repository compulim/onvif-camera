import { spawn } from 'node:child_process';

function ingestCommands(config) {
  const destination = `rtsp://127.0.0.1:${config.rtspPort}/camera`;
  const output = ['-f', 'rtsp', '-rtsp_transport', 'tcp', destination];
  if (config.player === 'external') return [];
  if (config.player === 'mpv') {
    return [
      {
        command: 'mpv',
        args: [
          '--no-config', '--no-terminal', '--no-sub', '--loop-file=inf',
          `--vf=lavfi=[scale=${config.width}:${config.height},fps=${config.fps},format=yuv420p]`,
          '--ovc=libx264',
          `--ovcopts=preset=veryfast,tune=zerolatency,profile=main,b=${config.bitrate * 1000},g=${config.fps * 2},bf=0`,
          ...(config.audio
            ? ['--oac=aac', '--oacopts=b=64000', '--audio-samplerate=48000', '--audio-channels=mono']
            : ['--aid=no']),
          '--of=nut', '--o=-', '--', config.source
        ]
      },
      {
        command: 'ffmpeg',
        args: ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-re', '-i', 'pipe:0',
          '-map', '0:v:0', ...(config.audio ? ['-map', '0:a:0?'] : []), '-c', 'copy', ...output]
      }
    ];
  }
  return [{
    command: 'ffmpeg',
    args: [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-re', '-stream_loop', '-1', '-i', config.source,
      '-map', '0:v:0', ...(config.audio ? ['-map', '0:a:0?'] : ['-an']),
      '-vf', `scale=${config.width}:${config.height},fps=${config.fps}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-b:v', `${config.bitrate}k`, '-g', String(config.fps * 2), '-bf', '0',
      ...(config.audio ? ['-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1'] : []),
      ...output
    ]
  }];
}

function startIngest(config, onFailure) {
  const commands = ingestCommands(config);
  const children = [];
  let stopping = false;
  for (const [index, { command, args }] of commands.entries()) {
    const child = spawn(command, args, {
      shell: false,
      stdio: [index ? 'pipe' : 'ignore', index < commands.length - 1 ? 'pipe' : 'ignore', 'inherit']
    });
    children.push(child);
    child.on('error', () => {
      if (!stopping) onFailure(new Error(`Unable to start ${command}; check that it is installed`));
    });
    child.on('exit', (code, signal) => {
      if (!stopping) onFailure(new Error(`${command} stopped (${signal || code})`));
    });
    if (index) {
      // EPIPE is expected if the downstream encoder stops first.
      child.stdin.on('error', () => {});
      children[index - 1].stdout.pipe(child.stdin);
    }
  }
  return {
    async close() {
      stopping = true;
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
          resolve();
          return;
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      })));
    }
  };
}

export { ingestCommands, startIngest };
