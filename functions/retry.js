export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const sid = url.searchParams.get('sid') || '';

  if (!sid) {
    return new Response(JSON.stringify({ error: '缺少 sid 參數' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzNvAeEywVCgVGieJFZqgdutS_l4pjbNH4K9CIF8zgtybCapUexWCb9R3PLAM2qFCldnA/exec';
  const apiUrl = GAS_URL + '?sid=' + encodeURIComponent(sid);

  // 照官方範例：重新建立 Request，並設定 Origin header
  const newRequest = new Request(apiUrl, request);
  newRequest.headers.set('Origin', new URL(apiUrl).origin);

  const gasResponse = await fetch(newRequest);

  // 照官方範例：重新建立 Response 才能修改 headers
  const response = new Response(gasResponse.body, gasResponse);
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Content-Type', 'application/json');

  return response;
}
