/**
 * MyReceiptApp PWA メインスクリプト (app.js)
 * - 撮影画像のブラウザ内長辺1800px JPEG圧縮
 * - IndexedDB へのオフラインキュー保存・管理
 * - Google Identity Services (OAuth2) & Google Drive API v3 連携
 * - MyReceiptApp/inbox への一括アップロード
 * - MyReceiptApp/data/receipts.json と archive/ 画像の取得・縦並び詳細表示
 */

const DB_NAME = "MyReceiptAppDB";
const DB_VERSION = 1;
const QUEUE_STORE = "upload_queue";
const MAX_IMAGE_EDGE = 1800;
const JPEG_QUALITY = 0.84;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

let dbInstance = null;
let accessToken = sessionStorage.getItem("gdrive_access_token") || null;
let tokenClient = null;
let receiptsData = [];
let driveCache = {
  rootFolderId: null,
  inboxFolderId: null,
  dataFolderId: null,
  archiveFolderId: null,
  subFolderIds: {},
  blobUrls: {}
};

// =========================================================
// トースト通知
// =========================================================
let toastTimer = null;
function showToast(msg, duration = 3200) {
  const el = document.getElementById("statusToast");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, duration);
}

// =========================================================
// IndexedDB 管理
// =========================================================
function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function addQueueItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).add(item);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getAllQueueItems() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readonly");
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function deleteQueueItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function clearAllQueueItems() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// =========================================================
// 画像の長辺1800px JPEG圧縮
// =========================================================
function compressImageToJpegBlob(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
        if (width >= height) {
          height = Math.round((height * MAX_IMAGE_EDGE) / width);
          width = MAX_IMAGE_EDGE;
        } else {
          width = Math.round((width * MAX_IMAGE_EDGE) / height);
          height = MAX_IMAGE_EDGE;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("画像圧縮に失敗しました"));
          resolve(blob);
        },
        "image/jpeg",
        JPEG_QUALITY
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像の読み込みに失敗しました"));
    };
    img.src = url;
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function makeTimestampFilename(prefix, ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).substring(2, 6);
  return `${prefix}_${ts}_${rand}.${ext}`;
}

async function handleSelectedFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  let added = 0;
  for (const file of Array.from(fileList)) {
    try {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const safeName = makeTimestampFilename("pdf", "pdf");
        await addQueueItem({
          filename: safeName,
          originalName: file.name,
          mimeType: "application/pdf",
          fileType: "pdf",
          blob: file,
          size: file.size,
          createdAt: new Date().toLocaleString("ja-JP")
        });
        added++;
      } else if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(file.name)) {
        const compressedBlob = await compressImageToJpegBlob(file);
        const safeName = makeTimestampFilename("rcpt", "jpg");
        await addQueueItem({
          filename: safeName,
          originalName: file.name,
          mimeType: "image/jpeg",
          fileType: "image",
          blob: compressedBlob,
          size: compressedBlob.size,
          createdAt: new Date().toLocaleString("ja-JP")
        });
        added++;
      }
    } catch (err) {
      console.error(err);
      showToast(`追加失敗 (${file.name}): ${err.message}`);
    }
  }
  await renderQueueList();
  if (added > 0) {
    showToast(`${added}件をオフラインキューに保存しました`);
  }
}

async function renderQueueList() {
  const items = await getAllQueueItems();
  const countEl = document.getElementById("queueCount");
  const listEl = document.getElementById("queueList");
  const uploadBtn = document.getElementById("uploadAllBtn");
  const clearBtn = document.getElementById("clearQueueBtn");

  countEl.textContent = String(items.length);
  uploadBtn.disabled = items.length === 0;
  clearBtn.style.display = items.length > 0 ? "inline-block" : "none";
  listEl.innerHTML = "";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "queue-item";

    let thumbEl;
    if (item.fileType === "pdf") {
      thumbEl = document.createElement("div");
      thumbEl.className = "queue-thumb";
      thumbEl.textContent = "PDF";
    } else {
      thumbEl = document.createElement("img");
      thumbEl.className = "queue-thumb";
      thumbEl.src = URL.createObjectURL(item.blob);
    }

    const info = document.createElement("div");
    info.className = "queue-info";
    info.innerHTML = `
      <div class="queue-name">${escapeHtml(item.originalName || item.filename)}</div>
      <div class="queue-meta">${formatBytes(item.size)} ・ ${escapeHtml(item.createdAt)}</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "queue-del";
    delBtn.type = "button";
    delBtn.textContent = "削除";
    delBtn.onclick = async () => {
      await deleteQueueItem(item.id);
      await renderQueueList();
    };

    row.appendChild(thumbEl);
    row.appendChild(info);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }
}

// =========================================================
// Google OAuth2 & Google Drive API v3
// =========================================================
function getSettings() {
  return {
    clientId: (localStorage.getItem("myreceipt_client_id") || "").trim(),
    rootFolderName: (localStorage.getItem("myreceipt_root_folder") || "MyReceiptApp").trim() || "MyReceiptApp"
  };
}

function updateAuthUI() {
  const badge = document.getElementById("authBadgeBtn");
  if (accessToken) {
    badge.textContent = "Google接続済";
    badge.classList.add("connected");
  } else {
    badge.textContent = "Google未接続 (タップで認証)";
    badge.classList.remove("connected");
  }
}

function ensureAccessToken() {
  return new Promise((resolve, reject) => {
    if (accessToken) return resolve(accessToken);

    const { clientId } = getSettings();
    if (!clientId) {
      switchTab("tab-settings");
      showToast("先に設定タブでOAuthクライアントIDを設定してください");
      return reject(new Error("OAuthクライアントIDが未設定です"));
    }

    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      return reject(new Error("Google認証ライブラリの読み込み中です。数秒後に再試行してください"));
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(`Google認証エラー: ${resp.error}`));
          return;
        }
        accessToken = resp.access_token;
        sessionStorage.setItem("gdrive_access_token", accessToken);
        updateAuthUI();
        showToast("Googleドライブに接続しました");
        resolve(accessToken);
      }
    });

    tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function driveFetch(url, options = {}) {
  const token = await ensureAccessToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    accessToken = null;
    sessionStorage.removeItem("gdrive_access_token");
    updateAuthUI();
    throw new Error("認証セッションが切れました。再度ボタンを押してログインしてください。");
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive API エラー (${res.status}): ${errText}`);
  }
  return res;
}

async function findFolderId(name, parentId = null) {
  const escapedName = name.replace(/'/g, "\\'");
  let q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}' and trashed = false`;
  if (parentId) {
    q += ` and '${parentId}' in parents`;
  }
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`;
  const res = await driveFetch(url);
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function createFolder(name, parentId = null) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentId) metadata.parents = [parentId];
  const res = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata)
  });
  const data = await res.json();
  return data.id;
}

async function ensureDriveStructure() {
  if (driveCache.rootFolderId && driveCache.inboxFolderId && driveCache.dataFolderId) {
    return driveCache;
  }
  const { rootFolderName } = getSettings();
  let rootId = await findFolderId(rootFolderName);
  if (!rootId) {
    rootId = await createFolder(rootFolderName);
  }
  let inboxId = await findFolderId("inbox", rootId);
  if (!inboxId) inboxId = await createFolder("inbox", rootId);

  let dataId = await findFolderId("data", rootId);
  if (!dataId) dataId = await createFolder("data", rootId);

  let archiveId = await findFolderId("archive", rootId);
  if (!archiveId) archiveId = await createFolder("archive", rootId);

  driveCache.rootFolderId = rootId;
  driveCache.inboxFolderId = inboxId;
  driveCache.dataFolderId = dataId;
  driveCache.archiveFolderId = archiveId;

  const statusBox = document.getElementById("folderStatusBox");
  if (statusBox) {
    statusBox.textContent = `接続済みフォルダ: ${rootFolderName} (ID: ${rootId})`;
  }
  return driveCache;
}

// =========================================================
// inbox への一括アップロード処理
// =========================================================
async function uploadBlobToDriveFolder(blob, filename, mimeType, folderId) {
  const metadata = {
    name: filename,
    parents: [folderId]
  };
  const boundary = "-------MyReceiptAppBoundary" + Date.now();
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const closePart = `\r\n--${boundary}--`;

  const multipartBody = new Blob([metaPart, blob, closePart], {
    type: `multipart/related; boundary=${boundary}`
  });

  await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    body: multipartBody
  });
}

async function uploadAllQueuedItems() {
  const items = await getAllQueueItems();
  if (items.length === 0) return;

  const btn = document.getElementById("uploadAllBtn");
  const progressBox = document.getElementById("uploadProgressBox");
  btn.disabled = true;
  progressBox.style.display = "block";

  try {
    progressBox.textContent = "Googleドライブのフォルダを確認中...";
    const { inboxFolderId } = await ensureDriveStructure();

    let done = 0;
    for (const item of items) {
      done++;
      progressBox.textContent = `送信中 (${done} / ${items.length}): ${item.originalName || item.filename}`;
      await uploadBlobToDriveFolder(item.blob, item.filename, item.mimeType, inboxFolderId);
      await deleteQueueItem(item.id);
      await renderQueueList();
    }
    progressBox.textContent = `✅ 全 ${done} 件の送信が完了しました！PC側で数秒以内に自動解析されます。`;
    showToast(`${done}件を inbox へ送信しました`);
  } catch (err) {
    console.error(err);
    progressBox.textContent = `⚠️ 送信中断: ${err.message}`;
    showToast(err.message);
  } finally {
    await renderQueueList();
  }
}

// =========================================================
// receipts.json の取得と一覧描画
// =========================================================
async function fetchReceiptsJson() {
  const listContainer = document.getElementById("receiptListContainer");
  listContainer.innerHTML = `<div style="text-align:center;padding:24px;color:var(--muted);">Googleドライブからデータを読み込み中...</div>`;

  try {
    const { dataFolderId } = await ensureDriveStructure();
    const q = `name = 'receipts.json' and '${dataFolderId}' in parents and trashed = false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=1`;
    const searchRes = await driveFetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.files || searchData.files.length === 0) {
      receiptsData = [];
      renderReceiptList();
      return;
    }

    const fileId = searchData.files[0].id;
    const downloadRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    const json = await downloadRes.json();
    receiptsData = Array.isArray(json) ? json : [];
    renderReceiptList();
    showToast(`レシート ${receiptsData.length} 件を読み込みました`);
  } catch (err) {
    console.error(err);
    listContainer.innerHTML = `<div style="text-align:center;padding:24px;color:var(--danger);font-size:0.85rem;">読み込みエラー: ${escapeHtml(err.message)}</div>`;
  }
}

function renderReceiptList() {
  const container = document.getElementById("receiptListContainer");
  const searchVal = (document.getElementById("searchInput").value || "").trim().toLowerCase();
  const monthVal = (document.getElementById("monthFilter").value || "").trim();

  const filtered = receiptsData.filter((r) => {
    if (monthVal && !(r.date || "").startsWith(monthVal)) {
      return false;
    }
    if (searchVal) {
      const itemNames = (r.items || []).map((i) => i.name || "").join(" ");
      const hay = `${r.store_name || ""} ${r.category || ""} ${r.invoice_number || ""} ${r.memo || ""} ${itemNames}`.toLowerCase();
      if (!hay.includes(searchVal)) return false;
    }
    return true;
  });

  // 日付降順
  filtered.sort((a, b) => {
    const da = `${a.date || ""} ${a.time || ""}`;
    const db = `${b.date || ""} ${b.time || ""}`;
    return db.localeCompare(da);
  });

  const totalSum = filtered.reduce((acc, r) => acc + (Number(r.total_amount) || 0), 0);
  document.getElementById("listCountLabel").textContent = String(filtered.length);
  document.getElementById("listTotalLabel").textContent = `¥${totalSum.toLocaleString("ja-JP")}`;

  if (filtered.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:30px;color:var(--muted);font-size:0.88rem;">該当するレシートデータがありません</div>`;
    return;
  }

  container.innerHTML = "";
  for (const r of filtered) {
    const card = document.createElement("div");
    card.className = "receipt-card" + (r.has_discrepancy ? " discrepancy" : "");

    const itemsSummary = (r.items || []).map((i) => i.name).filter(Boolean).join("、") || r.memo || "明細なし";
    const isPdf = r.file_type === "pdf";

    card.innerHTML = `
      <div class="rcpt-left">
        <div class="rcpt-date-row">
          <span>${escapeHtml(r.date || "日付不明")}</span>
          <span class="badge badge-cat">${escapeHtml(r.category || "消耗品費")}</span>
          ${isPdf ? '<span class="badge badge-pdf">PDF</span>' : ""}
          ${r.has_discrepancy ? '<span class="badge badge-warn">⚠️要確認</span>' : ""}
        </div>
        <div class="rcpt-store">${escapeHtml(r.store_name || "不明店舗")}</div>
        <div class="rcpt-sub">${escapeHtml(itemsSummary)}</div>
      </div>
      <div class="rcpt-amount">¥${Number(r.total_amount || 0).toLocaleString("ja-JP")}</div>
    `;

    card.onclick = () => openReceiptDetail(r);
    container.appendChild(card);
  }
}

// =========================================================
// 相対パス (archive/YYYY-MM/filename) から Google Drive ファイルを取得
// =========================================================
async function findDriveFileByRelativePath(relPath) {
  if (!relPath) return null;
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  await ensureDriveStructure();
  let currentParentId = driveCache.rootFolderId;

  // 途中フォルダを辿る (例: archive -> 2026-11)
  for (let i = 0; i < parts.length - 1; i++) {
    const folderName = parts[i];
    const cacheKey = `${currentParentId}/${folderName}`;
    if (driveCache.subFolderIds[cacheKey]) {
      currentParentId = driveCache.subFolderIds[cacheKey];
    } else if (i === 0 && folderName === "archive" && driveCache.archiveFolderId) {
      currentParentId = driveCache.archiveFolderId;
      driveCache.subFolderIds[cacheKey] = currentParentId;
    } else {
      const fid = await findFolderId(folderName, currentParentId);
      if (!fid) return null;
      driveCache.subFolderIds[cacheKey] = fid;
      currentParentId = fid;
    }
  }

  const fileName = parts[parts.length - 1].replace(/'/g, "\\'");
  const q = `name = '${fileName}' and '${currentParentId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,webViewLink)&pageSize=1`;
  const res = await driveFetch(url);
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

// =========================================================
// 詳細画面（上：画像 / 下：全抽出項目）
// =========================================================
async function openReceiptDetail(r) {
  const overlay = document.getElementById("detailOverlay");
  const titleEl = document.getElementById("detailTitle");
  const imgPane = document.getElementById("detailImagePane");
  const imgEl = document.getElementById("detailImage");
  const loadingEl = document.getElementById("detailImageLoading");
  const openOrigBtn = document.getElementById("openOriginalDriveBtn");
  const dataPane = document.getElementById("detailDataPane");

  titleEl.textContent = `${r.date || ""} ${r.store_name || ""}`;
  imgPane.classList.remove("zoomed");
  imgEl.style.display = "none";
  imgEl.src = "";
  loadingEl.style.display = "block";
  loadingEl.textContent = "アーカイブ画像を読み込み中...";
  openOrigBtn.style.display = "none";

  // 下半分：全抽出項目のレンダリング
  const items = r.items || [];
  const itemsRowsHtml =
    items.length > 0
      ? items
          .map(
            (item) => `
        <tr>
          <td>${escapeHtml(item.name || "")}</td>
          <td class="num">${escapeHtml(String(item.quantity ?? 1))}</td>
          <td class="num">${item.unit_price != null ? "¥" + Number(item.unit_price).toLocaleString("ja-JP") : "-"}</td>
          <td class="num"><strong>¥${Number(item.amount || 0).toLocaleString("ja-JP")}</strong></td>
          <td class="num">${escapeHtml(item.tax_rate || "")}</td>
        </tr>
      `
          )
          .join("")
      : `<tr><td colspan="5" style="text-align:center;color:var(--muted);">明細データなし</td></tr>`;

  const warnBanner = r.has_discrepancy
    ? `<div style="background:var(--warning-bg);color:#92400e;padding:10px 12px;border-radius:10px;font-size:0.8rem;font-weight:700;margin-bottom:10px;border:1px solid #fcd34d;">
         ⚠️ 金額要確認: ${escapeHtml(r.discrepancy_note || `差額 ${r.discrepancy_diff || 0}円`)}
       </div>`
    : "";

  dataPane.innerHTML = `
    ${warnBanner}
    <div class="field-grid">
      <div class="field-box">
        <div class="field-label">日付 / 時刻</div>
        <div class="field-value">${escapeHtml(r.date || "-")} ${escapeHtml(r.time || "")}</div>
      </div>
      <div class="field-box">
        <div class="field-label">税込合計金額</div>
        <div class="field-value large-amount">¥${Number(r.total_amount || 0).toLocaleString("ja-JP")}</div>
      </div>
      <div class="field-box full">
        <div class="field-label">店舗・発行元名称</div>
        <div class="field-value">${escapeHtml(r.store_name || "-")} ${r.store_phone ? `<span style="font-weight:400;font-size:0.8rem;color:var(--muted);">(${escapeHtml(r.store_phone)})</span>` : ""}</div>
      </div>
      <div class="field-box">
        <div class="field-label">適格請求書登録番号 (インボイス)</div>
        <div class="field-value">${escapeHtml(r.invoice_number || "なし")}</div>
      </div>
      <div class="field-box">
        <div class="field-label">勘定科目 / 支払方法</div>
        <div class="field-value">${escapeHtml(r.category || "-")} ／ ${escapeHtml(r.payment_method || "-")}</div>
      </div>
      <div class="field-box">
        <div class="field-label">税抜小計</div>
        <div class="field-value">${r.subtotal_amount != null ? "¥" + Number(r.subtotal_amount).toLocaleString("ja-JP") : "-"}</div>
      </div>
      <div class="field-box">
        <div class="field-label">消費税額合計 (8% / 10%)</div>
        <div class="field-value">¥${Number(r.tax_amount || 0).toLocaleString("ja-JP")}</div>
      </div>
      ${
        r.memo
          ? `<div class="field-box full">
               <div class="field-label">メモ・備考</div>
               <div class="field-value" style="font-weight:500;font-size:0.84rem;">${escapeHtml(r.memo)}</div>
             </div>`
          : ""
      }
      <div class="field-box full">
        <div class="field-label">保管パス (Googleドライブ)</div>
        <div class="field-value" style="font-size:0.76rem;color:var(--muted);font-weight:500;">${escapeHtml(r.archive_file || "-")}</div>
      </div>
    </div>

    <div style="font-size:0.85rem;font-weight:700;margin:8px 0 6px;">購入品目明細 (${items.length}件)</div>
    <table class="items-table">
      <thead>
        <tr>
          <th>品目名</th>
          <th class="num">数量</th>
          <th class="num">単価</th>
          <th class="num">金額</th>
          <th class="num">税率</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRowsHtml}
      </tbody>
    </table>
  `;

  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");

  // 上半分：プレビュー画像（PDFの場合は生成済みの .preview.png）をDriveから取得
  const previewPath = r.preview_file || r.archive_file;
  try {
    if (driveCache.blobUrls[previewPath]) {
      imgEl.src = driveCache.blobUrls[previewPath];
      imgEl.style.display = "block";
      loadingEl.style.display = "none";
    } else {
      const fileMeta = await findDriveFileByRelativePath(previewPath);
      if (!fileMeta) {
        loadingEl.textContent = "プレビュー画像がGoogleドライブ上に見つかりませんでした";
      } else {
        const mediaRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileMeta.id}?alt=media`);
        const blob = await mediaRes.blob();
        const objUrl = URL.createObjectURL(blob);
        driveCache.blobUrls[previewPath] = objUrl;
        imgEl.src = objUrl;
        imgEl.style.display = "block";
        loadingEl.style.display = "none";
      }
    }

    // 原本ファイルリンク（特にPDFの場合に便利）
    if (r.archive_file) {
      const origMeta = await findDriveFileByRelativePath(r.archive_file);
      if (origMeta && origMeta.webViewLink) {
        openOrigBtn.style.display = "inline-block";
        openOrigBtn.onclick = () => window.open(origMeta.webViewLink, "_blank", "noopener");
      }
    }
  } catch (err) {
    console.error(err);
    loadingEl.textContent = `画像読込失敗: ${err.message}`;
  }
}

// =========================================================
// HTMLエスケープ・タブ切替・初期化
// =========================================================
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === tabId);
  });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  if (tabId === "tab-list" && receiptsData.length === 0 && accessToken) {
    fetchReceiptsJson();
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  // Service Worker 登録
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW登録スキップ:", e));
  }

  // 設定復元
  const { clientId, rootFolderName } = getSettings();
  document.getElementById("clientIdInput").value = clientId;
  document.getElementById("rootFolderInput").value = rootFolderName;
  updateAuthUI();

  // キュー描画
  await renderQueueList();

  // タブ切り替え
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // ファイル・カメラ入力
  document.getElementById("cameraInput").addEventListener("change", (e) => {
    handleSelectedFiles(e.target.files);
    e.target.value = "";
  });
  document.getElementById("fileInput").addEventListener("change", (e) => {
    handleSelectedFiles(e.target.files);
    e.target.value = "";
  });

  // キュー操作
  document.getElementById("uploadAllBtn").addEventListener("click", uploadAllQueuedItems);
  document.getElementById("clearQueueBtn").addEventListener("click", async () => {
    if (confirm("送信待ちキュー内のファイルをすべて削除しますか？")) {
      await clearAllQueueItems();
      await renderQueueList();
    }
  });

  // 一覧検索・フィルタ・更新
  document.getElementById("searchInput").addEventListener("input", renderReceiptList);
  document.getElementById("monthFilter").addEventListener("change", renderReceiptList);
  document.getElementById("refreshListBtn").addEventListener("click", fetchReceiptsJson);

  // 設定保存・認証
  document.getElementById("saveSettingsBtn").addEventListener("click", () => {
    const cid = document.getElementById("clientIdInput").value.trim();
    const rname = document.getElementById("rootFolderInput").value.trim() || "MyReceiptApp";
    localStorage.setItem("myreceipt_client_id", cid);
    localStorage.setItem("myreceipt_root_folder", rname);
    driveCache.rootFolderId = null;
    showToast("設定を保存しました");
  });

  const handleAuthClick = async () => {
    try {
      accessToken = null;
      await ensureAccessToken();
      await ensureDriveStructure();
    } catch (err) {
      showToast(err.message);
    }
  };
  document.getElementById("googleLoginBtn").addEventListener("click", handleAuthClick);
  document.getElementById("authBadgeBtn").addEventListener("click", handleAuthClick);

  // 詳細モーダル操作
  document.getElementById("closeDetailBtn").addEventListener("click", () => {
    const overlay = document.getElementById("detailOverlay");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
  });
  document.getElementById("toggleZoomBtn").addEventListener("click", () => {
    document.getElementById("detailImagePane").classList.toggle("zoomed");
  });
});

