// Web Push with no payload. The push only wakes the service worker, which then asks the hub
// what to show, so message text never passes through a browser vendor's push service.
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

export function loadVapidKeys(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const rawPublic = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const keys = {
    public: b64url(rawPublic),
    private_jwk: privateKey.export({ format: 'jwk' }),
  };
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function vapidHeader(endpoint, keys, subject, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey({ key: keys.private_jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.public}`;
}

// Resolves to 'sent', 'gone' when the subscription should be deleted, or 'failed'.
export async function sendWake(endpoint, keys, subject) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(endpoint, keys, subject),
        TTL: '86400',
        Urgency: 'high',
        'Content-Length': '0',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404 || response.status === 410) return 'gone';
    return response.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
