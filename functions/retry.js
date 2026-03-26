export async function onRequest(context) {
  const url = new URL(context.request.url);
  const sid = url.searchParams.get('sid') || '';

  if (!sid) {
    return new Response(JSON.stringify({ error: '缺少 sid 參數' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbwFe32VAT3TWrhZNhEZaQsJXxE5hv4BqeMFKAtlqY1YXB3vu05xH5j69-xUkMVp8juBhw/exec';

  const gasResponse = await fetch(GAS_URL + '?sid=' + encodeURIComponent(sid), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const text = await gasResponse.text();

  return new Response(text, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
