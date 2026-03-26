export async function onRequest(context) {
  const url = new URL(context.request.url);
  const sid = url.searchParams.get('sid') || '';

  if (!sid) {
    return new Response(JSON.stringify({ error: '缺少 sid 參數' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzNvAeEywVCgVGieJFZqgdutS_l4pjbNH4K9CIF8zgtybCapUexWCb9R3PLAM2qFCldnA/exec';

  const gasResponse = await fetch(GAS_URL + '?sid=' + encodeURIComponent(sid));
  const text = await gasResponse.text();

  return new Response(text, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
