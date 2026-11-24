/** Czech invitation e-mail (RUN 01B): one short message, ClearSpace colours, plain-text twin. */

export interface InvitationEmailData {
  inviterName: string;
  projectName: string;
  role: 'admin' | 'member' | 'viewer' | null;
  acceptUrl: string;
  expiresAt: string; // ISO
}

const ROLE_TEXT: Record<'admin' | 'member' | 'viewer', string> = {
  admin: 'správce (upravuje projekt a spravuje členy)',
  member: 'editor (upravuje úkoly a komentuje)',
  viewer: 'čtenář (projekt jen čte)',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

/** Untrusted names: one line, bounded, no URLs that a mail client could turn into links. */
export function safeName(s: string, max = 80): string {
  const one = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
  // break link-looking text so mail clients do not turn a name into a clickable link
  return one.replace(/(https?):\/\//gi, '$1\u200b://').replace(/www\./gi, 'www\u200b.') || 'Kolega';
}

export function formatCzechDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Prague' });
}

export function invitationSubject(d: InvitationEmailData): string {
  return `${safeName(d.inviterName, 60)} vás zve do projektu ${safeName(d.projectName, 60)} v ClearSpace`;
}

export function invitationText(d: InvitationEmailData): string {
  const lines = [
    'Dobrý den,',
    '',
    `${safeName(d.inviterName)} vás zve ke spolupráci na projektu „${safeName(d.projectName)}“ v aplikaci ClearSpace.`,
    ...(d.role ? [`Vaše role: ${ROLE_TEXT[d.role]}.`] : []),
    '',
    'Pozvánku přijmete na této adrese:',
    d.acceptUrl,
    '',
    `Odkaz platí do ${formatCzechDate(d.expiresAt)} a lze ho použít jen jednou, s účtem na tuto e-mailovou adresu.`,
    '',
    'Pokud pozvánku nečekáte, můžete tento e-mail ignorovat. Bez přijetí se nic nestane.',
    '',
    'ClearSpace',
  ];
  return lines.join('\n');
}

export function invitationHtml(d: InvitationEmailData): string {
  const inviter = escapeHtml(safeName(d.inviterName));
  const project = escapeHtml(safeName(d.projectName));
  const url = escapeHtml(d.acceptUrl);
  const role = d.role ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1b1b16">Vaše role: <strong>${escapeHtml(ROLE_TEXT[d.role])}</strong>.</p>` : '';
  return `<!doctype html>
<html lang="cs">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pozvánka do ClearSpace</title></head>
<body style="margin:0;padding:0;background:#fbf9f4;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf9f4;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e8e3d8;border-radius:12px">
        <tr><td style="padding:28px 32px 8px">
          <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#1b1b16">clearspace<span style="color:#0b7d57">.</span></p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1b1b16">Dobrý den,</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#1b1b16"><strong>${inviter}</strong> vás zve ke spolupráci na projektu <strong>${project}</strong>.</p>
          ${role}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:#0b7d57">
            <a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Přijmout pozvánku</a>
          </td></tr></table>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#5d5a52">Odkaz platí do ${escapeHtml(formatCzechDate(d.expiresAt))} a lze ho použít jen jednou, s účtem na tuto e-mailovou adresu.</p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#5d5a52;word-break:break-all">Pokud tlačítko nefunguje, otevřete: ${url}</p>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;border-top:1px solid #efeae0">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#8a867c">Pokud pozvánku nečekáte, můžete tento e-mail ignorovat. Bez přijetí se nic nestane.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
