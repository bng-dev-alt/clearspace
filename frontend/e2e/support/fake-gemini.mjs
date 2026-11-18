// Falešný Gemini pro lokální E2E (žádná síť ven, žádné kredity). Spuštění: node e2e/support/fake-gemini.mjs <port>
// Odpovídá na POST /v1beta/models/<model>:generateContent. Výstup se odvozuje z přepisu v promptu, takže citace
// jsou doslovné; navíc záměrně vrací halucinované položky, aby E2E ověřilo, že je validátor zahodí.
import http from 'node:http';

const port = Number(process.argv[2] || 55590);
let calls = 0;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function segmentsFrom(text) {
  // řádky tvaru "[seg-3] 1:05 Petr: text"
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\[(seg-\d+)\](?: \d+:\d{2}(?::\d{2})?)?(?: ([^:\n]{1,60}):)? (.+)$/.exec(line.trim());
    if (m) out.push({ id: m[1], speaker: m[2] ?? null, text: m[3] });
  }
  return out;
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__stats') return reply(res, 200, { calls });
    if (req.method !== 'POST' || !/:generateContent/.test(req.url ?? '')) return reply(res, 404, { error: { message: 'not found' } });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls += 1;
      let payload = {};
      try { payload = JSON.parse(raw); } catch { return reply(res, 400, { error: { message: 'bad json' } }); }
      const text = (payload.contents ?? []).flatMap((c) => c.parts ?? []).map((p) => p.text ?? '').join('\n');
      const segs = segmentsFrom(text);
      const find = (re) => segs.find((s) => re.test(s.text));
      const decision = find(/Rozhodli/i);
      const action = find(/připraví|pripravi/i);
      const risk = find(/Riziko/i);
      const q = (s, re) => (s.text.match(re) || [s.text.slice(0, 40)])[0];
      const out = {
        summary: 'Porada řešila release a přípravu migrace.',
        decisions: decision ? [{ text: 'Release se posouvá na pátek.', evidence: [{ segment_id: decision.id, quote: q(decision, /release posuneme na pátek/i) }] }] : [],
        action_items: [
          ...(action ? [{ text: 'Připravit migraci databáze.', evidence: [{ segment_id: action.id, quote: q(action, /připraví migraci databáze/i) }], owner_text: 'Honza', due_text: 'do 25. listopadu', existing_card_id: null }] : []),
          // halucinace: vymyšlený vlastník a termín u skutečné citace + zcela vymyšlená položka bez důkazu
          ...(action ? [{ text: 'Zkontrolovat certifikát.', evidence: [{ segment_id: action.id, quote: q(action, /připraví migraci databáze/i) }], owner_text: 'Karel Dvořák', due_text: 'příští týden', existing_card_id: null }] : []),
          { text: 'Vymyšlený úkol.', evidence: [{ segment_id: 'seg-999', quote: 'nikdo to neřekl' }], owner_text: null, due_text: null, existing_card_id: null },
        ],
        follow_ups: [],
        risks: risk ? [{ text: 'Dodavatel může zpozdit certifikát.', evidence: [{ segment_id: risk.id, quote: q(risk, /dodavatel může zpozdit certifikát/i) }] }] : [],
        blockers: [],
        open_questions: [],
      };
      reply(res, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 123, totalTokenCount: 444 },
        modelVersion: 'fake-gemini',
      });
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`fake gemini on ${port}`));
