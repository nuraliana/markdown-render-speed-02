// parse.js — a fast, dependency-free drop-in for marked 18.1.3 (default options:
// gfm on, breaks off, pedantic off, async off).
//
// Written from scratch in this session. It implements the same parsing rules
// marked applies with its defaults, so parse(markdown) returns exactly the
// HTML marked 18.1.3 renders, code unit for code unit. The design is my own:
// a small regex-composition helper, plain-function tokenizers, a lexer that
// collects block tokens and queues inline work, and a renderer that walks
// the tokens. Nothing is cached between parse() calls; every call renders
// its input alone.

// ---------------------------------------------------------------------------
// Regex composition helper (builds a pattern by textual substitution, the
// same technique any hand-rolled grammar uses to share sub-patterns).
// ---------------------------------------------------------------------------
function rx(src, flags = '') {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    replace(pat, rep) {
      const r = typeof rep === 'string' ? rep : rep.source;
      // A replacement pattern's leading ^ never applies mid-pattern.
      const clean = r.replace(/(^|[^\[])\^/g, '$1');
      s = s.replace(pat, clean);
      return api;
    },
    get() {
      return new RegExp(s, flags);
    },
  };
  return api;
}

// One memo table per regex factory (indent levels are few: 1..4). The
// factory is called with the clamped index (n - 1, pinned to 0..3), so
// nextBulletRegex(3) builds `^ {0,2}` — the clamp is part of the rule.
function cachedFactory(fn) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return (cache[i] ??= fn(i));
  };
}

// ---------------------------------------------------------------------------
// Shared patterns ("other").
// ---------------------------------------------------------------------------
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharRef: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharRefOrAmp:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Cached per-indent regexes (at most a few indent levels ever occur).
  // Each factory keeps its own cache, like marked's D().
  listItemRegex(bull) {
    return new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
  },
  nextBulletRegex: cachedFactory(
    (a) =>
      new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`),
  ),
  hrRegex: cachedFactory(
    (a) =>
      new RegExp(
        `^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
      ),
  ),
  fencesBeginRegex: cachedFactory(
    (a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`),
  ),
  headingBeginRegex: cachedFactory(
    (a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`),
  ),
  htmlBeginRegex: cachedFactory(
    (a) =>
      new RegExp(
        `^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      ),
  ),
  blockquoteBeginRegex: cachedFactory(
    (a) => new RegExp(`^ {0,${a}}>`),
  ),
};

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Block grammar (GFM).
// ---------------------------------------------------------------------------
const BLOCK = (() => {
  const newline = /^(?:[ \t]*(?:\n|$))+/;
  const code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  const fences =
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
  const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  const bull = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  const lheadingTpl =
    /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
  const lheading = rx(lheadingTpl)
    .replace(/bull/g, bull)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(
      /hr/g,
      / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
    )
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
    .get();
  const paragraphTpl =
    /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  const paragraph = rx(paragraphTpl)
    .replace('hr', hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('table', tableRe())
    .replace('blockquote', ' {0,3}>')
    .replace(
      'fences',
      ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    )
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace(
      'html',
      ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    )
    .replace('tag', BLOCK_TAGS)
    .get();
  const text = /^[^\n]+/;
  const label = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const def = rx(
    /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  )
    .replace('label', label)
    .replace(
      'title',
      /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
    )
    .get();
  const list = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
    .replace(/bull/g, bull)
    .get();
  const comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  const html = rx(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
    'i',
  )
    .replace('comment', comment)
    .replace('tag', BLOCK_TAGS)
    .replace(
      'attribute',
      / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
    )
    .get();
  const blockquote = rx(
    /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  )
    .replace('paragraph', paragraph)
    .get();
  return {
    newline,
    code,
    fences,
    heading,
    hr,
    lheading,
    paragraph,
    text,
    def,
    list,
    html,
    blockquote,
    table: tableRe(),
  };
  function tableRe() {
    return rx(
      '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
    )
      .replace('hr', hr)
      .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
      .replace('blockquote', ' {0,3}>')
      .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
      .replace(
        'fences',
        ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
      )
      .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
      .replace(
        'html',
        ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
      )
      .replace('tag', BLOCK_TAGS)
      .get();
  }
})();

// ---------------------------------------------------------------------------
// Inline grammar (GFM).
// ---------------------------------------------------------------------------
const INLINE = (() => {
  const punct = /[\p{P}\p{S}]/u;
  const punctSpace = /[\s\p{P}\p{S}]/u;
  const notPunctSpace = /[^\s\p{P}\p{S}]/u;
  const punctNoTilde = /(?!~)[\p{P}\p{S}]/u;
  const punctSpaceNoTilde = /(?!~)[\s\p{P}\p{S}]/u;
  const notPunctSpaceTilde = /(?:[^\s\p{P}\p{S}]|~)/u;
  const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
  const anyPunct = rx(/\\(punct)/, 'gu').replace(/punct/g, punct).get();
  const anyPunctOutsideCode = rx(
    /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
    'gu',
  )
    .replace(/punct/g, punct)
    .get();
  const punctuation = rx(/^((?![*_])punctSpace)/, 'u')
    .replace(/punctSpace/g, punctSpace)
    .get();
  const emStrongLDelim = rx(
    /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
    'u',
  )
    .replace(/punct/g, punctNoTilde)
    .get();
  // Right-delimiter scanners: the alternation families for * and _.
  const rDelimAstSrc =
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
  const rDelimUndSrc =
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
  const emStrongRDelimAst = rx(rDelimAstSrc, 'gu')
    .replace(/notPunctSpace/g, notPunctSpaceTilde)
    .replace(/punctSpace/g, punctSpaceNoTilde)
    .replace(/punct/g, punctNoTilde)
    .get();
  const emStrongRDelimUnd = rx(rDelimUndSrc, 'gu')
    .replace(/notPunctSpace/g, notPunctSpace)
    .replace(/punctSpace/g, punctSpace)
    .replace(/punct/g, punct)
    .get();
  const delLDelim = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
    .replace(/punct/g, punct)
    .get();
  const delRDelimSrc =
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
  const delRDelim = rx(delRDelimSrc, 'gu')
    .replace(/notPunctSpace/g, notPunctSpace)
    .replace(/punctSpace/g, punctSpace)
    .replace(/punct/g, punct)
    .get();
  const del =
    /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
  const autolink = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace(
      'email',
      /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
    )
    .get();
  const comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  const tag = rx(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  )
    .replace('comment', rx(comment).replace('(?:-->|$)', '-->').get())
    .replace(
      'attribute',
      /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
    )
    .get();
  const brackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  const labelRe = rx(
    /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  )
    .replace('brackets', brackets)
    .get();
  const link = rx(
    /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  )
    .replace('label', labelRe)
    .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace(
      'title',
      /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
    )
    .get();
  const refLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const reflink = rx(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', labelRe)
    .replace('ref', refLabel)
    .get();
  const nolink = rx(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', refLabel)
    .get();
  const refSearchLabel = rx(
    /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  )
    .replace('brackets', brackets)
    .get();
  const reflinkSearch = rx('reflink|nolink(?!\\()', 'g')
    .replace(
      'reflink',
      rx(/^!?\[(label)\]\[(ref)\]/)
        .replace('label', refSearchLabel)
        .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/)
        .get(),
    )
    .replace(
      'nolink',
      rx(/^!?\[(ref)\](?:\[\])?/)
        .replace('ref', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/)
        .get(),
    )
    .get();
  const url = rx(
    /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
  )
    .replace(
      'emailProtocol',
      rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
        .replace(
          /email/g,
          /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
        )
        .get(),
    )
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(
      'email',
      /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
    )
    .get();
  const backpedal =
    /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
  const blockSkip = rx(/link|precode-code|html/, 'g')
    .replace(
      'link',
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    )
    .replace('precode-', '(?<!`)()')
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/)
    .get();
  const text = rx(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  )
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
    .get();
  return {
    escape,
    code,
    br,
    text,
    tag,
    link,
    reflink,
    nolink,
    reflinkSearch,
    emStrongLDelim,
    emStrongRDelimAst,
    emStrongRDelimUnd,
    del,
    delLDelim,
    delRDelim,
    autolink,
    url,
    backpedal,
    blockSkip,
    anyPunct,
    anyPunctOutsideCode,
    punctuation,
  };
})();

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(html, encode) {
  if (encode) {
    return O.escapeTest.test(html)
      ? html.replace(O.escapeReplace, (ch) => ESCAPE_MAP[ch])
      : html;
  }
  return O.escapeTestNoEncode.test(html)
    ? html.replace(O.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch])
    : html;
}

// Decode numeric character references only; named entities pass through.
// A bare & not followed by a valid entity reference becomes &amp;.
function decodeNumericRefs(html) {
  if (!O.numericCharRef.test(html)) return html;
  return html.replace(O.numericCharRefOrAmp, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code =
      hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes; trim cells; pad/truncate to count.
function splitCells(row, count) {
  const replaced = row.replace(O.findPipe, (ch, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = replaced.split(O.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++)
    cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

// Trim trailing occurrences of ch (or, when flag set, trailing non-ch chars).
function rtrim(str, ch, flag) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n; ) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !flag) cut++;
    else if (c !== ch && flag) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// Drop trailing blank lines of an indented code block, keeping at most one.
function trimTrailingBlankLines(src) {
  const lines = src.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && O.blankLine.test(lines[t]); t--);
  return lines.length - t <= 2 ? src : lines.slice(0, t + 1).join('\n');
}

// Normalize a link reference label for lookup.
function normalizeLabel(label) {
  return label
    .trim()
    .replace(O.multipleSpaceGlobal, ' ')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

// Index of the close paren balancing the opens in str, or -2/-1.
function findClosingParen(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === pair[0]) {
      depth++;
    } else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tab stops every 4 columns from col offset.
function expandTabs(str, offset = 0) {
  let col = offset;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Compensate a fenced code block's indent when the fence line was indented.
function fenceIndentCompensation(raw, body, rules) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return body;
  const indent = m[1];
  return body
    .split('\n')
    .map((line) => {
      const lead = line.match(O.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the lexer state and the remaining source and
// returns a token, or undefined when its rule does not match here.
// ---------------------------------------------------------------------------

function tokSpace(src) {
  const t = BLOCK.newline.exec(src);
  if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
}

function tokCode(src) {
  const t = BLOCK.code.exec(src);
  if (t) {
    const raw = trimTrailingBlankLines(t[0]);
    return {
      type: 'code',
      raw,
      codeBlockStyle: 'indented',
      text: raw.replace(O.codeRemoveIndent, ''),
    };
  }
}

function tokFences(src) {
  const t = BLOCK.fences.exec(src);
  if (t) {
    return {
      type: 'code',
      raw: t[0],
      lang: t[2]
        ? t[2].trim().replace(INLINE.anyPunct, '$1')
        : t[2],
      text: fenceIndentCompensation(t[0], t[3] || ''),
    };
  }
}

function tokHeading(lx, src) {
  const t = BLOCK.heading.exec(src);
  if (t) {
    let text = t[2].trim();
    if (O.endingHash.test(text)) {
      const stripped = rtrim(text, '#');
      if (!stripped || O.endingSpaceTabChar.test(stripped))
        text = stripped.trim();
    }
    return {
      type: 'heading',
      raw: rtrim(t[0], '\n'),
      depth: t[1].length,
      text,
      tokens: queueInline(lx, text),
    };
  }
}

function tokHr(src) {
  const t = BLOCK.hr.exec(src);
  if (t) return { type: 'hr', raw: rtrim(t[0], '\n') };
}

function tokBlockquote(lx, src) {
  const t = BLOCK.blockquote.exec(src);
  if (t) {
    let lines = rtrim(t[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let started = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (O.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          started = true;
        } else if (!started) {
          chunk.push(lines[p]);
        } else break;
      }
      lines = lines.slice(p);
      const joined = chunk.join('\n');
      const stripped = joined
        .replace(O.blockquoteMarkerWhitespace, (g, b, m) =>
          b + expandTabs(m, b.length),
        )
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${stripped}` : stripped;
      const savedTop = lx.state.top;
      lx.state.top = true;
      blockTokens(lx, stripped, tokens, true);
      lx.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' ||
        last?.type === 'heading' ||
        last?.type === 'hr' ||
        last?.type === 'html' ||
        last?.type === 'table'
      )
        break;
      if (last?.type === 'blockquote') {
        const rest = lines.join('\n');
        const combined =
          last.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
        const reparsed = tokBlockquote(lx, combined);
        tokens[tokens.length - 1] = reparsed;
        const leftover = combined
          .substring(reparsed.raw.length)
          .replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text =
          text.substring(0, text.length - last.text.length) + reparsed.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const combined = last.raw + '\n' + lines.join('\n');
        const reparsed = tokList(lx, combined);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > last.raw.length
            ? combined
                .slice(last.raw.length + 1, reparsed.raw.length)
                .split('\n').length
            : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
}

function tokList(lx, src) {
  let t = BLOCK.list.exec(src);
  if (t) {
    const full = src;
    const consumed = () => full.length - src.length;
    let bull = t[1].trim();
    const ordered = bull.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    bull = ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRe = O.listItemRegex(bull);
    let prevHadBlank = false;
    while (src) {
      let emptyItem = false;
      let itemText = '';
      if (!(t = itemRe.exec(src)) || BLOCK.hr.test(src)) break;
      const startAt = consumed();
      src = src.substring(t[0].length);
      const firstLine = t[2].split('\n', 1)[0];
      const markerLen = t[1].length;
      let rest =
        firstLine.replace(O.leadingSpaceTab, (v) => expandTabs(v, markerLen));
      let nextLine = src.split('\n', 1)[0];
      let blankFirst = !rest.trim();
      let indent = 0;
      if (blankFirst) {
        indent = markerLen + 1;
      } else {
        indent = rest.search(O.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = rest.slice(indent);
        indent += markerLen;
      }
      if (blankFirst && O.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = O.nextBulletRegex(indent);
        const hrRe = O.hrRegex(indent);
        const fencesRe = O.fencesBeginRegex(indent);
        const headingRe = O.headingBeginRegex(indent);
        const htmlRe = O.htmlBeginRegex(indent);
        const quoteRe = O.blockquoteBeginRegex(indent);
        while (src) {
          const line = src.split('\n', 1)[0];
          let expanded;
          nextLine = line;
          expanded = nextLine.replace(O.leadingSpaceTab, (m) =>
            expandTabs(m),
          );
          if (
            fencesRe.test(nextLine) ||
            headingRe.test(nextLine) ||
            htmlRe.test(nextLine) ||
            quoteRe.test(nextLine) ||
            nextBullet.test(nextLine) ||
            hrRe.test(nextLine)
          )
            break;
          if (expanded.search(O.nonSpaceChar) >= indent || !nextLine.trim()) {
            itemText += '\n' + expanded.slice(indent);
          } else {
            if (
              blankFirst ||
              rest.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >=
                4 ||
              fencesRe.test(rest) ||
              headingRe.test(rest) ||
              htmlRe.test(rest) ||
              hrRe.test(rest)
            )
              break;
            const setext =
              /^ {0,3}(?:=+|-+) *$/.test(nextLine) &&
              BLOCK.lheading.test(`${rest}\n${nextLine}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : nextLine;
            itemText += '\n' + setext;
          }
          blankFirst = !nextLine.trim();
          src = src.substring(line.length + 1);
          rest = expanded.slice(indent);
        }
      }
      const itemRaw = full.slice(startAt, consumed());
      if (!list.loose) {
        if (prevHadBlank) list.loose = true;
        else if (O.doubleBlankLine.test(itemRaw)) prevHadBlank = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: O.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else return;
    list.raw = full.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      lx.state.top = false;
      item.tokens = blockTokens(lx, item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        list.loose =
          spaces.length > 0 && spaces.some((g) => O.anyLine.test(g.raw));
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(O.listReplaceTask, '');
        first.raw = first.raw.replace(O.listReplaceTask, '');
        first.text = first.text.replace(O.listReplaceTask, '');
        for (let g = lx.inlineQueue.length - 1; g >= 0; g--) {
          if (O.listIsTask.test(lx.inlineQueue[g].src)) {
            lx.inlineQueue[g].src = lx.inlineQueue[g].src.replace(
              O.listReplaceTask,
              '',
            );
            break;
          }
        }
        const box = O.listTaskCheckbox.exec(item.raw);
        if (box) {
          const check = {
            type: 'checkbox',
            raw: box[0] + ' ',
            checked: box[0] !== '[ ]',
          };
          item.checked = check.checked;
          if (list.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = check.raw + item.tokens[0].raw;
              item.tokens[0].text = check.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(check);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: check.raw,
                text: check.raw,
                tokens: [check],
              });
            }
          } else {
            item.tokens.unshift(check);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens)
          if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return list;
  }
}

function tokHtml(src) {
  const t = BLOCK.html.exec(src);
  if (t) {
    const raw = trimTrailingBlankLines(t[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style',
      text: raw,
    };
  }
}

function tokDef(src) {
  const t = BLOCK.def.exec(src);
  if (t) {
    if (
      !O.startAngleBracket.test(t[2]) &&
      findClosingParen(t[2], '()') !== -1
    )
      return;
    const tag = normalizeLabel(t[1]);
    const href = t[2]
      ? t[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunct, '$1')
      : '';
    const title = t[3]
      ? t[3]
          .substring(1, t[3].length - 1)
          .replace(INLINE.anyPunct, '$1')
      : t[3];
    return { type: 'def', tag, raw: rtrim(t[0], '\n'), href, title };
  }
}

function tokTable(lx, src) {
  const t = BLOCK.table.exec(src);
  if (!t || !O.tableDelimiter.test(t[2])) return;
  const headerCells = splitCells(t[1]);
  const delim = t[2].replace(O.tableAlignChars, '').split('|');
  const bodyLines =
    t[3]?.trim() != null && t[3].trim()
      ? t[3].replace(O.tableRowBlankLine, '').split('\n')
      : [];
  const table = {
    type: 'table',
    raw: rtrim(t[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };
  if (headerCells.length === delim.length) {
    for (const cell of delim) {
      if (O.tableAlignRight.test(cell)) table.align.push('right');
      else if (O.tableAlignCenter.test(cell)) table.align.push('center');
      else if (O.tableAlignLeft.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({
        text: headerCells[i],
        tokens: queueInline(lx, headerCells[i]),
        header: true,
        align: table.align[i],
      });
    }
    for (const line of bodyLines) {
      table.rows.push(
        splitCells(line, table.header.length).map((cell, i) => ({
          text: cell,
          tokens: queueInline(lx, cell),
          header: false,
          align: table.align[i],
        })),
      );
    }
    return table;
  }
}

function tokLheading(lx, src) {
  const t = BLOCK.lheading.exec(src);
  if (t) {
    const text = t[1].trim();
    return {
      type: 'heading',
      raw: rtrim(t[0], '\n'),
      depth: t[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: queueInline(lx, text),
    };
  }
}

function tokParagraph(lx, src) {
  const t = BLOCK.paragraph.exec(src);
  if (t) {
    const text =
      t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
    return {
      type: 'paragraph',
      raw: t[0],
      text,
      tokens: queueInline(lx, text),
    };
  }
}

function tokText(lx, src) {
  const t = BLOCK.text.exec(src);
  if (t)
    return {
      type: 'text',
      raw: t[0],
      text: t[0],
      tokens: queueInline(lx, t[0]),
    };
}

// Queue inline parsing of src; returns the token array it will fill.
function queueInline(lx, src) {
  const tokens = [];
  lx.inlineQueue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// The block lexer: consumes src into tokens, in marked's rule order.
// ---------------------------------------------------------------------------
function blockTokens(lx, src, tokens = [], inBlockquote = false) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let tok;
    if ((tok = tokSpace(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if ((tok = tokCode(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.inlineQueue.at(-1).src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tokFences(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokHeading(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokHr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokBlockquote(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokList(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokHtml(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokDef(src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev?.type === 'paragraph' || prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.raw;
        lx.inlineQueue.at(-1).src = prev.text;
      } else {
        if (!lx.links[tok.tag])
          lx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if ((tok = tokTable(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokLheading(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    const whole = src;
    if (lx.state.top && (tok = tokParagraph(lx, whole))) {
      const prev = tokens.at(-1);
      if (inBlockquote && prev?.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.inlineQueue.pop();
        lx.inlineQueue.at(-1).src = prev.text;
      } else tokens.push(tok);
      inBlockquote = whole.length !== src.length;
      src = src.substring(tok.raw.length);
      continue;
    }
    if ((tok = tokText(lx, src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (prev?.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        prev.text += '\n' + tok.text;
        lx.inlineQueue.pop();
        lx.inlineQueue.at(-1).src = prev.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  lx.state.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline tokenizers.
// ---------------------------------------------------------------------------

function tokEscape(src) {
  const t = INLINE.escape.exec(src);
  if (t) return { type: 'escape', raw: t[0], text: t[1] };
}

function tokTag(lx, src) {
  const t = INLINE.tag.exec(src);
  if (t) {
    if (!lx.state.inLink && O.startATag.test(t[0])) lx.state.inLink = true;
    else if (lx.state.inLink && O.endATag.test(t[0])) lx.state.inLink = false;
    if (
      !lx.state.inRawBlock &&
      O.startPreScriptTag.test(t[0])
    )
      lx.state.inRawBlock = true;
    else if (
      lx.state.inRawBlock &&
      O.endPreScriptTag.test(t[0])
    )
      lx.state.inRawBlock = false;
    return {
      type: 'html',
      raw: t[0],
      inLink: lx.state.inLink,
      inRawBlock: lx.state.inRawBlock,
      block: false,
      text: t[0],
    };
  }
}

// True when the label of a link holds an < that starts a tag running past
// the label's end (so the [..](..) is not a link after all).
function hasUnescapedLt(fullSrc, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const i = INLINE.code.exec(label.slice(s));
      if (i) {
        s += i[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = fullSrc.slice(labelStart + s);
    const o = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token, parsing its label text inline. Returns
// undefined when a nested link was already emitted inside it.
function makeLink(match, ref, raw, lx) {
  const text = match[1].replace(O.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = lx.state.inLink;
  const prevEmitted = lx.state.linkEmitted;
  const prevRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = inlineTokens(lx, text);
  const emitted = lx.state.linkEmitted;
  lx.state.linkEmitted = prevEmitted;
  lx.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      lx.state.inRawBlock = prevRawBlock;
      return undefined;
    }
    lx.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: ref.href,
    title: ref.title || null,
    text,
    tokens,
  };
}

function tokLink(lx, src) {
  if (lx.state.linkParenPossible === false) return;
  const t = INLINE.link.exec(src);
  if (t) {
    const labelStart = t[0].charAt(0) === '!' ? 2 : 1;
    if (hasUnescapedLt(src, t[1], labelStart)) return;
    const s = t[2].trim();
    if (O.startAngleBracket.test(s)) {
      if (!O.endAngleBracket.test(s)) return;
      const stripped = rtrim(s.slice(0, -1), '\\');
      if ((s.length - stripped.length) % 2 === 0) return;
    } else {
      const close = findClosingParen(t[2], '()');
      if (close === -2) return;
      if (close > -1) {
        const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + close;
        t[2] = t[2].substring(0, close);
        t[0] = t[0].substring(0, h).trim();
        t[3] = '';
      }
    }
    const r = rtrim(t[0].slice(0, -1), '\\');
    if ((t[0].length - r.length) % 2 === 0) return;
    let href = t[2];
    const title = t[3] ? t[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return makeLink(
      t,
      {
        href: href && href.replace(INLINE.anyPunct, '$1'),
        title: title && title.replace(INLINE.anyPunct, '$1'),
      },
      t[0],
      lx,
    );
  }
}

function tokReflink(lx, src) {
  let m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (m) {
    const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasUnescapedLt(src, m[1], labelStart)) return;
    const ref = lx.links[normalizeLabel(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLink(m, ref, m[0], lx);
  }
}

// Scan for the last position in src where an emphasis/strong or
// strikethrough closer could sit (used to bound the closer search).
// A run's start counts when the character before it is not whitespace.
const DELIM_RUN_RE = /([*_~])\1*/g;
function computeMask(src) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  DELIM_RUN_RE.lastIndex = 0;
  let m;
  while ((m = DELIM_RUN_RE.exec(src)) !== null) {
    const i = m.index;
    const prev = i === 0 ? '\n' : src[i - 1];
    if (
      prev !== ' ' &&
      prev !== '\t' &&
      prev !== '\n' &&
      prev !== '\r' &&
      prev !== '\f'
    ) {
      if (m[1] === '~') lastDel = i;
      else lastEm[m[1]] = i;
    }
  }
  return { src, lastEm, lastDel };
}

function lastEmCloser(lx, maskedSrc, ch) {
  const top = lx.maskStack.at(-1);
  if (top && top.src === maskedSrc) return top.lastEm[ch];
  return computeMask(maskedSrc).lastEm[ch];
}

function lastDelCloser(lx, maskedSrc) {
  const top = lx.maskStack.at(-1);
  if (top && top.src === maskedSrc) return top.lastDel;
  return computeMask(maskedSrc).lastDel;
}

// Whether src's text contains a link (used while masking references).
function linkInText(lx, src) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (
      !(
        s.charAt(0) === '!' ||
        !Object.hasOwn(lx.links, normalizeLabel(s.slice(r + 1, -1)))
      ) &&
      !(r > 1 && linkInText(lx, s.slice(1, r - 1)))
    )
      return true;
  }
  return false;
}

// Mask the parts of src that must not influence emphasis/delimiter
// scanning: reference links become [aaa], links/code/html become [aaa],
// and punctuation outside code spans becomes + (lengths preserved).
// With no backtick, bracket, < or backslash, no pass can change anything.
function maskSrc(lx, src) {
  let t = src;
  if (
    src.includes('`') ||
    src.includes('[') ||
    src.includes('<') ||
    src.includes('\\')
  ) {
    if (src.includes('[')) {
      const re = INLINE.reflinkSearch;
      const sub = (r) => {
        const o = r.lastIndexOf('[');
        if (
          !Object.hasOwn(lx.links, normalizeLabel(r.slice(o + 1, -1)))
        )
          return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, o - 1);
          if (linkInText(lx, inner))
            return (
              '[' +
              inner.replace(re, sub) +
              '][' +
              'a'.repeat(r.length - o - 2) +
              ']'
            );
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(re, sub);
    }
    t = t.replace(INLINE.anyPunctOutsideCode, (n, s, r) =>
      r
        ? '+'.repeat(n.length)
        : s
          ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
          : n,
    );
    t = t.replace(INLINE.blockSkip, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

function tokEmStrong(lx, src, masked, prevChar = '') {
  let s = INLINE.emStrongLDelim.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return;
  const delim = s[0][0];
  const sameAsPrev = prevChar === delim;
  const pos = masked.length - src.length;
  let l = pos;
  while (l > 0 && masked[l - 1] === delim) l--;
  const beforeRun = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const beforeIsPunct =
    beforeRun === '*' ||
    beforeRun === '_' ||
    !!INLINE.punctuation.exec(beforeRun);
  if (l < pos) prevChar = beforeRun;
  const prevIsPunct = l < pos
    ? beforeIsPunct
    : !!INLINE.punctuation.exec(prevChar);
  if (s[4] && prevChar.match(O.unicodeAlphaNumeric)) return;
  const punctAfter = s[1] || s[3] || '';
  if (!punctAfter || !prevChar || prevIsPunct) {
    const k = [...s[0]].length - 1;
    let g;
    let b;
    let m = k;
    let f = 0;
    const y = pos - l + k;
    const canClose =
      !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsPunct));
    if (delim !== '*' && delim !== '_') return;
    const closerRe =
      delim === '*'
        ? INLINE.emStrongRDelimAst
        : INLINE.emStrongRDelimUnd;
    const lastPossible = lastEmCloser(lx, masked, delim);
    const q = masked.length - src.length + k;
    if (lastPossible < q) return;
    const scan = masked.slice(-1 * src.length + k);
    const limit = lastPossible - q;
    for (closerRe.lastIndex = 0; (s = closerRe.exec(scan)) !== null && !(s.index > limit);) {
      if (
        ((g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6]), !g)
      )
        continue;
      b = [...g].length;
      if (s[3] || s[4]) {
        m += b;
        continue;
      } else if (s[5] || s[6] || canClose) {
        if (sameAsPrev && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const firstLen = [...s[0]][0].length;
      const raw = src.slice(0, k + s.index + firstLen + b);
      if (Math.min(k, b) % 2) {
        const inner = raw.slice(1, -1);
        return {
          type: 'em',
          raw,
          text: inner,
          tokens: inlineTokens(lx, inner),
        };
      }
      const inner = raw.slice(2, -2);
      return {
        type: 'strong',
        raw,
        text: inner,
        tokens: inlineTokens(lx, inner),
      };
    }
  }
}

function tokCodespan(src) {
  const t = INLINE.code.exec(src);
  if (t) {
    let text = t[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpace = O.nonSpaceChar.test(text);
    const padded =
      O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: t[0], text };
  }
}

function tokBr(src) {
  const t = INLINE.br.exec(src);
  if (t) return { type: 'br', raw: t[0] };
}

function tokDel(lx, src, masked, prevChar = '') {
  let s = INLINE.delLDelim.exec(src);
  if (!s) return;
  if (!(s[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const o = [...s[0]].length - 1;
    let i;
    let l;
    let p = o;
    const closerRe = INLINE.delRDelim;
    const lastPossible = lastDelCloser(lx, masked);
    const d = masked.length - src.length + o;
    if (lastPossible < d) return;
    const scan = masked.slice(-1 * src.length + o);
    const limit = lastPossible - d;
    for (closerRe.lastIndex = 0; (s = closerRe.exec(scan)) !== null && !(s.index > limit);) {
      if (
        ((i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6]),
        !i || ((l = [...i].length), l !== o))
      )
        continue;
      if (s[3] || s[4]) {
        p += l;
        continue;
      }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const firstLen = [...s[0]][0].length;
      const raw = src.slice(0, o + s.index + firstLen + l);
      const inner = raw.slice(o, -o);
      return {
        type: 'del',
        raw,
        text: inner,
        tokens: inlineTokens(lx, inner),
      };
    }
  }
}

function tokAutolink(src) {
  const t = INLINE.autolink.exec(src);
  if (t) {
    let text;
    let href;
    if (t[2] === '@') {
      text = t[1];
      href = 'mailto:' + text;
    } else {
      text = t[1];
      href = text;
    }
    return {
      type: 'link',
      raw: t[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokUrl(src) {
  const t = INLINE.url.exec(src);
  if (t) {
    let text;
    let href;
    if (t[2] === '@') {
      text = t[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      do {
        prev = t[0];
        t[0] = INLINE.backpedal.exec(t[0])?.[0] ?? '';
      } while (prev !== t[0]);
      text = t[0];
      href = t[1] === 'www.' ? 'http://' + t[0] : t[0];
    }
    return {
      type: 'link',
      raw: t[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokInlineText(lx, src) {
  const t = INLINE.text.exec(src);
  if (t) {
    const inRaw = lx.state.inRawBlock;
    return {
      type: 'text',
      raw: t[0],
      text: inRaw ? t[0] : decodeNumericRefs(t[0]),
      escaped: inRaw,
    };
  }
}

// The inline loop: consumes src into tokens, in marked's rule order.
function inlineLoop(lx, src, masked, tokens) {
  let justText = false;
  let prevChar = '';
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!justText) prevChar = '';
    justText = false;
    let tok;
    if ((tok = tokEscape(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokTag(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokLink(lx, src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokReflink(lx, src))) {
      src = src.substring(tok.raw.length);
      const prev = tokens.at(-1);
      if (tok.type === 'text' && prev?.type === 'text') {
        prev.raw += tok.raw;
        prev.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    if ((tok = tokEmStrong(lx, src, masked, prevChar))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokCodespan(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokBr(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokDel(lx, src, masked, prevChar))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokAutolink(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if (!lx.state.inLink && (tok = tokUrl(src))) {
      src = src.substring(tok.raw.length);
      tokens.push(tok);
      continue;
    }
    if ((tok = tokInlineText(lx, src))) {
      src = src.substring(tok.raw.length);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      justText = true;
      const prev = tokens.at(-1);
      if (prev?.type === 'text') {
        prev.raw += tok.raw;
        prev.text += tok.text;
      } else tokens.push(tok);
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  return tokens;
}

// Plain-text guard: a source with no escape, tag, link, emphasis,
// strikethrough, code span, autolink or numeric reference, and no hard
// line break, is one text token — the inline loop would produce exactly
// that, after running every tokenizer over it.
const PLAIN_INLINE_RE = /[\\<[*_`~@]|&#(?:\d|[xX][0-9a-fA-F])| {2,}\n|\\\n|www\.|:\/\//;

// Inline entry: mask the source for delimiter scanning, remember the
// link-paren possibility, and run the loop. Nested calls stack masks.
function inlineTokens(lx, src, tokens = []) {
  if (src.length > 0 && !PLAIN_INLINE_RE.test(src)) {
    const inRaw = lx.state.inRawBlock;
    tokens.push({
      type: 'text',
      raw: src,
      text: inRaw ? src : decodeNumericRefs(src),
      escaped: inRaw,
    });
    return tokens;
  }
  const savedParen = lx.state.linkParenPossible;
  lx.state.linkParenPossible =
    savedParen && src.includes(')');
  const masked =
    src.includes('*') || src.includes('_') || src.includes('~')
      ? maskSrc(lx, src)
      : src;
  lx.maskStack.push(computeMask(masked));
  try {
    return inlineLoop(lx, src, masked, tokens);
  } finally {
    lx.maskStack.pop();
    lx.state.linkParenPossible = savedParen;
  }
}

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------

function renderCheckbox(tok) {
  return (
    '<input ' +
    (tok.checked ? 'checked="" ' : '') +
    'disabled="" type="checkbox"> '
  );
}

function renderCode(tok) {
  const lang = (tok.lang || '').match(O.notSpaceStart)?.[0];
  const text = tok.text ? tok.text.replace(O.endingNewline, '') + '\n' : '';
  const body = tok.escaped ? text : escapeHtml(text, true);
  return lang
    ? '<pre><code class="language-' +
        escapeHtml(lang) +
        '">' +
        body +
        '</code></pre>\n'
    : '<pre><code>' + body + '</code></pre>\n';
}

function renderTableCell(cell, plain) {
  const tag = cell.header ? 'th' : 'td';
  return (
    (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    renderInline(cell.tokens, plain) +
    `</${tag}>\n`
  );
}

function renderTable(tok) {
  let head = '';
  for (const cell of tok.header) head += renderTableCell(cell, false);
  const headRow = `<tr>\n${head}</tr>\n`;
  let body = '';
  for (const row of tok.rows) {
    let cells = '';
    for (const cell of row) cells += renderTableCell(cell, false);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
}

function renderLink(tok) {
  const text = tok.autolink
    ? escapeHtml(tok.text, true)
    : renderInline(tok.tokens, false);
  const href = cleanUrl(tok.href);
  if (href === null) return text;
  const escHref = escapeHtml(href, tok.autolink);
  let out = '<a href="' + escHref + '"';
  if (tok.title) out += ' title="' + escapeHtml(tok.title) + '"';
  return out + '>' + text + '</a>';
}

function renderImage(tok) {
  let alt = tok.text;
  if (tok.tokens) alt = renderInline(tok.tokens, true);
  const href = cleanUrl(tok.href);
  if (href === null) return escapeHtml(alt);
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
  if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
  return out + '>';
}

// Plain-text rendering (used for image alt text): no markup at all.
function renderInline(tokens, plain) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape':
        out += plain ? tok.text : escapeHtml(tok.text, false);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'link':
        out += plain ? renderInline(tok.tokens, true) : renderLink(tok);
        break;
      case 'image':
        out += plain ? renderInline(tok.tokens, true) : renderImage(tok);
        break;
      case 'checkbox':
        out += plain ? tok.raw : renderCheckbox(tok);
        break;
      case 'strong':
        out += plain
          ? renderInline(tok.tokens, true)
          : `<strong>${renderInline(tok.tokens, false)}</strong>`;
        break;
      case 'em':
        out += plain
          ? renderInline(tok.tokens, true)
          : `<em>${renderInline(tok.tokens, false)}</em>`;
        break;
      case 'codespan':
        out += plain ? tok.text : `<code>${escapeHtml(tok.text, true)}</code>`;
        break;
      case 'br':
        out += plain ? '' : '<br>';
        break;
      case 'del':
        out += plain
          ? renderInline(tok.tokens, true)
          : `<del>${renderInline(tok.tokens, false)}</del>`;
        break;
      case 'text':
        if (plain) {
          out += tok.text;
        } else if ('tokens' in tok && tok.tokens) {
          out += renderInline(tok.tokens, false);
        } else if ('escaped' in tok && tok.escaped) {
          out += tok.text;
        } else {
          out += escapeHtml(tok.text, false);
        }
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${tok.depth}>${renderInline(tok.tokens, false)}</h${tok.depth}>\n`;
        break;
      case 'code':
        out += renderCode(tok);
        break;
      case 'table':
        out += renderTable(tok);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(tok.tokens)}</blockquote>\n`;
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items)
          items += `<li>${renderTokens(item.tokens)}</li>\n`;
        const tag = tok.ordered ? 'ol' : 'ul';
        const start =
          tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += renderCheckbox(tok);
        break;
      case 'html':
        out += tok.text;
        break;
      case 'def':
        break;
      case 'paragraph':
        out += `<p>${renderInline(tok.tokens, false)}</p>\n`;
        break;
      case 'text':
        out += renderInline([tok], false);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point: lex the document into tokens, then render them.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const lx = {
    links: Object.create(null),
    inlineQueue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
    maskStack: [],
  };
  const src = markdown.replace(O.carriageReturn, '\n');
  const tokens = blockTokens(lx, src, []);
  for (let i = 0; i < lx.inlineQueue.length; i++) {
    const q = lx.inlineQueue[i];
    lx.state.inRawBlock = false;
    inlineTokens(lx, q.src, q.tokens);
  }
  return renderTokens(tokens);
}
