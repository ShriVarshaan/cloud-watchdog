// Removes account details from a recorded AWS response, so it can be
// committed as a test fixture. Used by record-fixtures.ts.
//
// What is replaced (the same input always gets the same replacement, so links
// between resources survive):
//   - 12-digit account ids         the profile's own -> 111122223333
//   - resource ids                 i-..., vol-..., vpc-..., sg-... (prefix kept)
//   - IPv4, IPv6 and MAC addresses
//   - host names                   they embed IP addresses and database names
//   - names                        key pairs, database names and users, groups,
//                                  descriptions, load balancers, SageMaker
//                                  endpoints, configs and models, container
//                                  image URIs, the name part of ARNs
//   - tags                         every value; every key except Name and aws:*
//   - e-mail addresses
// `$metadata` (request ids) is dropped.
//
// This is a best effort, not a guarantee: it knows the fields of the calls the
// app makes today. READ THE SANITISED FILES BEFORE COMMITTING THEM.

const FAKE_ACCOUNT = '111122223333'

/** String values under these keys (lower-cased) are names chosen by the user. */
const NAME_KEYS = new Set([
  'keyname',
  'masterusername',
  'dbname',
  'dbinstanceidentifier',
  'dbclusteridentifier',
  'readreplicasourcedbinstanceidentifier',
  'readreplicadbinstanceidentifiers',
  'readreplicasourcedbclusteridentifier',
  'readreplicadbclusteridentifiers',
  'dbsubnetgroupname',
  'dbparametergroupname',
  'dbclusterparametergroupname',
  'dbsecuritygroupname',
  'optiongroupname',
  'groupname',
  'dbiresourceid',
  'kmskeyid',
  'clienttoken',
  'userid',
  'description',
  'groupdescription',
  'dbsubnetgroupdescription',
  'loadbalancername',
  'endpointname',
  'endpointconfigname',
  'modelname',
  // Container image URIs name the user's ECR repository.
  'specifiedimage',
  'resolvedimage'
])

/** Names under these keys also appear inside other strings (ARNs, messages), and are replaced there too. */
const IDENTIFIER_KEYS = new Set([
  'dbinstanceidentifier',
  'dbclusteridentifier',
  'readreplicasourcedbinstanceidentifier',
  'readreplicadbinstanceidentifiers',
  'readreplicasourcedbclusteridentifier',
  'readreplicadbclusteridentifiers',
  'loadbalancername',
  'endpointname',
  'endpointconfigname',
  'modelname'
])

/** The name inside an ELBv2 ARN's `app|net|gwy/<name>/<hash>`. Type and hash are not personal. */
const ELB_V2_NAME = /^(?:app|net|gwy)\/([^/]+)\/[0-9a-f]+$/

const TAG_LIST_KEYS = new Set(['tags', 'taglist', 'tagset'])

const RESOURCE_ID = /\b([a-z]+(?:-[a-z]+)*)-[0-9a-f]{8,17}\b/g
const RESOURCE_ID_ONLY = /^[a-z]+(?:-[a-z]+)*-[0-9a-f]{8,17}$/
const ACCOUNT_ID = /(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g
const DASHED_IP = /\b(ip|ec2)-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\b/g
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g
const MAC = /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ARN = /arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{0,12}:([^\s"',]+)/g

const isHostKey = (key: string) => key === 'address' || key.endsWith('dnsname') || key.includes('hostname')
const isAwsDefault = (value: string) => /^default(?![A-Za-z0-9])/.test(value)
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function isPrivateIp(a: number, b: number): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** Returns a function that sanitises one value. Reuse it for every file of a recording. */
export function createSanitizer(realAccountId: string): (value: unknown) => unknown {
  const names = new Map<string, string>()
  /** The subset of `names` that is also replaced inside other strings. */
  const spread = new Set<string>()
  const ids = new Map<string, string>()
  const accounts = new Map<string, string>([[realAccountId, FAKE_ACCOUNT]])
  const publicIps = new Map<string, string>()
  const privateIps = new Map<string, string>()
  const hosts = new Map<string, string>()
  const ipv6s = new Map<string, string>()
  const macs = new Map<string, string>()
  const tagKeys = new Map<string, string>()

  /** The replacement for `original`, made by `make(n)` the first time it is seen. */
  function mapped(map: Map<string, string>, original: string, make: (n: number) => string): string {
    let replacement = map.get(original)
    if (replacement === undefined) {
      replacement = make(map.size + 1)
      map.set(original, replacement)
    }
    return replacement
  }

  const nameFor = (original: string) => mapped(names, original, (n) => `name-${n}`)

  function ipFor(a: string, b: string, c: string, d: string, separator: string): string {
    const octets = [a, b, c, d].map(Number)
    if (octets.some((octet) => octet > 255)) return [a, b, c, d].join(separator)
    const address = octets.join('.')
    if (address === '0.0.0.0' || octets[0] === 127 || octets[0] === 255) return [a, b, c, d].join(separator)
    const replacement = isPrivateIp(octets[0]!, octets[1]!)
      ? mapped(privateIps, address, (n) => `10.0.${Math.floor(n / 256)}.${n % 256}`)
      : mapped(publicIps, address, (n) => `203.0.113.${n % 256}`)
    return replacement.replaceAll('.', separator)
  }

  /** The name part of each ARN in `text`: "db:shop-db" -> "shop-db". Resource ids are left to RESOURCE_ID. */
  function arnNames(text: string): string[] {
    const found: string[] = []
    for (const match of text.matchAll(ARN)) {
      const resource = match[1]!
      const split = resource.search(/[/:]/)
      const rest = split === -1 ? resource : resource.slice(split + 1)
      const elbName = ELB_V2_NAME.exec(rest)?.[1]
      if (elbName) found.push(elbName)
      else if (rest && !RESOURCE_ID_ONLY.test(rest)) found.push(rest)
    }
    return found
  }

  /** First pass: find every name, so the second pass can replace it wherever it appears. */
  function collect(value: unknown, key: string): void {
    if (typeof value === 'string') {
      for (const name of arnNames(value)) {
        nameFor(name)
        spread.add(name)
      }
      if (NAME_KEYS.has(key) && value && !value.startsWith('arn:') && !isAwsDefault(value)) {
        nameFor(value)
        if (IDENTIFIER_KEYS.has(key)) spread.add(value)
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (TAG_LIST_KEYS.has(key) && isTag(item)) {
          if (item.Value) nameFor(item.Value)
        } else {
          collect(item, key)
        }
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) collect(child, childKey.toLowerCase())
    }
  }

  function isTag(value: unknown): value is { Key: string; Value?: string } {
    return value !== null && typeof value === 'object' && typeof (value as { Key?: unknown }).Key === 'string'
  }

  let spreadPattern: RegExp | null = null
  function buildSpreadPattern(): void {
    // Longest first, so "shop-db" wins over "shop". Very short names are too
    // likely to match by accident.
    const candidates = [...spread].filter((name) => name.length >= 3).sort((a, b) => b.length - a.length)
    spreadPattern = candidates.length
      ? new RegExp(`(?<![A-Za-z0-9])(?:${candidates.map(escapeRegExp).join('|')})(?![A-Za-z0-9])`, 'g')
      : null
  }

  /** Replaces everything recognisable inside a string. */
  function scrub(text: string, key: string): string {
    let out = text
    if (spreadPattern) out = out.replace(spreadPattern, (name) => nameFor(name))
    out = out.replace(RESOURCE_ID, (id, prefix: string) =>
      mapped(ids, id, (n) => `${prefix}-${n.toString(16).padStart(17, '0')}`)
    )
    out = out.replace(ACCOUNT_ID, (account) => mapped(accounts, account, (n) => String(n - 1).padStart(12, '0')))
    out = out.replace(DASHED_IP, (_all, prefix: string, a: string, b: string, c: string, d: string) => {
      return `${prefix}-${ipFor(a, b, c, d, '-')}`
    })
    // Version numbers such as 15.0.4236.7 look like addresses.
    if (!key.includes('version')) {
      out = out.replace(IPV4, (_all, a: string, b: string, c: string, d: string) => ipFor(a, b, c, d, '.'))
    }
    out = out.replace(MAC, (mac) => mapped(macs, mac.toLowerCase(), (n) => `02:00:00:00:00:${n.toString(16).padStart(2, '0')}`))
    out = out.replace(EMAIL, 'user@example.com')
    return out
  }

  /** Second pass: builds the sanitised copy. */
  function walk(value: unknown, key: string): unknown {
    if (typeof value === 'string') {
      if (!value) return value
      if (isHostKey(key)) return mapped(hosts, value, (n) => `host-${n}.example.invalid`)
      if (key.includes('ipv6')) return mapped(ipv6s, value, (n) => `2001:db8::${n.toString(16)}`)
      if (NAME_KEYS.has(key) && names.has(value)) return names.get(value)
      return scrub(value, key)
    }
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (TAG_LIST_KEYS.has(key) && isTag(item)) {
          const keepKey = item.Key === 'Name' || item.Key.startsWith('aws:')
          return {
            ...item,
            Key: keepKey ? item.Key : mapped(tagKeys, item.Key, (n) => `tag-key-${n}`),
            ...(typeof item.Value === 'string' ? { Value: item.Value ? nameFor(item.Value) : '' } : {})
          }
        }
        return walk(item, key)
      })
    }
    if (value !== null && typeof value === 'object') {
      const copy: Record<string, unknown> = {}
      for (const [childKey, child] of Object.entries(value)) {
        if (childKey === '$metadata') continue
        copy[childKey] = walk(child, childKey.toLowerCase())
      }
      return copy
    }
    return value
  }

  return (value) => {
    collect(value, '')
    buildSpreadPattern()
    return walk(value, '')
  }
}
