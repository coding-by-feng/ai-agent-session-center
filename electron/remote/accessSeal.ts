/**
 * This computer's half of the account seal (plan 18, stage 2): a computer signed in to the same AASC Cloud account
 * connects to another one without a pairing link.
 *
 * It makes an ephemeral P-256 key pair per connection and sends only the public point. The backend answers the ticket
 * with a 32-byte seal secret that only it, this computer (through its own server, over TLS) and the machine that
 * redeems the ticket learn. The machine answers with its own ephemeral point and the device token sealed:
 *   shared = ECDH(clientPriv, machineKey)                        (32 bytes, the x-coordinate)
 *   key    = HKDF-SHA256(ikm = shared ‖ sealSecret, salt = utf8(nonce),
 *                        info = utf8('aasc-access-v1') ‖ clientKeyRaw(65) ‖ machineKeyRaw(65), 32 bytes)
 *   plain  = AES-256-GCM-open(key, iv, sealed, aad = utf8('aasc-access-v1:' + nonce + ':' + host:port))
 * The secret makes the seal the real machine's: any box on the network sees the public key and the nonce and could
 * seal a token of its own to them, but not without the secret. `host:port` is the address THIS computer dialled,
 * never one an answer names: a box that passes the request on to the machine gets a seal for the machine's address,
 * which does not open here. The same construction as the phone's (mobile/shell/src/enrollCrypto.ts, plan 17) with its
 * own domain string, so neither seal opens as the other.
 *
 * The private key stays in a closure, and nothing here logs.
 */
import { createDecipheriv, createECDH, hkdfSync } from 'crypto'

export const ACCESS_SEAL_INFO = 'aasc-access-v1'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/
/** 32 bytes, base64url: a ticket or its seal secret. */
export const B64U43 = /^[A-Za-z0-9_-]{43}$/
/** A 65-byte uncompressed P-256 point, base64url. */
export const KEY87 = /^[A-Za-z0-9_-]{87}$/
const IV16 = /^[A-Za-z0-9_-]{16}$/
/** The sealed JSON is a few hundred bytes; anything far larger isn't one. */
const SEALED = /^[A-Za-z0-9_-]{23,4096}$/
const HOST_PORT = /^[0-9a-z.-]{1,253}:\d{1,5}$/i

export interface ClientKey {
  /** The raw public point, base64url (KEY87): the only half that travels. */
  clientKey: string
  /** ECDH with the machine's public point. The private half is held by this function alone: no property holds it. */
  shared(machineKey: Buffer): Buffer
}

/** A fresh key pair for one connection. */
export function newClientKey(): ClientKey {
  const ecdh = createECDH('prime256v1')
  const clientKey = ecdh.generateKeys().toString('base64url') // uncompressed, 65 bytes
  return { clientKey, shared: (machineKey) => ecdh.computeSecret(machineKey) }
}

/** What the machine sealed: this computer's device there, and whether its owner still has to press Allow. */
export interface SealedAccess {
  deviceId: string
  deviceToken: string
  status: 'pending' | 'active'
  /** While pending: the 6-digit code the machine shows beside its Allow button. */
  confirmCode: string | null
}

function field(raw: unknown, key: string): unknown {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
}

/**
 * The device the machine sealed to `key`, when the answer opens with the ticket's `sealSecret` and the AAD naming
 * `nonce` and the address this computer dialled (`boundAddress`, from remoteClient's dialledAddress); null for anything else.
 * Never throws.
 */
export function openSealedAccess(
  key: ClientKey, answer: unknown, nonce: string, boundAddress: string, sealSecret: string,
): SealedAccess | null {
  if (!B64U43.test(sealSecret) || !HEX64.test(nonce) || !HOST_PORT.test(boundAddress) || !KEY87.test(key.clientKey)) return null
  const machineKeyText = field(answer, 'machineKey')
  const ivText = field(answer, 'iv')
  const sealedText = field(answer, 'sealed')
  if (typeof machineKeyText !== 'string' || !KEY87.test(machineKeyText)) return null
  if (typeof ivText !== 'string' || !IV16.test(ivText)) return null
  if (typeof sealedText !== 'string' || !SEALED.test(sealedText)) return null
  const secret = Buffer.from(sealSecret, 'base64url')
  const clientKeyRaw = Buffer.from(key.clientKey, 'base64url')
  const machineKeyRaw = Buffer.from(machineKeyText, 'base64url')
  const iv = Buffer.from(ivText, 'base64url')
  const sealed = Buffer.from(sealedText, 'base64url')
  if (secret.length !== 32 || clientKeyRaw.length !== 65 || machineKeyRaw.length !== 65 || machineKeyRaw[0] !== 0x04) return null
  if (iv.length !== 12 || sealed.length <= 16) return null
  let plain: unknown
  try {
    const shared = key.shared(machineKeyRaw) // throws for a point that isn't on the curve
    const aes = Buffer.from(hkdfSync(
      'sha256', Buffer.concat([shared, secret]), Buffer.from(nonce, 'utf8'),
      Buffer.concat([Buffer.from(ACCESS_SEAL_INFO, 'utf8'), clientKeyRaw, machineKeyRaw]), 32,
    ))
    const decipher = createDecipheriv('aes-256-gcm', aes, iv, { authTagLength: 16 })
    decipher.setAAD(Buffer.from(`${ACCESS_SEAL_INFO}:${nonce}:${boundAddress}`, 'utf8'))
    decipher.setAuthTag(sealed.subarray(sealed.length - 16))
    const opened = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
    plain = JSON.parse(opened.toString('utf8'))
  } catch {
    return null
  }
  const deviceId = field(plain, 'deviceId')
  const deviceToken = field(plain, 'deviceToken')
  const status = field(plain, 'status')
  const confirmCode = field(plain, 'confirmCode')
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) return null
  if (typeof deviceToken !== 'string' || deviceToken.length < 20 || deviceToken.length > 512) return null
  if (status === 'active') {
    if (confirmCode !== null && confirmCode !== undefined && typeof confirmCode !== 'string') return null
    return { deviceId, deviceToken, status, confirmCode: null }
  }
  if (status !== 'pending' || typeof confirmCode !== 'string' || !/^\d{6}$/.test(confirmCode)) return null
  return { deviceId, deviceToken, status, confirmCode }
}
