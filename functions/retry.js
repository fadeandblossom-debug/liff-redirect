export async function onRequest(context) {
  try {
    const { request } = context;
    const { searchParams } = new URL(request.url);
    const sid = searchParams.get('sid') || '';

    if (!sid) {
      return new Response(JSON.stringify({ error: '缺少 sid 參數' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const GAS_URL = 'https://script.google.com/macros/s/AKfycbzNvAeEywVCgVGieJFZqgdutS_l4pjbNH4K9CIF8zgtybCapUexWCb9R3PLAM2qFCldnA/exec';
    const gasRes = await fetch(GAS_URL + '?sid=' + encodeURIComponent(sid), { redirect: 'follow' });
    const text = await gasRes.text();
    const data = JSON.parse(text);

    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
