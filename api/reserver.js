// api/reserver.js — Fonction Vercel appelée par l'agent Vapi.
// Trouve le créneau LIBRE le plus proche de l'heure demandée dans Cal.com,
// le réserve, et envoie un SMS Twilio de confirmation.

const CAL_BASE = 'https://api.cal.com/v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  try {
    const body = req.body || {};
    let args =
      body?.message?.toolCalls?.[0]?.function?.arguments ??
      body?.arguments ??
      body;
    if (typeof args === 'string') args = JSON.parse(args);

    const { prestation, date_heure, nom_client, telephone, email } = args;

    if (!date_heure || !nom_client || !telephone) {
      return res.status(200).json({
        ok: false,
        error: 'Informations manquantes : il me faut la date, le nom et le téléphone.',
      });
    }

    // Fuseau : si l'heure n'a pas d'indication, on considère Paris (été = +02:00).
    let dt = String(date_heure).trim().replace(' ', 'T');
    if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(dt)) dt = dt + '+02:00';
    console.log('date_heure reçu:', JSON.stringify(date_heure), '-> interprété:', dt);
    const requested = new Date(dt);
    const reqT = isNaN(requested.getTime()) ? 0 : requested.getTime();

    const tel = normalizeTel(telephone);
    const eventTypeId = Number(process.env.CAL_EVENT_TYPE_ID);

    // 1) Récupérer les créneaux LIBRES sur une fenêtre autour du jour demandé.
    const startDay = new Date().toISOString().slice(0, 10); // toujours à partir d'aujourd'hui
    const endObj = new Date(startDay + 'T00:00:00Z');
    endObj.setUTCDate(endObj.getUTCDate() + 8);
    const endDay = endObj.toISOString().slice(0, 10);

    const slotsUrl = `${CAL_BASE}/slots?eventTypeId=${eventTypeId}&start=${startDay}&end=${endDay}&timeZone=Europe/Paris`;
    const slotsRes = await fetch(slotsUrl, {
      headers: {
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
        'cal-api-version': '2024-09-04',
      },
    });
    const slotsJson = await slotsRes.json();
    if (!slotsRes.ok) {
      console.error('Cal.com slots error:', JSON.stringify(slotsJson));
      return res.status(200).json({ ok: false, error: "Impossible de lire les disponibilités, réessaie plus tard." });
    }

    const byDay = slotsJson.data || {};
    const sorted = Object.values(byDay)
      .flat()
      .map((s) => (typeof s === 'string' ? s : s.start))
      .filter(Boolean)
      .map((iso) => ({ iso, t: new Date(iso).getTime() }))
      .sort((a, b) => a.t - b.t);

    if (sorted.length === 0) {
      return res.status(200).json({
        ok: false,
        error: "Aucun créneau libre cette semaine-là, propose une autre semaine au client.",
      });
    }

    // Choisir le créneau libre le plus proche de la demande (à défaut, le plus tôt).
    const chosen = sorted.find((x) => x.t >= reqT) || sorted[0];
    const exact = Math.abs(chosen.t - reqT) < 60 * 1000;

    // 2) Réserver ce créneau.
    const cal = await fetch(`${CAL_BASE}/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
        'cal-api-version': process.env.CAL_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventTypeId,
        start: new Date(chosen.iso).toISOString(),
        attendee: {
          name: nom_client,
          email: email || 'client@vocalpro.fr',
          phoneNumber: tel,
          timeZone: 'Europe/Paris',
          language: 'fr',
        },
        metadata: { prestation: prestation || '', source: 'VocalPro' },
      }),
    });
    const calData = await cal.json();
    if (!cal.ok) {
      console.error('Cal.com error:', JSON.stringify(calData));
      return res.status(200).json({ ok: false, error: "Ce créneau vient d'être pris, propose une autre heure." });
    }

    const quand = new Date(chosen.iso).toLocaleString('fr-FR', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Europe/Paris',
    });

    await sendSms(
      tel,
      `Bonjour ${nom_client}, votre RDV ${prestation || ''} est confirmé le ${quand}. À bientôt !`
    );

    const message = exact
      ? `C'est réservé pour le ${quand}. Vous recevez un SMS de confirmation.`
      : `Ce créneau n'était pas libre, je vous ai réservé le plus proche : ${quand}. Vous recevez un SMS de confirmation.`;

    return res.status(200).json({ ok: true, exact, message });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: 'Une erreur est survenue, on réessaie.' });
  }
}

// 06 12 34 56 78 -> +33612345678
function normalizeTel(raw) {
  let t = String(raw || '').replace(/[\s.\-()]/g, '');
  if (t.startsWith('+')) return t;
  if (t.startsWith('00')) return '+' + t.slice(2);
  if (t.startsWith('0')) return '+33' + t.slice(1);
  if (t.startsWith('33')) return '+' + t;
  return t;
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return; // SMS optionnel tant que Twilio n'est pas configuré
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
}
