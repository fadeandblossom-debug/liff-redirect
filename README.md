# 榮枯有時 Fade & Blossom — LINE 預約自動化系統技術文件

> 最後更新：2026-03-29
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
11. [LINE 訊息範本](#line-訊息範本)
12. [部署方式](#部署方式)
13. [重要技術筆記](#重要技術筆記)
14. [常見問題排查](#常見問題排查)
15. [開發踩坑紀錄](#開發踩坑紀錄)
16. [附錄：相關資源](#附錄相關資源)

---

## 系統概覽

本系統為花藝工作室「榮枯有時 Fade & Blossom」的 LINE 預約自動化流程，整合 LIFF → Tally 表單 → Google Sheet → LINE Messaging API → 綠界 ECPay 金流，讓店家透過 Google Sheet 操作，完成從接單到收款的完整流程。

> **表單工具**：使用 Tally（非 Google Forms）
> **LINE Channel ID**：2009304285

### 主要功能

| Stage | 名稱 | 觸發方式 | 說明 |
|-------|------|----------|------|
| Stage 1 | 新單自動歡迎 | 時間觸發（每分鐘） | 新訂單自動發送 LINE 歡迎訊息 |
| Stage 2 | 發送訂單確認 | 手動填「發送」觸發 | 發送訂單明細給客戶確認 |
| Stage 3 | 發送付款連結 | 手動填「發送」觸發 | 產生綠界付款連結並發送 LINE |
| Stage 4 | 付款結果通知 | 綠界 POST 回傳 | 付款成功發 LINE 通知，失敗更新狀態 |
| Stage 4+ | 重新付款 | 客戶從失敗頁點擊 | 重新產生付款連結並跳轉 |

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
    ├── Stage2：onEditTrigger → LINE 訂單確認
    ├── Stage3：onEditTrigger → 產生付款連結 → LINE
    ├── Stage4 doPost：接收綠界付款結果 → LINE 通知
    └── Stage4 doGet：重新產生付款連結 → 跳轉頁面
         ↓
Cloudflare Pages（liff-redirect.pages.dev）
    ├── pay.html：接收參數，POST 給綠界
    └── result.html：付款失敗頁面，含重新付款按鈕
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

### index.html（LIFF 跳轉頁）

位於 GitHub repo 根目錄，部署在 `https://liff-redirect.pages.dev/`。

唯一任務：取得客戶的 LINE `userId` 後，帶入 Tally 表單連結並跳轉。

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>載入中...</title>
</head>
<body>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script>
    async function main() {
      await liff.init({ liffId: "你的LIFF_ID" });
      if (!liff.isLoggedIn()) {
        liff.login();
      } else {
        const profile = await liff.getProfile();
        const userId = profile.userId;
        const tallyUrl = `https://tally.so/r/你的表單ID?userId=${userId}`;
        window.location.href = tallyUrl;
      }
    }
    main();
  </script>
</body>
</html>
```

> ⚠️ **更換 Tally 表單時**：只需修改 `index.html` 中的 `tallyUrl` 變數即可。原本發送給客戶的 LIFF URL（`https://liff.line.me/xxx`）完全不需要變動。

### userId 寫入機制

> ⚠️ **重要**：系統不具備 Google 帳號與 LINE 帳號的連動能力，所有 LINE 推播完全依賴表單提交時寫入的 `userId` 字串。若該欄位為空，Stage 1、2、3 的所有自動化推播皆會失效。

**完整流程：**

1. 客戶點擊 LINE 內的 LIFF URL
2. LIFF 頁面（`index.html`）呼叫 `liff.getProfile()` 取得 `userId`
3. 跳轉至 Tally 表單，URL 帶入 `?userId=U50ca69780f65ec1`
4. Tally 表單內的**隱藏欄位（Hidden Field）**名稱為 `userId`，自動抓取 URL 參數值
5. 客戶提交後，Tally 原生整合將所有欄位推播至 Google Sheet D 欄

### Tally 表單設定重點

- 加入 **Hidden Field**，欄位名稱設為 `userId`（大小寫敏感）
- Hidden Field 值來源：URL 參數，參數名稱 `userId`
- Tally 整合：連接「花藝訂單記錄表」→「花禮預訂單」工作表
- 確認 `userId` 對應到 Sheet D 欄

---

## 🛠️ SOP：更換 Tally 表單流程

需要發布新活動或更換訂購表單時，依照以下三個階段操作：

### 第一階段：Tally 表單端

1. 在 Tally 建立新表單
2. 加入 **Hidden Field**，名稱為 `userId`，來源為 URL 參數 `userId`
3. 點擊 `Publish`，取得新的表單 ID（如 `nNEW_ID`）
4. 在 Tally `Integrations` 重新連接 Google Sheet

### 第二階段：更新 index.html

1. 開啟 GitHub repo `fadeandblossom-debug/liff-redirect`
2. 修改 `index.html` 中的 `tallyUrl`：
   ```javascript
   const tallyUrl = `https://tally.so/r/nNEW_ID?userId=${userId}`;
   ```
3. 推送到 `main` branch，Cloudflare 自動部署

> LIFF URL（`https://liff.line.me/xxx`）**不需要變動**。

### 第三階段：GAS 確認

- 如新表單寫入新工作表，修改 `Config.gs` 的 `SHEET_NAME`
- 確認新工作表標題列包含：`userId`、`訂購人姓名`、`配送方式`、`付款金額` 等關鍵欄位（欄位順序不影響程式，字眼需正確）

### 上線前測試清單

- [ ] 手機點擊 LIFF 連結，確認正確跳轉至新表單
- [ ] 表單網址末端出現 `?userId=U12345...`
- [ ] 提交測試單後，Sheet D 欄有正確寫入 userId
- [ ] 提交後約 1 分鐘內收到 Stage 1 歡迎訊息
- [ ] 手動填「發送」後收到 Stage 2 訂單確認明細
- [ ] 手動填「發送」後收到 Stage 3 付款連結，連結可正常進入綠界付款頁



---

## LINE 後台設定

### LINE Developers Console

1. 登入 [LINE Developers Console](https://developers.line.biz)
2. 選擇對應的 Provider 和 Messaging API Channel

### Messaging API Channel 設定

| 設定項目 | 值 |
|---------|------|
| Channel ID | `2009304285` |
| Webhook URL | `https://script.google.com/macros/s/AKfycbzMwwQ3GU2rq1fZ5zPo1AHvgKGJQdGRByQ_XiS0IbzQPPCqxqFvamIRCahS8I8uSecz/exec` |
| Use webhook | 開啟（ON） |
| Auto-reply messages | 關閉（由 GAS 控制回應） |

### LIFF 設定

| 設定項目 | 說明 |
|---------|------|
| Endpoint URL | Tally 表單 URL（不含 userId，由 LIFF JS 動態附加） |
| Scope | `profile`（需要讀取 userId） |

### Access Token 取得

1. 進入 Messaging API Channel
2. 找到 **Channel Access Token** 區塊
3. 點「Issue」產生長期 token
4. 複製後存入 GAS Script Properties，Key 為 `LINE_TOKEN`

> ⚠️ Token 若重新產生，舊 token 立即失效，必須立刻更新 Script Properties，否則所有 LINE 推播會失敗。

---

## 環境設定

### GAS 專案位置

- **Google Sheet 名稱**：花藝訂單記錄表
- **開啟方式**：花藝訂單記錄表 → 擴充功能 → Apps Script
- **GAS 專案名稱**：LINE 預約串接
- **綁定方式**：容器綁定（非 Standalone）

### GAS Script Properties（指令碼屬性）

進入 GAS 專案 → 左側齒輪「專案設定」→「指令碼屬性」：

| Key | 說明 |
|-----|------|
| `ECPAY_ID` | 綠界商店代號（正式環境：`3492283`） |
| `ECPAY_KEY` | 綠界 HashKey |
| `ECPAY_IV` | 綠界 HashIV |
| `LINE_TOKEN` | LINE Messaging API Channel Access Token |

> ⚠️ 絕對不要把金鑰直接寫在程式碼裡。

### GAS 觸發條件設定

進入 GAS 專案 → 左側時鐘圖示「觸發條件」，需手動建立以下兩個觸發器：

| 函式名稱 | 類型 | 設定 |
|---------|------|------|
| `autoWelcomeTrigger` | 時間驅動 | 分鐘計時器，每 1 分鐘 |
| `onEditTrigger` | 試算表，編輯時 | — |

> ⚠️ 這兩個觸發器不會自動建立，專案初始化時必須手動新增。

### GAS 部署設定

- **執行身分**：我（GAS 專案擁有者）
- **誰可以存取**：所有人
- **穩定部署 URL**：
  ```
  https://script.google.com/macros/s/AKfycbzb-IRbn6OoJJDHsv8lREJjZxC9ASfSJnIqjY_bK6pKKXc7kZcmnt1Ke4kD1T7p85GfoQ/exec
  ```

> ⚠️ 每次修改程式碼後必須「管理部署 → 編輯現有部署 → 新版本 → 部署」。絕對不要新增新部署，否則 URL 改變後需同步更新三個地方：`EcPayUtils.gs` 的 `ReturnURL`、`result.html` 的 `GAS_URL`、綠界後台的 `ReturnURL`。

### 綠界後台設定

登入 [綠界後台](https://vendor.ecpay.com.tw)：

| 設定項目 | 值 |
|---------|-----|
| 幕後回傳程式（ReturnURL） | GAS 部署 URL |
| 付款失敗頁面（OrderResultURL） | `https://liff-redirect.pages.dev/result.html` |
| 付款成功頁面（ClientBackURL） | 留空（使用綠界預設頁面）|

### Cloudflare Pages

- **GitHub repo**：`fadeandblossom-debug/liff-redirect`
- **網域**：`https://liff-redirect.pages.dev`
- **部署方式**：推送到 `main` branch 自動觸發

**GitHub repo 檔案清單：**

| 檔案 | 說明 |
|------|------|
| `index.html` | LIFF 跳轉頁，取得 userId 後跳轉到 Tally 表單 |
| `pay.html` | 橋接頁，接收 GAS 參數後 POST 給綠界 |
| `result.html` | 付款失敗頁面，含重新付款按鈕 |
| `functions/retry.js` | 舊版 Cloudflare Function（已棄用，保留備查） |

---

## GAS 檔案說明與完整程式碼

### Config.gs

```javascript
const CONFIG = {
  LINE_ACCESS_TOKEN:    PropertiesService.getScriptProperties().getProperty('LINE_TOKEN'),
  SHEET_NAME:           '花禮預訂單',
  TRIGGER_COL_NAME:     '是否發送訂單確認',
  TRIGGER_VALUE:        '發送',
  PAY_LINK_COL_NAME:    '付款連結',
  STATUS_COL_NAME:      '狀態',
  PAY_TRIGGER_COL_NAME: '發送付款連結',
  PAY_TRIGGER_VALUE:    '發送'
};
```

### LineUtils.gs

```javascript
function sendLinePush(userId, message) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const payload = {
    to: userId,
    messages: [{ type: 'text', text: message }]
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + CONFIG.LINE_ACCESS_TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  console.log('LINE Push 回應：' + response.getContentText());
}
```

### Stage1_Notify.gs

**觸發方式**：時間觸發（每 1 分鐘）

```javascript
function autoWelcomeTrigger() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
  const allData = sheet.getDataRange().getValues();

  const userIdIdx = headers.indexOf('userId');
  const stIdx = headers.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));

  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const userId = row[userIdIdx] ? row[userIdIdx].toString().trim() : '';
    const status = row[stIdx] ? row[stIdx].toString().trim() : '';

    if (!userId || status) continue;

    const customerName = row[headers.indexOf('訂購人姓名')] || '您';
    const welcomeMsg = customerName + ' 您好 🌿\n'
      + '感謝您填寫榮枯有時的花禮預訂單！\n'
      + '我們已收到您的訂單，花藝師將於確認細節後與您聯繫。\n'
      + '\n'
      + '如有任何問題歡迎隨時與我們聯繫 🤍';

    sendLinePush(userId, welcomeMsg);
    sheet.getRange(i + 1, stIdx + 1).setValue('1-已受理新單');
    console.log('Stage1 發送歡迎訊息：' + customerName);
  }
}
```

### Stage2_OrderConfirm.gs

**觸發方式**：`onEditTrigger`（安裝型 on-edit 觸發）

```javascript
function onEditTrigger(e) {
  if (!e || !e.range) return;

  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== CONFIG.SHEET_NAME) return;

  const headerValues = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const headers = headerValues.map(h => h.toString().replace(/[\s\r\n]+/g, ''));

  const editedCol = range.getColumn();
  const editedValue = range.getValue();

  const triggerIdx = headers.indexOf(CONFIG.TRIGGER_COL_NAME.replace(/[\s\r\n]+/g, ''));
  if (triggerIdx !== -1 && editedCol === triggerIdx + 1 && editedValue === CONFIG.TRIGGER_VALUE) {
    processOrderConfirmation(sheet, range.getRow(), headers);
    return;
  }

  const payTriggerIdx = headers.indexOf(CONFIG.PAY_TRIGGER_COL_NAME.replace(/[\s\r\n]+/g, ''));
  if (payTriggerIdx !== -1 && editedCol === payTriggerIdx + 1 && editedValue === CONFIG.PAY_TRIGGER_VALUE) {
    processPayLink(sheet, range.getRow(), headers);
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
    let hours = rawTime.getHours();
    let minutes = rawTime.getMinutes();
    let startM = minutes < 30 ? '00' : '30';
    let endH = minutes < 30 ? hours : hours + 1;
    let endM = minutes < 30 ? '30' : '00';
    let startTotal = hours * 100 + parseInt(startM);
    let endTotal = endH * 100 + parseInt(endM);

    if (startTotal < 1100) {
      timeRangeStr = '11:00 - 11:30';
    } else if (endTotal >= 2030) {
      timeRangeStr = '20:00 - 20:30';
    } else {
      timeRangeStr = hours.toString().padStart(2, '0') + ':' + startM + ' - ' + endH.toString().padStart(2, '0') + ':' + endM;
    }
  } else {
    timeRangeStr = '11:00 - 20:30 (依預約時段)';
  }

  const itemPrice = Number(order['花禮價格']) || 0;
  const itemCount = Number(order['花禮數量']) || 1;
  const itemTotal = itemPrice * itemCount;
  const cardTotal = Number(order['卡片費']) || 0;
  const shippingFee = Number(order['配送運費']) || 0;
  const totalAmount = itemTotal + cardTotal + shippingFee;

  let shippingInfo = isShipping ?
    '\n【 三、收花人資訊 】\n▪️ 收件姓名：' + (order['收花人姓名'] || '同訂購人') +
    '\n▪️ 收件地址：' + (order['收花地址'] || '未提供') +
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

```javascript
function processPayLink(sheet, row, headers) {
  const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const order = {};
  headers.forEach((header, index) => { order[header] = rowData[index]; });

  const userId = order['userId'] ? order['userId'].toString().trim() : '';
  if (!userId) {
    console.log('Row ' + row + ' 沒有 userId，跳過');
    return;
  }

  const submissionId = (order['SubmissionID'] || '').toString().replace(/[\s\r\n]+/g, '').substring(0, 8);
  const timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'MMddHHmm');
  const tradeNo = (submissionId + timestamp).substring(0, 20);

  const totalAmount = Number(order['付款金額']) || 0;
  if (totalAmount <= 0) {
    console.log('Row ' + row + ' 付款金額為 0，跳過');
    return;
  }

  const payUrl = createEcPayLink(tradeNo, totalAmount, 'FlowerOrder', submissionId);

  const payLinkIdx = headers.indexOf(CONFIG.PAY_LINK_COL_NAME.replace(/[\s\r\n]+/g, ''));
  if (payLinkIdx !== -1) sheet.getRange(row, payLinkIdx + 1).setValue(payUrl);

  const tradeNoIdx = headers.indexOf('付款單號');
  if (tradeNoIdx !== -1) sheet.getRange(row, tradeNoIdx + 1).setValue(tradeNo);

  const customerName = order['訂購人姓名'] ? order['訂購人姓名'].toString().trim() : '您';

  const payMsg = customerName + ' 您好 🌿\n'
    + '感謝您確認訂單！以下為您的付款連結，請協助於 3 天內完成付款\n'
    + '付款成功即代表訂單正式成立\n'
    + '\n'
    + '💳 付款金額：NT$ ' + totalAmount + '\n'
    + '🔗 付款連結：' + payUrl + '\n'
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
  if (stIdx !== -1) sheet.getRange(row, stIdx + 1).setValue('3-已發送付款連結');

  console.log('Stage3 成功發送付款連結：' + customerName);
}

function testProcessPayLink() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
  processPayLink(sheet, 2, headers);
}
```

### EcPayUtils.gs

```javascript
function createEcPayLink(tradeNo, totalAmount, itemName, submissionId) {
  const merchantId = PropertiesService.getScriptProperties().getProperty('ECPAY_ID');
  const hashKey    = PropertiesService.getScriptProperties().getProperty('ECPAY_KEY');
  const hashIV     = PropertiesService.getScriptProperties().getProperty('ECPAY_IV');
  const tradeDate  = Utilities.formatDate(new Date(), 'GMT+8', 'yyyy/MM/dd HH:mm:ss');

  const params = {
    ChoosePayment:     'ALL',
    IgnorePayment:     'CVS#BARCODE',
    EncryptType:       '1',
    ItemName:          itemName,
    MerchantID:        merchantId,
    MerchantTradeDate: tradeDate,
    MerchantTradeNo:   tradeNo,
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

```javascript
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

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => h.toString().replace(/[\s\r\n]+/g, ''));
    const allData = sheet.getDataRange().getValues();

    const tradeNoIdx = headers.indexOf('付款單號');
    if (tradeNoIdx === -1) {
      console.error('找不到付款單號欄位');
      return ContentService.createTextOutput('0|Error');
    }

    let targetRow = -1;
    for (let i = 1; i < allData.length; i++) {
      if (allData[i][tradeNoIdx] && allData[i][tradeNoIdx].toString().trim() === tradeNo) {
        targetRow = i + 1;
        break;
      }
    }

    if (targetRow === -1) {
      console.error('找不到對應訂單：' + tradeNo);
      return ContentService.createTextOutput('0|Error');
    }

    const rowData      = allData[targetRow - 1];
    const userId       = rowData[headers.indexOf('userId')] ? rowData[headers.indexOf('userId')].toString().trim() : '';
    const customerName = rowData[headers.indexOf('訂購人姓名')] ? rowData[headers.indexOf('訂購人姓名')].toString().trim() : '您';
    const totalAmount  = rowData[headers.indexOf('付款金額')] || 0;

    const stIdx      = headers.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));
    const payDateIdx = headers.indexOf('付款日期');

    if (rtnCode === '1') {
      if (stIdx !== -1) sheet.getRange(targetRow, stIdx + 1).setValue('4-付款完成');
      if (payDateIdx !== -1) sheet.getRange(targetRow, payDateIdx + 1).setValue(paymentDate);

      if (userId) {
        const successMsg = customerName + ' 您好 🌸\n'
          + '您的付款已成功完成！\n\n'
          + '💳 付款金額：NT$ ' + totalAmount + '\n'
          + '📅 付款時間：' + paymentDate + '\n'
          + '💰 付款方式：' + paymentType + '\n\n'
          + '訂單已正式成立，花藝師將準時為您安排花禮製作 🌿\n'
          + '如有任何問題歡迎隨時與我們聯繫 🤍';
        sendLinePush(userId, successMsg);
      }

    } else {
      // 付款失敗：僅更新狀態，不發 LINE（客戶從 result.html 自助重新付款）
      if (stIdx !== -1) sheet.getRange(targetRow, stIdx + 1).setValue('付款失敗');
      console.log('付款失敗，訂單：' + tradeNo);
    }

    return ContentService.createTextOutput('1|OK');

  } catch (err) {
    console.error('Stage4 錯誤：' + err.message);
    return ContentService.createTextOutput('0|Error');
  }
}

function doGet(e) {
  try {
    const submissionId = e.parameter['orderId'] || '';

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

    const timestamp = Utilities.formatDate(new Date(), 'GMT+8', 'MMddHHmm');
    const tradeNo = (submissionId.replace(/[\s\r\n]+/g, '').substring(0, 8) + timestamp).substring(0, 20);
    const payUrl = createEcPayLink(tradeNo, totalAmount, 'FlowerOrder', submissionId);

    const tradeNoIdx = sheetHeaders.indexOf('付款單號');
    const payLinkIdx = sheetHeaders.indexOf(CONFIG.PAY_LINK_COL_NAME.replace(/[\s\r\n]+/g, ''));
    const stIdx = sheetHeaders.indexOf(CONFIG.STATUS_COL_NAME.replace(/[\s\r\n]+/g, ''));

    if (tradeNoIdx !== -1) sheet.getRange(targetRow, tradeNoIdx + 1).setValue(tradeNo);
    if (payLinkIdx !== -1) sheet.getRange(targetRow, payLinkIdx + 1).setValue(payUrl);
    if (stIdx !== -1) sheet.getRange(targetRow, stIdx + 1).setValue('3-已發送付款連結');

    const html = HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head>' +
      '<style>' +
      '* { box-sizing:border-box; margin:0; padding:0; }' +
      'html, body { background-color:#fbeddc !important; }' +
      '#wrapper {' +
      '  display:flex !important;' +
      '  align-items:center !important;' +
      '  justify-content:center !important;' +
      '  padding:40px 24px !important;' +
      '  background-color:#fbeddc !important;' +
      '}' +
      'p.title {' +
      '  font-size:22px !important;' +
      '  color:#2e2e2e !important;' +
      '  font-weight:normal !important;' +
      '  margin:0 0 12px 0 !important;' +
      '  line-height:1.6 !important;' +
      '}' +
      'p.subtitle {' +
      '  font-size:15px !important;' +
      '  color:#777 !important;' +
      '  margin:0 0 32px 0 !important;' +
      '  line-height:1.8 !important;' +
      '}' +
      'a.pay-btn {' +
      '  display:inline-block !important;' +
      '  background-color:#8ea68e !important;' +
      '  color:#ffffff !important;' +
      '  font-size:16px !important;' +
      '  padding:14px 40px !important;' +
      '  border-radius:50px !important;' +
      '  text-decoration:none !important;' +
      '  letter-spacing:0.1em !important;' +
      '}' +
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
      '<script>' +
      'function centerContent() {' +
      '  var wrapper = document.getElementById("wrapper");' +
      '  var wh = window.innerHeight || document.documentElement.clientHeight || screen.height;' +
      '  wrapper.style.minHeight = wh + "px";' +
      '}' +
      'centerContent();' +
      'window.addEventListener("resize", centerContent);' +
      '<\/script>' +
      '</body></html>'
    );

    return html
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (err) {
    console.error('doGet 錯誤：' + err.message);
    return HtmlService.createHtmlOutput('<p>發生錯誤：' + err.message + '</p>')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

function testDoGet() {
  const e = { parameter: { orderId: 'jad749J' } };
  const result = doGet(e);
  console.log(result.getContent());
}
```

---

## Cloudflare Pages 檔案說明

### pay.html

GAS 與綠界之間的橋接頁，接收所有綠界參數，過濾掉 `orderId` 和 `sid` 後以 POST 方式提交給綠界。

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>前往付款頁面...</title>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center;
           align-items: center; height: 100vh; margin: 0; background: #faf9f7; color: #555; }
    p { font-size: 16px; }
  </style>
</head>
<body>
  <p>正在前往付款頁面，請稍候…</p>
  <form id="ecpayForm" method="POST"
        action="https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5">
  </form>
  <script>
    (function () {
      const EXCLUDE = ['orderId', 'sid'];
      const params = new URLSearchParams(window.location.search);
      const form = document.getElementById('ecpayForm');
      params.forEach(function (value, key) {
        if (EXCLUDE.indexOf(key) !== -1) return;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
      });
      form.submit();
    })();
  </script>
</body>
</html>
```

### result.html

付款失敗時顯示，提供「重新付款」按鈕。接收 URL 參數 `sid` 或 `orderId`（SubmissionID）。

按鈕點擊後用 `window.location.href` 跳轉到 GAS doGet URL（帶 `orderId`），GAS 產生新連結後顯示中間頁，客戶再點一次進入綠界。

> 因 GAS HtmlService iframe 沙盒限制，中間頁無法自動跳轉，客戶需手動點擊一次。

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
| K：運送-花禮抵達時 | 客戶填寫 | 客戶 |
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
| AD：付款單號 | MerchantTradeNo | Stage3 / Stage4 doGet 寫入 |
| AE：付款連結 | 完整付款連結 | Stage3 / Stage4 doGet 寫入 |

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
  ↓ 客戶付款成功 → 綠界 POST → Stage4 doPost
4-付款完成

或

3-已發送付款連結
  ↓ 客戶付款失敗 → Stage4 doPost 更新狀態
付款失敗
  ↓ 客戶在 result.html 點「重新付款」→ Stage4 doGet
3-已發送付款連結（新連結）
```

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
🔗 付款連結：{連結}
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
2. 修改程式碼，按「儲存」
3. 點右上角「部署」→「管理部署作業」
4. 點選現有部署（**絕對不要新增**）→ 鉛筆圖示編輯
5. 版本選「新版本」，填說明，按「部署」
6. URL 保持不變

### Cloudflare Pages 更新流程

1. 修改 `result.html` 或 `pay.html`
2. 推送到 GitHub `main` branch
3. 自動部署，約 1-2 分鐘完成

---

## 重要技術筆記

### 1. GAS 保留字 `sid`
`sid` 是 GAS URL 參數保留字，使用會導致「找不到網頁」。本系統改用 `orderId`。

### 2. GAS HtmlService iframe 沙盒限制
`HtmlService` 頁面被包在 iframe 中，瀏覽器沙盒阻止自動跳轉到外部網站（包括 `window.location.replace`、`window.top.location`、`setTimeout` 觸發的點擊）。解決方案：`<base target="_top">` + 手動點擊按鈕。

### 3. 綠界 CSP 限制
綠界付款頁設定 `frame-ancestors: none`，不允許被 iframe 嵌入。

### 4. GAS 部署 URL 穩定性
新增部署會產生新 URL。URL 改變需同步更新：`EcPayUtils.gs` 的 `ReturnURL`、`result.html` 的 `GAS_URL`、綠界後台的 `ReturnURL`。

### 5. pay.html 參數過濾
必須過濾 `orderId` 和 `sid`，否則綠界回傳 `Parameter Error. orderId Not In Spec`。

### 6. CheckMacValue 計算
排除 `CheckMacValue` 本身，參數按 key 字母順序排列，特殊 URL encoding 後 SHA-256 雜湊。

### 7. userId 為空的影響
客戶不是從 LINE 內的 LIFF 連結進入表單，Stage 1/2/3 推播全部失效。必須確保客戶只透過 LIFF 連結填表。

### 8. MerchantTradeNo 不可重複
使用 `SubmissionID前8碼 + MMddHHmm` 時間戳組成，重新付款時自動產生新單號。

---

## 常見問題排查

| 問題 | 可能原因 | 解決方法 |
|------|---------|---------|
| Stage1 沒有自動發送 | 觸發器未建立 / userId 為空 | 確認時間觸發器存在；確認 D 欄有值 |
| 填「發送」沒反應 | on-edit 觸發器未建立 | 確認安裝型 onEditTrigger 存在 |
| GAS URL 顯示「找不到網頁」 | 使用了 `sid` 參數 / 多帳號登入 / 錯誤 URL | 改用 `orderId`；無痕視窗測試；確認使用穩定 URL |
| 付款失敗顯示 `orderId Not In Spec` | pay.html 未過濾 orderId | 確認 EXCLUDE 陣列含 `'orderId'` |
| 付款成功但 LINE 無通知 | GAS 冷啟動延遲 | 8 分鐘內屬正常；超過則查執行記錄 |
| 重新部署後功能異常 | 新增了新部署導致 URL 改變 | 使用「編輯現有部署」，不要新增 |
| LINE 推播全部失效 | LINE_TOKEN 過期 | 重新產生 token 並更新 Script Properties |
| 客戶沒有 userId | 不是從 LIFF 連結進入 | 確保客戶只透過 LINE 內的 LIFF 連結填表 |

---

## 開發踩坑紀錄

這份紀錄說明開發過程中遇到的關鍵問題與最終解法，目的是讓接手的工程師不需要重新踩同樣的坑。

---

### 坑 1：`sid` 是 GAS 保留字

**症狀**：URL 帶 `?sid=xxx` 打開 GAS Web App，瀏覽器顯示「很抱歉，目前無法開啟這個檔案」，但不帶參數卻正常。

**嘗試過的方向**：以為是部署問題、帳號登入問題、URL 失效問題，花了很長時間重新部署、換 URL、用無痕視窗測試。

**根本原因**：`sid` 是 GAS Web App 的系統保留參數名稱，使用它會導致 Google 在請求到達 `doGet` 之前就回傳錯誤頁面。GAS 官方文件有提到這個限制，但錯誤訊息完全看不出來是參數名稱問題。

**解法**：把所有 `sid` 參數改名為 `orderId`，包含 `EcPayUtils.gs`、`result.html`、`doGet` 三個地方。

---

### 坑 2：Cloudflare Function 打不通 GAS

**症狀**：`retry.js`（Cloudflare Pages Function）用 `fetch()` 呼叫 GAS URL，回傳的是 Google 的「找不到網頁」HTML 錯誤頁，不是 GAS 的回應。

**嘗試過的方向**：換不同的 GAS 部署 URL、檢查 fetch 參數、加 `redirect: 'follow'`，全部無效。

**根本原因**：GAS Web App 的請求流程是先回傳 302 redirect 到 `script.googleusercontent.com`，這個重新導向需要瀏覽器的 session/cookie 才能正常完成。Server-to-server 的請求（如 Cloudflare Function）沒有瀏覽器 session，Google 會直接拒絕並回傳錯誤頁。

**解法**：放棄 Cloudflare Function 作為中介，改讓 `result.html` 的按鈕直接用 `window.location.href` 跳轉到 GAS URL，讓瀏覽器本身去發請求，session 問題自然解決。

---

### 坑 3：GAS HtmlService 的 iframe 沙盒無法自動跳轉到綠界

**症狀**：GAS `doGet` 用 `HtmlService` 回傳帶有 `window.location.replace(payUrl)` 的 HTML，瀏覽器顯示空白頁或 Google 的警告頁，完全沒有跳轉到綠界。

**嘗試過的方向**：
- 用 `window.location.replace()` → 被 iframe 沙盒阻擋
- 用 `window.top.location.replace()` → 被 `allow-top-navigation` 限制阻擋
- 用 `setTimeout(fn, 100)` 延遲點擊 → 瀏覽器判定為非用戶手勢，仍被阻擋
- 加 `setXFrameOptionsMode(ALLOWALL)` → 解決了 iframe 顯示問題，但跳轉仍被阻擋

**根本原因**：GAS `HtmlService` 回傳的頁面被包在一個帶有嚴格沙盒屬性的 iframe 中，`allow-top-navigation-by-user-activation` 規定只有真實的用戶手勢（點擊）才能觸發頂層導航，JavaScript 自動執行的跳轉一律被攔截。

**解法**：GAS 官方文件提到在 IFRAME 模式下，需要用 `<base target="_top">` + `<a>` 標籤讓用戶手動點擊跳轉。最終方案是 `doGet` 回傳一個風格與 `result.html` 一致的頁面，顯示「重新付款連結已產生」和「前往付款頁面 →」按鈕，客戶手動點一次即可進入綠界。

---

### 坑 4：`orderId` 參數被送進綠界導致交易失敗

**症狀**：付款頁面顯示「交易失敗，訊息代碼：10100050，Parameter Error. orderId Not In Spec」。

**嘗試過的方向**：以為是 CheckMacValue 計算錯誤，重新驗證計算邏輯，但計算完全正確。

**根本原因**：`pay.html` 把 URL 上所有參數（包含自訂的 `orderId`）全部 POST 給綠界，而綠界不認識 `orderId` 這個參數，直接拒絕整筆交易。

**解法**：在 `pay.html` 加入過濾邏輯，POST 給綠界前排除 `orderId` 和 `sid`：
```javascript
const EXCLUDE = ['orderId', 'sid'];
params.forEach(function (value, key) {
  if (EXCLUDE.indexOf(key) !== -1) return;
  // 加入 form
});
```

---

### 坑 5：GAS 部署 URL 一直在變

**症狀**：每次修改 GAS 程式碼後重新部署，URL 都會變，導致綠界後台的 `ReturnURL`、`result.html` 的 `GAS_URL`、`EcPayUtils.gs` 的 `ReturnURL` 三個地方都要跟著改，非常容易漏掉。

**根本原因**：在 GAS 部署介面點「新增部署作業」會產生全新的部署 ID 和 URL，而不是更新現有的部署。

**解法**：每次修改程式碼後，一律使用「管理部署作業 → 點現有部署的鉛筆圖示 → 版本選新版本 → 部署」。這樣 URL 永遠不變，只有程式碼版本更新。

---

### 坑 6：GAS HtmlService 手機畫面所有內容縮成 40%

**症狀**：`doGet` 回傳的頁面在手機上字體和按鈕都非常小，DevTools 確認 CSS `font-size: 22px` 有套到，但視覺上只有約 9px 大小。

**嘗試過的方向**：以為是 Caja sanitizer 過濾了 CSS，試過 inline style、`<style>` 標籤、`!important`，全部無效。

**根本原因**：GAS 外層容器把 iframe 預設寬度設為 980px（桌面寬度），再用縮放把 iframe 塞進手機畫面，導致所有內容等比例縮小約 40%（390/980）。直接寫在 HTML 字串裡的 `<meta name="viewport">` 標籤會被 GAS 忽略，完全不生效。

**解法**：用 `.addMetaTag()` 方法加上 viewport 設定，這是 GAS 官方支援的唯一方式：
```javascript
return HtmlService.createHtmlOutput(htmlContent)
  .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
  .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
```

---

### 坑 7：GAS 執行記錄顯示「找不到這個執行項目的記錄」

**症狀**：在執行記錄點開某筆 `doGet` 記錄，顯示「找不到這個執行項目的記錄，擷取近期執行項目的記錄可能有短暫延遲。」，無法看到 `console.log` 輸出。

**根本原因**：GAS 執行記錄有延遲，而且從瀏覽器觸發的 Web App 請求有時記錄會遺失。這是 GAS 平台本身的限制，不是程式問題。

**解法**：改用 GAS 編輯器直接執行測試函式（如 `testDoGet()`），這樣執行記錄一定會出現且完整。

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
