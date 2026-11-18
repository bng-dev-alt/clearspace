// Falešný Gemini pro lokální E2E (žádná síť ven, žádné kredity). Spuštění: node e2e/support/fake-gemini.mjs <port>
// Odpovídá na POST /v1beta/models/<model>:generateContent. Výstup se odvozuje z přepisu v promptu, takže citace
// jsou doslovné; navíc záměrně vrací halucinované položky, aby E2E ověřilo, že je validátor zahodí.
import http from 'node:http';

const port = Number(process.argv[2] || 55590);
let calls = 0;
let last = { system: '', text: '' };

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function segmentsFrom(text) {
  // řádky tvaru "[seg-3] 1:05 Petr: text"
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\[(seg-[\w-]+)\](?: \d+:\d{2}(?::\d{2})?)?(?: ([^:\n]{1,60}):)? (.+)$/.exec(line.trim());
    if (m) out.push({ id: m[1], speaker: m[2] ?? null, text: m[3] });
  }
  return out;
}


function meetingBrief(text) {
  const segs = segmentsFrom(text);
  const find = (re) => segs.find((s) => re.test(s.text));
  const decision = find(/Rozhodli/i);
  const action = find(/připraví|pripravi/i);
  const risk = find(/Riziko/i);
  const q = (s, re) => (s.text.match(re) || [s.text.slice(0, 40)])[0];
  return {
    summary: 'Porada řešila release a přípravu migrace.',
    decisions: decision ? [{ text: 'Release se posouvá na pátek.', evidence: [{ segment_id: decision.id, quote: q(decision, /release posuneme na pátek/i) }] }] : [],
    action_items: [
      ...(action ? [{ text: 'Připravit migraci databáze.', evidence: [{ segment_id: action.id, quote: q(action, /připraví migraci databáze/i) }], owner_text: 'Honza', due_text: 'do 25. listopadu', existing_card_id: null }] : []),
      ...(action ? [{ text: 'Zkontrolovat certifikát.', evidence: [{ segment_id: action.id, quote: q(action, /připraví migraci databáze/i) }], owner_text: 'Karel Dvořák', due_text: 'příští týden', existing_card_id: null }] : []),
      { text: 'Vymyšlený úkol.', evidence: [{ segment_id: 'seg-999', quote: 'nikdo to neřekl' }], owner_text: null, due_text: null, existing_card_id: null },
    ],
    follow_ups: [],
    risks: risk ? [{ text: 'Dodavatel může zpozdit certifikát.', evidence: [{ segment_id: risk.id, quote: q(risk, /dodavatel může zpozdit certifikát/i) }] }] : [],
    blockers: [],
    open_questions: [],
  };
}

// Řádky kontextu tvaru "[card:ID] "Název" | ..." a "[item:ID] druh: text"
function refsIn(text) {
  const out = [];
  for (const m of text.matchAll(/\[((?:card|comment|check|activity|item):[^\]\s]+)\]([^\n]*)/g)) out.push({ ref: m[1], rest: m[2] });
  return out;
}

function projectBrief(text) {
  const refs = refsIn(text);
  const blocked = refs.find((r) => r.ref.startsWith('card:') && /Blokováno/.test(r.rest));
  const item = refs.find((r) => r.ref.startsWith('item:'));
  const cardId = blocked ? blocked.ref.slice(5) : null;
  return {
    summary: 'Projekt je ohrožen blokovanou migrací.',
    health_narrative: 'Skóre vychází z blokátoru a úkolu po termínu.',
    risks: [
      // halucinace: neexistující zdroj (musí být zahozeno) + citace, která ve zdroji není (musí být "neověřeno")
      { text: 'Vymyšlené riziko.', severity: 'high', refs: ['card:neexistuje', 'comment:fake'], quote: null },
      ...(blocked ? [{ text: 'Migrace může ohrozit termín.', severity: 'medium', refs: [blocked.ref], quote: 'tohle ve zdroji není' }] : []),
    ],
    blockers: blocked ? [{ text: 'Migrace je blokovaná.', refs: [blocked.ref], quote: null }] : [],
    next_actions: blocked ? [{ text: 'Odblokovat migraci.', kind: 'unblock', refs: [blocked.ref], target_card_id: cardId }, { text: 'Nesmyslný cíl.', kind: 'update', refs: [blocked.ref], target_card_id: 'card-foreign' }] : [],
    open_questions: item ? [{ text: 'Je rozhodnutí z porady stále platné?', refs: [item.ref], quote: null }] : [],
    notes_on_data: [],
  };
}

function chat(text) {
  const blocked = refsIn(text).find((r) => r.ref.startsWith('card:') && /Blokováno/.test(r.rest));
  return `Blokuje to ${blocked ? `[${blocked.ref}]` : 'nějaká karta'}. Vymyšlený zdroj [card:neexistuje] se zahodí.`;
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__stats') return reply(res, 200, { calls });
    if (req.method === 'GET' && req.url === '/__last') return reply(res, 200, last);
    if (req.method !== 'POST' || !/:generateContent/.test(req.url ?? '')) return reply(res, 404, { error: { message: 'not found' } });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls += 1;
      let payload = {};
      try { payload = JSON.parse(raw); } catch { return reply(res, 400, { error: { message: 'bad json' } }); }
      const text = (payload.contents ?? []).flatMap((c) => c.parts ?? []).map((p) => p.text ?? '').join('\n');
      const system = (payload.systemInstruction?.parts ?? []).map((p) => p.text ?? '').join('\n');
      last = { system, text };
      let out;
      if (/analytik porad/.test(system)) out = meetingBrief(text);
      // R7: existující featury; PM záměrně vrací vlastní (halucinované) healthScore, které server musí přepsat vzorcem
      else if (/AI Project Manager/.test(system)) out = { summary: 'PM shrnutí', healthScore: 3, confidenceScore: 80, risks: [], blockers: [], suggestedChanges: [] };
      else if (/Daily Executive Briefing/.test(system)) out = { greeting: 'Dobré ráno', executiveSummary: 'ok', completedYesterday: [], topPrioritiesToday: [], capacityAlerts: [], recommendedActions: [] };
      else if (/optimalizaci a vylepšování zadání/.test(system)) out = { details: 'Lepší popis', acceptanceCriteria: '1.', risks: '', missingInfo: '', checklist: [] };
      else if (/Project Brief/.test(system)) out = projectBrief(text);
      else out = null; // chat = prostý text
      const answer = out === null ? chat(text) : JSON.stringify(out);
      reply(res, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 123, totalTokenCount: 444 },
        modelVersion: 'fake-gemini',
      });
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`fake gemini on ${port}`));
