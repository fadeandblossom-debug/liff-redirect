export async function onRequest(context) {
  const url = new URL(context.request.url);
  const sid = url.searchParams.get('sid') || '';

  if (!sid) {
    return new Response(JSON.stringify({ error: '缺少 sid 參數' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbyAeMvhJ6ye3so25B64rvslzkgdGV81OGnWbVwSCaZPO_4sSrkKdxfhjBBIkqkFkmCKyg/exec';

  try {
    const response = await fetch(GAS_URL + '?sid=' + encodeURIComponent(sid), {
      redirect: 'follow'
    });
    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
