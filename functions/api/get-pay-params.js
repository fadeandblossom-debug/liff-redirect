import { createHash } from 'node:crypto';

function computeCheckMacValue(params, hashKey, hashIV) {
  // 1. 按字母排序
  const sortedKeys = Object.keys(params).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // 2. 串接參數
  let queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&');

  // 3. 前後加 HashKey 和 HashIV
  queryString = `HashKey=${hashKey}&${queryString}&HashIV=${hashIV}`;

  // 4. URL encoding
  queryString = encodeURIComponent(queryString)
    .replace(/%20/g, '+')
    .replace(/%21/g, '!')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*')
    .replace(/%2D/g, '-')
    .replace(/%2E/g, '.')
    .replace(/%5F/g, '_');

  // 5. 轉小寫
  queryString = queryString.toLowerCase();

  // 6. SHA256 並轉大寫
  return createHash('sha256').update(queryString).digest('hex').toUpperCase();
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const orderId = url.searchParams.get('orderId');

  if (!orderId) {
    return new Response(JSON.stringify({ error: '缺少 orderId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const ECPAY_KEY = context.env.ECPAY_KEY;
  const ECPAY_IV  = context.env.ECPAY_IV;

  if (!ECPAY_KEY || !ECPAY_IV) {
    return new Response(JSON.stringify({ error: '缺少金流設定' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 1. 呼叫 GAS doGet 取得金額
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec';
  let totalAmount;
  try {
    const gasRes = await fetch(`${GAS_URL}?orderId=${encodeURIComponent(orderId)}&mode=api`, {
      redirect: 'follow'
    });
    const gasData = await gasRes.json();
    totalAmount = gasData.totalAmount;
    if (!totalAmount || totalAmount <= 0) throw new Error('金額異常');
  } catch (err) {
    return new Response(JSON.stringify({ error: '查詢訂單失敗：' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. 產生新的 MerchantTradeNo（orderId 前8碼 + 當下時間戳）
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const tradeNo = (orderId.substring(0, 8) + timestamp).substring(0, 20);

  // 3. 組綠界參數
  const tradeDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const params = {
    MerchantID:       '3492283',
    MerchantTradeNo:  tradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType:      'aio',
    TotalAmount:      String(totalAmount),
    TradeDesc:        'FlowerGift',
    ItemName:         'FlowerOrder',
    ReturnURL:        'https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec',
    OrderResultURL:   'https://liff-redirect.pages.dev/payment-result',
    ChoosePayment:    'ALL',
    EncryptType:      '1',
    IgnorePayment:    'CVS#BARCODE',
    CustomField1:     orderId,
  };

  // 4. 計算 CheckMacValue
  const checkMacValue = computeCheckMacValue(params, ECPAY_KEY, ECPAY_IV);

  // 5. 回傳完整參數給 pay.html
  return new Response(JSON.stringify({
    ...params,
    CheckMacValue: checkMacValue,
    ecpayUrl: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5'
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
