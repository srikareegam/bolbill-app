// A product's details and prices — MRP, purchase and selling — with their history.
// Shared by the Bill page (✎ next to the price hint) and the Products page.
//
// mountProductEditor({ shopCode, toast, via, lookup, onOpenPurchase })
//     -> { open(name, entry, { mode }), refresh() }
//   via            — "bill" or "prices": written into the price history with each change
//   lookup(key)    — returns the latest catalog entry, so the sheet shows saved changes straight away
//   onOpenPurchase — tapping an invoice line in the history opens that purchase
//   open(…, { mode: "view" })  shows the prices, "✎ Edit product" and the history (Products page)
//   open(…, { mode: "edit" })  goes straight to editing (Bill page ✎, new products)
//   refresh()      — call when the data changes, to redraw the sheet if it's open

import {
  saveProductPrices, deleteProduct, renameProduct, productKey,
  packOrNull, packText, PACK_TYPES, PACK_UNITS, unitLabel, unitPriceText,
  effectivePack, effectivePackType, effectivePackUnit, offerText, looseUnit, unitPrice
} from "./data.js";

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => "₹" + r2(n).toFixed(2).replace(/\.00$/, "");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = (key) => key ? new Date(key + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "";
const fmtWhen = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + ", " +
         d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// "Lowest" stays here only so older history lines (from before it was removed) still read properly.
const LABEL = { pack: "Pack", mrp: "MRP", purchasePrice: "Purchase", sellPrice: "Selling", sellLoose: "Loose selling", minPrice: "Lowest" };
const VIA = { bill: "Changed on the bill", prices: "Changed in Products" };

export function mountProductEditor({ shopCode, toast, via = "", lookup = null, onOpenPurchase = null }){
  const root = document.createElement("div");
  root.className = "modal-backdrop hidden";
  root.innerHTML = `
    <div class="modal">
      <div class="modal-title pe-title">Product</div>
      <div class="modal-sub pe-sub"></div>

      <div class="pe-view">
        <div class="pe-packline"></div>
        <div class="pe-tiles"></div>
        <div class="btn-row" style="margin-top:12px;">
          <button class="btn btn-ghost pe-close">Close</button>
          <button class="btn btn-primary pe-edit-btn">✎ Edit product</button>
        </div>
        <div class="section-label" style="margin:18px 2px 6px;">Price history — newest first</div>
        <div class="card pe-timeline" style="padding:2px 14px;"></div>
        <button class="icon-btn pe-delete" style="display:block; margin:16px auto 0; color:var(--danger);">🗑 Delete product</button>
      </div>

      <div class="pe-edit">
        <div class="section-label" style="margin:4px 2px 8px;">Product details</div>
        <div class="field"><label>Product name</label><input type="text" class="pe-name" placeholder="e.g. Red Label 500g"></div>
        <div class="field">
          <label>Bought as</label>
          <div class="pe-pack-row">
            <select class="pe-packsel">
              <option value="loose">Loose</option>
              ${PACK_TYPES.map(t => `<option value="${t}">${cap(t)}</option>`).join("")}
            </select>
            <span class="pe-pcs-wrap">× <input type="number" class="pe-pcs" inputmode="numeric" placeholder="25">
              <select class="pe-unitsel">${PACK_UNITS.map(u => `<option value="${u}">${u}</option>`).join("")}</select></span>
          </div>
        </div>
        <div class="section-label" style="margin:14px 2px 8px;">Prices</div>
        <div class="pe-grid">
          <div class="field"><label>MRP ₹</label><input type="number" class="pe-mrp" inputmode="decimal" placeholder="—"></div>
          <div class="field"><label class="pe-sell-label">Selling price ₹</label><input type="number" class="pe-sell" inputmode="decimal" placeholder="—"></div>
          <div class="field pe-loose-field" style="grid-column:span 2;"><label class="pe-loose-label">Loose selling ₹ (per kg)</label><input type="number" class="pe-loose" inputmode="decimal" placeholder="price when sold loose"></div>
          <div class="field" style="grid-column:span 2;"><label class="pe-buy-label">Purchase price ₹</label><input type="number" class="pe-buy" inputmode="decimal" placeholder="—"></div>
        </div>
        <div class="pe-buy-note"></div>
        <div class="pe-msgs"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost pe-cancel">Cancel</button>
          <button class="btn btn-primary pe-save">Save</button>
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
      ? "Tap “Edit product” to change it — every change is kept below"
      : "Used on the bill: the selling price fills in by itself";
  }

  // ---------- View: current prices + history ----------
  // When each field was last changed by hand, from the change log.
  function lastChangedAt(field){
    const c = (current.changes || []).filter(c => c.diff && c.diff[field]).pop();
    return c ? c.at : null;
  }
  function renderView(){
    q(".pe-title").textContent = current.name;
    q(".pe-packline").innerHTML = `Bought as <b>${packText(effectivePack(current), effectivePackType(current), effectivePackUnit(current))}</b>`;
    const p = current.purchase;
    // For a pack product every price shows twice, separately: the whole pack (₹2275 / bag) and the
    // individual price inside it (₹87.50/kg). pack = { perCase, type, unit } that price is for.
    const tile = (field, value, note, pack, wide) => {
      const per = pack && packOrNull(pack.perCase);
      // the selling price per bag isn't divided — the loose price is typed separately
      const each = per && value != null && !pack.noEach ? unitPriceText(value, pack.perCase, pack.unit) : "";
      return `
      <div class="pe-tile${field === "sellPrice" ? " main" : ""}"${wide ? ' style="grid-column:span 2;"' : ""}>
        <div class="pe-tlabel">${LABEL[field]}</div>
        <div class="pe-tval">${value != null ? money(value) : "—"}</div>
        ${per && value != null ? `<div class="pe-tper">per ${escapeHtml(packText(pack.perCase, pack.type, pack.unit))}</div>` : ""}
        ${each ? `<div class="pe-teach">${escapeHtml(each)}</div>` : ""}
        <div class="pe-tnote">${value != null && note ? note : (value == null ? "not set" : "&nbsp;")}</div>
      </div>`;
    };
    const since = (field) => { const at = lastChangedAt(field); return at ? "since " + fmtWhen(at) : ""; };
    const buyNote = !p ? "" : p.fromInvoice
      ? `invoice · ${escapeHtml(p.supplierName || "")} · ${fmtDate(p.date)}`
      : (since("purchasePrice") ? "by hand · " + since("purchasePrice").replace("since ", "") : "by hand");
    // selling price and MRP are for the product's usual pack; the purchase price for the pack it was bought in
    const productPack = effectivePack(current)
      ? { perCase: effectivePack(current), type: effectivePackType(current), unit: effectivePackUnit(current) } : null;
    const buyPack = p && packOrNull(p.perCase) ? { perCase: p.perCase, type: p.packType, unit: p.packUnit } : null;
    if (productPack){
      // pack product: selling price per bag, and its own (typed) loose price per kg / pc
      const lu = looseUnit(productPack.unit);
      const looseTile = `
        <div class="pe-tile main">
          <div class="pe-tlabel">Loose selling</div>
          <div class="pe-tval">${current.sellLoose != null ? money(current.sellLoose) : "—"}</div>
          <div class="pe-tper">per ${lu}</div>
          <div class="pe-tnote">${current.sellLoose != null ? (since("sellLoose") || "&nbsp;") : "not set"}</div>
        </div>`;
      q(".pe-tiles").innerHTML =
        tile("sellPrice", current.sellPrice, since("sellPrice"), { ...productPack, noEach: true }) + looseTile +
        tile("mrp", current.mrp, since("mrp"), productPack) +
        tile("purchasePrice", p ? p.price : null, buyNote, buyPack);
    } else {
      q(".pe-tiles").innerHTML =
        tile("sellPrice", current.sellPrice, since("sellPrice"), null, true) +
        tile("mrp", current.mrp, since("mrp"), null) +
        tile("purchasePrice", p ? p.price : null, buyNote, buyPack);
    }
    renderTimeline();
  }

  // Hand edits, renames and invoice prices in one list, newest first.
  function renderTimeline(){
    const events = [
      ...(current.changes || []).map(c => ({ at: c.at || 0, kind: c.deleted ? "deleted" : c.renamedFrom ? "renamed" : "edit", c })),
      ...(current.history || []).map(h => ({ at: h.savedAt || 0, kind: "invoice", h }))
    ].sort((a, b) => b.at - a.at);
    const box = q(".pe-timeline");
    if (!events.length){ box.innerHTML = `<div class="history-empty" style="padding:14px 0;">No changes yet</div>`; return; }
    box.innerHTML = events.map(e => {
      if (e.kind === "invoice"){
        const h = e.h;
        const offer = offerText(h.offer);
        return `<div class="pe-hrow${onOpenPurchase ? " link" : ""}" data-pid="${escapeHtml(h.purchaseId)}">
          <div class="pe-hwhen">${fmtDate(h.date)}</div>
          <div class="pe-hwhat">Purchase price <b>${money(h.price)}</b>${escapeHtml(unitLabel(h.perCase, h.packType, h.packUnit))}${packOrNull(h.perCase) ? ` · ${escapeHtml(unitPriceText(h.price, h.perCase, h.packUnit))}` : ""}${offer ? ` · 🎁 ${escapeHtml(offer)}` : ""}</div>
          <div class="pe-hsrc">From invoice · ${escapeHtml(h.supplierName || "supplier")}${onOpenPurchase ? " · tap to view" : ""}</div>
        </div>`;
      }
      const src = `<div class="pe-hsrc">${VIA[e.c.via] || "Changed by hand"}</div>`;
      if (e.kind === "deleted"){
        return `<div class="pe-hrow"><div class="pe-hwhen">${fmtWhen(e.at)}</div><div class="pe-hwhat">Product deleted — prices removed</div>${src}</div>`;
      }
      if (e.kind === "renamed"){
        return `<div class="pe-hrow"><div class="pe-hwhen">${fmtWhen(e.at)}</div><div class="pe-hwhat">Renamed from “${escapeHtml(e.c.renamedFrom)}”</div>${src}</div>`;
      }
      // fixed order — Firestore doesn't keep the order of the fields inside a change
      const diff = e.c.diff || {};
      const lines = Object.keys(LABEL).filter(f => diff[f]).map(f => f === "pack"
        ? `Pack ${packText(diff.pack.from, diff.pack.fromType, diff.pack.fromUnit)} → <b>${packText(diff.pack.to, diff.pack.toType, diff.pack.toUnit)}</b>`
        : `${LABEL[f]} ${diff[f].from != null ? money(diff[f].from) : "—"} → <b>${diff[f].to != null ? money(diff[f].to) : "removed"}</b>`);
      return `<div class="pe-hrow"><div class="pe-hwhen">${fmtWhen(e.at)}</div><div class="pe-hwhat">${lines.join("<br>")}</div>${src}</div>`;
    }).join("");
    if (onOpenPurchase) box.querySelectorAll(".pe-hrow.link").forEach(el => el.onclick = () => { close(); onOpenPurchase(el.dataset.pid); });
  }

  q(".pe-close").onclick = close;
  q(".pe-edit-btn").onclick = () => startEdit();

  // ---------- Edit ----------
  const packType = () => q(".pe-packsel").value;           // "loose" or a pack type
  function showPack(){
    const t = packType();
    q(".pe-pcs-wrap").style.visibility = t === "loose" ? "hidden" : "visible";
    const n = packOrNull(num(".pe-pcs")), unit = q(".pe-unitsel").value;
    q(".pe-buy-label").textContent = t === "loose" ? "Purchase price ₹ (each)" : `Purchase price ₹ (${n ? packText(n, t, unit) : "whole " + t})`;
    q(".pe-sell-label").textContent = t === "loose" ? "Selling price ₹" : `Selling price ₹ (per ${t})`;
    q(".pe-loose-field").style.display = t === "loose" ? "none" : "block";
    q(".pe-loose-label").textContent = `Loose selling ₹ (per ${looseUnit(unit)})`;
    updateBuyNote();
    check();
  }
  q(".pe-packsel").addEventListener("change", showPack);
  q(".pe-pcs").addEventListener("input", showPack);
  q(".pe-unitsel").addEventListener("change", showPack);

  // Warnings while typing.
  function check(){
    const mrp = num(".pe-mrp"), buy = num(".pe-buy"), sell = num(".pe-sell");
    const msgs = [];
    let block = false;
    if ([mrp, buy, sell].some(v => v != null && !(v >= 0))){ msgs.push(["bad", "Prices can't be negative"]); block = true; }
    if (packType() !== "loose" && !packOrNull(num(".pe-pcs"))){ msgs.push(["bad", `Enter how many are in a ${packType()} (2 or more)`]); block = true; }
    if (sell != null && mrp != null && sell > mrp) msgs.push(["warn", `Selling price ${money(sell)} is above MRP ${money(mrp)}`]);
    // a pack's purchase price can't be compared with a per-piece selling price
    if (packType() === "loose" && sell != null && buy != null && sell < buy) msgs.push(["warn", `Selling price ${money(sell)} is below what you paid (${money(buy)})`]);
    if (packType() !== "loose"){
      if (sell != null && buy != null && sell < buy) msgs.push(["warn", `Selling price ${money(sell)} per ${packType()} is below what you paid (${money(buy)})`]);
      const loose = num(".pe-loose"), cost = unitPrice(buy, num(".pe-pcs"), q(".pe-unitsel").value);
      if (loose != null && !(loose >= 0)){ msgs.push(["bad", "Prices can't be negative"]); block = true; }
      if (loose != null && cost && loose < cost.value) msgs.push(["warn", `Loose price ${money(loose)}/${cost.per} is below what you paid (${money(cost.value)}/${cost.per})`]);
    }
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
  // Under the purchase box: the individual price inside the pack (= ₹50/kg), and where the price came from.
  function updateBuyNote(){
    const t = packType();
    const each = t !== "loose" ? unitPriceText(num(".pe-buy"), packOrNull(num(".pe-pcs")), q(".pe-unitsel").value) : "";
    const source = q(".pe-buy").value.trim() !== buyAtOpen ? "Set by hand — the next invoice will update it again" : buyNote();
    q(".pe-buy-note").textContent = [each ? "= " + each : "", source].filter(Boolean).join(" · ");
  }
  q(".pe-buy").addEventListener("input", updateBuyNote);

  function startEdit(prefillName = ""){
    q(".pe-title").textContent = current ? current.name : "New product";
    q(".pe-name").value = current ? current.name : prefillName;
    const set = (sel, v) => { q(sel).value = v == null ? "" : v; };
    set(".pe-mrp", current && current.mrp);
    set(".pe-buy", current && current.purchase && current.purchase.price);
    set(".pe-sell", current && current.sellPrice);
    set(".pe-loose", current && current.sellLoose);
    const pack = effectivePack(current);
    set(".pe-pcs", pack);
    q(".pe-packsel").value = pack ? effectivePackType(current) : "loose";
    q(".pe-unitsel").value = pack ? effectivePackUnit(current) : "pcs";
    buyAtOpen = q(".pe-buy").value.trim();
    q(".pe-buy-note").textContent = buyNote();
    showPack();
    setMode("edit");
    setTimeout(() => (current ? q(".pe-sell") : q(".pe-name")).focus(), 50);
  }
  q(".pe-cancel").onclick = () => { if (openedInEdit || !current) close(); else { renderView(); setMode("view"); } };

  q(".pe-save").onclick = async () => {
    if (!check()) return;
    const name = q(".pe-name").value.trim();
    if (!name){ toast("Enter the product name"); q(".pe-name").focus(); return; }
    const buyNow = q(".pe-buy").value.trim();
    const isPack = packType() !== "loose";
    const btn = q(".pe-save");
    btn.disabled = true;
    try{
      // renamed: move the product (and its lines on past purchases) to the new name first
      if (current && name !== current.name) await renameProduct(shopCode, current.name, name, via);
      await saveProductPrices(shopCode, name, {
        mrp: num(".pe-mrp"), purchasePrice: buyNow === "" ? null : Number(buyNow), sellPrice: num(".pe-sell"),
        pack: isPack ? packOrNull(num(".pe-pcs")) : null, packType: isPack ? packType() : null,
        packUnit: isPack ? q(".pe-unitsel").value : null,
        sellLoose: isPack ? num(".pe-loose") : null
      }, buyNow !== buyAtOpen, { before: current, via });
      toast(`Saved ${name}`);
      if (openedInEdit){ close(); }
      else {
        // back to the view, showing the saved product and the new history line
        current = (lookup && lookup(productKey(name))) || current;
        renderView();
        setMode("view");
      }
    }catch(e){
      if (/already exists/.test(e.message || "")) toast(e.message);   // name taken — the message says so
      else { console.error(e); toast("Couldn't save — check your connection"); }
    }
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
    if (!confirm(`Delete “${current.name}”? Its prices are removed and it leaves the Products list and bill suggestions.${note}`)) return;
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
