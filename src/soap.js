import { createHash, timingSafeEqual } from 'node:crypto';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import * as v from 'valibot';

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  suppressEmptyNode: true,
  suppressBooleanAttributes: false
});

// Parsed element text: either a plain string or an element with attributes and text.
const TextSchema = v.union([
  v.string(),
  v.pipe(
    v.looseObject({ '#text': v.optional(v.string(), '') }),
    v.check(node => Object.keys(node).every(key => key === '#text' || key.startsWith('@_'))),
    v.transform(node => node['#text'])
  )
]);

const UsernameTokenSchema = v.looseObject({
  Username: TextSchema,
  // Digest only: never accept a plaintext password over HTTP.
  Password: v.looseObject({
    '#text': v.string(),
    '@_Type': v.pipe(v.string(), v.endsWith('#PasswordDigest'))
  }),
  Nonce: v.pipe(TextSchema, v.regex(/^[A-Za-z0-9+/]+={0,2}$/)),
  Created: TextSchema
});

const SecurityHeaderSchema = v.looseObject({
  Security: v.looseObject({ UsernameToken: UsernameTokenSchema })
});

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error('Invalid XML');
  }
  return parser.parse(xml);
}

function buildXml(document) {
  return builder.build({ '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' }, ...document });
}

function envelope(body) {
  return buildXml({
    's:Envelope': {
      '@_xmlns:s': 'http://www.w3.org/2003/05/soap-envelope',
      '@_xmlns:tds': 'http://www.onvif.org/ver10/device/wsdl',
      '@_xmlns:trt': 'http://www.onvif.org/ver10/media/wsdl',
      '@_xmlns:tt': 'http://www.onvif.org/ver10/schema',
      's:Body': body
    }
  });
}

function fault(code, reason) {
  return envelope({
    's:Fault': {
      's:Code': {
        's:Value': 's:Sender',
        's:Subcode': { 's:Value': { '@_xmlns:ter': 'http://www.onvif.org/ver10/error', '#text': `ter:${code}` } }
      },
      's:Reason': { 's:Text': { '@_xml:lang': 'en', '#text': reason } }
    }
  });
}

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(header, config, usedNonces, now = Date.now()) {
  if (!config.username) return true;
  const result = v.safeParse(SecurityHeaderSchema, header);
  if (!result.success) return false;
  const token = result.output.Security.UsernameToken;
  if (!equal(token.Username, config.username)) return false;
  const timestamp = Date.parse(token.Created);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300000) return false;
  const nonceBytes = Buffer.from(token.Nonce, 'base64');
  if (!nonceBytes.length) return false;
  const nonceKey = nonceBytes.toString('base64');
  for (const [key, expires] of usedNonces) {
    if (expires <= now) usedNonces.delete(key);
  }
  if (usedNonces.has(nonceKey) || usedNonces.size >= 10000) return false;
  const expected = createHash('sha1')
    .update(nonceBytes).update(token.Created).update(config.password).digest('base64');
  if (!equal(token.Password['#text'], expected)) return false;
  usedNonces.set(nonceKey, timestamp + 300000);
  return true;
}

export { authorized, buildXml, envelope, fault, parseXml, TextSchema };
