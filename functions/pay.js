export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const orderId = url.searchParams.get('orderId');

  if (!orderId) {
    return new Response('缺少訂單編號，請聯繫店家重新取得付款連結。', { status: 400 });
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec';
  return Response.redirect(`${GAS_URL}?orderId=${encodeURIComponent(orderId)}`, 302);
}
