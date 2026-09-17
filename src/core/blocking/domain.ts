/**
 * Registrable-domain (eTLD+1) helper for third-party checks and domain-list matching. A compact
 * table of the public suffixes that matter for tracking decisions stands in for the full Public
 * Suffix List; the Kotlin engine (`blocking/Domains.kt`) mirrors the exact same table so both
 * platforms agree on what "third party" means.
 */

/** Multi-label public suffixes (the second level is itself a suffix, e.g. `co.uk`). */
const MULTI_LABEL_SUFFIXES = new Set([
  // Country second-level registrations
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'sch.uk',
  'ac.uk',
  'gov.uk',
  'nhs.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'ad.jp',
  'ed.jp',
  'gr.jp',
  'lg.jp',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'id.au',
  'asn.au',
  'com.br',
  'net.br',
  'org.br',
  'gov.br',
  'edu.br',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  'com.tw',
  'net.tw',
  'org.tw',
  'edu.tw',
  'gov.tw',
  'co.kr',
  'ne.kr',
  'or.kr',
  'go.kr',
  'ac.kr',
  're.kr',
  'co.in',
  'net.in',
  'org.in',
  'firm.in',
  'gen.in',
  'ind.in',
  'ac.in',
  'edu.in',
  'gov.in',
  'co.za',
  'org.za',
  'net.za',
  'gov.za',
  'ac.za',
  'web.za',
  'com.mx',
  'org.mx',
  'net.mx',
  'gob.mx',
  'edu.mx',
  'com.ar',
  'net.ar',
  'org.ar',
  'gob.ar',
  'edu.ar',
  'com.tr',
  'net.tr',
  'org.tr',
  'gov.tr',
  'edu.tr',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'ac.nz',
  'school.nz',
  'com.sg',
  'net.sg',
  'org.sg',
  'edu.sg',
  'gov.sg',
  'com.hk',
  'net.hk',
  'org.hk',
  'edu.hk',
  'gov.hk',
  'com.my',
  'net.my',
  'org.my',
  'edu.my',
  'gov.my',
  'co.id',
  'or.id',
  'ac.id',
  'go.id',
  'web.id',
  'my.id',
  'com.ph',
  'net.ph',
  'org.ph',
  'com.vn',
  'net.vn',
  'org.vn',
  'edu.vn',
  'gov.vn',
  'co.th',
  'in.th',
  'or.th',
  'ac.th',
  'go.th',
  'com.pk',
  'net.pk',
  'org.pk',
  'edu.pk',
  'gov.pk',
  'com.bd',
  'net.bd',
  'org.bd',
  'com.eg',
  'net.eg',
  'org.eg',
  'com.sa',
  'net.sa',
  'org.sa',
  'edu.sa',
  'gov.sa',
  'co.il',
  'org.il',
  'net.il',
  'ac.il',
  'gov.il',
  'com.ua',
  'net.ua',
  'org.ua',
  'edu.ua',
  'gov.ua',
  'kiev.ua',
  'com.pl',
  'net.pl',
  'org.pl',
  'edu.pl',
  'gov.pl',
  'com.ru',
  'net.ru',
  'org.ru',
  'msk.ru',
  'spb.ru',
  'com.es',
  'org.es',
  'nom.es',
  'gob.es',
  'edu.es',
  'com.pt',
  'org.pt',
  'edu.pt',
  'gov.pt',
  'com.gr',
  'net.gr',
  'org.gr',
  'edu.gr',
  'gov.gr',
  'com.co',
  'net.co',
  'org.co',
  'edu.co',
  'gov.co',
  'com.pe',
  'net.pe',
  'org.pe',
  'gob.pe',
  'com.ve',
  'net.ve',
  'org.ve',
  'com.ec',
  'net.ec',
  'org.ec',
  'com.uy',
  'net.uy',
  'org.uy',
  'com.py',
  'net.py',
  'org.py',
  'com.bo',
  'net.bo',
  'org.bo',
  'com.do',
  'net.do',
  'org.do',
  'com.gt',
  'net.gt',
  'org.gt',
  'com.ng',
  'net.ng',
  'org.ng',
  'edu.ng',
  'gov.ng',
  'co.ke',
  'or.ke',
  'ne.ke',
  'ac.ke',
  'go.ke',
  'co.tz',
  'or.tz',
  'ac.tz',
  'go.tz',
  'co.ug',
  'or.ug',
  'ac.ug',
  'go.ug',
  'co.zw',
  'org.zw',
  'ac.zw',
  'co.mz',
  'org.mz',
  'co.ao',
  'og.ao',
  'com.gh',
  'org.gh',
  'edu.gh',
  'gov.gh',
  'co.ma',
  'net.ma',
  'org.ma',
  'ac.ma',
  'gov.ma',
  'com.tn',
  'org.tn',
  'com.dz',
  'org.dz',
  'com.lb',
  'org.lb',
  'com.jo',
  'org.jo',
  'com.kw',
  'org.kw',
  'com.qa',
  'org.qa',
  'com.bh',
  'org.bh',
  'com.om',
  'org.om',
  'co.ae',
  'net.ae',
  'org.ae',
  'ac.ae',
  'gov.ae',
  'co.at',
  'or.at',
  'ac.at',
  'gv.at',
  'co.hu',
  'org.hu',
  'info.hu',
  'com.ro',
  'org.ro',
  'nom.ro',
  'com.mt',
  'org.mt',
  'net.mt',
  'com.cy',
  'org.cy',
  'net.cy',
  'com.lv',
  'org.lv',
  'edu.lv',
  'com.ee',
  'org.ee',
  'edu.ee',
  'com.lt',
  'org.lt',
  'com.by',
  'org.by',
  'com.kz',
  'org.kz',
  'com.uz',
  'org.uz',
  'com.ge',
  'org.ge',
  'com.am',
  'org.am',
  'com.az',
  'org.az',
  'com.np',
  'org.np',
  'edu.np',
  'com.lk',
  'org.lk',
  'edu.lk',
  'com.mm',
  'org.mm',
  'com.kh',
  'org.kh',
  'com.la',
  'org.la',
  'com.mn',
  'org.mn',
  'com.af',
  'org.af',
  'com.iq',
  'org.iq',
  'com.ye',
  'org.ye',
  'co.cr',
  'or.cr',
  'ac.cr',
  'com.pa',
  'org.pa',
  'com.sv',
  'org.sv',
  'com.hn',
  'org.hn',
  'com.ni',
  'org.ni',
  'com.jm',
  'org.jm',
  'com.tt',
  'org.tt',
  'com.bs',
  'org.bs',
  'com.bz',
  'org.bz',
  'com.cu',
  'org.cu',
  'com.pr',
  'org.pr',
  'com.ai',
  'com.ag',
  'com.bb',
  'com.lc',
  'com.vc',
  'com.gd',
  'com.kn',
  'com.dm',
  'com.ky',
  'com.vi',
  'com.gy',
  'com.sr',
  'com.fj',
  'com.pg',
  'com.sb',
  'com.vu',
  'com.ws',
  'com.to',
  'com.nf',
  'com.ki',
  'com.nr',
  'com.tv',
  'com.fm',
  'com.pw',
  'com.mh',
  'com.pf',
  'com.nc',
  'com.mu',
  'com.sc',
  'com.mv',
  'com.km',
  'com.mg',
  'com.re',
  'com.yt',
  // Well-known hosting providers whose customers are unrelated sites (PSL "private" section)
  'github.io',
  'githubusercontent.com',
  'gitlab.io',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'herokuapp.com',
  'appspot.com',
  'blogspot.com',
  'wordpress.com',
  'tumblr.com',
  'cloudfront.net',
  'amazonaws.com',
  'azurewebsites.net',
  'windows.net',
  'cloudapp.net',
  'workers.dev',
  'glitch.me',
  'repl.co',
  'surge.sh',
  'now.sh',
  'fly.dev',
  'onrender.com',
  'readthedocs.io',
  'neocities.org',
  'myshopify.com',
  'squarespace.com',
  'wixsite.com',
  'weebly.com',
  'webflow.io',
  'ngrok.io',
  'ngrok.app',
  'trycloudflare.com',
  'duckdns.org',
  'no-ip.org',
  'dyndns.org',
  'ddns.net',
  'hopto.org',
  'zapto.org',
  'sytes.net',
  'dynv6.net',
  'nip.io',
  'sslip.io',
  'xip.io',
  'localhost.run',
  'loca.lt',
  'lhr.life',
  'serveo.net',
  'us-east-1.amazonaws.com',
  'eu-west-1.amazonaws.com',
  's3.amazonaws.com',
  'compute.amazonaws.com',
  'elb.amazonaws.com'
])

/** Two-letter TLDs where any of these labels is a public suffix (generic pattern `<sld>.<cc>`). */
const GENERIC_CC_SLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go'])

/** The suffix tables, exposed so a test can hold the Kotlin mirror to them. */
export function publicSuffixTables(): { multiLabel: string[]; genericCcSlds: string[] } {
  return { multiLabel: [...MULTI_LABEL_SUFFIXES], genericCcSlds: [...GENERIC_CC_SLDS] }
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Hostname of `url` lowercased and without a trailing dot; `null` when it has none. */
export function hostnameOf(url: string): string | null {
  // Fast path: avoid URL parsing for the common http(s) case.
  let start = url.indexOf('://')
  if (start === -1) {
    try {
      const host = new URL(url).hostname
      return host ? host.toLowerCase() : null
    } catch {
      return null
    }
  }
  start += 3
  let end = url.length
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c === 47 || c === 63 || c === 35) {
      // '/', '?', '#'
      end = i
      break
    }
  }
  let authority = url.slice(start, end)
  const at = authority.lastIndexOf('@')
  if (at !== -1) authority = authority.slice(at + 1)
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    return close === -1 ? null : authority.slice(0, close + 1).toLowerCase()
  }
  const colon = authority.indexOf(':')
  if (colon !== -1) authority = authority.slice(0, colon)
  if (authority.endsWith('.')) authority = authority.slice(0, -1)
  return authority ? authority.toLowerCase() : null
}

/**
 * The registrable domain of a hostname (`a.b.example.co.uk` → `example.co.uk`). IP literals and
 * single-label hosts are returned unchanged.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || IPV4_RE.test(host) || host.startsWith('[') || !host.includes('.')) return host
  const labels = host.split('.')
  // Longest matching multi-label suffix wins (e.g. `s3.amazonaws.com` over `amazonaws.com`).
  for (let take = Math.min(4, labels.length - 1); take >= 2; take--) {
    const suffix = labels.slice(-take).join('.')
    if (MULTI_LABEL_SUFFIXES.has(suffix)) {
      return labels.slice(-(take + 1)).join('.')
    }
  }
  if (labels.length >= 3) {
    const tld = labels[labels.length - 1]
    const sld = labels[labels.length - 2]
    if (tld.length === 2 && GENERIC_CC_SLDS.has(sld)) return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

/** Registrable domain of a URL, or `null` for URLs without a host. */
export function domainOf(url: string): string | null {
  const host = hostnameOf(url)
  return host ? registrableDomain(host) : null
}

/** `host` equals `domain` or is one of its subdomains. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  if (host === domain) return true
  return (
    host.length > domain.length &&
    host.endsWith(domain) &&
    host[host.length - domain.length - 1] === '.'
  )
}

/**
 * Whether `url` is third party to `initiator` (an origin or URL). A request without an
 * initiator is first party (top-level navigations); a request from a non-http(s) initiator
 * such as an extension page is third party.
 */
export function isThirdParty(url: string, initiator: string | undefined): boolean {
  if (!initiator) return false
  const a = domainOf(url)
  const b = domainOf(initiator)
  if (!a || !b) return true
  return a !== b
}
