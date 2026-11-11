import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { ingestCommands } from '../src/ingest.js';

function config(player = 'ffmpeg', audio = true) {
  return { ...loadConfig({
    CAMERA_ADDRESS: '192.168.1.20',
    CAMERA_SOURCE: '/media/a file;$(not-a-command).mp4',
    CAMERA_PLAYER: player
  }), audio };
}

test('FFmpeg receives the source as one argument and publishes H264/AAC over loopback TCP', () => {
  const options = config();
  const [command] = ingestCommands(options);
  assert.equal(command.command, 'ffmpeg');
  assert.equal(command.args[command.args.indexOf('-i') + 1], options.source);
  assert.equal(command.args[command.args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(command.args[command.args.indexOf('-c:a') + 1], 'aac');
  assert.equal(command.args[command.args.indexOf('-vf') + 1], 'scale=1280:720,fps=15');
  assert.equal(command.args.at(-1), 'rtsp://127.0.0.1:8554/camera');
  assert.equal(command.args.at(-2), 'tcp');
});

test('mpv encodes to stdout and FFmpeg paces and relays the stream without re-encoding', () => {
  const [player, relay] = ingestCommands(config('mpv'));
  assert.equal(player.command, 'mpv');
  assert.ok(player.args.includes('--o=-'));
  assert.ok(player.args.includes('--of=nut'));
  assert.equal(player.args.at(-2), '--');
  assert.equal(player.args.at(-1), config().source);
  assert.equal(relay.command, 'ffmpeg');
  assert.ok(relay.args.includes('-re'));
  assert.equal(relay.args[relay.args.indexOf('-i') + 1], 'pipe:0');
  assert.equal(relay.args[relay.args.indexOf('-c') + 1], 'copy');
});

test('video-only ingest disables audio and external mode does not spawn a player', () => {
  assert.ok(ingestCommands(config('ffmpeg', false))[0].args.includes('-an'));
  assert.ok(!ingestCommands(config('ffmpeg', false))[0].args.includes('-c:a'));
  assert.ok(ingestCommands(config('mpv', false))[0].args.includes('--aid=no'));
  assert.deepEqual(ingestCommands(config('external')), []);
});
