/** Shared XML 1.0 helpers for the launchd plist and Task Scheduler renderers/parsers. */

export function escapeXml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(v: string): string {
  return v.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);/g, (_m, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'amp') return '&';
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** Throws for characters XML 1.0 cannot represent (control characters other than tab/LF/CR). */
export function assertXmlSafe(v: string, target: string): void {
  if ([...v].some((c) => { const n = c.charCodeAt(0); return n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d; })) {
    throw new Error(`Cannot write a value containing control characters into ${target}.`);
  }
}
