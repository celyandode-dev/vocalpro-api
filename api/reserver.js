// api/reserver.js — Fonction Vercel appelée par l'agent Vapi.
// Reçoit un RDV → le crée dans Cal.com → envoie un SMS Twilio de confirmation.
// Déploie ce fichier dans /api/ de n'importe quel projet Vercel (Next.js ou autre).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  try {
    // Vapi peut envoyer les arguments de plusieurs façons — on gère les cas courants
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

    // Normalisation du fuseau : si l'heure n'a pas d'indication de fuseau,
    // on considère qu'elle est en heure de Paris (été = +02:00).
    let dt = String(date_heure).trim();
    if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(dt)) {
      dt = dt + '+02:00';
    }
    const startIso = new Date(dt).toISOString();

    // 1) Créer le RDV dans Cal.com
    const cal = await fetch('https://api.cal.com/v2/bookings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
        'cal-api-version': process.env.CAL_API_VERSION, // valeur affichée dans la doc de l'endpoint /v2/bookings
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
        start: startIso,
        attendee: {
          name: nom_client,
          email: email || 'client@vocalpro.fr',
          phoneNumber: telephone,
          timeZone: 'Europe/Paris',
          language: 'fr',
        },
        metadata: { prestation: prestation || '', source: 'VocalPro' },
      }),
    });

    const calData = await cal.json();
    if (!cal.ok) {
      console.error('Cal.com error:', JSON.stringify(calData));
      return res.status(200).json({
        ok: false,
        error: "Ce créneau n'est pas disponible, propose une autre heure au client.",
      });
    }

    // 2) SMS de confirmation via Twilio
    const quand = new Date(dt).toLocaleString('fr-FR', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Europe/Paris',
    });
    await sendSms(
      telephone,
      `Bonjour ${nom_client}, votre RDV ${prestation || ''} est confirmé le ${quand}. À bientôt !`
    );

    // 3) Réponse que l'agent lira à voix haute
    return res.status(200).json({
      ok: true,
      message: `C'est réservé pour le ${quand}. Vous recevez un SMS de confirmation.`,
    });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: 'Une erreur est survenue, on réessaie.' });
  }
}

async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM; // ton numéro Twilio, ex +33756xxxxxx
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
