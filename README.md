# 榮枯有時 Fade & Blossom — LINE 預約自動化系統技術文件

> 最後更新：2026-05-08
> GAS 專案名稱：LINE 預約串接
> GAS 綁定方式：容器綁定（花藝訂單記錄表）

---

## 目錄

1. [系統概覽](#系統概覽)
2. [技術架構](#技術架構)
3. [前置作業：LIFF 與 Tally 表單設定](#前置作業liff-與-tally-表單設定)
4. [🛠️ SOP：更換 Tally 表單流程](#️-sop更換-tally-表單流程)
5. [LINE 後台設定](#line-後台設定)
6. [環境設定](#環境設定)
7. [GAS 檔案說明與完整程式碼](#gas-檔案說明與完整程式碼)
8. [Cloudflare Pages 檔案說明](#cloudflare-pages-檔案說明)
9. [Google Sheet 欄位對照](#google-sheet-欄位對照)
10. [訂單狀態流程](#訂單狀態流程)
11. [Google Calendar 整合（Stage 5）](#google-calendar-整合stage-5)
12. [LINE 訊息範本](#line-訊息範本)
13. [部署方式](#部署方式)
14. [重要技術筆記](#重要技術筆記)
15. [常見問題排查](#常見問題排查)
16. [開發踩坑紀錄](#開發踩坑紀錄)
17. [附錄：相關資源](#附錄相關資源)

---

## 系統概覽

本系統為花藝工作室「榮枯有時 Fade & Blossom」的 LINE 預約自動化流程，整合 LIFF → Tally 表單 → Google Sheet → LINE Messaging API → 綠界 ECPay 金流 → Google Calendar，讓店家透過 Google Sheet 操作，完成從接單到收款、行事曆管理的完整流程。

> **表單工具**：使用 Tally（非 Google Forms）
> **LINE Channel ID**：2009304285

### 主要功能

| Stage | 名稱 | 觸發方式 | 說明 |
|-------|------|----------|------|
| Stage 1 | 新單自動歡迎 | 時間觸發（每分鐘） | 新訂單自動發送 LINE 歡迎訊息 |
| Stage 2 | 發送訂單確認 | 手動填「發送」觸發 | 發送訂單明細給客戶確認（含配送運費顯示） |
| Stage 3 | 發送付款連結 | 手動填「發送」觸發 | 產生短網址付款連結並發送 LINE |
| Stage 4 | 付款結果通知 | 綠界 POST 回傳 | 付款成功發 LINE 通知，失敗更新狀態 |
| Stage 4+ | 重新付款 | 客戶從失敗頁點擊 | 重新產生付款連結並跳轉 |
| Stage 5 | Google Calendar 整合 | 付款成功自動觸發 / Sheet 編輯 | 建立/更新/管理行事曆活動 |

---

## 技術架構

```
客戶點擊 LINE 內的訂購連結（LIFF URL）
    ↓
LIFF 取得客戶 LINE userId
    ↓
跳轉至 Tally 表單（URL 帶入 userId 參數）
    ↓
客戶填寫並提交表單
    ↓
Tally 原生整合推播至 Google Sheet「花禮預訂單」
    ↓
Google Apps Script（容器綁定於花藝訂單記錄表）
    ├── Stage1：時間觸發（每分鐘）→ LINE 歡迎訊息
    ├── Stage2：onEditTrigger → LINE 訂單確認（含配送運費）
    ├── Stage3：onEditTrigger → 產生短網址付款連結 → LINE
    ├── Stage4 doPost：接收綠界付款結果（用 CustomField1 查找訂單）→ LINE 通知 → 建立 Calendar 活動
    ├── Stage4 doGet：重新產生付款連結（API mode 回傳 JSON）
    └── Stage5：onEditTrigger → 更新/刪除/重建 Calendar 活動
         ↓
Cloudflare Pages（liff-redirect.pages.dev）
    ├── pay.html：向 /api/get-pay-params 取得新單號與參數，自動 POST 給綠界
    ├── result.html：付款失敗/首次付款入口頁，含「前往付款」/「重新付款」按鈕
    ├── functions/api/get-pay-params.js：產生新 MerchantTradeNo、計算 CheckMacValue
    ├── functions/payment-result.js：接收綠界 POST，轉址到 result.html 或 success.html
    └── functions/test-gas.js：測試用（可保留或刪除）
         ↓
綠界 ECPay 正式金流
    └── payment.ecpay.com.tw/Cashier/AioCheckOut/V5
```

---

## 前置作業：LIFF 與 Tally 表單設定

### LIFF 連結產生與跳轉邏輯

LIFF 連結（`https://liff.line.me/xxx`）是整個系統的**入口**。它並非由 Tally 或 GAS 產生，而是在 LINE Developers Console 手動設定，並搭配一個放在 Cloudflare Pages 的 HTML 頁面執行跳轉。

**設定流程：**

1. 登入 [LINE Developers Console](https://developers.line.biz)
2. 選擇 Channel（ID：`2009304285`）→ 點選「LIFF」分頁
3. 建立 LIFF App，設定：
   - **Scopes**：務必勾選 `profile`（否則 `liff.getProfile()` 會失敗）
   - **Endpoint URL**：`https://liff-redirect.pages.dev/`（即 Cloudflare Pages 的 `index.html`）
4. 建立後取得 LIFF URL，格式為 `https://liff.line.me/200xxxxxxx-xxxxxxxx`
5. 將這個 LIFF URL 放進 LINE 的訊息或選單中，作為客戶的訂購入口

---

## GAS 檔案說明與完整程式碼

### Config.gs

```javascript
const CONFIG = {
  SHEET_NAME:         '花禮預訂單',
  TRIGGER_COL_NAME:   '是否發送訂單確認',
  TRIGGER_VALUE:      '發送',
  PAY_TRIGGER_COL_NAME: '發送付款連結',
  PAY_TRIGGER_VALUE:  '發送',
  STATUS_COL_NAME:    '狀態',
  PAY_LINK_COL_NAME:  '付款連結',
};
```

### Stage2_OrderConfirm.gs

**觸發方式**：`onEditTrigger`（安裝型 on-edit 觸發）

> ✅ 2026-05-08 更新：選擇配送時，LINE 訊息新增顯示「配送運費：NT$ xxx」欄位。

```javascript
// =============================================
// Stage2_OrderConfirm.gs
// =============================================

function onEditTrigger(e) {
  if (!e || !e.range) return;
  console.log('onEditTrigger 觸發：' + e.range.getSheet().getName() + ' 第 ' + e.range.getRow() + ' 列 第 ' + e.range.getColumn() + ' 欄');
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== CONFIG.SHEET_NAME) return;

  const headerValues = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headers = headerValues.map(h => h.toString().replace(/[\s\r\n]+/g, ''));

  const editedCol   = range.getColumn();
  const editedValue = range.getValue();

  // --- Stage 2：Z 欄填「發送」→ 發訂單確認 LINE ---
  const triggerIdx = headers.indexOf(CONFIG.TRIGGER_COL_NAME.replace(/[\s\r\n]+/g, ''));
  if (triggerIdx !== -1 && editedCol === triggerIdx + 1 && editedValue === CONFIG.TRIGGER_VALUE) {
    processOrderConfirmation(sheet, range.getRow(), headers);
    return;
  }

  // --- Stage 3：AB 欄填「發送」→ 發付款連結 LINE ---
  const payTriggerIdx = headers.indexOf(CONFIG.PAY_TRIGGER_COL_NAME.replace(/[\s\r\n]+/g, ''));
  if (payTriggerIdx !== -1 && editedCol === payTriggerIdx + 1 && editedValue === CONFIG.PAY_TRIGGER_VALUE) {
    processPayLink(sheet, range.getRow(), headers);
    return;
  }

  // --- Stage 5：AF 欄填「刪除」或「重建」→ 管理 Calendar 活動 ---
  const manageCalIdx = headers.indexOf('刪除重建行事曆');
  if (manageCalIdx !== -1 && editedCol === manageCalIdx + 1) {
    const rowData = sheet.getRange(range.getRow(), 1, 1, sheet.getLastColumn()).getValues()[0];

    if (editedValue === '刪除') {
      softDeleteCalendarEvent(rowData, headers, range.getRow(), sheet);
      sheet.getRange(range.getRow(), manageCalIdx + 1).setValue('');
      return;
    }

    if (editedValue === '重建') {
      rebuildCalendarEvent(rowData, headers, range.getRow(), sheet);
      sheet.getRange(range.getRow(), manageCalIdx + 1).setValue('');
      return;
    }
  }

  // --- Stage 5：指定欄位修改 → 已付款才更新 Calendar ---
  const calendarTriggerCols = [
    '訂購人姓名', '花禮品項', '花禮名稱', '配送方式', '配送運費',
    '訂花人手機', '取花日期', '自取-取花時段', '運送-花禮抵達時段',
    '花禮數量', '卡片類型', '卡片費', '加購卡片數量',
    '收花人姓名', '收花地址', '收花人電話', '訂單備註',
    '付款日期', '付款單號', '付款金額'
  ].map(name => headers.indexOf(name) + 1).filter(col => col > 0);

  if (calendarTriggerCols.includes(editedCol)) {
    const rowData = sheet.getRange(range.getRow(), 1, 1, sheet.getLastColumn()).getValues()[0];
    const order   = {};
    headers.forEach((h, i) => { order[h] = rowData[i]; });

    const payDate = (order['付款日期'] || '').toString().trim();
    if (payDate) {
      updateCalendarEvent(rowData, headers);
    }
    return;
  }
}

function processOrderConfirmation(sheet, row, headers) {
  const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const order = {};
  headers.forEach((header, index) => { order[header] = rowData[index]; });

  const shippingMethod = (order['配送方式'] || '').toString();
  const isShipping = shippingMethod.includes('配送') || shippingMethod.includes('運送');

  const timeLabel = isShipping ? '▪️ 運送花禮時段：' : '▪️ 自取花禮時段：';
  const rawTime = isShipping ? order['運送-花禮抵達時段'] : order['自取-取花時段'];
  let timeRangeStr = '';

  if (rawTime instanceof Date) {
    let hours   = rawTime.getHours();
    let minutes = rawTime.getMinutes();
    let startM  = minutes < 30 ? '00' : '30';
    let endH    = minutes < 30 ? hours : hours + 1;
    let endM    = minutes < 30 ? '30' : '00';
    let startTotal = hours * 100 + parseInt(startM);
    let endTotal   = endH * 100 + parseInt(endM);

    if (startTotal < 1100) {
      timeRangeStr = '11:00 - 11:30';
    } else if (endTotal >= 2030) {
      timeRangeStr = '20:00 - 20:30';
    } else {
      timeRangeStr = hours.toString().padStart(2, '0') + ':' + startM
        + ' - '
        + endH.toString().padStart(2, '0') + ':' + endM;
    }
  } else {
    timeRangeStr = '11:00 - 20:30 (依預約時段)';
  }

  const itemPrice   = Number(order['花禮價格']) || 0;
  const itemCount   = Number(order['花禮數量']) || 1;
  const itemTotal   = itemPrice * itemCount;
  const cardTotal   = Number(order['卡片費'])   || 0;
  const shippingFee = Number(order['配送運費']) || 0;
  const totalAmount = itemTotal + cardTotal + shippingFee;

  let shippingInfo = isShipping ?
    '\n【 三、收花人資訊 】\n▪️ 收件姓名：' + (order['收花人姓名']  || '同訂購人') +
    '\n▪️ 收件地址：' + (order['收花地址']   || '未提供') +
    '\n▪️ 聯絡電話：' + (order['收花人電話'] || '未提供') : '';

  const pickupDate = order['取花日期'] instanceof Date ?
    Utilities.formatDate(order['取花日期'], 'GMT+8', 'yyyy-MM-dd') : order['取花日期'];

  const confirmMsg = order['訂購人姓名'] + ' 您好，這是您的【 訂單確認 】明細：\n\n'
    + '感謝您讓「榮枯有時」參與您的生活。\n'
    + '以下是您的訂單明細及費用計算，請確認資料無誤：\n\n'
    + '【 一、訂購明細 】\n'
    + '▪️ 取花日期：' + pickupDate + '\n'
    + timeLabel + timeRangeStr + '\n'
    + '  （工作室取貨時段為 11:00 - 20:30）\n'
    + '▪️ 花禮品項：' + (order['花禮品項'] || '無') + '\n'
    + '▪️ 花禮名稱：' + (order['花禮名稱'] || '依需求調整') + '\n'
    + '▪️ 花禮數量：' + itemCount + '\n'
    + '▪️ 花禮金額：NT$ ' + itemTotal + '\n'
    + '▪️ 加購卡片：' + (order['卡片類型'] || '無') + ' (NT$ ' + cardTotal + ' / ' + (order['加購卡片數量'] || 0) + '張)\n'
    + '▪️ 加購金額：NT$ ' + cardTotal + '\n'
    + (isShipping ? '▪️ 配送運費：NT$ ' + shippingFee + '\n' : '')  // ✅ 選擇配送才顯示運費
    + '▪️ 應付總額：NT$ ' + totalAmount + '\n'
    + '▪️ 訂單備註：' + (order['訂單備註'] || '無') + '\n'
    + shippingInfo + '\n\n'
    + '【 二、訂購人資訊 】\n'
    + '▪️ 聯絡姓名：' + order['訂購人姓名'] + '\n'
    + '▪️ 聯絡電話：' + order['訂花人手機'] + '\n\n'
    + '---\n'
    + '🌿 若上述訂單資訊確認無誤，請回覆告知我們。\n'
    + '確認後花藝師將為您提供後續服務。';

  const userIdIdx = headers.indexOf('userId');
  if (userIdIdx !== -1 && rowData[userIdIdx]) {
    sendLinePush(rowData[userIdIdx], confirmMsg);
    const stIdx = headers.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));
    if (stIdx !== -1) sheet.getRange(row, stIdx + 1).setValue('已確認訂單');
    console.log('Stage2 成功發送：' + order['訂購人姓名']);
  } else {
    console.log('錯誤：第 ' + row + ' 列找不到 userId');
  }
}
```

### Stage3_PayLink.gs

> ✅ 2026-05-08 更新：LINE 發送的付款連結改為短網址（`pay.html?orderId=xxx`），每次點擊都由 Cloudflare Function 產生新的 MerchantTradeNo，解決重複點擊導致付款失敗的問題。店家只需發送一次連結，客戶可以多次點擊。

```javascript
/**
 * Stage3_PayLink.gs
 */
function processPayLink(sheet, row, headers) {
  const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const order = {};
  headers.forEach((header, index) => { order[header] = rowData[index]; });

  const userId = order['userId'] ? order['userId'].toString().trim() : "";
  if (!userId) {
    console.log("Row " + row + " 沒有 userId，跳過");
    return;
  }

  const submissionId = (order['SubmissionID'] || "").toString().replace(/[\s\r\n]+/g, '').substring(0, 8);
  const timestamp = Utilities.formatDate(new Date(), "GMT+8", "MMddHHmm");
  const tradeNo = (submissionId + timestamp).substring(0, 20);

  const totalAmount = Number(order['付款金額']) || 0;
  if (totalAmount <= 0) {
    console.log("Row " + row + " 付款金額為 0，跳過");
    return;
  }

  const itemName = 'FlowerOrder';
  const payUrl = createEcPayLink(tradeNo, totalAmount, itemName, submissionId);

  // 寫回付款連結（完整連結，供後台查閱）
  const payLinkColName = CONFIG.PAY_LINK_COL_NAME.replace(/[\s\r\n]+/g, '');
  const payLinkIdx = headers.indexOf(payLinkColName);
  if (payLinkIdx !== -1) {
    sheet.getRange(row, payLinkIdx + 1).setValue(payUrl);
  }

  // 寫回付款單號
  const tradeNoIdx = headers.indexOf('付款單號');
  if (tradeNoIdx !== -1) {
    sheet.getRange(row, tradeNoIdx + 1).setValue(tradeNo);
  }

  const customerName = order['訂購人姓名'] ? order['訂購人姓名'].toString().trim() : '您';

  // ✅ 發給客戶的連結改為短網址，每次點擊都會產生新單號
  const shortPayUrl = 'https://liff-redirect.pages.dev/pay.html?orderId=' + encodeURIComponent(submissionId);

  const payMsg = customerName + ' 您好 🌿\n'
    + '感謝您確認訂單！以下為您的付款連結，請協助於 3 天內完成付款\n'
    + '付款成功即代表訂單正式成立\n'
    + '\n'
    + '💳 付款金額：NT$ ' + totalAmount + '\n'
    + '🔗 付款連結：' + shortPayUrl + '\n'
    + '付款完成後您會於LINE收到通知訊息，\n'
    + '我們將立即為您安排花禮製作，\n'
    + '如有任何問題歡迎隨時與我們聯繫 🤍\n'
    + '\n'
    + '－－－－－－－－－－－－－－－\n'
    + '【安全支付聲明】\n'
    + '本站委託 綠界科技 (ECPay) 處理款項，流程安全透明\n'
    + '🔗 付款跳轉： 網址開頭必為 payment.ecpay.com.tw\n'
    + '💳 多元繳費： 支援Apple Pay、信用卡、ATM虛擬帳號\n'
    + '🛡️ 防詐提醒： 我們不會以電話要求您前往 ATM 操作或解除分期付款。';

  sendLinePush(userId, payMsg);

  const stIdx = headers.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));
  if (stIdx !== -1) {
    sheet.getRange(row, stIdx + 1).setValue("3-已發送付款連結");
  }

  console.log("Stage3 成功發送付款連結：" + customerName);
}

function testProcessPayLink() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
  processPayLink(sheet, 2, headers);
}
```

### EcPayUtils.gs

> ℹ️ `createEcPayLink` 產生的長網址仍然寫入 Sheet AG 欄供後台查閱，但不再發給客戶。客戶收到的是短網址，由 Cloudflare Function 即時計算 CheckMacValue。

```javascript
function createEcPayLink(tradeNo, totalAmount, itemName, submissionId) {
  const merchantId = PropertiesService.getScriptProperties().getProperty('ECPAY_ID');
  const hashKey    = PropertiesService.getScriptProperties().getProperty('ECPAY_KEY');
  const hashIV     = PropertiesService.getScriptProperties().getProperty('ECPAY_IV');
  const tradeDate  = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');

  const params = {
    ChoosePayment:     'ALL',
    CustomField1:      submissionId,
    EncryptType:       '1',
    IgnorePayment:     'CVS#BARCODE',
    ItemName:          itemName,
    MerchantID:        merchantId,
    MerchantTradeDate: tradeDate,
    MerchantTradeNo:   tradeNo,
    OrderResultURL:    'https://liff-redirect.pages.dev/payment-result',
    PaymentType:       'aio',
    ReturnURL:         'https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec',
    TotalAmount:       totalAmount.toString(),
    TradeDesc:         'FlowerGift'
  };

  params['CheckMacValue'] = computeCheckMacValue(params, hashKey, hashIV);

  const BASE = 'https://liff-redirect.pages.dev/pay.html';
  const qs = Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');

  return BASE + '?' + qs + '&orderId=' + encodeURIComponent(submissionId);
}

function computeCheckMacValue(params, hashKey, hashIV) {
  const sortedKeys = Object.keys(params).sort(
    (a, b) => a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const queryString = sortedKeys.map(k => k + '=' + params[k]).join('&');
  const raw = 'HashKey=' + hashKey + '&' + queryString + '&HashIV=' + hashIV;

  let encoded = encodeURIComponent(raw).toLowerCase();
  encoded = encoded
    .replace(/%20/g, '+').replace(/%2d/g, '-').replace(/%5f/g, '_')
    .replace(/%2e/g, '.').replace(/%21/g, '!').replace(/%2a/g, '*')
    .replace(/%28/g, '(').replace(/%29/g, ')');

  const rawBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, encoded, Utilities.Charset.UTF_8
  );
  return rawBytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').toUpperCase();
}

function testEcPayLink() {
  const url = createEcPayLink('flwtest' + Date.now(), 100, 'FlowerOrder', 'testSID');
  console.log(url);
}
```

### Stage4_PayNotify.gs

> ✅ 2026-05-08 更新：
> - `doPost` 改用 `CustomField1`（submissionId）查找訂單，不再依賴付款單號，解決重複點擊連結後單號被覆蓋導致找不到訂單的問題。
> - `doGet` 新增 `mode=api` 回傳 JSON，供 Cloudflare Function 查詢金額使用。
> - 付款成功才寫入實際成交的付款單號，Sheet 紀錄的永遠是真正付款成功的單號。

```javascript
/**
 * Stage4_PayNotify.gs
 */
function doPost(e) {
  try {
    const params = e.parameter;

    const receivedMac = params['CheckMacValue'];
    const hashKey = PropertiesService.getScriptProperties().getProperty('ECPAY_KEY');
    const hashIV  = PropertiesService.getScriptProperties().getProperty('ECPAY_IV');

    const clonedParams = Object.assign({}, params);
    delete clonedParams['CheckMacValue'];
    const computedMac = computeCheckMacValue(clonedParams, hashKey, hashIV);

    if (receivedMac !== computedMac) {
      console.error('CheckMacValue 驗證失敗');
      return ContentService.createTextOutput('0|Error');
    }

    const tradeNo     = params['MerchantTradeNo'];
    const rtnCode     = params['RtnCode'];
    const paymentDate = params['PaymentDate'] || '';
    const paymentType = params['PaymentType'] || '';

    // ✅ 改用 CustomField1（submissionId）查找，不再依賴付款單號
    const submissionId = params['CustomField1'] || '';
    if (!submissionId) {
      console.error('缺少 CustomField1（submissionId）');
      return ContentService.createTextOutput('0|Error');
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
    const allData = sheet.getDataRange().getValues();

    // ✅ 用 SubmissionID 欄位比對，不管單號怎麼變都能找到正確的列
    const sidIdx = headers.indexOf('SubmissionID');
    if (sidIdx === -1) {
      console.error('找不到 SubmissionID 欄位');
      return ContentService.createTextOutput('0|Error');
    }

    let targetRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][sidIdx] && allData[i][sidIdx].toString().trim() === submissionId) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) {
      console.error('找不到對應訂單，submissionId：' + submissionId);
      return ContentService.createTextOutput('0|Error');
    }

    const rowData      = allData[targetRow - 1];
    const userId       = rowData[headers.indexOf('userId')] ? rowData[headers.indexOf('userId')].toString().trim() : '';
    const customerName = rowData[headers.indexOf('訂購人姓名')] ? rowData[headers.indexOf('訂購人姓名')].toString().trim() : '您';
    const totalAmount  = rowData[headers.indexOf('付款金額')] || 0;

    const stIdx      = headers.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));
    const payDateIdx = headers.indexOf('付款日期');
    const tradeNoIdx = headers.indexOf('付款單號');

    if (rtnCode === '1') {
      // ✅ 付款成功：寫入本次實際成交的單號
      if (tradeNoIdx !== -1) sheet.getRange(targetRow, tradeNoIdx + 1).setValue(tradeNo);
      if (stIdx !== -1)      sheet.getRange(targetRow, stIdx + 1).setValue('4-付款完成');
      if (payDateIdx !== -1) sheet.getRange(targetRow, payDateIdx + 1).setValue(paymentDate);

      // --- 發送 LINE 付款成功通知 ---
      if (userId) {
        const successMsg = customerName + ' 您好 🌸\n'
          + '您的付款已成功完成！\n'
          + '\n'
          + '💳 付款金額：NT$ ' + totalAmount + '\n'
          + '📅 付款時間：' + paymentDate + '\n'
          + '💰 付款方式：' + paymentType + '\n'
          + '\n'
          + '訂單已正式成立，花藝師將準時為您安排花禮製作 🌿\n'
          + '如有任何問題歡迎隨時與我們聯繫 🤍';
        sendLinePush(userId, successMsg);
      }

      // --- Stage 5：建立 Google Calendar 活動 ---
      createCalendarEvent(rowData, headers);

    } else {
      // ✅ 付款失敗：只更新狀態，不動付款單號
      if (stIdx !== -1) sheet.getRange(targetRow, stIdx + 1).setValue('付款失敗');
      console.log('付款失敗，tradeNo：' + tradeNo + '，submissionId：' + submissionId);
    }

    return ContentService.createTextOutput('1|OK');

  } catch (err) {
    console.error('Stage4 錯誤：' + err.message);
    return ContentService.createTextOutput('0|Error');
  }
}

function doGet(e) {
  try {
    const submissionId = e.parameter['orderId'] || '';  // sid → orderId（sid 是 GAS 保留字）
    const mode = e.parameter['mode'] || '';

    if (!submissionId) {
      return HtmlService.createHtmlOutput('<p>缺少訂單編號</p>')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
    const allData = sheet.getDataRange().getValues();

    const sidIdx = sheetHeaders.indexOf('SubmissionID');
    if (sidIdx === -1) {
      return HtmlService.createHtmlOutput('<p>找不到 SubmissionID 欄位</p>')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    let targetRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][sidIdx] && allData[i][sidIdx].toString().trim() === submissionId) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) {
      return HtmlService.createHtmlOutput('<p>找不到對應訂單</p>')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const rowData = allData[targetRow - 1];
    const totalAmount = Number(rowData[sheetHeaders.indexOf('付款金額')]) || 0;
    if (totalAmount <= 0) {
      return HtmlService.createHtmlOutput('<p>付款金額異常</p>')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    // ✅ API mode：只回傳金額和 submissionId，給 Cloudflare Function 用
    if (mode === 'api') {
      return ContentService.createTextOutput(JSON.stringify({
        totalAmount: totalAmount,
        submissionId: submissionId
      })).setMimeType(ContentService.MimeType.JSON);
    }

    const timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'MMddHHmm');
    const tradeNo = (submissionId.replace(/[\s\r\n]+/g, '').substring(0, 8) + timestamp).substring(0, 20);

    const payUrl = createEcPayLink(tradeNo, totalAmount, 'FlowerOrder', submissionId);

    const tradeNoIdx = sheetHeaders.indexOf('付款單號');
    const payLinkIdx = sheetHeaders.indexOf(CONFIG.PAY_LINK_COL_NAME.replace(/[\s\r\n]+/g, ''));
    const stIdx      = sheetHeaders.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));

    if (tradeNoIdx !== -1) sheet.getRange(targetRow, tradeNoIdx + 1).setValue(tradeNo);
    if (payLinkIdx !== -1) sheet.getRange(targetRow, payLinkIdx + 1).setValue(payUrl);
    if (stIdx !== -1)      sheet.getRange(targetRow, stIdx + 1).setValue('3-已發送付款連結');

    // 手動按鈕跳轉（GAS iframe 沙盒擋住自動跳轉）
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><base target="_top">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<style>' +
      'body { margin:0; padding:0; background-color:#fbeddc; }' +
      '#wrapper { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px 24px; background-color:#fbeddc; }' +
      'p.title { font-size:22px !important; color:#2e2e2e !important; margin:0 0 12px 0; font-weight:normal; }' +
      'p.subtitle { font-size:15px !important; color:#777 !important; margin:0 0 32px 0; }' +
      'a.pay-btn { display:inline-block !important; background-color:#8ea68e !important; color:#ffffff !important; font-size:16px !important; padding:14px 40px !important; border-radius:50px !important; text-decoration:none !important; }' +
      '</style>' +
      '</head>' +
      '<body>' +
      '<div id="wrapper">' +
      '  <div style="max-width:480px;width:100%;text-align:center;">' +
      '    <p class="title">重新付款連結已產生</p>' +
      '    <p class="subtitle">請點擊下方按鈕前往付款頁面</p>' +
      '    <a href="' + payUrl + '" class="pay-btn" target="_top">前往付款頁面 →</a>' +
      '  </div>' +
      '</div>' +
      '</body></html>'
    )
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (err) {
    console.error('doGet 錯誤：' + err.message);
    return HtmlService.createHtmlOutput('<p>發生錯誤：' + err.message + '</p>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

function testDoGet() {
  const e = { parameter: { orderId: 'WOG0lYk' } };
  const result = doGet(e);
  console.log(result.getContent());
}

function testDoPostLookup() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
  const allData = sheet.getDataRange().getValues();
  const sidIdx = headers.indexOf('SubmissionID');

  const submissionId = 'WOG0lYk';
  let targetRow = -1;
  for (let i = 1; i < allData.length; i++) {
    if (allData[i][sidIdx] && allData[i][sidIdx].toString().trim() === submissionId) {
      targetRow = i + 1;
      break;
    }
  }
  console.log('找到的列：' + targetRow);
  console.log('找到的訂購人：' + allData[targetRow - 1][headers.indexOf('訂購人姓名')]);
}
```

---

## Cloudflare Pages 檔案說明

### pay.html

> ✅ 2026-05-08 更新：不再直接接收綠界參數。改為向同源的 `/api/get-pay-params` 取得最新的付款參數（含新的 MerchantTradeNo 和 CheckMacValue），再自動 POST 給綠界。每次進入都會產生全新的付款單號，解決重複點擊失敗的問題。

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>前往付款頁面...</title>
  <style>
    body {
      font-family: sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #faf9f7;
      color: #555;
    }
    p { font-size: 16px; }
    p.error { color: #e3836c; }
  </style>
</head>
<body>
  <p id="msg">正在前往付款頁面，請稍候…</p>
  <script>
    var msgEl = document.getElementById('msg');
    var params = new URLSearchParams(window.location.search);
    var orderId = params.get('orderId') || '';

    if (!orderId) {
      msgEl.className = 'error';
      msgEl.textContent = '連結異常，請聯繫店家重新取得付款連結。';
    } else {
      fetch('/api/get-pay-params?orderId=' + encodeURIComponent(orderId))
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.error) {
            msgEl.className = 'error';
            msgEl.textContent = '付款連結異常，請聯繫店家。（' + data.error + '）';
            return;
          }
          var form = document.createElement('form');
          form.method = 'POST';
          form.action = data.ecpayUrl;
          var exclude = ['ecpayUrl'];
          Object.keys(data).forEach(function(key) {
            if (exclude.includes(key)) return;
            var input = document.createElement('input');
            input.type = 'hidden';
            input.name = key;
            input.value = data[key];
            form.appendChild(input);
          });
          document.body.appendChild(form);
          form.submit();
        })
        .catch(function() {
          msgEl.className = 'error';
          msgEl.textContent = '連結異常，請聯繫店家重新取得付款連結。';
        });
    }
  </script>
</body>
</html>
```

### functions/api/get-pay-params.js

> ✅ 2026-05-08 新增：接收 `orderId`，向 GAS doGet（`mode=api`）查詢付款金額，產生新的 `MerchantTradeNo`，並用存放在 Cloudflare Secret 中的 `ECPAY_KEY` 和 `ECPAY_IV` 計算 `CheckMacValue`，回傳完整綠界參數給 `pay.html`。
>
> **Cloudflare Pages 設定需求**：
> - Settings → Variables and Secrets → 新增 `ECPAY_KEY`（Secret 類型）
> - Settings → Variables and Secrets → 新增 `ECPAY_IV`（Secret 類型）
> - Settings → Runtime → Compatibility flags → 新增 `nodejs_compat`

```javascript
import { createHash } from 'node:crypto';

function computeCheckMacValue(params, hashKey, hashIV) {
  const sortedKeys = Object.keys(params).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  let queryString = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
  queryString = `HashKey=${hashKey}&${queryString}&HashIV=${hashIV}`;
  queryString = encodeURIComponent(queryString)
    .replace(/%20/g, '+')
    .replace(/%21/g, '!')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2A/g, '*')
    .replace(/%2D/g, '-')
    .replace(/%2E/g, '.')
    .replace(/%5F/g, '_');
  queryString = queryString.toLowerCase();
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

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const timestamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const tradeNo = (orderId.substring(0, 8) + timestamp).substring(0, 20);
  const tradeDate = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const params = {
    MerchantID:        '3492283',
    MerchantTradeNo:   tradeNo,
    MerchantTradeDate: tradeDate,
    PaymentType:       'aio',
    TotalAmount:       String(totalAmount),
    TradeDesc:         'FlowerGift',
    ItemName:          'FlowerOrder',
    ReturnURL:         'https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec',
    OrderResultURL:    'https://liff-redirect.pages.dev/payment-result',
    ChoosePayment:     'ALL',
    EncryptType:       '1',
    IgnorePayment:     'CVS#BARCODE',
    CustomField1:      orderId,
  };

  const checkMacValue = computeCheckMacValue(params, ECPAY_KEY, ECPAY_IV);

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
```

### result.html

付款失敗時顯示，提供「重新付款」按鈕。

接收 URL GET 參數：`orderId`（SubmissionID）、`RtnCode`（錯誤代碼）、`RtnMsg`（錯誤訊息）。

按鈕點擊後用 `window.location.href` 跳轉到 GAS doGet URL（帶 `orderId`），GAS 產生新連結後顯示中間頁，客戶再點一次進入綠界。

> 因 GAS HtmlService iframe 沙盒限制，中間頁無法自動跳轉，客戶需手動點擊一次。

### success.html

付款成功時顯示，風格與 `result.html` 一致。顯示付款成功訊息，告知客戶數分鐘後 LINE 將收到通知。

不接收任何 URL 參數，直接顯示固定內容。

### functions/payment-result.js

接收綠界 POST 的付款結果，解析 `CustomField1`（orderId）、`RtnCode`、`RtnMsg`，依 `RtnCode` 判斷：
- `RtnCode === '1'`（付款成功）→ 302 轉址到 `success.html`
- 其他（付款失敗）→ 302 轉址到 `result.html?orderId=xxx&RtnCode=xxx&RtnMsg=xxx`

```javascript
export async function onRequestPost(context) {
  const formData = await context.request.formData();

  const orderId  = formData.get('CustomField1') || '';
  const rtnCode  = formData.get('RtnCode')       || '';
  const rtnMsg   = formData.get('RtnMsg')        || '';

  if (rtnCode === '1') {
    return Response.redirect('https://liff-redirect.pages.dev/success.html', 302);
  }

  const params = new URLSearchParams();
  if (orderId)  params.set('orderId',  orderId);
  if (rtnCode)  params.set('RtnCode',  rtnCode);
  if (rtnMsg)   params.set('RtnMsg',   decodeURIComponent(rtnMsg));

  return Response.redirect('https://liff-redirect.pages.dev/result.html?' + params.toString(), 302);
}
```

---

## Google Sheet 欄位對照

- **試算表名稱**：花藝訂單記錄表
- **工作表名稱**：花禮預訂單

| 欄位 | 說明 | 由誰填入 |
|------|------|---------|
| A：SubmissionID | 表單提交 ID | Tally 自動 |
| B：RespondentID | 填答者 ID | Tally 自動 |
| C：Submitted at | 提交時間 | Tally 自動 |
| D：userId | LINE 用戶 ID（LIFF 注入） | Tally 隱藏欄位自動 |
| E：訂花人IG帳號 | 客戶填寫 | 客戶 |
| F：訂購人姓名 | 客戶填寫 | 客戶 |
| G：訂花人手機 | 客戶填寫 | 客戶 |
| H：取花日期 | 客戶填寫 | 客戶 |
| I：配送方式 | 客戶填寫 | 客戶 |
| J：自取-取花時段 | 客戶填寫 | 客戶 |
| K：運送-花禮抵達時段 | 客戶填寫 | 客戶 |
| L：收花人姓名 | 客戶填寫 | 客戶 |
| M：收花地址 | 客戶填寫 | 客戶 |
| N：收花人電話 | 客戶填寫 | 客戶 |
| O：是否需要加購卡片 | 客戶填寫 | 客戶 |
| P：卡片類型 | 客戶填寫 | 客戶 |
| Q：加購卡片數量 | 客戶填寫 | 客戶 |
| R：訂單備註 | 客戶填寫 | 客戶 |
| S：花禮品項 | 客戶填寫 | 客戶 |
| T：花禮名稱 | 客戶填寫 | 客戶 |
| U：花禮數量 | 客戶填寫 | 客戶 |
| V：花禮價格 | 客戶填寫 | 客戶 |
| W：卡片費 | 客戶填寫 | 客戶 |
| X：配送運費 | 客戶填寫 | 客戶 |
| Y：付款金額 | 客戶填寫 | 客戶 |
| Z：是否發送訂單確認 | 填「發送」觸發 Stage2 | 店家手動 |
| AA：狀態 | 訂單狀態 | GAS 自動寫入 |
| AB：發送付款連結 | 填「發送」觸發 Stage3 | 店家手動 |
| AC：付款日期 | 付款成功日期 | Stage4 自動寫入 |
| AD：付款單號 | 實際成交的 MerchantTradeNo | Stage4 doPost 付款成功時寫入 |
| AE：CalendarEventID | Google Calendar 活動 ID | Stage5 自動寫入 |
| AF：刪除重建行事曆 | 填「刪除」或「重建」觸發對應動作 | 店家手動 |
| AG：付款連結 | 完整付款連結（供後台查閱，不發給客戶） | Stage3 / Stage4 doGet 寫入 |

---

## 訂單狀態流程

```
（空白）
  ↓ Stage1 每分鐘自動掃描
1-已受理新單
  ↓ Z 欄填「發送」→ Stage2
已確認訂單
  ↓ AB 欄填「發送」→ Stage3
3-已發送付款連結
  ↓ 客戶點短網址 → pay.html → 取得新單號 → POST 給綠界 → 付款成功
  → 綠界 POST → Stage4 doPost → Stage5 建立 Calendar
4-付款完成

或

3-已發送付款連結
  ↓ 客戶付款失敗 → 綠界 POST → Cloudflare payment-result.js → result.html
付款失敗
  ↓ 客戶點「重新付款」→ Stage4 doGet → 重新付款連結頁面 → 客戶點按鈕 → pay.html → 綠界
3-已發送付款連結（新連結）
```

---

## Google Calendar 整合（Stage 5）

### 核心概念

**Calendar 是 Sheet 的顯示層，所有操作以 Sheet 為主，Calendar 自動同步。**

### Calendar 活動格式

**標題：**
- 自取：`🌿 王小明｜永生花禮盒｜自取`
- 配送：`🌿 陳美玲｜鮮花花束｜配送 運費NT$150`

**內文包含：** 訂購人資訊、花禮明細（含加購卡片）、收件人資訊（配送才顯示）、付款資訊、備註（有值才顯示）

**活動顏色：**
- 新建立活動：香蕉黃（`CalendarApp.EventColor.YELLOW`）
- 軟刪除活動：石墨灰（`CalendarApp.EventColor.GRAY`）

> ⚠️ 顏色設定只對新建立的活動生效，已建立的活動需手動在 Google Calendar 更改顏色。
- 正常：`15:15 - 15:45`（30 分鐘區間）
- 最早：`11:00 - 11:30`
- 最晚：`20:00 - 20:30`
- 無法解析：`11:00 - 20:30`

### 自動觸發邏輯

**付款成功時 → 自動建立 Calendar 活動**
```
綠界付款成功 → doPost → 寫入「4-付款完成」→ createCalendarEvent() → EventID 寫入 AE 欄
```

**修改指定欄位時 → 已付款才自動更新**

觸發更新的欄位：F、G、H、I、J、K、L、M、N、P、Q、R、S、T、U、W、X、Y、AC、AD

未付款（AC 欄空白）的列修改不觸發，因為 Calendar 上還沒有這筆活動。

### 手動管理（AF 欄）

| AF 欄填入 | 行為 |
|---------|------|
| 刪除 | 活動標題加【已刪除】前綴 + 變灰色；AE 欄加 `DELETE:` 前綴；AF 欄自動清空 |
| 重建 | 先刪舊活動（避免重複）→ 用 Sheet 目前資料建新活動 → 寫入新 EventID；AF 欄自動清空 |

### 常見操作情境

| 情境 | 操作方式 |
|------|---------|
| 修改訂單任何資訊 | 直接改 Sheet，Calendar 自動同步 |
| 刪除某筆 Calendar 活動 | AF 欄填「刪除」|
| 誤刪 Calendar 活動想救回 | AF 欄填「重建」|
| 刪除整筆訂單 | 先 AF 欄填「刪除」，再刪 Sheet 列 |

### 注意事項

- **絕對不要直接在 Google Calendar 修改活動**，下次 Sheet 觸發時會被覆蓋
- **AF 欄操作完成後會自動清空**，不需要手動清除
- **刪除 Sheet 列之前務必先填「刪除」**，否則 Calendar 上會留下孤立活動
- **直接去 Calendar 手動刪除後**，若要重建需先手動清空 AE 欄，再填「重建」

---

## LINE 訊息範本

### Stage 1 — 歡迎訊息
```
{姓名} 您好 🌿
感謝您填寫榮枯有時的花禮預訂單！
我們已收到您的訂單，花藝師將於確認細節後與您聯繫。

如有任何問題歡迎隨時與我們聯繫 🤍
```

### Stage 2 — 訂單確認明細
```
{姓名} 您好，這是您的【 訂單確認 】明細：

感謝您讓「榮枯有時」參與您的生活。
以下是您的訂單明細及費用計算，請確認資料無誤：

【 一、訂購明細 】
▪️ 取花日期：{日期}
▪️ 自取/運送花禮時段：{時段}
▪️ 花禮品項 / 名稱 / 數量 / 金額
▪️ 加購卡片 / 金額
▪️ 配送運費：NT$ {運費}（僅配送訂單顯示）
▪️ 應付總額：NT$ {總額}
▪️ 訂單備註：{備註}

（配送訂單加上：【 三、收花人資訊 】）

【 二、訂購人資訊 】
▪️ 聯絡姓名 / 電話

---
🌿 若上述訂單資訊確認無誤，請回覆告知我們。
```

### Stage 3 — 付款連結
```
{姓名} 您好 🌿
感謝您確認訂單！以下為您的付款連結，請協助於 3 天內完成付款
付款成功即代表訂單正式成立

💳 付款金額：NT$ {金額}
🔗 付款連結：https://liff-redirect.pages.dev/pay.html?orderId={submissionId}
...（含安全支付聲明）
```

### Stage 4 — 付款成功通知
```
{姓名} 您好 🌸
您的付款已成功完成！

💳 付款金額：NT$ {金額}
📅 付款時間：{時間}
💰 付款方式：{方式}

訂單已正式成立，花藝師將準時為您安排花禮製作 🌿
如有任何問題歡迎隨時與我們聯繫 🤍
```

---

## 部署方式

### GAS 更新流程

1. 開啟「花藝訂單記錄表」→「擴充功能」→「Apps Script」
2. 修改程式碼，按「儲存」（Ctrl+S）
3. 若修改的是 `doGet` 或 `doPost`（Web App 入口）：
   - 點右上角「部署」→「管理部署作業」
   - 點選現有部署（**絕對不要新增**）→ 鉛筆圖示編輯
   - 版本選「新版本」，填說明，按「部署」
   - URL 保持不變
4. 若修改的是 `onEditTrigger` 相關邏輯（Stage2、Stage3、Stage5）：
   - 按 Ctrl+S 儲存即可，不需要重新部署

### Cloudflare Pages 更新流程

1. 修改對應檔案，推送到 GitHub `main` branch
2. 自動部署，約 1-2 分鐘完成
3. 確認 Cloudflare Dashboard → Deployments 最新一筆 Status 為 Success

### Cloudflare Pages 必要設定

Settings → Variables and Secrets：
- `ECPAY_KEY`（Secret 類型）= 綠界 HashKey
- `ECPAY_IV`（Secret 類型）= 綠界 HashIV

Settings → Runtime → Compatibility flags：
- `nodejs_compat`（必須啟用，否則 `node:crypto` 無法使用）

---

## 重要技術筆記

### 1. GAS 保留字 `sid`
`sid` 是 GAS URL 參數保留字，使用會導致「找不到網頁」。本系統改用 `orderId`。

### 2. GAS HtmlService iframe 沙盒限制
`HtmlService` 頁面被包在 iframe 中，瀏覽器沙盒阻止所有形式的外部跳轉（包括 `window.location.replace`、`window.top.location`、`window.top.location.href`、`<a target="_top">`）。解決方案：改由 Cloudflare 的靜態頁面（`pay.html`）發起跳轉，完全繞開 GAS iframe 沙盒。

### 3. 綠界 CSP 限制
綠界付款頁設定 `frame-ancestors: none`，不允許被 iframe 嵌入。

### 4. GAS 部署 URL 穩定性
新增部署會產生新 URL。URL 改變需同步更新：`EcPayUtils.gs` 的 `ReturnURL`、`result.html` 的 `GAS_URL`、`functions/api/get-pay-params.js` 的 `GAS_URL`。

### 5. MerchantTradeNo 不可重複與新架構
每次客戶點擊 `pay.html` 時，`/api/get-pay-params.js` 會用 `submissionId前8碼 + MMddHHmm` 即時產生新的 `MerchantTradeNo`，確保每次點擊都是全新的付款單號，完全解決重複點擊失敗的問題。

### 6. doPost 改用 CustomField1 查找訂單
原本 `doPost` 用 `MerchantTradeNo` 查找 Sheet 對應列。由於 `MerchantTradeNo` 每次點擊都會更新，舊單號付款後可能找不到訂單。改用永遠不變的 `CustomField1`（submissionId）查找，並在付款成功後才寫入實際成交的單號。

### 7. CheckMacValue 計算
在 GAS 端：排除 `CheckMacValue` 本身，參數按 key 字母順序排列，特殊 URL encoding 後 SHA-256 雜湊。
在 Cloudflare Function 端：使用 `node:crypto` 的 `createHash('sha256')`，需啟用 `nodejs_compat` 相容性旗標。

### 8. Cloudflare Function server-to-server 呼叫 GAS
Cloudflare Function 用 `fetch(GAS_URL, { redirect: 'follow' })` 可以成功呼叫 GAS doGet 並取得 JSON 回應，不受 CORS 限制（server-to-server）。GAS doGet 需在 `mode=api` 時回傳 JSON，而不是 HTML。

### 9. GAS HtmlService 手機畫面縮成 40%
GAS 外層容器把 iframe 預設寬度設為 980px，再縮放塞進手機，導致內容縮小約 40%。直接寫在 HTML 字串裡的 `<meta viewport>` 標籤會被 GAS 忽略。解決方案：用 `.addMetaTag('viewport', 'width=device-width, initial-scale=1.0')` 方法加上 viewport 設定。

### 10. 綠界 OrderResultURL 需由程式碼動態設定
綠界後台的「失敗頁面」欄位必須**留空**，改由 `functions/api/get-pay-params.js` 的 `OrderResultURL` 參數動態帶入，並搭配 `CustomField1` 傳遞 `submissionId`。

### 11. GAS Calendar OAuth 必須手動觸發授權
GAS Web App 執行時不會自動跳出授權視窗。新增 Calendar 功能後，必須在 GAS 編輯器手動執行一次 `authorizeCalendar()` 函式完成授權，後續 `doPost` 觸發才能正常使用 `CalendarApp`。

### 12. ChoosePayment 參數語法
綠界 `ChoosePayment` 不支援 `#` 連接多個付款方式（那是 `IgnorePayment` 的語法）。顯示全部付款方式用 `ALL`，排除特定方式用 `IgnorePayment: 'CVS#BARCODE'`。

### 13. CalendarApp.EventColor 名稱與 Google Calendar UI 不同
GAS 的 EventColor 屬性名稱和 Google Calendar UI 顯示的顏色名稱不一致，例如「石墨灰（Graphite）」在 GAS 中要用 `GRAY`，「香蕉（Banana）」要用 `YELLOW`。

### 14. success.html 需放在 repo 根目錄
`success.html` 必須放在 Cloudflare Pages repo 的**根目錄**，不能放在 `functions/` 資料夾。

---

## 常見問題排查

| 問題 | 可能原因 | 解決方法 |
|------|---------|---------|
| Stage1 沒有自動發送 | 觸發器未建立 / userId 為空 | 確認時間觸發器存在；確認 D 欄有值 |
| 填「發送」沒反應 | on-edit 觸發器未建立 | 確認安裝型 onEditTrigger 存在 |
| GAS URL 顯示「找不到網頁」 | 使用了 `sid` 參數 / 多帳號登入 / 錯誤 URL | 改用 `orderId`；無痕視窗測試；確認使用穩定 URL |
| pay.html 顯示連結異常 | /api/get-pay-params 回傳錯誤 | 確認 Cloudflare Secret 有設定 ECPAY_KEY 和 ECPAY_IV；確認 nodejs_compat 已啟用 |
| pay.html 顯示查詢訂單失敗 | GAS doGet mode=api 回傳異常 | 確認 GAS 已重新部署且 doGet 有 mode=api 判斷 |
| 付款成功但 LINE 無通知 | GAS 冷啟動延遲 | 8 分鐘內屬正常；超過則查執行記錄 |
| 重新部署後功能異常 | 新增了新部署導致 URL 改變 | 使用「編輯現有部署」，不要新增 |
| LINE 推播全部失效 | LINE_TOKEN 過期 | 重新產生 token 並更新 Script Properties |
| 客戶沒有 userId | 不是從 LIFF 連結進入 | 確保客戶只透過 LINE 內的 LIFF 連結填表 |
| 付款失敗頁面白畫面 | 綠界用 POST 跳轉，靜態頁面讀不到參數 | 確認 functions/payment-result.js 有正確部署 |
| Calendar 活動沒有建立 | GAS 未完成 Calendar OAuth 授權 | 在 GAS 編輯器執行 authorizeCalendar() 完成授權 |
| Calendar 活動找不到 | 直接在 Calendar 手動刪除，AE 欄 EventID 殘留 | 清空 AE 欄後，AF 欄填「重建」 |
| ATM 付款選項不顯示 | ChoosePayment 語法錯誤 | 確認使用 `ALL` + `IgnorePayment: 'CVS#BARCODE'` |
| Cloudflare Function 部署失敗 | 未啟用 nodejs_compat | Settings → Runtime → Compatibility flags 加入 `nodejs_compat` |

---

## 開發踩坑紀錄

這份紀錄說明開發過程中遇到的關鍵問題與最終解法，目的是讓接手的工程師不需要重新踩同樣的坑。

---

### 坑 1：`sid` 是 GAS 保留字

**症狀**：URL 帶 `?sid=xxx` 打開 GAS Web App，瀏覽器顯示「很抱歉，目前無法開啟這個檔案」，但不帶參數卻正常。

**根本原因**：`sid` 是 GAS Web App 的系統保留參數名稱，使用它會導致 Google 在請求到達 `doGet` 之前就回傳錯誤頁面。

**解法**：把所有 `sid` 參數改名為 `orderId`，包含 `EcPayUtils.gs`、`result.html`、`doGet` 三個地方。

---

### 坑 2：Cloudflare Function fetch GAS 拿到空白 HTML 外殼

**症狀**：`Cloudflare Function` 用 `fetch()` 呼叫 GAS doGet，確認可以打通（有收到回應），但回傳的是空白 HTML 外殼，無法取得任何有用內容。

**嘗試過的方向**：原本以為 Cloudflare Function 根本打不通 GAS（因為 GAS 302 redirect 需要瀏覽器 session），但實測後發現 Cloudflare 的 `fetch({ redirect: 'follow' })` 可以成功 follow GAS 的 302，拿到回應。問題不在於打不通，而在於內容。

**根本原因**：GAS HtmlService 回傳的是帶有 iframe 的 HTML 結構，Cloudflare Function 拿到的是外殼，iframe 內容因為跨域被清空，只剩一個空的 `<div>` 框。

**解法**：讓 GAS doGet 在接收到 `mode=api` 參數時，改用 `ContentService.createTextOutput` 回傳純 JSON（`{ totalAmount, submissionId }`），Cloudflare Function 就能正確解析，不受 iframe 跨域限制影響。

---

### 坑 3：GAS HtmlService 的 iframe 沙盒所有跳轉方式都失敗

**症狀**：GAS `doGet` 用 `HtmlService` 回傳帶有各種跳轉邏輯的 HTML，在 LINE 內建瀏覽器和電腦瀏覽器都無法跳轉到綠界。

**嘗試過的所有方向（全部失敗）：**
- `window.location.replace(payUrl)` → 白畫面
- `window.location.href = payUrl` → 白畫面
- `window.top.location.href = payUrl` → 被沙盒擋住
- `<a href="..." target="_top">` → 被沙盒擋住
- `<button onclick="window.top.location.href='...'">` → payUrl 含特殊字元（`%`、`&`）導致 JS 字串截斷，按鈕點了沒反應
- `encodeURIComponent(payUrl)` 嵌入 onclick → 仍被沙盒擋住

**根本原因**：GAS `HtmlService` 回傳的頁面被包在帶有嚴格沙盒屬性的 iframe 中，`allow-top-navigation-by-user-activation` 規定只有真實的用戶手勢才能觸發頂層導航。而實測發現即使是真實點擊，在 LINE 內建瀏覽器和部分電腦瀏覽器中仍然被擋住。這不是特定瀏覽器的問題，是 GAS iframe 架構本身的根本限制。

**解法**：完全放棄從 GAS 頁面跳轉到綠界。改由 Cloudflare 的靜態 `pay.html` 頁面（不在 GAS iframe 中）向同源的 `/api/get-pay-params` 取得付款參數，再直接 form POST 給綠界，整個流程不經過 GAS iframe，沙盒問題完全消失。

---

### 坑 4：`orderId` 參數被送進綠界導致交易失敗

**症狀**：付款頁面顯示「交易失敗，訊息代碼：10100050，Parameter Error. orderId Not In Spec」。

**根本原因**：舊版 `pay.html` 把 URL 上所有參數（包含自訂的 `orderId`）全部 POST 給綠界，而綠界不認識 `orderId`。

**解法**：新版 `pay.html` 改為向 `/api/get-pay-params` 取得精確的參數清單，只傳綠界認識的參數，完全避免這個問題。

---

### 坑 5：GAS 部署 URL 一直在變

**症狀**：每次修改 GAS 程式碼後重新部署，URL 都會變。

**根本原因**：在 GAS 部署介面點「新增部署作業」會產生全新的部署 ID 和 URL。

**解法**：一律使用「管理部署作業 → 點現有部署的鉛筆圖示 → 版本選新版本 → 部署」。

---

### 坑 6：GAS HtmlService 手機畫面所有內容縮成 40%

**症狀**：`doGet` 回傳的頁面在手機上字體和按鈕都非常小，DevTools 確認 CSS 有套到，但視覺上只有約 9px。

**根本原因**：GAS 外層容器把 iframe 預設寬度設為 980px，再縮放塞進手機，導致內容等比例縮小約 40%。直接寫在 HTML 字串裡的 `<meta viewport>` 標籤會被 GAS 忽略。

**解法**：用 `.addMetaTag('viewport', 'width=device-width, initial-scale=1.0')` 方法加上 viewport 設定。

---

### 坑 7：GAS 執行記錄顯示「找不到這個執行項目的記錄」

**症狀**：在執行記錄點開某筆 `doPost` 記錄，顯示「找不到這個執行項目的記錄」。

**根本原因**：GAS 執行記錄有延遲，而且從瀏覽器觸發的 Web App 請求有時記錄會遺失。這是 GAS 平台本身的限制。

**解法**：改用 GAS 編輯器直接執行測試函式，這樣執行記錄一定會出現且完整。付款後的 doPost 記錄可能延遲數分鐘才出現，屬正常現象。

---

### 坑 8：綠界付款失敗頁在 Safari 顯示白畫面

**症狀**：付款失敗後，Safari 跳轉到 `result.html` 顯示白畫面，重新付款按鈕不出現。

**根本原因**：綠界的 `OrderResultURL` 用 POST 方式傳遞付款結果，但 `result.html` 是靜態頁面，無法接收 POST body 的參數。

**解法**：
1. 在 Cloudflare Pages 新增 `functions/payment-result.js`，接收綠界 POST，解析 `CustomField1`（orderId）和錯誤代碼，再以 302 轉址到 `result.html?orderId=xxx&RtnCode=xxx`
2. `functions/api/get-pay-params.js` 的 `OrderResultURL` 指向 `https://liff-redirect.pages.dev/payment-result`
3. 綠界後台「失敗頁面」欄位留空

---

### 坑 9：GAS Calendar OAuth 不會自動觸發授權視窗

**症狀**：新增 `Stage5_Calendar.gs` 並在 `appsscript.json` 加入 Calendar scope 後，執行測試函式仍顯示「The script does not have permission to perform that action」，且不跳出授權視窗。

**根本原因**：GAS Web App 執行時不會自動觸發授權視窗。必須在 GAS 編輯器直接執行一個最簡單的 Calendar 函式才能觸發授權流程。

**解法**：在 `Stage5_Calendar.gs` 新增 `authorizeCalendar()` 函式並執行一次：
```javascript
function authorizeCalendar() {
  const cal = CalendarApp.getDefaultCalendar();
  console.log('Calendar 授權成功，名稱：' + cal.getName());
}
```

---

### 坑 10：ChoosePayment 使用 `#` 連接導致付款頁無法顯示

**症狀**：將 `ChoosePayment` 改為 `'Credit#ATM#APPLEPAY'` 後，綠界付款頁顯示「ChoosePayment Is Not Match」錯誤。

**根本原因**：`#` 連接多個值是 `IgnorePayment` 的語法，`ChoosePayment` 不支援這種寫法。

**解法**：改回 `ChoosePayment: 'ALL'`，搭配 `IgnorePayment: 'CVS#BARCODE'` 排除不需要的付款方式。

---

### 坑 11：OrderResultURL 付款成功也會觸發跳轉

**症狀**：付款成功後，客戶看到的是付款失敗頁面（`result.html`），而不是綠界的成功頁面。

**根本原因**：`OrderResultURL` 是客戶端跳轉參數，**不分付款成功或失敗都會觸發**。

**解法**：在 `payment-result.js` 加入 `RtnCode` 判斷：
- `RtnCode === '1'` → 跳轉到 `success.html`
- 其他 → 跳轉到 `result.html`

---

### 坑 12：CalendarApp.EventColor 顏色名稱與 Google Calendar UI 不同

**症狀**：設定 `CalendarApp.EventColor.GRAPHITE` 後，活動顏色沒有改變。

**根本原因**：GAS 的 EventColor 屬性名稱和 Google Calendar UI 顯示的名稱不同。

**對照表：**

| Google Calendar UI | GAS EventColor |
|-------------------|----------------|
| 石墨灰（Graphite） | `GRAY` |
| 香蕉（Banana） | `YELLOW` |
| 鼠尾草（Sage） | `PALE_GREEN` |
| 孔雀（Peacock） | `PALE_BLUE` |
| 藍莓（Blueberry） | `BLUE` |
| 番茄（Tomato） | `RED` |

**解法**：將 `GRAPHITE` 改為 `GRAY`，香蕉黃使用 `YELLOW`。

---

### 坑 13：onEditTrigger 改了程式碼但觸發器跑舊版

**症狀**：`onEditTrigger` 明明有偵測某欄，但改欄後 Calendar 完全沒有更新。

**根本原因**：GAS 安裝型觸發器在程式碼修改後，如果沒有重新儲存讓觸發器重新載入，可能會繼續執行舊版本的程式碼。

**解法**：每次修改 `onEditTrigger` 相關邏輯後，務必確認有按下儲存（Ctrl+S），觸發器重新載入後問題自動解決。

---

### 坑 14：Cloudflare Function 使用 node:crypto 部署失敗

**症狀**：推送 `functions/api/get-pay-params.js` 後，Cloudflare 部署失敗，錯誤訊息為 `Error: No such module "node:crypto"`。

**根本原因**：Cloudflare Pages Function 預設不啟用 Node.js 相容模組，`node:crypto` 需要額外的相容性旗標。

**解法**：Cloudflare Dashboard → Workers & Pages → `liff-redirect` → Settings → Runtime → Compatibility flags，加入 `nodejs_compat`。之後推送才能正常部署。

---

### 坑 15：Cloudflare pay.js 的 308 Permanent Redirect 殘留

**症狀**：刪除 `functions/pay.js` 後，訪問 `pay.html?orderId=xxx` 仍然被 308 轉址，Network 顯示 `pay.html → 308 → pay → 302 → GAS`。

**根本原因**：`pay.js` 曾對 `/pay` 路由設定 302，Cloudflare 邊緣節點快取為 308 Permanent Redirect，即使刪除檔案後仍然生效。

**解法**：在 Cloudflare Dashboard 點「Retry」重新部署，強制刷新邊緣節點快取。若仍然無效，用帶不同 query string 的網址（如 `?nocache=1`）測試繞過快取。

---

### 坑 16：doPost 用付款單號查找訂單，重複點擊後找不到訂單

**症狀**：客戶點了付款連結但沒有付款，之後重新付款成功，但 LINE 通知沒發、Sheet 狀態沒更新、Calendar 沒建立，GAS 執行記錄顯示「找不到對應訂單」。

**根本原因**：原本 `doPost` 用 `MerchantTradeNo`（付款單號）查找 Sheet 對應列。但每次客戶重新進入 `pay.html` 時，`/api/get-pay-params` 都會產生新的 `MerchantTradeNo`，Sheet 的付款單號欄位被更新。當客戶用舊連結完成付款時，綠界回傳的是舊單號，但 Sheet 已存最新單號，比對失敗。

**解法**：`doPost` 改用 `CustomField1`（submissionId，由 Tally 產生，永遠不變）查找訂單。付款成功後再把**實際成交的** `MerchantTradeNo` 寫回 Sheet，確保記錄的永遠是真正付款成功的單號。

---

### 坑 17：Stage2 選擇配送時 LINE 訊息沒有顯示運費

**症狀**：客戶選擇配送時，LINE 訂單確認訊息的明細中沒有「配送運費」這一行，但應付總額已經包含運費，導致客戶看到總額卻不知道運費是多少。

**根本原因**：`processOrderConfirmation` 中雖然有讀取 `shippingFee` 並加進 `totalAmount`，但 `confirmMsg` 的組裝邏輯從來沒有把「配送運費」這一行加進去。

**解法**：在 `confirmMsg` 組裝時，在「加購金額」和「應付總額」之間加入：
```javascript
+ (isShipping ? '▪️ 配送運費：NT$ ' + shippingFee + '\n' : '')
```
只有選擇配送的訂單才顯示這一行，自取訂單不顯示。

---

### 坑 18：GitHub 刪除檔案後忘記 Commit，導致長時間排查方向錯誤

**症狀**：在 GitHub 網頁介面刪除 `functions/pay.js` 後，Cloudflare 沒有觸發新的部署，`/pay` 路由的 302 轉址持續生效，導致 `pay.html?orderId=xxx` 一直被導到 GAS doGet，排查方向繞了很大一圈。

**根本原因**：GitHub 網頁介面刪除檔案後，畫面會顯示「This file was deleted」的 diff 預覽，但這只是**暫存狀態**，必須按右上角的「Commit changes...」才算真正提交到 `main` branch，Cloudflare 才會觸發重新部署。

**解法**：刪除檔案後務必確認按下「Commit changes...」，並在 Cloudflare Dashboard 確認有新的部署記錄出現且 Status 為 Success。

> ⚠️ GitHub 網頁介面操作特別容易忘記這個步驟，建議每次操作後都回 Cloudflare 確認部署狀態。

---

## 附錄：相關資源

| 資源 | 連結 |
|------|------|
| GAS 部署 URL | `https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec` |
| Cloudflare Pages | `https://liff-redirect.pages.dev` |
| GitHub Repo | `fadeandblossom-debug/liff-redirect` |
| 綠界正式付款頁 | `https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5` |
| 綠界後台 | `https://vendor.ecpay.com.tw` |
| LINE Developers | `https://developers.line.biz` |
| Tally 表單後台 | `https://tally.so` |
