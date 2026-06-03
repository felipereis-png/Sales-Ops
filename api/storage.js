const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx2q9ELRW9zbxl6-YfD2-PeAbsHd91qEFwyRg1qt76OZBZ6OuLXYETWE7DMTDy1-Gh6Qg/exec';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const { tab } = req.query;
    if (!tab) return res.status(400).json({ error: 'missing tab' });
    try {
      const r = await fetch(`${APPS_SCRIPT_URL}?tab=${encodeURIComponent(tab)}`);
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const r = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(405).json({ error: 'method not allowed' });
};
