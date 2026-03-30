export async function onRequestPost(context) {
  const formData = await context.request.formData();

  const orderId  = formData.get('CustomField1') || '';
  const rtnCode  = formData.get('RtnCode')       || '';
  const rtnMsg   = formData.get('RtnMsg')        || '';

  const params = new URLSearchParams();
  if (orderId)  params.set('orderId',  orderId);
  if (rtnCode)  params.set('RtnCode',  rtnCode);
  if (rtnMsg)   params.set('RtnMsg',   decodeURIComponent(rtnMsg));

  const redirectUrl = 'https://liff-redirect.pages.dev/result.html?' + params.toString();

  return Response.redirect(redirectUrl, 302);
}
