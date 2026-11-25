// A product's four prices — MRP, purchase, selling and lowest (non-negotiable) — with their history.
// Shared by the Bill page (✎ next to the price hint) and the Purchase page's Prices tab.
//
// mountProductEditor({ shopCode, toast, via, lookup, onOpenPurchase })
//     -> { open(name, entry, { mode }), refresh() }
//   via            — "bill" or "prices": written into the price history with each change
//   lookup(key)    — returns the latest catalog entry, so the sheet shows saved changes straight away
//   onOpenPurchase — tapping an invoice line in the history opens that purchase
//   open(…, { mode: "view" })  shows the prices, "✎ Edit prices" and the history (Prices tab)
//   open(…, { mode: "edit" })  goes straight to editing (Bill page ✎, new products)
//   refresh()      — call when the data changes, to redraw the sheet if it's open

import { saveProductPrices, deleteProduct } from "./data.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => "₹" + r2(n).toFixed(2).replace(/\.00$/, "");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = (key) => key ? new Date(key + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "";
const fmtWhen = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + ", " +
         d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
};
const LABEL = { mrp: "MRP", purchasePrice: "Purchase", sellPrice: "Selling", minPrice: "Lowest" };
const VIA = { bill: "Changed on the bill", prices: "Changed in Prices" };

export function mountProductEditor({ shopCode, toast, via = "", lookup = null, onOpenPurchase = null }){
  const root = document.createElement("div");
  root.className = "modal-backdrop hidden";
  root.innerHTML = `
    <div class="modal">
      <div class="modal-title pe-title">Product prices</div>
      <div class="modal-sub pe-sub"></div>

      <div class="pe-view">
        <div class="pe-tiles"></div>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn btn-ghost pe-close">Close</button>
          <button class="btn btn-primary pe-edit-btn">✎ Edit prices</button>
        </div>
        <div class="section-label" style="margin:18px 2px 6px;">Price history — newest first</div>
        <div class="card pe-timeline" style="padding:2px 14px;"></div>
        <button class="icon-btn pe-delete" style="display:block; margin:16px auto 0; color:var(--danger);">🗑 Delete product</button>
      </div>

      <div class="pe-edit">
        <div class="field pe-name-field"><label>Product name</label><input type="text" class="pe-name" placeholder="e.g. Red Label 500g"></div>
        <div class="pe-grid">
          <div class="field"><label>MRP ₹</label><input type="number" class="pe-mrp" inputmode="decimal" placeholder="—"></div>
          <div class="field"><label>Purchase price ₹</label><input type="number" class="pe-buy" inputmode="decimal" placeholder="—"></div>
          <div class="field"><label>Selling price ₹</label><input type="number" class="pe-sell" inputmode="decimal" placeholder="—"></div>
          <div class="field"><label>Lowest (non-negotiable) ₹</label><input type="number" class="pe-min" inputmode="decimal" placeholder="—"></div>
        </div>
        <div class="pe-buy-note"></div>
        <div class="pe-msgs"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost pe-cancel">Cancel</button>
          <button class="btn btn-primary pe-save">Save prices</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const num = (sel) => { const v = q(sel).value.trim(); return v === "" ? null : Number(v); };

  let current = null;        // catalog entry (null = new product)
  let mode = "view";
  let openedInEdit = false;  // Cancel/Save then closes the sheet instead of going back to the view
  let buyAtOpen = "";        // purchase box value when editing started, to tell if it was typed by hand

  const isOpen = () => !root.classList.contains("hidden");
  function close(){ root.classList.add("hidden"); }
  function setMode(m){
    mode = m;
    q(".pe-view").style.display = m === "view" ? "block" : "none";
    q(".pe-edit").style.display = m === "edit" ? "block" : "none";
    q(".pe-sub").textContent = m === "view"
      ? "Tap “Edit prices” to change them — every change is kept below"
      : "Used on the bill: selling price fills in, lowest price warns you";
  }

  // ---------- View: current prices + history ----------
  // When each price was last changed by hand, from the change log.
  function lastChangedAt(field){
    const c = (current.changes || []).filter(c => c.diff && c.diff[field]).pop();
    return c ? c.at : null;
  }
  function renderView(){
    q(".pe-title").textContent = current.name;
    const p = current.purchase;
    const tile = (field, value, note) => `
      <div class="pe-tile${field === "sellPrice" ? " main" : ""}">
        <div class="pe-tlabel">${LABEL[field]}</div>
        <div class="pe-tval">${value != null ? money(value) : "—"}</div>
        <div class="pe-tnote">${value != null && note ? note : (value == null ? "not set" : "&nbsp;")}</div>
      </div>`;
    const since = (field) => { const at = lastChangedAt(field); return at ? "since " + fmtWhen(at) : ""; };
    const buyNote = !p ? "" : p.fromInvoice
      ? `invoice · ${escapeHtml(p.supplierName || "")} · ${fmtDate(p.date)}`
      : (since("purchasePrice") ? "by hand · " + since("purchasePrice").replace("since ", "") : "by hand");
    q(".pe-tiles").innerHTML =
      tile("sellPrice", current.sellPrice, since("sellPrice")) +
      tile("mrp", current.mrp, since("mrp")) +
      tile("purchasePrice", p ? p.price : null, buyNote) +
      tile("minPrice", current.minPrice, since("minPrice"));
    renderTimeline();
  }

  // Hand edits and invoice prices in one list, newest first.
  function renderTimeline(){
    const events = [
      ...(current.changes || []).map(c => ({ at: c.at || 0, kind: c.deleted ? "deleted" : "edit", c })),
      ...(current.history || []).map(h => ({ at: h.savedAt || 0, kind: "invoice", h }))
    ].sort((a, b) => b.at - a.at);
    const box = q(".pe-timeline");
    if (!events.length){ box.innerHTML = `<div class="history-empty" style="padding:14px 0;">No changes yet</div>`; return; }
    box.innerHTML = events.map(e => {
      if (e.kind === "invoice"){
        const h = e.h;
        return `<div class="pe-hrow${onOpenPurchase ? " link" : ""}" data-pid="${escapeHtml(h.purchaseId)}">
          <div class="pe-hwhen">${fmtDate(h.date)}</div>
          <div class="pe-hwhat">Purchase price <b>${money(h.price)}</b></div>
          <div class="pe-hsrc">From invoice · ${escapeHtml(h.supplierName || "supplier")}${onOpenPurchase ? " · tap to open" : ""}</div>
        </div>`;
      }
      if (e.kind === "deleted"){
        return `<div class="pe-hrow"><div class="pe-hwhen">${fmtWhen(e.at)}</div><div class="pe-hwhat">Product deleted — prices removed</div></div>`;
      }
      // fixed order — Firestore doesn't keep the order of the fields inside a change
      const diff = e.c.diff || {};
      const lines = Object.keys(LABEL).filter(f => diff[f]).map(f =>
        `${LABEL[f]} ${diff[f].from != null ? money(diff[f].from) : "—"} → <b>${diff[f].to != null ? money(diff[f].to) : "removed"}</b>`);
      return `<div class="pe-hrow">
        <div class="pe-hwhen">${fmtWhen(e.at)}</div>
        <div class="pe-hwhat">${lines.join("<br>")}</div>
        <div class="pe-hsrc">${VIA[e.c.via] || "Changed by hand"}</div>
      </div>`;
    }).join("");
    if (onOpenPurchase) box.querySelectorAll(".pe-hrow.link").forEach(el => el.onclick = () => { close(); onOpenPurchase(el.dataset.pid); });
  }

  q(".pe-close").onclick = close;
  q(".pe-edit-btn").onclick = () => startEdit();

  // ---------- Edit ----------
  // Warnings while typing. Lowest above selling makes no sense, so that one blocks Save.
  function check(){
    const mrp = num(".pe-mrp"), buy = num(".pe-buy"), sell = num(".pe-sell"), min = num(".pe-min");
    const msgs = [];
    let block = false;
    if ([mrp, buy, sell, min].some(v => v != null && !(v >= 0))){ msgs.push(["bad", "Prices can't be negative"]); block = true; }
    if (min != null && sell != null && min > sell){ msgs.push(["bad", `Lowest price ${money(min)} is more than the selling price ${money(sell)}`]); block = true; }
    if (sell != null && mrp != null && sell > mrp) msgs.push(["warn", `Selling price ${money(sell)} is above MRP ${money(mrp)}`]);
    if (sell != null && buy != null && sell < buy) msgs.push(["warn", `Selling price ${money(sell)} is below what you paid (${money(buy)})`]);
    if (min != null && buy != null && min < buy) msgs.push(["warn", `Lowest price ${money(min)} is below what you paid (${money(buy)})`]);
    q(".pe-msgs").innerHTML = msgs.map(([kind, text]) => `<div class="pe-msg ${kind}">${escapeHtml(text)}</div>`).join("");
    q(".pe-save").disabled = block;
    return !block;
  }
  root.querySelectorAll(".pe-grid input").forEach(inp => inp.addEventListener("input", check));
  function buyNote(){
    const p = current && current.purchase;
    if (!p) return "";
    return p.fromInvoice ? `From invoice · ${p.supplierName || "supplier"} · ${fmtDate(p.date)}` : "Set by hand";
  }
  q(".pe-buy").addEventListener("input", () => {
    q(".pe-buy-note").textContent = q(".pe-buy").value.trim() !== buyAtOpen ? "Set by hand — the next invoice will update it again" : buyNote();
  });

  function startEdit(prefillName = ""){
    q(".pe-title").textContent = current ? current.name : "New product prices";
    q(".pe-name-field").style.display = current ? "none" : "block";
    q(".pe-name").value = current ? "" : prefillName;
    const set = (sel, v) => { q(sel).value = v == null ? "" : v; };
    set(".pe-mrp", current && current.mrp);
    set(".pe-buy", current && current.purchase && current.purchase.price);
    set(".pe-sell", current && current.sellPrice);
    set(".pe-min", current && current.minPrice);
    buyAtOpen = q(".pe-buy").value.trim();
    q(".pe-buy-note").textContent = buyNote();
    check();
    setMode("edit");
    setTimeout(() => (current ? q(".pe-sell") : q(".pe-name")).focus(), 50);
  }
  q(".pe-cancel").onclick = () => { if (openedInEdit || !current) close(); else { renderView(); setMode("view"); } };

  q(".pe-save").onclick = async () => {
    if (!check()) return;
    const name = current ? current.name : q(".pe-name").value.trim();
    if (!name){ toast("Enter the product name"); q(".pe-name").focus(); return; }
    const buyNow = q(".pe-buy").value.trim();
    const btn = q(".pe-save");
    btn.disabled = true;
    try{
      await saveProductPrices(shopCode, name, {
        mrp: num(".pe-mrp"), purchasePrice: buyNow === "" ? null : Number(buyNow),
        sellPrice: num(".pe-sell"), minPrice: num(".pe-min")
      }, buyNow !== buyAtOpen, { before: current, via });
      toast(`Prices saved for ${name}`);
      if (openedInEdit){ close(); }
      else {
        // back to the view, showing the saved prices and the new history line
        current = (lookup && lookup(current.key)) || current;
        renderView();
        setMode("view");
      }
    }catch(e){ console.error(e); toast("Couldn't save — check your connection"); }
    btn.disabled = false;
  };

  q(".pe-delete").onclick = async () => {
    if (!current) return;
    const bought = (current.history || []).length;
    const note = bought
      ? (bought === 1
          ? `\n\nYour past purchase of it stays as it is. If a new invoice has it again, it comes back.`
          : `\n\nYour ${bought} past purchases of it stay as they are. If a new invoice has it again, it comes back.`)
      : "";
    if (!confirm(`Delete “${current.name}”? Its prices are removed and it leaves the Prices list and bill suggestions.${note}`)) return;
    try{
      await deleteProduct(shopCode, current.name, bought > 0, via);
      toast(`${current.name} deleted`);
      close();
    }catch(e){ console.error(e); toast("Couldn't delete — check your connection"); }
  };

  return {
    open(name, entry, opts = {}){
      current = entry || null;
      openedInEdit = opts.mode === "edit" || !current;
      root.classList.remove("hidden");
      if (openedInEdit) startEdit(name || "");
      else { renderView(); setMode("view"); }
    },
    // the page calls this when its data changes, so an open view shows the latest prices
    refresh(){
      if (!isOpen() || !current || mode !== "view" || !lookup) return;
      const fresh = lookup(current.key);
      if (fresh){ current = fresh; renderView(); }
    }
  };
}
