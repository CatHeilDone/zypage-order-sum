(() => {
  const KEY = "zp_sum_col", FKEY = "zp_sum_filter", PKEY = "zp_sum_paid", MAX_PAGES = 1000;
  let pickMode = false, filterText = localStorage.getItem(FKEY) || "", running = false, stopFlag = false;
  let onlyPaid = localStorage.getItem(PKEY) !== "0";
  const excluded = new WeakSet();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || "").replace(/\s+/g, " ").trim();

  function parseMoney(txt) {
    if (!txt || !/\d/.test(txt)) return null;
    let s = txt.replace(/\s/g, "").replace(/[^\d.,]/g, "");
    s = s.replace(/[.,]\d{1,2}$/, "").replace(/[.,]/g, "");
    const n = parseInt(s, 10);
    return isNaN(n) ? null : n;
  }
  const fmt = n => n.toLocaleString("vi-VN") + " đ";

  // ---------- bảng ----------
  function getTable(doc = document) {
    const tables = [...doc.querySelectorAll("table")].filter(t => t.rows.length > 1);
    return tables.sort((a, b) => b.rows.length - a.rows.length)[0] || null;
  }
  const bodyRows = table => table.tBodies.length ? [...table.tBodies].flatMap(b => [...b.rows]) : [...table.rows].slice(1);
  const headCells = table => [...(table.tHead ? table.tHead.rows[0] : table.rows[0]).cells];

  function amountCol(table) {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) return parseInt(saved, 10);
    const heads = headCells(table);
    let h = heads.find(c => c.classList.contains("studio_order_amount") || c.querySelector('[data-sort="amount"]'));
    if (h) return h.cellIndex;
    for (const re of [/số tiền/i, /thành tiền/i, /tổng/i, /amount/i, /total/i, /price/i, /giá/i]) {
      h = heads.find(c => re.test(c.textContent)); if (h) return h.cellIndex;
    }
    return -1;
  }
  function statusCol(table) {
    const h = headCells(table).find(c => c.querySelector('[data-sort="status"]') || /trạng thái|status/i.test(c.textContent));
    return h ? h.cellIndex : -1;
  }
  const isPaid = txt => /đã thanh toán|paid/i.test(txt || "");

  function pageSum(table, col, f, paidOnly) {
    const sc = statusCol(table);
    let total = 0, count = 0, rows = 0; const sigs = [];
    for (const r of bodyRows(table)) {
      const cell = r.cells[col]; if (!cell) continue;
      const v = parseMoney(cell.textContent); if (v === null) continue;
      rows++; sigs.push(norm(r.textContent));
      if (paidOnly && sc >= 0 && r.cells[sc] && !isPaid(r.cells[sc].textContent)) continue;
      if (f && !r.textContent.toLowerCase().includes(f)) continue;
      total += v; count++;
    }
    return { total, count, rows, sig: sigs.join("|") };
  }

  // ---------- phân trang ----------
  const PAGE_RE = /Trang\s*(\d+)\s*\/\s*(\d+)/i;
  function pageInfo(doc = document) {
    const m = (doc.body.textContent || "").match(PAGE_RE);
    return m ? { cur: +m[1], total: +m[2] } : null;
  }
  const PAG = '.pagination, .pager, .paginate, [class*="paginat"], [class*="pager"], nav[aria-label*="agin"]';
  function pagControls(doc) {
    let ctrls = [];
    const holder = [...doc.body.querySelectorAll("*")].find(el =>
      PAGE_RE.test(el.textContent) && ![...el.children].some(c => PAGE_RE.test(c.textContent)));
    if (holder) {
      let el = holder;
      for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
        const c = [...el.querySelectorAll("a,button")].filter(x => !x.closest("table") && !x.closest("#zp-sum"));
        if (c.length >= 2) { ctrls = c; break; }
      }
    }
    if (!ctrls.length) ctrls = [...doc.querySelectorAll(PAG)].flatMap(c => [...c.querySelectorAll("a,button")]);
    return ctrls;
  }
  function labelOf(el) {
    const d = [...el.querySelectorAll("*")].map(c => (c.getAttribute("class") || "") + " " + (c.getAttribute("data-icon") || ""));
    return [el.getAttribute("aria-label"), el.title, el.textContent, ...d].join(" ").toLowerCase();
  }
  function kindOf(el) {
    const t = norm(el.textContent);
    if (/^\d+$/.test(t)) return "num";
    const l = labelOf(el);
    const right = /right|next|sau|tiếp|›|»|forward/.test(l), left = /left|prev|trước|‹|«|back/.test(l);
    const far = /double|angles|last|first|cuối|đầu|end|start|step/.test(l);
    if (right) return far ? "last" : "next";
    if (left) return far ? "first" : "prev";
    return "other";
  }
  const isDisabled = el => !!el && (el.disabled || el.getAttribute("aria-disabled") === "true" ||
    /disabled/.test(el.className || "") || /disabled/.test(el.parentElement?.className || ""));

  function findNextEl(doc) {
    const info = pageInfo(doc);
    if (info && info.cur >= info.total) return null;
    const rel = doc.querySelector('a[rel~="next"]');
    if (rel && !isDisabled(rel)) return rel;
    const ctrls = pagControls(doc);
    const nx = ctrls.find(c => kindOf(c) === "next");
    if (nx) return isDisabled(nx) ? null : nx;
    if (info) { const n = ctrls.find(c => norm(c.textContent) === String(info.cur + 1)); if (n && !isDisabled(n)) return n; }
    return null;
  }
  function findFirstEl(doc) {
    const info = pageInfo(doc);
    if (info && info.cur <= 1) return null;
    const ctrls = pagControls(doc);
    return ctrls.find(c => kindOf(c) === "first" && !isDisabled(c)) ||
           ctrls.find(c => norm(c.textContent) === "1" && !isDisabled(c)) || null;
  }
  const usableHref = (el, base) => {
    const h = el && el.getAttribute("href");
    if (!h || h === "#" || /^javascript:/i.test(h)) return null;
    try { return new URL(h, base).href; } catch { return null; }
  };

  // ---------- cộng toàn bộ ----------
  async function fetchMode(col, f, st) {
    let url = usableHref(findFirstEl(document), location.href) || location.href;
    const seenUrl = new Set(), seenSig = new Set();
    let total = 0, count = 0, pages = 0;
    while (url && pages < MAX_PAGES && !stopFlag) {
      if (seenUrl.has(url)) break; seenUrl.add(url);
      st(`Đang đọc trang ${pages + 1}…`, total, count);
      const html = await (await fetch(url, { credentials: "include" })).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const table = getTable(doc);
      const r = table ? pageSum(table, col, f, onlyPaid) : null;
      if (!r || r.rows === 0) { if (pages === 0) return null; break; }
      if (seenSig.has(r.sig)) break; seenSig.add(r.sig);
      total += r.total; count += r.count; pages++;
      const nx = findNextEl(doc); if (!nx) break;
      const nu = usableHref(nx, url);
      if (!nu) { if (pages === 1) return null; break; }
      url = nu;
    }
    return { total, count, pages };
  }

  const liveSig = () => {
    const t = getTable(), i = pageInfo();
    return (i ? i.cur : "") + "#" + (t ? bodyRows(t).slice(0, 3).map(r => norm(r.textContent)).join("|") + bodyRows(t).length : "");
  };
  async function waitChange(before) {
    for (let i = 0; i < 80; i++) { await sleep(100); if (liveSig() !== before) { await sleep(150); return true; } }
    return false;
  }
  async function goFirst() {
    for (let g = 0; g < MAX_PAGES && !stopFlag; g++) {
      const info = pageInfo(); if (!info || info.cur <= 1) return;
      const ctrls = pagControls(document);
      const el = findFirstEl(document) || ctrls.find(c => kindOf(c) === "prev" && !isDisabled(c));
      if (!el) return;
      const b = liveSig(); el.click(); if (!(await waitChange(b))) return;
    }
  }
  async function clickMode(col, f, st) {
    st("Đang về trang đầu…");
    await goFirst();
    const seenSig = new Set(); let total = 0, count = 0, pages = 0;
    while (pages < MAX_PAGES && !stopFlag) {
      const table = getTable(); if (!table) break;
      const r = pageSum(table, col, f, onlyPaid);
      if (seenSig.has(r.sig)) break; seenSig.add(r.sig);
      total += r.total; count += r.count; pages++;
      const info = pageInfo();
      st(`Đang đọc trang ${info ? info.cur + "/" + info.total : pages}…`, total, count);
      const nx = findNextEl(document);
      if (!nx) break;
      const b = liveSig(); nx.click();
      if (!(await waitChange(b))) break;
    }
    return { total, count, pages };
  }

  async function sumAll() {
    const table = getTable();
    if (!table) return setAll("Không tìm thấy bảng đơn hàng.");
    const col = amountCol(table);
    if (col < 0) return setAll("Chưa biết cột tiền → bấm “Chọn cột” trước.");
    const f = filterText.trim().toLowerCase();
    running = true; stopFlag = false; $(".zp-allbtn").textContent = "Dừng";
    try {
      let r = await fetchMode(col, f, setAll);
      if (!r) r = await clickMode(col, f, setAll);
      setAll(stopFlag ? `Đã dừng • ${r.pages} trang` : `Xong • ${r.pages} trang`, r.total, r.count);
    } catch (e) { setAll("Lỗi: " + e.message); }
    running = false; $(".zp-allbtn").textContent = "Tính toàn bộ lịch sử";
  }

  // ---------- trang hiện tại ----------
  function compute() {
    const table = getTable();
    let total = 0, count = 0, note = "";
    document.querySelectorAll(".zp-col-hl").forEach(e => e.classList.remove("zp-col-hl"));
    if (table) {
      const col = amountCol(table), sc = statusCol(table);
      if (col < 0) note = "Chưa nhận diện được cột tiền → bấm “Chọn cột”.";
      else {
        const f = filterText.trim().toLowerCase();
        for (const r of bodyRows(table)) {
          const cell = r.cells[col]; if (!cell) continue;
          const v = parseMoney(cell.textContent); if (v === null) continue;
          cell.classList.add("zp-col-hl"); r.style.cursor = "pointer";
          const off = excluded.has(r); r.classList.toggle("zp-row-off", off);
          if (off) continue;
          if (onlyPaid && sc >= 0 && r.cells[sc] && !isPaid(r.cells[sc].textContent)) continue;
          if (f && !r.textContent.toLowerCase().includes(f)) continue;
          total += v; count++;
        }
        note = `Cột tiền: ${col + 1}` + (f ? ` • lọc: “${filterText}”` : "") + " • click dòng để loại/bao gồm";
      }
    } else note = "Không thấy bảng đơn hàng.";
    return { total, count, note };
  }

  // ---------- UI ----------
  const box = document.createElement("div");
  box.id = "zp-sum";
  box.innerHTML = `
    <h4><span>💰 Tổng tiền đơn hàng</span><button class="zp-x" title="Thu gọn">–</button></h4>
    <div class="zp-body">
      <div class="zp-sub">Trang này</div>
      <div class="zp-total">0 đ</div>
      <div class="zp-sub zp-count"></div>
      <div class="zp-sub zp-note"></div>
      <div class="zp-all">
        <div class="zp-sub">Toàn bộ lịch sử</div>
        <div class="zp-all-total">—</div>
        <div class="zp-sub zp-all-note">Bấm nút bên dưới (tự về trang đầu rồi chạy hết).</div>
        <button class="zp-allbtn zp-primary">Tính toàn bộ lịch sử</button><button class="zp-copyall">Copy</button>
      </div>
      <label><input type="checkbox" class="zp-paid">Chỉ tính đơn “Đã thanh toán”</label>
      <input class="zp-filter" placeholder="Lọc thêm theo chữ trong dòng (tuỳ chọn)">
      <button class="zp-pick">Chọn cột</button><button class="zp-reset">Reset</button><button class="zp-copy">Copy trang</button>
    </div>`;
  document.body.appendChild(box);
  const $ = s => box.querySelector(s);
  $(".zp-filter").value = filterText; $(".zp-paid").checked = onlyPaid;

  function setAll(msg, total, count) {
    $(".zp-all-note").textContent = msg + (count != null ? ` • ${count} đơn` : "");
    if (total != null) { $(".zp-all-total").textContent = fmt(total); box.dataset.all = total; }
  }
  function render() {
    const { total, count, note } = compute();
    $(".zp-total").textContent = fmt(total);
    $(".zp-count").textContent = `${count} đơn được tính`;
    $(".zp-note").textContent = note;
    box.dataset.total = total;
  }

  $(".zp-paid").onchange = e => { onlyPaid = e.target.checked; localStorage.setItem(PKEY, onlyPaid ? "1" : "0"); render(); };
  $(".zp-filter").addEventListener("input", e => { filterText = e.target.value; localStorage.setItem(FKEY, filterText); render(); });
  $(".zp-x").onclick = () => { const b = $(".zp-body"); b.style.display = b.style.display === "none" ? "" : "none"; };
  $(".zp-copy").onclick = () => navigator.clipboard.writeText(box.dataset.total || "0");
  $(".zp-copyall").onclick = () => navigator.clipboard.writeText(box.dataset.all || "0");
  $(".zp-reset").onclick = () => { [KEY, FKEY, PKEY].forEach(k => localStorage.removeItem(k)); location.reload(); };
  $(".zp-pick").onclick = () => { pickMode = true; $(".zp-note").textContent = "Bấm vào 1 ô bất kỳ của cột tiền…"; };
  $(".zp-allbtn").onclick = () => { running ? (stopFlag = true) : sumAll(); };

  // kéo thả bảng
  $("h4").addEventListener("mousedown", e => {
    if (e.target.closest("button")) return;
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    box.style.right = "auto"; box.style.left = r.left + "px"; box.style.top = r.top + "px";
    const mv = ev => { box.style.left = ev.clientX - dx + "px"; box.style.top = ev.clientY - dy + "px"; };
    const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  });

  document.addEventListener("click", e => {
    if (box.contains(e.target) || running) return;
    const cell = e.target.closest("td,th");
    if (pickMode && cell) {
      e.preventDefault(); e.stopPropagation();
      localStorage.setItem(KEY, cell.cellIndex); pickMode = false; render(); return;
    }
    const row = e.target.closest("tbody tr, tr"), t = getTable();
    if (row && t && t.contains(row) && !e.target.closest("a,button,input,select")) {
      excluded.has(row) ? excluded.delete(row) : excluded.add(row); render();
    }
  }, true);

  let tm; new MutationObserver(m => {
    if (running || m.every(x => box.contains(x.target))) return;
    clearTimeout(tm); tm = setTimeout(render, 300);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  render();
})();
