import { createHash, timingSafeEqual } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true
});

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, char => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
  })[char]);
}

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Invalid XML');
  }
  return parser.parse(xml);
}

function envelope(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
 xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
 xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
 xmlns:tt="http://www.onvif.org/ver10/schema">
<s:Body>${body}</s:Body></s:Envelope>`;
}

function fault(code, reason) {
  return envelope(`<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value xmlns:ter="http://www.onvif.org/ver10/error">ter:${code}</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en">${escapeXml(reason)}</s:Text></s:Reason></s:Fault>`);
}

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function text(value) {
  return typeof value === 'string' ? value : value?.['#text'] || '';
}

function authorized(header, config, usedNonces, now = Date.now()) {
  if (!config.username) return true;
  const token = header?.Security?.UsernameToken;
  if (!token || !equal(text(token.Username), config.username)) return false;
  const created = text(token.Created);
  const timestamp = Date.parse(created);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300000) return false;
  const nonce = text(token.Nonce);
  const type = token.Password?.['@_Type'] || '';
  // Digest only: never accept a plaintext password over HTTP.
  if (!type.endsWith('#PasswordDigest') || !nonce || !/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) return false;
  const nonceBytes = Buffer.from(nonce, 'base64');
  if (!nonceBytes.length) return false;
  const nonceKey = nonceBytes.toString('base64');
  for (const [key, expires] of usedNonces) {
    if (expires <= now) usedNonces.delete(key);
  }
  if (usedNonces.has(nonceKey) || usedNonces.size >= 10000) return false;
  const expected = createHash('sha1')
    .update(nonceBytes).update(created).update(config.password).digest('base64');
  if (!equal(text(token.Password), expected)) return false;
  usedNonces.set(nonceKey, timestamp + 300000);
  return true;
}

export { authorized, envelope, escapeXml, fault, parseXml };
