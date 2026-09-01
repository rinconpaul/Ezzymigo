// Unicode-aware word segmentation and lexical anchoring utilities
// Phase 2 — Architecture D Retrieval Simplification (Stage 1 Qualified Lexical Filtering)

export function detectScript(text: string): string {
  if (!text) return 'empty';
  const hasCJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u.test(text);
  const hasArabic = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u.test(text);
  const hasCyrillic = /[\u0400-\u04ff]/u.test(text);
  const hasDevanagari = /[\u0900-\u097f]/u.test(text);
  const hasLatin = /[a-zA-Z\u00C0-\u024F]/u.test(text);

  const scripts: string[] = [];
  if (hasCJK) scripts.push('cjk');
  if (hasArabic) scripts.push('arabic');
  if (hasCyrillic) scripts.push('cyrillic');
  if (hasDevanagari) scripts.push('devanagari');
  if (hasLatin) scripts.push('latin');

  if (scripts.length === 0) return 'symbolic';
  if (scripts.length === 1) return scripts[0];
  return `mixed_${scripts.join('_')}`;
}

export function segmentUnicodeWords(text: string, locale: string = 'und'): string[] {
  if (!text || typeof text !== 'string') return [];
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
    const segments = Array.from(segmenter.segment(text));
    return segments
      .filter(s => s.isWordLike)
      .map(s => s.segment.trim().toLowerCase())
      .filter(w => w.length > 0);
  } catch (err) {
    // Fallback if Intl.Segmenter fails for unknown locale
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }
}

/**
 * Universal Multilingual Non-Substantive Token Set.
 * Contains closed-class function words (articles, prepositions, auxiliary verbs, pronouns, question particles)
 * and generic reporting/conversational verbs across English, French, Spanish, German, Italian, Japanese, Chinese, Arabic.
 */
const MULTILINGUAL_NON_SUBSTANTIVE_TOKENS = new Set<string>([
  // --- English Function Words & Auxiliary/Pronouns ---
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'up', 'about', 'into', 'through', 'after', 'before', 'under', 'between', 'is', 'am', 'are', 'was',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'this', 'that', 'these', 'those', 'what', 'which',
  'who', 'whom', 'whose', 'why', 'when', 'where', 'how', 'much', 'many', 'if', 'then', 'so', 'than',
  'too', 'very', 'just', 'also', 'not', 'no', 'nor', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'me', 'him', 'us', 'them', 'it', 'i', 'you', 'he', 'she', 'we', 'they', 'got', 'get', 'any', 'some',
  // --- English Reporting / Conversational Verbs ---
  'said', 'say', 'says', 'saying', 'tell', 'told', 'tells', 'telling', 'ask', 'asked', 'asks', 'asking',
  'mention', 'mentioned', 'mentions', 'mentioning', 'comment', 'commented', 'comments', 'commenting',
  'speak', 'spoke', 'spoken', 'speaking', 'talk', 'talked', 'talks', 'talking',

  // --- French Function Words & Pronouns ---
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'et', 'ou', 'mais', 'dans', 'en',
  'a', 'à', 'au', 'aux', 'pour', 'par', 'avec', 'sans', 'sous', 'sur', 'chez', 'est', 'sont',
  'était', 'étaient', 'etre', 'être', 'été', 'ont', 'avait', 'avaient', 'avoir', 'eu', 'faire',
  'fait', 'ce', 'cet', 'cette', 'ces', 'c', 'qui', 'que', 'qu', 'quoi', 'dont', 'où', 'ou',
  'quand', 'comment', 'pourquoi', 'combien', 'si', 'alors', 'donc', 'ne', 'pas', 'plus', 'mon',
  'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur',
  'leurs', 'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'me', 'te', 'se',
  'y', 'moi', 'toi', 'lui', 'eux',
  // --- French Reporting / Conversational Verbs ---
  'dit', 'dite', 'dites', 'disait', 'disaient', 'dire', 'parler', 'parle', 'parlé', 'parlais',
  'raconter', 'raconte', 'raconté', 'racontait', 'mentionner', 'mentionne', 'mentionné',
  'mentionnait', 'demander', 'demande', 'demandé', 'demandait',

  // --- Spanish Function Words & Pronouns ---
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'e', 'o', 'u', 'pero', 'en', 'a',
  'de', 'del', 'al', 'por', 'para', 'con', 'sin', 'sobre', 'entre', 'es', 'son', 'era', 'eran',
  'ser', 'sido', 'fue', 'fueron', 'he', 'ha', 'has', 'han', 'hemos', 'había', 'habían', 'haber',
  'habido', 'hacer', 'hace', 'hizo', 'hecho', 'este', 'esta', 'estos', 'estas', 'esto', 'ese',
  'esa', 'esos', 'esas', 'eso', 'aquel', 'aquella', 'aquellos', 'aquellas', 'que', 'qué', 'quien',
  'quién', 'quienes', 'quiénes', 'cual', 'cuál', 'cuales', 'cuáles', 'cuando', 'cuándo', 'donde',
  'dónde', 'como', 'cómo', 'cuanto', 'cuánto', 'cuanta', 'cuánta', 'cuantos', 'cuántos', 'cuantas',
  'cuántas', 'si', 'sí', 'no', 'ni', 'tan', 'muy', 'más', 'mas', 'mi', 'mis', 'tu', 'tus', 'su',
  'sus', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'yo', 'tú', 'él', 'ella', 'ellos', 'ellas',
  'nosotros', 'nosotras', 'usted', 'ustedes', 'me', 'te', 'se', 'nos', 'le', 'les', 'lo',
  // --- Spanish Reporting / Conversational Verbs ---
  'dice', 'dijo', 'decía', 'decia', 'decían', 'decian', 'decir', 'dicho', 'hablar', 'habla',
  'habló', 'hablo', 'hablaba', 'hablaban', 'contar', 'cuenta', 'contó', 'conto', 'contaba',
  'mencionar', 'menciona', 'mencionó', 'menciono', 'mencionaba', 'comentar', 'comenta',
  'comentó', 'comento', 'comentaba', 'preguntar', 'pregunta', 'preguntó', 'pregunto',

  // --- German Function Words & Pronouns ---
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'in', 'an', 'auf', 'aus', 'bei', 'mit', 'nach', 'seit', 'von', 'zu',
  'um', 'für', 'fuer', 'ohne', 'durch', 'über', 'ueber', 'unter', 'ist', 'sind', 'war', 'waren',
  'sein', 'gewesen', 'hat', 'haben', 'hatte', 'hatten', 'gehabt', 'wird', 'werden', 'wurde',
  'wurden', 'dieser', 'diese', 'dieses', 'diesen', 'diesem', 'jener', 'jene', 'jenes', 'wer',
  'was', 'wann', 'wo', 'wie', 'warum', 'wieso', 'weshalb', 'wieviel', 'wie viel', 'nicht',
  'kein', 'keine', 'keinem', 'keinen', 'keiner', 'mein', 'meine', 'meinem', 'meinen', 'meiner',
  'dein', 'deine', 'sein', 'seine', 'ihr', 'ihre', 'unser', 'unsere', 'euer', 'eure', 'ich',
  'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'dich', 'sich', 'uns', 'euch', 'ihm', 'ihnen',
  // --- German Reporting / Conversational Verbs ---
  'sagt', 'sagte', 'gesagt', 'sagen', 'sprechen', 'spricht', 'sprach', 'gesprochen', 'erzählen',
  'erzaehlen', 'erzählt', 'erzaehlt', 'erzählte', 'erzaehlte', 'meinen', 'meint', 'meinte',
  'gemeint', 'erwähnen', 'erwaehnen', 'erwähnt', 'erwaehnt', 'erwähnte', 'erwaehnte',
  'fragen', 'fragt', 'fragte', 'gefragt',

  // --- Italian Function Words & Pronouns ---
  'il', 'lo', 'la', 'i', 'gli', 'le', 'l', 'un', 'uno', 'una', 'un\'', 'e', 'ed', 'o', 'ma',
  'in', 'a', 'ad', 'da', 'per', 'con', 'su', 'tra', 'fra', 'di', 'del', 'dello', 'della', 'dei',
  'degli', 'delle', 'd', 'è', 'e\'', 'sono', 'era', 'erano', 'essere', 'stato', 'stata', 'stati',
  'state', 'ha', 'hanno', 'aveva', 'avevano', 'avere', 'avuto', 'fa', 'fare', 'fatto', 'questo',
  'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle', 'chi', 'che', 'cosa',
  'cui', 'dove', 'quando', 'come', 'perché', 'perche', 'quanto', 'quanta', 'quanti', 'quante',
  'se', 'non', 'più', 'piu', 'molto', 'mio', 'mia', 'miei', 'mie', 'tuo', 'tua', 'tuoi', 'tue',
  'suo', 'sua', 'suoi', 'sue', 'nostro', 'nostra', 'nostri', 'nostre', 'vostro', 'vostra',
  'vostri', 'vostre', 'loro', 'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'mi', 'ti', 'si',
  'ci', 'vi', 'li', 'le', 'gli', 'ne',
  // --- Italian Reporting / Conversational Verbs ---
  'dice', 'disse', 'diceva', 'detto', 'dire', 'parlare', 'parla', 'parlò', 'parlo', 'parlato',
  'parlavano', 'raccontare', 'racconta', 'raccontò', 'racconto', 'raccontato', 'menzionare',
  'menziona', 'menzionò', 'menziono', 'menzionato', 'commentare', 'commenta', 'commentò',
  'commento', 'chiedere', 'chiede', 'chiese', 'chiesto',

  // --- Japanese Function Particles, Copula, & Pronouns ---
  'は', 'が', 'を', 'に', 'へ', 'で', 'と', 'から', 'より', 'まで', 'の', 'も', 'ね', 'よ',
  'か', 'な', 'だ', 'である', 'です', 'でした', 'ます', 'ました', 'これ', 'それ', 'あれ',
  'どれ', 'この', 'その', 'あの', 'どの', 'ここ', 'そこ', 'あそこ', 'どこ', 'いつ', '誰',
  'だれ', 'なぜ', 'どう', 'どうして', '何', 'なに', 'なん', 'いくら', 'どのくらい', 'さん',
  // --- Japanese Reporting / Conversational Verbs ---
  '言った', '言っていた', '言っていました', '言います', '言いました', '言う', 'いう',
  '話した', '話していた', '話していました', '話す', '述べた', '述べていた', '聞いた',
  '聞いていた', '尋ねた', 'おっしゃった',

  // --- Chinese Function Words, Pronouns, & Particles ---
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '这', '这个', '那', '那个',
  '哪', '哪个', '什么', '谁', '怎么', '怎样', '多少', '几', '为什么', '和', '跟', '与',
  '同', '及', '或', '或者', '但是', '但', '而且', '虽然', '因为', '所以', '如果', '就',
  '也', '都', '不', '没', '没有', '很', '非常', '到', '从', '向', '对', '给', '把', '被',
  '让', '着', '过', '吧', '呢', '啊', '吗',
  // --- Chinese Reporting / Conversational Verbs ---
  '说', '说了', '说过', '讲', '讲了', '提到', '提及', '讨论', '问', '问了', '告诉',

  // --- Arabic Function Words, Pronouns, & Particles ---
  'في', 'من', 'على', 'إلى', 'الى', 'عن', 'مع', 'حتى', 'منذ', 'لـ', 'بـ', 'كـ', 'و', 'فـ',
  'ثم', 'أو', 'او', 'أم', 'ام', 'لكن', 'بل', 'لا', 'ما', 'لم', 'لن', 'إن', 'ان', 'أن',
  'كان', 'كانت', 'يكون', 'تكون', 'هذا', 'هذه', 'هؤلاء', 'ذلك', 'تلك', 'الذي', 'التي',
  'الذين', 'اللاتي', 'من', 'ماذا', 'متى', 'أين', 'اين', 'كيف', 'كم', 'لماذا', 'هل', 'أ',
  'أنا', 'انا', 'أنت', 'انت', 'هو', 'هي', 'نحن', 'هم', 'هن', 'لي', 'لك', 'له', 'لها',
  'لنا', 'لهم', 'بي', 'بك', 'به', 'بها', 'بنا', 'بهم', 'عني', 'عنك', 'عنه', 'عنها',
  // --- Arabic Reporting / Conversational Verbs ---
  'قال', 'قالت', 'يقول', 'تقول', 'ذكر', 'ذكرت', 'يذكر', 'تذكر', 'حكى', 'حكت',
  'أخبر', 'اخبر', 'أخبرت', 'اخبرت', 'سأل', 'سال', 'سألت', 'سالت', 'تكلم', 'تحدث',
]);

/**
 * Checks whether a segmented token is a substantive lexical anchor.
 * Returns false if the token is a function word, conversational verb, or non-informative fragment.
 */
export function isSubstantiveAnchorToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;
  const clean = token.trim().toLowerCase();
  if (clean.length === 0) return false;

  // Numbers/digits are substantive anchors (e.g. "450", "12")
  if (/^\d+$/u.test(clean)) {
    return true;
  }

  // Tokens of length 1 in alphabetic/syllabic scripts are non-substantive
  if (clean.length === 1 && /[a-zA-Z\u00C0-\u024F\u0600-\u06ff\u0400-\u04ff]/u.test(clean)) {
    return false;
  }

  // Check against universal multilingual non-substantive set
  if (MULTILINGUAL_NON_SUBSTANTIVE_TOKENS.has(clean)) {
    return false;
  }

  return true;
}

export interface UniqueLexicalAnchorResult {
  candidateId: string;
  matchedTokens: string[];
  uniqueTokens: string[];
  qualifiedUniqueTokens: string[];
  rejectedUniqueTokens: string[];
}

/**
 * Extracts unique discriminative tokens present in a candidate document that are ABSENT from other candidates in the pool.
 * Distinguishes qualified substantive anchors from non-substantive/stopword tokens.
 */
export function extractUniqueDiscriminativeTokens(
  queryTokens: string[],
  candidateDocs: Array<{ id: string; text: string }>
): Map<string, UniqueLexicalAnchorResult> {
  const result = new Map<string, UniqueLexicalAnchorResult>();
  if (candidateDocs.length === 0 || queryTokens.length === 0) return result;

  // Build candidate token sets
  const candidateTokenSets = new Map<string, Set<string>>();
  for (const doc of candidateDocs) {
    const docTokens = segmentUnicodeWords(doc.text);
    candidateTokenSets.set(doc.id, new Set(docTokens));
  }

  // Find matched query tokens for each candidate
  const candidateMatches = new Map<string, string[]>();
  for (const doc of candidateDocs) {
    const tokenSet = candidateTokenSets.get(doc.id)!;
    const matches = queryTokens.filter(qToken => tokenSet.has(qToken));
    candidateMatches.set(doc.id, matches);
  }

  // Identify unique discriminators and qualify substantive tokens
  for (const doc of candidateDocs) {
    const myMatches = candidateMatches.get(doc.id) || [];
    const uniqueTokens = myMatches.filter(token => {
      // Check if any other candidate in the pool contains this token
      for (const otherDoc of candidateDocs) {
        if (otherDoc.id === doc.id) continue;
        const otherSet = candidateTokenSets.get(otherDoc.id);
        if (otherSet && otherSet.has(token)) {
          return false; // Not unique to this candidate
        }
      }
      return true; // Unique to this candidate in the candidate pool
    });

    const qualifiedUniqueTokens = uniqueTokens.filter(isSubstantiveAnchorToken);
    const rejectedUniqueTokens = uniqueTokens.filter(t => !isSubstantiveAnchorToken(t));

    result.set(doc.id, {
      candidateId: doc.id,
      matchedTokens: myMatches,
      uniqueTokens,
      qualifiedUniqueTokens,
      rejectedUniqueTokens,
    });
  }

  return result;
}

