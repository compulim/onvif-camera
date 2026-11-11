import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { cameraScopes, deviceUrl } from './camera.js';
import { buildXml, parseXml } from './soap.js';

const group = '239.255.255.250';
const port = 3702;
const discoveryNamespace = 'http://schemas.xmlsoap.org/ws/2005/04/discovery';
const addressingNamespace = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';

const ProbeEnvelopeSchema = v.looseObject({
  Envelope: v.looseObject({
    Header: v.looseObject({ MessageID: v.pipe(v.string(), v.minLength(1), v.maxLength(256)) }),
    Body: v.looseObject({
      // An empty <Probe/> parses to an empty string.
      Probe: v.union([
        v.literal(''),
        v.looseObject({
          Types: v.optional(v.string(), ''),
          Scopes: v.optional(v.union([
            v.string(),
            v.looseObject({ '#text': v.optional(v.string(), ''), '@_MatchBy': v.optional(v.string()) })
          ]), '')
        })
      ])
    })
  })
});

function discoveryMessage(config, action, relatesTo, sequence = 1) {
  const endpoint = { 'a:EndpointReference': { 'a:Address': `urn:uuid:${config.uuid}` } };
  const metadata = {
    'd:Types': 'dn:NetworkVideoTransmitter',
    'd:Scopes': cameraScopes(config).join(' '),
    'd:XAddrs': deviceUrl(config),
    'd:MetadataVersion': 1
  };
  const content = action === 'ProbeMatches'
    ? { 'd:ProbeMatches': { 'd:ProbeMatch': { ...endpoint, ...metadata } } }
    : { [`d:${action}`]: { ...endpoint, ...(action === 'Bye' ? {} : metadata) } };
  return buildXml({
    's:Envelope': {
      '@_xmlns:s': 'http://www.w3.org/2003/05/soap-envelope',
      '@_xmlns:a': addressingNamespace,
      '@_xmlns:d': discoveryNamespace,
      '@_xmlns:dn': 'http://www.onvif.org/ver10/network/wsdl',
      's:Header': {
        'a:MessageID': `urn:uuid:${randomUUID()}`,
        'a:To': relatesTo ? `${addressingNamespace}/role/anonymous` : 'urn:schemas-xmlsoap-org:ws:2005:04:discovery',
        'a:Action': `${discoveryNamespace}/${action}`,
        ...(relatesTo ? { 'a:RelatesTo': relatesTo } : {}),
        'd:AppSequence': { '@_InstanceId': config.instanceId || 1, '@_MessageNumber': sequence }
      },
      's:Body': content
    }
  });
}

function matchesProbe(xml, config) {
  const result = v.safeParse(ProbeEnvelopeSchema, parseXml(xml));
  if (!result.success) return undefined;
  const { Header: header, Body: { Probe: probe } } = result.output.Envelope;
  const types = probe === '' ? '' : probe.Types;
  if (types.split(/\s+/).filter(Boolean).some(type => !type.endsWith(':NetworkVideoTransmitter') && type !== 'NetworkVideoTransmitter')) return undefined;
  const scopeNode = probe === '' ? '' : probe.Scopes;
  const scopes = typeof scopeNode === 'string' ? scopeNode : scopeNode['#text'];
  const matchBy = typeof scopeNode === 'string' ? undefined : scopeNode['@_MatchBy'];
  if (matchBy && matchBy !== `${discoveryNamespace}/rfc3986`) return undefined;
  if (!scopes.split(/\s+/).filter(Boolean).every(scope =>
    cameraScopes(config).some(own => own === scope || own.startsWith(`${scope.replace(/\/$/, '')}/`)))) return undefined;
  return header.MessageID;
}

function startDiscovery(config, onError = console.error) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const instance = { ...config, instanceId: Math.floor(Date.now() / 1000) };
  let sequence = 0;
  let ready = false;
  let allowance = 20;
  let lastRefill = Date.now();
  const send = (action, id, targetPort = port, address = group, callback) =>
    socket.send(Buffer.from(discoveryMessage(instance, action, id, ++sequence)), targetPort, address, callback);
  socket.on('error', onError);
  socket.on('message', (message, remote) => {
    if (!ready || message.length > 8192) return;
    const now = Date.now();
    allowance = Math.min(20, allowance + (now - lastRefill) / 100);
    lastRefill = now;
    if (allowance < 1) return;
    allowance--;
    try {
      const id = matchesProbe(message.toString('utf8'), config);
      if (id) send('ProbeMatches', id, remote.port, remote.address);
    } catch {
      // Ignore malformed multicast traffic from other devices.
    }
  });
  socket.bind(port, '0.0.0.0', () => {
    try {
      socket.addMembership(group, config.address);
      socket.setMulticastInterface(config.address);
      socket.setMulticastTTL(1);
      ready = true;
      send('Hello');
    } catch (error) {
      onError(error);
    }
  });
  return {
    close() {
      return new Promise(resolve => {
        if (ready) {
          ready = false;
          send('Bye', undefined, port, group, () => socket.close(resolve));
        } else {
          socket.close(resolve);
        }
      });
    }
  };
}

export { discoveryMessage, matchesProbe, startDiscovery };
