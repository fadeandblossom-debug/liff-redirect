export async function onRequestPost(context) {
  const formData = await context.request.formData();

  const orderId  = formData.get('CustomField1') || '';
  const rtnCode  = formData.get('RtnCode')       || '';
  const rtnMsg   = formData.get('RtnMsg')        || '';

  // 付款成功 → 不跳轉，讓綠界顯示自己的成功頁面
  if (rtnCode === '1') {
    return new Response('', { status: 200 });
  }

  // 付款失敗 → 跳轉到 result.html
  const params = new URLSearchParams();
  if (orderId)  params.set('orderId',  orderId);
  if (rtnCode)  params.set('RtnCode',  rtnCode);
  if (rtnMsg)   params.set('RtnMsg',   decodeURIComponent(rtnMsg));

  return Response.redirect('https://liff-redirect.pages.dev/result.html?' + params.toString(), 302);
}
