import { createServer } from 'node:http';
import { authorized, envelope, escapeXml as x, fault, parseXml } from './soap.js';

const profileToken = 'main';
const scopes = [
  'onvif://www.onvif.org/type/video_encoder',
  'onvif://www.onvif.org/Profile/Streaming',
  'onvif://www.onvif.org/hardware/RaspberryPi'
];

function cameraScopes(config) {
  return [...scopes, `onvif://www.onvif.org/name/${encodeURIComponent(config.name)}`];
}

function deviceUrl(config) {
  return `http://${config.address}:${config.port}/onvif/device_service`;
}

function videoSourceConfig(config) {
  return `<tt:VideoSourceConfiguration token="video_source"><tt:Name>Video source</tt:Name><tt:UseCount>1</tt:UseCount><tt:SourceToken>video</tt:SourceToken><tt:Bounds x="0" y="0" width="${config.width}" height="${config.height}"/></tt:VideoSourceConfiguration>`;
}

function videoEncoderConfig(config) {
  return `<tt:VideoEncoderConfiguration token="video_encoder"><tt:Name>H264</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${config.width}</tt:Width><tt:Height>${config.height}</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality><tt:RateControl><tt:FrameRateLimit>${config.fps}</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>${config.bitrate}</tt:BitrateLimit></tt:RateControl><tt:H264><tt:GovLength>${config.fps * 2}</tt:GovLength><tt:H264Profile>Main</tt:H264Profile></tt:H264><tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address><tt:Port>0</tt:Port><tt:TTL>1</tt:TTL><tt:AutoStart>false</tt:AutoStart></tt:Multicast><tt:SessionTimeout>PT60S</tt:SessionTimeout></tt:VideoEncoderConfiguration>`;
}

function audioSourceConfig() {
  return '<tt:AudioSourceConfiguration token="audio_source"><tt:Name>Audio source</tt:Name><tt:UseCount>1</tt:UseCount><tt:SourceToken>audio</tt:SourceToken></tt:AudioSourceConfiguration>';
}

function audioEncoderConfig(config) {
  return `<tt:AudioEncoderConfiguration token="audio_encoder"><tt:Name>${config.audioEncoding}</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>${config.audioEncoding}</tt:Encoding><tt:Bitrate>${config.audioBitrate}</tt:Bitrate><tt:SampleRate>${config.audioSampleRate}</tt:SampleRate><tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address><tt:Port>0</tt:Port><tt:TTL>1</tt:TTL><tt:AutoStart>false</tt:AutoStart></tt:Multicast><tt:SessionTimeout>PT60S</tt:SessionTimeout></tt:AudioEncoderConfiguration>`;
}

function profile(config) {
  return `<trt:Profiles token="${profileToken}" fixed="true"><tt:Name>${x(config.name)}</tt:Name>${videoSourceConfig(config)}${config.audio ? audioSourceConfig() : ''}${videoEncoderConfig(config)}${config.audio ? audioEncoderConfig(config) : ''}</trt:Profiles>`;
}

function capabilities(config) {
  const base = `http://${config.address}:${config.port}`;
  return `<tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr><tt:Network><tt:IPFilter>false</tt:IPFilter><tt:ZeroConfiguration>false</tt:ZeroConfiguration><tt:IPVersion6>false</tt:IPVersion6><tt:DynDNS>false</tt:DynDNS></tt:Network><tt:System><tt:DiscoveryResolve>false</tt:DiscoveryResolve><tt:DiscoveryBye>true</tt:DiscoveryBye><tt:RemoteDiscovery>false</tt:RemoteDiscovery><tt:SystemBackup>false</tt:SystemBackup><tt:SystemLogging>false</tt:SystemLogging><tt:FirmwareUpgrade>false</tt:FirmwareUpgrade><tt:SupportedVersions><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tt:SupportedVersions></tt:System><tt:IO/><tt:Security><tt:TLS1.1>false</tt:TLS1.1><tt:TLS1.2>false</tt:TLS1.2><tt:OnboardKeyGeneration>false</tt:OnboardKeyGeneration><tt:AccessPolicyConfig>false</tt:AccessPolicyConfig><tt:X.509Token>false</tt:X.509Token><tt:SAMLToken>false</tt:SAMLToken><tt:KerberosToken>false</tt:KerberosToken><tt:RELToken>false</tt:RELToken></tt:Security></tt:Device><tt:Media><tt:XAddr>${base}/onvif/media_service</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast><tt:RTP_TCP>true</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media>`;
}

function response(operation, args, config, media) {
  const ns = media ? 'trt' : 'tds';
  const wrap = body => envelope(`<${ns}:${operation}Response>${body}</${ns}:${operation}Response>`);
  const date = new Date();
  if (media) {
    if (['GetProfile', 'GetStreamUri'].includes(operation) && args?.ProfileToken === undefined) {
      return fault('NoProfile', 'A profile token is required');
    }
    if (args?.ProfileToken !== undefined && args.ProfileToken !== profileToken) {
      return fault('NoProfile', 'Unknown profile token');
    }
    const configurations = {
      VideoSource: { token: 'video_source', xml: videoSourceConfig(config) },
      VideoEncoder: { token: 'video_encoder', xml: videoEncoderConfig(config) },
      AudioSource: { token: 'audio_source', xml: config.audio ? audioSourceConfig() : '' },
      AudioEncoder: { token: 'audio_encoder', xml: config.audio ? audioEncoderConfig(config) : '' }
    };
    for (const [kind, value] of Object.entries(configurations)) {
      if (operation === `Get${kind}Configuration`) {
        if (!value.xml || args?.ConfigurationToken !== value.token) {
          return fault('NoConfig', 'Unknown configuration token');
        }
        return wrap(value.xml.replaceAll(`tt:${kind}Configuration`, 'trt:Configuration'));
      }
      if (operation === `GetCompatible${kind}Configurations`) {
        if (args?.ProfileToken !== profileToken) return fault('NoProfile', 'A profile token is required');
        return wrap(value.xml.replaceAll(`tt:${kind}Configuration`, 'trt:Configurations'));
      }
    }
    switch (operation) {
      case 'GetProfiles': return wrap(profile(config));
      case 'GetProfile':
        return wrap(profile(config).replaceAll('trt:Profiles', 'trt:Profile'));
      case 'GetStreamUri':
        if (args?.StreamSetup?.Stream !== 'RTP-Unicast' ||
            !['RTSP', 'TCP', 'UDP'].includes(args?.StreamSetup?.Transport?.Protocol)) {
          return fault('InvalidArgVal', 'Only unicast RTSP streaming is supported');
        }
        return wrap(`<trt:MediaUri><tt:Uri>rtsp://${config.address}:${config.rtspPort}/camera</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri>`);
      case 'GetVideoSources':
        return wrap(`<trt:VideoSources token="video"><tt:Framerate>${config.fps}</tt:Framerate><tt:Resolution><tt:Width>${config.width}</tt:Width><tt:Height>${config.height}</tt:Height></tt:Resolution></trt:VideoSources>`);
      case 'GetAudioSources':
        return wrap(config.audio ? `<trt:AudioSources token="audio"><tt:Channels>${config.audioChannels}</tt:Channels></trt:AudioSources>` : '');
      case 'GetVideoSourceConfigurations':
        return wrap(videoSourceConfig(config).replaceAll('tt:VideoSourceConfiguration', 'trt:Configurations'));
      case 'GetVideoEncoderConfigurations':
        return wrap(videoEncoderConfig(config).replaceAll('tt:VideoEncoderConfiguration', 'trt:Configurations'));
      case 'GetAudioSourceConfigurations':
        return wrap(config.audio ? audioSourceConfig().replaceAll('tt:AudioSourceConfiguration', 'trt:Configurations') : '');
      case 'GetAudioEncoderConfigurations':
        return wrap(config.audio ? audioEncoderConfig(config).replaceAll('tt:AudioEncoderConfiguration', 'trt:Configurations') : '');
      case 'GetVideoEncoderConfigurationOptions':
        if (args?.ConfigurationToken !== undefined && args.ConfigurationToken !== 'video_encoder') {
          return fault('NoConfig', 'Unknown configuration token');
        }
        return wrap(`<trt:Options><tt:QualityRange><tt:Min>5</tt:Min><tt:Max>5</tt:Max></tt:QualityRange><tt:H264><tt:ResolutionsAvailable><tt:Width>${config.width}</tt:Width><tt:Height>${config.height}</tt:Height></tt:ResolutionsAvailable><tt:GovLengthRange><tt:Min>${config.fps * 2}</tt:Min><tt:Max>${config.fps * 2}</tt:Max></tt:GovLengthRange><tt:FrameRateRange><tt:Min>${config.fps}</tt:Min><tt:Max>${config.fps}</tt:Max></tt:FrameRateRange><tt:EncodingIntervalRange><tt:Min>1</tt:Min><tt:Max>1</tt:Max></tt:EncodingIntervalRange><tt:H264ProfilesSupported>Main</tt:H264ProfilesSupported></tt:H264></trt:Options>`);
      case 'GetAudioEncoderConfigurationOptions':
        if (args?.ConfigurationToken !== undefined && args.ConfigurationToken !== 'audio_encoder') {
          return fault('NoConfig', 'Unknown configuration token');
        }
        return wrap(config.audio ? `<trt:Options><tt:Encoding>${config.audioEncoding}</tt:Encoding><tt:BitrateList><tt:Items>${config.audioBitrate}</tt:Items></tt:BitrateList><tt:SampleRateList><tt:Items>${config.audioSampleRate}</tt:Items></tt:SampleRateList></trt:Options>` : '');
      case 'GetServiceCapabilities':
        return wrap('<trt:Capabilities SnapshotUri="false" Rotation="false" VideoSourceMode="false" OSD="false"><trt:ProfileCapabilities MaximumNumberOfProfiles="1"/><trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="true" RTP_RTSP_TCP="true" NonAggregateControl="false"/></trt:Capabilities>');
      default: return fault('ActionNotSupported', 'This read-only camera does not support this operation');
    }
  }
  switch (operation) {
    case 'GetDeviceInformation':
      return wrap('<tds:Manufacturer>rpi-onvif-camera</tds:Manufacturer><tds:Model>Raspberry Pi</tds:Model><tds:FirmwareVersion>1.0.0</tds:FirmwareVersion><tds:SerialNumber>' + x(config.uuid) + '</tds:SerialNumber><tds:HardwareId>rpi-onvif-camera</tds:HardwareId>');
    case 'GetSystemDateAndTime':
      return wrap(`<tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone><tt:UTCDateTime><tt:Time><tt:Hour>${date.getUTCHours()}</tt:Hour><tt:Minute>${date.getUTCMinutes()}</tt:Minute><tt:Second>${date.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${date.getUTCFullYear()}</tt:Year><tt:Month>${date.getUTCMonth() + 1}</tt:Month><tt:Day>${date.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime>`);
    case 'GetCapabilities':
      return wrap(`<tds:Capabilities>${capabilities(config)}</tds:Capabilities>`);
    case 'GetServices':
      return wrap(['device', 'media'].map(service => `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/${service}/wsdl</tds:Namespace><tds:XAddr>http://${config.address}:${config.port}/onvif/${service}_service</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version></tds:Service>`).join(''));
    case 'GetScopes':
      return wrap(cameraScopes(config).map(scope => `<tds:Scopes><tt:ScopeDef>Fixed</tt:ScopeDef><tt:ScopeItem>${x(scope)}</tt:ScopeItem></tds:Scopes>`).join(''));
    case 'GetHostname': return wrap('<tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP><tt:Name>rpi-onvif-camera</tt:Name></tds:HostnameInformation>');
    case 'GetDiscoveryMode': return wrap(`<tds:DiscoveryMode>${config.discovery ? 'Discoverable' : 'NonDiscoverable'}</tds:DiscoveryMode>`);
    case 'GetServiceCapabilities':
      return wrap(`<tds:Capabilities><tds:Network IPFilter="false" ZeroConfiguration="false" IPVersion6="false" DynDNS="false"/><tds:Security TLS1.0="false" TLS1.1="false" TLS1.2="false" UsernameToken="${Boolean(config.username)}" HttpDigest="false"/><tds:System DiscoveryResolve="false" DiscoveryBye="true" RemoteDiscovery="false" SystemBackup="false" SystemLogging="false" FirmwareUpgrade="false"/></tds:Capabilities>`);
    case 'GetNetworkProtocols':
      return wrap(`<tds:NetworkProtocols><tt:Name>HTTP</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${config.port}</tt:Port></tds:NetworkProtocols><tds:NetworkProtocols><tt:Name>RTSP</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${config.rtspPort}</tt:Port></tds:NetworkProtocols>`);
    default: return fault('ActionNotSupported', 'This read-only camera does not support this operation');
  }
}

function createCameraServer(config) {
  const nonces = new Map();
  const server = createServer(async (req, res) => {
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
      const document = parseXml(Buffer.concat(chunks).toString('utf8'));
      const body = document.Envelope?.Body;
      const operations = Object.keys(body || {}).filter(key => !key.startsWith('@_'));
      if (operations.length !== 1) throw new Error('Expected one SOAP operation');
      const operation = operations[0];
      let payload;
      if (!(req.url === '/onvif/device_service' && operation === 'GetSystemDateAndTime') &&
          !authorized(document.Envelope?.Header, config, nonces)) {
        res.writeHead(401, { 'Content-Type': 'application/soap+xml; charset=utf-8' })
          .end(fault('NotAuthorized', 'A fresh WS-Security UsernameToken digest is required'));
        return;
      }
      payload = response(operation, body[operation], config, req.url === '/onvif/media_service');
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
