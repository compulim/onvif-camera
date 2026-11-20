import { createServer } from 'node:http';
import * as v from 'valibot';
import { authorized, envelope, fault, parseXml, TextSchema } from './soap.js';

const profileToken = 'main';
const scopes = [
  'onvif://www.onvif.org/type/video_encoder',
  'onvif://www.onvif.org/Profile/Streaming'
];

const StreamSetupSchema = v.looseObject({
  Stream: v.optional(TextSchema),
  Transport: v.optional(v.looseObject({ Protocol: v.optional(TextSchema) }))
});

// An empty request element (e.g. <trt:GetProfiles/>) parses to an empty string.
const RequestSchema = v.pipe(
  v.union([
    v.literal(''),
    v.looseObject({
      ProfileToken: v.optional(TextSchema),
      ConfigurationToken: v.optional(TextSchema),
      StreamSetup: v.optional(StreamSetupSchema)
    })
  ]),
  v.transform(args => args === '' ? {} : args)
);

const SoapEnvelopeSchema = v.looseObject({
  Envelope: v.looseObject({
    Header: v.optional(v.unknown()),
    Body: v.looseObject({})
  })
});

function cameraScopes(config) {
  return [
    ...scopes,
    ...(config.audio ? ['onvif://www.onvif.org/type/audio_encoder'] : []),
    `onvif://www.onvif.org/hardware/${encodeURIComponent(config.model)}`,
    `onvif://www.onvif.org/name/${encodeURIComponent(config.name)}`
  ];
}

function deviceUrl(config) {
  return `http://${config.address}:${config.port}/onvif/device_service`;
}

function multicast() {
  return {
    'tt:Address': { 'tt:Type': 'IPv4', 'tt:IPv4Address': '0.0.0.0' },
    'tt:Port': 0,
    'tt:TTL': 1,
    'tt:AutoStart': 'false'
  };
}

function videoSourceConfig(config) {
  return {
    '@_token': 'video_source',
    'tt:Name': 'Video source',
    'tt:UseCount': 1,
    'tt:SourceToken': 'video',
    'tt:Bounds': { '@_x': 0, '@_y': 0, '@_width': config.width, '@_height': config.height }
  };
}

function videoEncoderConfig(config) {
  return {
    '@_token': 'video_encoder',
    'tt:Name': 'H264',
    'tt:UseCount': 1,
    'tt:Encoding': 'H264',
    'tt:Resolution': { 'tt:Width': config.width, 'tt:Height': config.height },
    'tt:Quality': 5,
    'tt:RateControl': {
      'tt:FrameRateLimit': config.fps,
      'tt:EncodingInterval': 1,
      'tt:BitrateLimit': config.bitrate
    },
    'tt:H264': { 'tt:GovLength': config.fps * 2, 'tt:H264Profile': 'Main' },
    'tt:Multicast': multicast(),
    'tt:SessionTimeout': 'PT60S'
  };
}

function audioSourceConfig() {
  return {
    '@_token': 'audio_source',
    'tt:Name': 'Audio source',
    'tt:UseCount': 1,
    'tt:SourceToken': 'audio'
  };
}

// ONVIF Media1 expresses audio sample rate in kHz (xs:int), e.g. 44100 Hz -> 44.
function audioSampleRateKHz(config) {
  return Math.round(config.audioSampleRate / 1000);
}

function audioEncoderConfig(config) {
  return {
    '@_token': 'audio_encoder',
    'tt:Name': 'AAC',
    'tt:UseCount': 1,
    'tt:Encoding': 'AAC',
    'tt:Bitrate': config.audioBitrate,
    'tt:SampleRate': audioSampleRateKHz(config),
    'tt:Multicast': multicast(),
    'tt:SessionTimeout': 'PT60S'
  };
}

function profile(config) {
  return {
    '@_token': profileToken,
    '@_fixed': 'true',
    'tt:Name': config.name,
    'tt:VideoSourceConfiguration': videoSourceConfig(config),
    ...(config.audio ? { 'tt:AudioSourceConfiguration': audioSourceConfig() } : {}),
    'tt:VideoEncoderConfiguration': videoEncoderConfig(config),
    ...(config.audio ? { 'tt:AudioEncoderConfiguration': audioEncoderConfig(config) } : {})
  };
}

function capabilities(config) {
  const base = `http://${config.address}:${config.port}`;
  return {
    'tt:Device': {
      'tt:XAddr': `${base}/onvif/device_service`,
      'tt:Network': {
        'tt:IPFilter': 'false',
        'tt:ZeroConfiguration': 'false',
        'tt:IPVersion6': 'false',
        'tt:DynDNS': 'false'
      },
      'tt:System': {
        'tt:DiscoveryResolve': 'false',
        'tt:DiscoveryBye': 'true',
        'tt:RemoteDiscovery': 'false',
        'tt:SystemBackup': 'false',
        'tt:SystemLogging': 'false',
        'tt:FirmwareUpgrade': 'false',
        'tt:SupportedVersions': { 'tt:Major': 2, 'tt:Minor': 0 }
      },
      'tt:IO': '',
      'tt:Security': {
        'tt:TLS1.1': 'false',
        'tt:TLS1.2': 'false',
        'tt:OnboardKeyGeneration': 'false',
        'tt:AccessPolicyConfig': 'false',
        'tt:X.509Token': 'false',
        'tt:SAMLToken': 'false',
        'tt:KerberosToken': 'false',
        'tt:RELToken': 'false'
      }
    },
    'tt:Media': {
      'tt:XAddr': `${base}/onvif/media_service`,
      'tt:StreamingCapabilities': {
        'tt:RTPMulticast': 'false',
        'tt:RTP_TCP': 'true',
        'tt:RTP_RTSP_TCP': 'true'
      }
    }
  };
}

function response(operation, rawArgs, config, media) {
  const ns = media ? 'trt' : 'tds';
  const wrap = (body = '') => envelope({ [`${ns}:${operation}Response`]: body });
  const parsed = v.safeParse(RequestSchema, rawArgs);
  if (!parsed.success) return fault('InvalidArgVal', 'Invalid request arguments');
  const args = parsed.output;
  const date = new Date();
  if (media) {
    if (['GetProfile', 'GetStreamUri'].includes(operation) && args.ProfileToken === undefined) {
      return fault('NoProfile', 'A profile token is required');
    }
    if (args.ProfileToken !== undefined && args.ProfileToken !== profileToken) {
      return fault('NoProfile', 'Unknown profile token');
    }
    const configurations = {
      VideoSource: { token: 'video_source', content: videoSourceConfig(config) },
      VideoEncoder: { token: 'video_encoder', content: videoEncoderConfig(config) },
      AudioSource: { token: 'audio_source', content: config.audio ? audioSourceConfig() : undefined },
      AudioEncoder: { token: 'audio_encoder', content: config.audio ? audioEncoderConfig(config) : undefined }
    };
    for (const [kind, value] of Object.entries(configurations)) {
      if (operation === `Get${kind}Configuration`) {
        if (!value.content || args.ConfigurationToken !== value.token) {
          return fault('NoConfig', 'Unknown configuration token');
        }
        return wrap({ 'trt:Configuration': value.content });
      }
      if (operation === `GetCompatible${kind}Configurations`) {
        if (args.ProfileToken !== profileToken) return fault('NoProfile', 'A profile token is required');
        return wrap(value.content ? { 'trt:Configurations': value.content } : '');
      }
      if (operation === `Get${kind}Configurations`) {
        return wrap(value.content ? { 'trt:Configurations': value.content } : '');
      }
    }
    switch (operation) {
      case 'GetProfiles': return wrap({ 'trt:Profiles': profile(config) });
      case 'GetProfile': return wrap({ 'trt:Profile': profile(config) });
      case 'GetStreamUri':
        if (args.StreamSetup?.Stream !== 'RTP-Unicast' ||
            !['RTSP', 'TCP', 'UDP'].includes(args.StreamSetup?.Transport?.Protocol)) {
          return fault('InvalidArgVal', 'Only unicast RTSP streaming is supported');
        }
        return wrap({
          'trt:MediaUri': {
            'tt:Uri': config.rtspUrl,
            'tt:InvalidAfterConnect': 'false',
            'tt:InvalidAfterReboot': 'false',
            'tt:Timeout': 'PT0S'
          }
        });
      case 'GetVideoSources':
        return wrap({
          'trt:VideoSources': {
            '@_token': 'video',
            'tt:Framerate': config.fps,
            'tt:Resolution': { 'tt:Width': config.width, 'tt:Height': config.height }
          }
        });
      case 'GetAudioSources':
        return wrap(config.audio ? { 'trt:AudioSources': { '@_token': 'audio', 'tt:Channels': config.audioChannels } } : '');
      case 'GetVideoEncoderConfigurationOptions':
        if (args.ConfigurationToken !== undefined && args.ConfigurationToken !== 'video_encoder') {
          return fault('NoConfig', 'Unknown configuration token');
        }
        return wrap({
          'trt:Options': {
            'tt:QualityRange': { 'tt:Min': 5, 'tt:Max': 5 },
            'tt:H264': {
              'tt:ResolutionsAvailable': { 'tt:Width': config.width, 'tt:Height': config.height },
              'tt:GovLengthRange': { 'tt:Min': config.fps * 2, 'tt:Max': config.fps * 2 },
              'tt:FrameRateRange': { 'tt:Min': config.fps, 'tt:Max': config.fps },
              'tt:EncodingIntervalRange': { 'tt:Min': 1, 'tt:Max': 1 },
              'tt:H264ProfilesSupported': 'Main'
            }
          }
        });
      case 'GetAudioEncoderConfigurationOptions':
        if (args.ConfigurationToken !== undefined && args.ConfigurationToken !== 'audio_encoder') {
          return fault('NoConfig', 'Unknown configuration token');
        }
        return wrap(config.audio ? {
          'trt:Options': {
            'tt:Options': {
              'tt:Encoding': 'AAC',
              'tt:BitrateList': { 'tt:Items': config.audioBitrate },
              'tt:SampleRateList': { 'tt:Items': audioSampleRateKHz(config) }
            }
          }
        } : '');
      case 'GetServiceCapabilities':
        return wrap({
          'trt:Capabilities': {
            '@_SnapshotUri': 'false',
            '@_Rotation': 'false',
            '@_VideoSourceMode': 'false',
            '@_OSD': 'false',
            'trt:ProfileCapabilities': { '@_MaximumNumberOfProfiles': 1 },
            'trt:StreamingCapabilities': {
              '@_RTPMulticast': 'false',
              '@_RTP_TCP': 'true',
              '@_RTP_RTSP_TCP': 'true',
              '@_NonAggregateControl': 'false'
            }
          }
        });
      default: return fault('ActionNotSupported', 'This read-only camera does not support this operation');
    }
  }
  switch (operation) {
    case 'GetDeviceInformation':
      return wrap({
        'tds:Manufacturer': config.manufacturer,
        'tds:Model': config.model,
        'tds:FirmwareVersion': config.firmwareVersion,
        'tds:SerialNumber': config.serialNumber,
        'tds:HardwareId': config.hardwareId
      });
    case 'GetSystemDateAndTime':
      return wrap({
        'tds:SystemDateAndTime': {
          'tt:DateTimeType': 'NTP',
          'tt:DaylightSavings': 'false',
          'tt:TimeZone': { 'tt:TZ': 'UTC0' },
          'tt:UTCDateTime': {
            'tt:Time': { 'tt:Hour': date.getUTCHours(), 'tt:Minute': date.getUTCMinutes(), 'tt:Second': date.getUTCSeconds() },
            'tt:Date': { 'tt:Year': date.getUTCFullYear(), 'tt:Month': date.getUTCMonth() + 1, 'tt:Day': date.getUTCDate() }
          }
        }
      });
    case 'GetCapabilities':
      return wrap({ 'tds:Capabilities': capabilities(config) });
    case 'GetServices':
      return wrap({
        'tds:Service': ['device', 'media'].map(service => ({
          'tds:Namespace': `http://www.onvif.org/ver10/${service}/wsdl`,
          'tds:XAddr': `http://${config.address}:${config.port}/onvif/${service}_service`,
          'tds:Version': { 'tt:Major': 2, 'tt:Minor': 0 }
        }))
      });
    case 'GetScopes':
      return wrap({
        'tds:Scopes': cameraScopes(config).map(scope => ({ 'tt:ScopeDef': 'Fixed', 'tt:ScopeItem': scope }))
      });
    case 'GetHostname':
      return wrap({ 'tds:HostnameInformation': { 'tt:FromDHCP': 'false', 'tt:Name': 'rpi-onvif-camera' } });
    case 'GetDiscoveryMode':
      return wrap({ 'tds:DiscoveryMode': config.discovery ? 'Discoverable' : 'NonDiscoverable' });
    case 'GetServiceCapabilities':
      return wrap({
        'tds:Capabilities': {
          'tds:Network': { '@_IPFilter': 'false', '@_ZeroConfiguration': 'false', '@_IPVersion6': 'false', '@_DynDNS': 'false' },
          'tds:Security': {
            '@_TLS1.0': 'false',
            '@_TLS1.1': 'false',
            '@_TLS1.2': 'false',
            '@_UsernameToken': String(Boolean(config.username)),
            '@_HttpDigest': 'false'
          },
          'tds:System': {
            '@_DiscoveryResolve': 'false',
            '@_DiscoveryBye': 'true',
            '@_RemoteDiscovery': 'false',
            '@_SystemBackup': 'false',
            '@_SystemLogging': 'false',
            '@_FirmwareUpgrade': 'false'
          }
        }
      });
    case 'GetNetworkProtocols':
      return wrap({
        'tds:NetworkProtocols': [
          { 'tt:Name': 'HTTP', 'tt:Enabled': 'true', 'tt:Port': config.port },
          { 'tt:Name': 'RTSP', 'tt:Enabled': 'true', 'tt:Port': config.rtspPort }
        ]
      });
    default: return fault('ActionNotSupported', 'This read-only camera does not support this operation');
  }
}

function createCameraServer(config) {
  const nonces = new Map();
  const server = createServer(async (req, res) => {
    const remoteAddress = req.socket.remoteAddress;
    let operation;
    res.on('finish', () => {
      if (req.url !== '/health') {
        console.log(`ONVIF ${remoteAddress} ${req.method} ${req.url}${operation ? ` ${operation}` : ''} ${res.statusCode}`);
      }
    });
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok\n');
      return;
    }
    if (!['/onvif/device_service', '/onvif/media_service'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) {
          res.writeHead(413, { Connection: 'close' }).end();
          return;
        }
        chunks.push(chunk);
      }
      const document = v.parse(SoapEnvelopeSchema, parseXml(Buffer.concat(chunks).toString('utf8')));
      const { Body: body, Header: header } = document.Envelope;
      const operations = Object.keys(body).filter(key => !key.startsWith('@_'));
      if (operations.length !== 1) throw new Error('Expected one SOAP operation');
      operation = operations[0];
      if (!(req.url === '/onvif/device_service' && operation === 'GetSystemDateAndTime') &&
          !authorized(header, config, nonces)) {
        res.writeHead(401, { 'Content-Type': 'application/soap+xml; charset=utf-8' })
          .end(fault('NotAuthorized', 'A fresh WS-Security UsernameToken digest is required'));
        return;
      }
      const payload = response(operation, body[operation], config, req.url === '/onvif/media_service');
      res.writeHead(payload.includes('<s:Fault>') ? 500 : 200, {
        'Content-Type': 'application/soap+xml; charset=utf-8'
      }).end(payload);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/soap+xml; charset=utf-8' })
          .end(fault('InvalidArgVal', 'Malformed SOAP request'));
      }
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 10000;
  return server;
}

export { cameraScopes, createCameraServer, deviceUrl };
