import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { cameraScopes, deviceUrl } from './camera.js';
import { escapeXml as x, parseXml } from './soap.js';

const group = '239.255.255.250';
const port = 3702;
const discoveryNamespace = 'http://schemas.xmlsoap.org/ws/2005/04/discovery';
const addressingNamespace = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';

function discoveryMessage(config, action, relatesTo, sequence = 1) {
  const endpoint = `<a:EndpointReference><a:Address>urn:uuid:${config.uuid}</a:Address></a:EndpointReference>`;
  const metadata = `<d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>${cameraScopes(config).map(x).join(' ')}</d:Scopes><d:XAddrs>${x(deviceUrl(config))}</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion>`;
  const content = action === 'ProbeMatches'
    ? `<d:ProbeMatches><d:ProbeMatch>${endpoint}${metadata}</d:ProbeMatch></d:ProbeMatches>`
    : `<d:${action}>${endpoint}${action === 'Bye' ? '' : metadata}</d:${action}>`;
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="${addressingNamespace}" xmlns:d="${discoveryNamespace}" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><s:Header><a:MessageID>urn:uuid:${randomUUID()}</a:MessageID><a:To>${relatesTo ? `${addressingNamespace}/role/anonymous` : 'urn:schemas-xmlsoap-org:ws:2005:04:discovery'}</a:To><a:Action>${discoveryNamespace}/${action}</a:Action>${relatesTo ? `<a:RelatesTo>${x(relatesTo)}</a:RelatesTo>` : ''}<d:AppSequence InstanceId="${config.instanceId || 1}" MessageNumber="${sequence}"/></s:Header><s:Body>${content}</s:Body></s:Envelope>`;
}

function matchesProbe(xml, config) {
  const document = parseXml(xml);
  const probe = document.Envelope?.Body?.Probe;
  const id = document.Envelope?.Header?.MessageID;
  if (probe === undefined || typeof id !== 'string' || id.length > 256) return undefined;
  const types = probe?.Types || '';
  if (typeof types !== 'string' || types.split(/\s+/).filter(Boolean).some(type => !type.endsWith(':NetworkVideoTransmitter') && type !== 'NetworkVideoTransmitter')) return undefined;
  const scopes = typeof probe?.Scopes === 'string' ? probe.Scopes : probe?.Scopes?.['#text'] || '';
  const matchBy = probe?.Scopes?.['@_MatchBy'];
  if (matchBy && matchBy !== `${discoveryNamespace}/rfc3986`) return undefined;
  if (typeof scopes !== 'string' || !scopes.split(/\s+/).filter(Boolean).every(scope =>
    cameraScopes(config).some(own => own === scope || own.startsWith(`${scope.replace(/\/$/, '')}/`)))) return undefined;
  return id;
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
