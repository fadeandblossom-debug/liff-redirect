export async function onRequest(context) {
  try {
    const { request } = context;
    const { searchParams } = new URL(request.url);
    const sid = searchParams.get('sid') || '';

    console.log('sid:', sid);

    if (!sid) {
      return new Response(JSON.stringify({ error: '缺少 sid 參數' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const GAS_URL = 'https://script.google.com/macros/s/AKfycbyAeMvhJ6ye3so25B64rvslzkgdGV81OGnWbVwSCaZPO_4sSrkKdxfhjBBIkqkFkmCKyg/exec';
    const gasRes = await fetch(GAS_URL + '?sid=' + encodeURIComponent(sid), { redirect: 'follow' });

    console.log('GAS status:', gasRes.status);
    const text = await gasRes.text();
    console.log('GAS text:', text);

    return new Response(text, {
      status: gasRes.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    console.error('catch error:', err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
