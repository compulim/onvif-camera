import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { test } from 'node:test';
import { createCameraServer } from '../src/camera.js';
import { loadConfig, unsetProbedKeys } from '../src/config.js';
import { discoveryMessage, matchesProbe } from '../src/discovery.js';
import { parseProbe } from '../src/media.js';
import { XMLBuilder } from 'fast-xml-parser';
import { authorized, parseXml } from '../src/soap.js';

const config = loadConfig({ CAMERA_ADDRESS: '192.168.1.20' });
const builder = new XMLBuilder({ ignoreAttributes: false });

function request(operation, body = '', header = '') {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl"><s:Header>${header}</s:Header><s:Body><trt:${operation}>${body}</trt:${operation}></s:Body></s:Envelope>`;
}

async function serve(t, options = config) {
  const server = createCameraServer(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (operation, body = '', path = 'media', header = '') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/onvif/${path}_service`, {
      method: 'POST', body: request(operation, body, header)
    });
    const xml = await res.text();
    return { status: res.status, xml, body: parseXml(xml).Envelope.Body };
  };
}

test('configuration validates required settings and has a stable endpoint identity', () => {
  assert.throws(() => loadConfig({}, {}), /CAMERA_ADDRESS/);
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.30', family: 'IPv4', internal: false }]
  };
  const detected = loadConfig({}, interfaces);
  assert.equal(detected.address, '192.168.1.30');
  assert.equal(detected.rtspUrl, 'rtsp://192.168.1.30:8554/camera');
  assert.equal(detected.audioSampleRate, 44100);
  assert.equal(loadConfig({ CAMERA_ADDRESS: '192.168.1.40' }, interfaces).address, '192.168.1.40');
  assert.equal(loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_PORT: '', CAMERA_NAME: '' }).port, 8000);
  assert.equal(loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_NAME: '' }).name, 'onvif-camera');
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: '127.0.0.1' }), /LAN/);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_PORT: '0' }), /CAMERA_PORT/);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_USERNAME: 'camera' }), /both/);
  assert.equal(config.uuid, loadConfig({ CAMERA_ADDRESS: config.address }).uuid);
  assert.deepEqual([config.manufacturer, config.hardwareId], ['Raspberry Pi', 'onvif-camera']);
  assert.equal(config.firmwareVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_RTSP_URL: 'http://192.168.1.30/camera' }), /CAMERA_RTSP_URL/);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_RTSP_URL: 'rtsp://viewer:' + 'secret@192.168.1.30/camera' }), /CAMERA_RTSP_URL/);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_RTSP_URL: 'not a url' }), /CAMERA_RTSP_URL/);
  assert.equal(loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_RTSP_URL: 'rtsps://camera.local/live' }).rtspPort, 322);
  assert.equal(config.rtspPort, 8554);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_MODEL: 'x'.repeat(65) }), /CAMERA_MODEL/);
});

test('stream URL and device identity are configurable', async t => {
  const custom = loadConfig({
    CAMERA_ADDRESS: config.address,
    CAMERA_RTSP_URL: 'rtsp://192.168.1.30/live/cam1',
    CAMERA_MANUFACTURER: 'Acme',
    CAMERA_MODEL: 'Cam 1',
    CAMERA_FIRMWARE_VERSION: '2.3.4',
    CAMERA_SERIAL_NUMBER: 'SN123',
    CAMERA_HARDWARE_ID: 'HW1'
  });
  assert.equal(custom.rtspPort, 554);
  const call = await serve(t, custom);
  const info = (await call('GetDeviceInformation', '', 'device')).body.GetDeviceInformationResponse;
  assert.deepEqual(
    [info.Manufacturer, info.Model, String(info.FirmwareVersion), info.SerialNumber, info.HardwareId],
    ['Acme', 'Cam 1', '2.3.4', 'SN123', 'HW1']
  );
  const uri = await call('GetStreamUri', '<trt:ProfileToken>main</trt:ProfileToken><trt:StreamSetup><Stream>RTP-Unicast</Stream><Transport><Protocol>RTSP</Protocol></Transport></trt:StreamSetup>');
  assert.equal(uri.body.GetStreamUriResponse.MediaUri.Uri, 'rtsp://192.168.1.30/live/cam1');
  const scopes = (await call('GetScopes', '', 'device')).body.GetScopesResponse.Scopes.map(scope => scope.ScopeItem);
  assert.ok(scopes.includes('onvif://www.onvif.org/hardware/Cam%201'));
});

test('device endpoints advertise only implemented services and LAN URLs', async t => {
  const call = await serve(t);
  const info = await call('GetDeviceInformation', '', 'device');
  assert.equal(info.status, 200);
  assert.equal(info.body.GetDeviceInformationResponse.Model, 'Camera Module');
  assert.equal((await call('GetHostname', '', 'device')).body.GetHostnameResponse.HostnameInformation.Name, '192.168.1.20');
  assert.equal(loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_ID: 'front-door' }).id, 'front-door');
  const capabilities = await call('GetCapabilities', '', 'device');
  assert.equal(capabilities.body.GetCapabilitiesResponse.Capabilities.Media.XAddr,
    'http://192.168.1.20:8000/onvif/media_service');
  assert.equal(capabilities.body.GetCapabilitiesResponse.Capabilities.PTZ, undefined);
  const services = await call('GetServices', '', 'device');
  assert.equal(services.body.GetServicesResponse.Service.length, 2);
  const clock = await call('GetSystemDateAndTime', '', 'device');
  assert.equal(Number(clock.body.GetSystemDateAndTimeResponse.SystemDateAndTime.UTCDateTime.Date.Year),
    new Date().getUTCFullYear());
});

test('media profile and URI describe the configured H264/AAC stream', async t => {
  const call = await serve(t);
  const profiles = await call('GetProfiles');
  assert.equal(profiles.status, 200);
  const profile = profiles.body.GetProfilesResponse.Profiles;
  assert.equal(profile['@_token'], 'main');
  assert.equal(profile.VideoEncoderConfiguration.Encoding, 'H264');
  assert.equal(profile.VideoEncoderConfiguration.Resolution.Width, '1920');
  assert.equal(profile.AudioEncoderConfiguration.Encoding, 'AAC');
  assert.equal(Number(profile.AudioEncoderConfiguration.Bitrate), 128);
  assert.equal(Number(profile.AudioEncoderConfiguration.SampleRate), 44);
  assert.equal(Number((await call('GetAudioSources')).body.GetAudioSourcesResponse.AudioSources.Channels), 2);
  assert.match((await call('GetScopes', '', 'device')).xml, /onvif:\/\/www\.onvif\.org\/type\/audio_encoder/);
  const uri = await call('GetStreamUri', '<trt:ProfileToken>main</trt:ProfileToken><trt:StreamSetup><Stream>RTP-Unicast</Stream><Transport><Protocol>RTSP</Protocol></Transport></trt:StreamSetup>');
  assert.equal(uri.body.GetStreamUriResponse.MediaUri.Uri, 'rtsp://192.168.1.20:8554/camera');
  assert.equal((await call('GetProfile', '<trt:ProfileToken>missing</trt:ProfileToken>')).status, 500);
  assert.equal((await call('GetStreamUri', '<trt:ProfileToken>main</trt:ProfileToken><trt:StreamSetup><Stream>RTP-Multicast</Stream></trt:StreamSetup>')).status, 500);
  assert.equal((await call('SetVideoEncoderConfiguration')).status, 500);
  assert.equal((await call('GetProfile')).status, 500);
  const invalid = await call('GetProfile', '<trt:ProfileToken><Nested>main</Nested></trt:ProfileToken>');
  assert.equal(invalid.status, 500);
  assert.match(invalid.xml, /ter:InvalidArgVal/);
  const encoder = await call('GetVideoEncoderConfiguration', '<trt:ConfigurationToken>video_encoder</trt:ConfigurationToken>');
  assert.equal(encoder.body.GetVideoEncoderConfigurationResponse.Configuration.Encoding, 'H264');
  assert.equal((await call('GetVideoEncoderConfiguration', '<trt:ConfigurationToken>missing</trt:ConfigurationToken>')).status, 500);
  const compatible = await call('GetCompatibleVideoEncoderConfigurations', '<trt:ProfileToken>main</trt:ProfileToken>');
  assert.equal(compatible.body.GetCompatibleVideoEncoderConfigurationsResponse.Configurations['@_token'], 'video_encoder');
  const options = await call('GetVideoEncoderConfigurationOptions');
  assert.equal(options.body.GetVideoEncoderConfigurationOptionsResponse.Options.H264.ResolutionsAvailable.Width, '1920');
});

test('video-only profiles omit audio and XML-escape configured names', async t => {
  const call = await serve(t, { ...config, audio: false, name: 'Camera <A> & "B"' });
  const profiles = await call('GetProfiles');
  assert.match(profiles.xml, /Camera &lt;A&gt; &amp; &quot;B&quot;/);
  assert.equal(profiles.body.GetProfilesResponse.Profiles.Name, 'Camera <A> & "B"');
  assert.equal(profiles.body.GetProfilesResponse.Profiles.AudioEncoderConfiguration, undefined);
  assert.equal((await call('GetAudioSources')).body.GetAudioSourcesResponse, '');
  assert.doesNotMatch((await call('GetScopes', '', 'device')).xml, /type\/audio_encoder/);
});

test('malformed, entity-bearing, oversized requests and incorrect paths are rejected', async t => {
  const server = createCameraServer(config).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const body of ['<broken', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>', request('GetProfiles') + request('GetProfiles')]) {
    const res = await fetch(`${base}/onvif/media_service`, { method: 'POST', body });
    assert.equal(res.status, 400);
    await res.text();
  }
  const oversized = await fetch(`${base}/onvif/media_service`, { method: 'POST', body: 'x'.repeat(65537) });
  assert.equal(oversized.status, 413);
  await oversized.text();
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
  assert.equal((await fetch(`${base}/onvif/device_service`)).status, 405);
});

function digestHeader(password, nonce, created, username = 'camera') {
  const digest = createHash('sha1').update(Buffer.from(nonce, 'base64')).update(created).update(password).digest('base64');
  return builder.build({
    Security: {
      UsernameToken: {
        Username: username,
        Password: { '@_Type': 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest', '#text': digest },
        Nonce: nonce,
        Created: created
      }
    }
  });
}

test('optional UsernameToken digest authentication rejects replay, bad passwords and stale timestamps', async t => {
  const authenticated = { ...config, username: 'camera', password: 'unit-test-only' };
  const call = await serve(t, authenticated);
  assert.equal((await call('GetProfiles')).status, 401);
  assert.equal((await call('GetSystemDateAndTime', '', 'device')).status, 200);
  const nonce = Buffer.from('unique-test-nonce').toString('base64');
  const header = digestHeader(authenticated.password, nonce, new Date().toISOString());
  assert.equal((await call('GetProfiles', '', 'media', header)).status, 200);
  assert.equal((await call('GetProfiles', '', 'media', header)).status, 401);
  const unpaddedNonce = header.replace(`<Nonce>${nonce}</Nonce>`, `<Nonce>${nonce.replace(/=+$/, '')}</Nonce>`);
  assert.equal((await call('GetProfiles', '', 'media', unpaddedNonce)).status, 401);
  const stale = digestHeader(authenticated.password, nonce, new Date(Date.now() - 600000).toISOString());
  assert.equal(authorized(parseXml(`<Header>${stale}</Header>`).Header, authenticated, new Map()), false);
  const bad = digestHeader('incorrect', nonce, new Date().toISOString());
  assert.equal((await call('GetProfiles', '', 'media', bad)).status, 401);
});

test('authentication decodes predefined and numeric XML escapes without allowing DTDs', async t => {
  const authenticated = { ...config, username: 'cam&operator', password: 'unit-test-only' };
  const call = await serve(t, authenticated);
  const header = digestHeader(authenticated.password,
    Buffer.from('escaped-username-nonce').toString('base64'), new Date().toISOString(), authenticated.username);
  assert.equal((await call('GetProfiles', '', 'media', header)).status, 200);
  assert.equal(parseXml('<value>&amp;&lt;&gt;&quot;&apos;&#38;&#x26;</value>').value, '&<>"\'&&');
  assert.throws(() => parseXml('<!DOCTYPE value [<!ENTITY x "expanded">]><value>&x;</value>'), /Invalid XML/);
});

test('WS-Discovery correlates probes, filters scopes/types and advertises correct metadata', () => {
  const probe = (body = '') => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header><MessageID>urn:uuid:test</MessageID></s:Header><s:Body><Probe>${body}</Probe></s:Body></s:Envelope>`;
  assert.equal(matchesProbe(probe(), config), 'urn:uuid:test');
  assert.equal(matchesProbe(probe('<Types>dn:NetworkVideoTransmitter</Types>'), config), 'urn:uuid:test');
  assert.equal(matchesProbe(probe('<Types>dn:Printer</Types>'), config), undefined);
  assert.equal(matchesProbe(probe('<Scopes>onvif://www.onvif.org/hardware/Other</Scopes>'), config), undefined);
  assert.equal(matchesProbe(probe('<Scopes>onvif://www.onvif.org/hardware</Scopes>'), config), 'urn:uuid:test');
  const match = parseXml(discoveryMessage(config, 'ProbeMatches', 'urn:uuid:test'));
  assert.equal(match.Envelope.Header.RelatesTo, 'urn:uuid:test');
  assert.equal(match.Envelope.Body.ProbeMatches.ProbeMatch.XAddrs, 'http://192.168.1.20:8000/onvif/device_service');
  assert.match(match.Envelope.Body.ProbeMatches.ProbeMatch.EndpointReference.Address, /^urn:uuid:/);
  assert.ok(parseXml(discoveryMessage(config, 'Hello')).Envelope.Body.Hello);
  assert.ok(parseXml(discoveryMessage(config, 'Bye')).Envelope.Body.Bye);
});

test('audio encoder settings are configurable', async t => {
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_AUDIO_BITRATE: '0' }), /CAMERA_AUDIO_BITRATE/);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_AUDIO_CHANNELS: '3' }), /CAMERA_AUDIO_CHANNELS/);
  assert.throws(() => loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_AUDIO_SAMPLE_RATE: '48' }), /CAMERA_AUDIO_SAMPLE_RATE/);
  const call = await serve(t, loadConfig({ CAMERA_ADDRESS: config.address, CAMERA_AUDIO_BITRATE: '64', CAMERA_AUDIO_SAMPLE_RATE: '48000', CAMERA_AUDIO_CHANNELS: '1' }));
  assert.equal(Number((await call('GetAudioSources')).body.GetAudioSourcesResponse.AudioSources.Channels), 1);
  const options = (await call('GetAudioEncoderConfigurationOptions')).body.GetAudioEncoderConfigurationOptionsResponse.Options.Options;
  assert.equal(options.Encoding, 'AAC');
  assert.equal(Number(options.BitrateList.Items), 64);
  assert.equal(Number(options.SampleRateList.Items), 48);
});

test('stream settings probed by ffprobe fill only unset values', () => {
  const probed = parseProbe(JSON.stringify({
    streams: [
      { codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '30000/1001', r_frame_rate: '30/1' },
      { codec_type: 'audio', sample_rate: '48000', channels: 1, bit_rate: '96000' }
    ]
  }));
  assert.deepEqual(probed, {
    CAMERA_WIDTH: '1280',
    CAMERA_HEIGHT: '720',
    CAMERA_FPS: '30',
    CAMERA_AUDIO: 'true',
    CAMERA_AUDIO_BITRATE: '96',
    CAMERA_AUDIO_SAMPLE_RATE: '48000',
    CAMERA_AUDIO_CHANNELS: '1'
  });
  const videoOnly = parseProbe(JSON.stringify({
    streams: [{ codec_type: 'video', width: 640, height: 480, avg_frame_rate: '0/0', r_frame_rate: '15/1', bit_rate: '2000000' }]
  }));
  assert.deepEqual(videoOnly, { CAMERA_WIDTH: '640', CAMERA_HEIGHT: '480', CAMERA_FPS: '15', CAMERA_BITRATE: '2000', CAMERA_AUDIO: 'false' });
  assert.throws(() => parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio' }] })), /no video/);

  const env = { CAMERA_ADDRESS: config.address, CAMERA_WIDTH: '1920', CAMERA_AUDIO_CHANNELS: '' };
  assert.deepEqual(unsetProbedKeys(env), [
    'CAMERA_HEIGHT', 'CAMERA_FPS', 'CAMERA_BITRATE', 'CAMERA_AUDIO',
    'CAMERA_AUDIO_BITRATE', 'CAMERA_AUDIO_SAMPLE_RATE', 'CAMERA_AUDIO_CHANNELS'
  ]);
  const merged = loadConfig(env, {}, { ...probed, CAMERA_FPS: '120', CAMERA_ADDRESS: '192.168.1.99' });
  assert.deepEqual(
    [merged.width, merged.height, merged.fps, merged.audio, merged.audioSampleRate, merged.audioChannels, merged.address],
    [1920, 720, 30, true, 48000, 1, config.address]
  );
  assert.equal(loadConfig(env, {}, videoOnly).audio, false);
});

test('snapshots are served only when a frame grabber is available', async t => {
  const call = await serve(t);
  const getSnapshotUri = '<trt:ProfileToken>main</trt:ProfileToken>';
  assert.equal((await call('GetSnapshotUri', getSnapshotUri)).status, 500);
  assert.equal((await call('GetServiceCapabilities')).body.GetServiceCapabilitiesResponse.Capabilities['@_SnapshotUri'], 'false');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let failing = false;
  const server = createCameraServer(config, { snapshot: async () => {
    if (failing) throw new Error('No stream');
    return jpeg;
  } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const soap = async (operation, body) => {
    const res = await fetch(`${base}/onvif/media_service`, { method: 'POST', body: request(operation, body) });
    return { status: res.status, body: parseXml(await res.text()).Envelope.Body };
  };
  assert.equal((await soap('GetServiceCapabilities')).body.GetServiceCapabilitiesResponse.Capabilities['@_SnapshotUri'], 'true');
  assert.equal((await soap('GetSnapshotUri')).status, 500);
  const uri = (await soap('GetSnapshotUri', getSnapshotUri)).body.GetSnapshotUriResponse.MediaUri.Uri;
  assert.equal(uri, 'http://192.168.1.20:8000/onvif/snapshot.jpg');
  const image = await fetch(`${base}/onvif/snapshot.jpg`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/onvif/snapshot.jpg`, { method: 'POST' })).status, 405);
  failing = true;
  const unavailable = await fetch(`${base}/onvif/snapshot.jpg`);
  assert.equal(unavailable.status, 503);
  await unavailable.text();
});

test('snapshot URL contains a secret when authentication is enabled', async t => {
  const authenticated = { ...config, username: 'camera', password: 'unit-test-only' };
  const server = createCameraServer(authenticated, { snapshot: async () => Buffer.from([0xff, 0xd8]) }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const header = digestHeader(authenticated.password, Buffer.from('snapshot-nonce').toString('base64'), new Date().toISOString());
  const res = await fetch(`${base}/onvif/media_service`, {
    method: 'POST', body: request('GetSnapshotUri', '<trt:ProfileToken>main</trt:ProfileToken>', header)
  });
  assert.equal(res.status, 200);
  const uri = new URL(parseXml(await res.text()).Envelope.Body.GetSnapshotUriResponse.MediaUri.Uri);
  assert.match(uri.pathname, /^\/onvif\/snapshot\/[0-9a-f]{32}\.jpg$/);
  assert.equal((await fetch(`${base}/onvif/snapshot.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/onvif/snapshot/${'0'.repeat(32)}.jpg`)).status, 404);
  const image = await fetch(`${base}${uri.pathname}`);
  assert.equal(image.status, 200);
  await image.arrayBuffer();
});
